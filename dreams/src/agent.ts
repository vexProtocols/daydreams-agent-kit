// Suppress AxFlow deprecation warnings from library that Railway treats as errors
// Override console methods BEFORE anything else runs to filter out this specific warning
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleLog = console.log;

const filterAxFlowWarning = (message: string): boolean => {
  return message.includes('new AxFlow() is deprecated') || 
         message.includes('[AxFlow]') ||
         (message.includes('AxFlow') && message.includes('deprecated')) ||
         (message.includes('flow() factory'));
};

// Intercept all console methods to catch the warning
console.error = (...args: any[]) => {
  const message = args.map(arg => String(arg)).join(' ');
  if (filterAxFlowWarning(message)) {
    return; // Suppress this warning - it's from inside the library
  }
  originalConsoleError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const message = args.map(arg => String(arg)).join(' ');
  if (filterAxFlowWarning(message)) {
    return; // Suppress this warning - it's from inside the library
  }
  originalConsoleWarn.apply(console, args);
};

// Also intercept console.log but ONLY filter AxFlow warnings, not startup messages
console.log = (...args: any[]) => {
  const message = args.map(arg => String(arg)).join(' ');
  // Only suppress if it's clearly an AxFlow deprecation warning
  // Don't suppress startup messages, error logs, or other important info
  if (filterAxFlowWarning(message) && message.includes('deprecated')) {
    return; // Suppress this warning - it's from inside the library
  }
  originalConsoleLog.apply(console, args);
};

// Normalize private key BEFORE any imports that might read it
// The library expects a 32-byte hex string WITH 0x prefix
// SECURITY: Never log private key data, even partially
if (process.env.PRIVATE_KEY) {
  const rawKey = process.env.PRIVATE_KEY;
  // Remove any existing 0x, normalize, then add 0x back
  const normalized = rawKey.trim().replace(/^0x/i, "").replace(/\s+/g, "").replace(/['"]/g, "");
  
  if (normalized.length === 64 && /^[0-9a-fA-F]+$/.test(normalized)) {
    const hexString = normalized.toLowerCase();
    // Library expects 0x prefix - add it back
    process.env.PRIVATE_KEY = `0x${hexString}`;
    // SECURITY: Only log that key was normalized, never log any part of the key
    console.log(`[daydreams-news] Private key normalized successfully`);
  } else {
    console.warn(
      `[daydreams-news] Invalid private key format: expected 64-char hex, got length ${normalized.length}. Clearing PRIVATE_KEY.`
    );
    delete process.env.PRIVATE_KEY;
  }
} else {
  console.warn(`[daydreams-news] PRIVATE_KEY environment variable not set - LLM features will be disabled`);
}

import { z } from "zod";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments } from "@lucid-agents/payments";
import { createAgentApp } from "@lucid-agents/hono";
import { createAxLLMClient } from "@lucid-agents/core/axllm";
import { flow } from "@ax-llm/ax";

type DaydreamsNewsItem = {
  title: string;
  summary?: string;
  url?: string;
  publishedAt?: string;
  source?: string;
};

const DEFAULT_NEWS_URL = "https://daydreams.systems/api/news/latest";


// The library reads PRIVATE_KEY from env and expects it with 0x prefix
// We've already normalized it above, so just let the library read it from env
let axClientConfig: any = {
  logger: {
    warn(message: unknown, error?: unknown) {
      // Filter out the harmless AxFlow deprecation warning from inside the library
      if (typeof message === 'string' && message.includes('new AxFlow() is deprecated')) {
        return; // Suppress this warning - it's from inside the library, not our code
      }
      if (error) {
        console.warn(`[daydreams-news] ${message}`, error);
      } else {
        console.warn(`[daydreams-news] ${message}`);
      }
    },
  },
};

const axClient = createAxLLMClient(axClientConfig);

if (!axClient.isConfigured()) {
  console.warn(
    "[daydreams-news] Ax LLM provider not configured — responses will use a scripted fallback."
  );
}

const daydreamsNewsFlow = flow<{ articles: string }>()
  .node(
    "summarizer",
    'articles:string -> summary:string "Summarize the latest Daydreams updates in two concise sentences."'
  )
  .node(
    "bulletGenerator",
    'articles:string, summary:string -> highlights:string[] "Return up to five bullet highlights referencing distinct Daydreams announcements."'
  )
  .execute("summarizer", (state) => ({
    articles: state.articles,
  }))
  .execute("bulletGenerator", (state) => ({
    articles: state.articles,
    summary: state.summarizerResult.summary as string,
  }))
  .returns((state) => ({
    summary:
      typeof state.summarizerResult.summary === "string"
        ? state.summarizerResult.summary
        : "",
    highlights: Array.isArray(state.bulletGeneratorResult.highlights)
      ? (state.bulletGeneratorResult.highlights as string[])
      : [],
  }));

// Create agent with builder pattern
const agent = await createAgent({
    name: "daydreams-news-agent",
    version: "0.1.0",
    description:
      "Summarises the latest Daydreams ecosystem news with AxFlow each time it is called.",
})
  .use(http())
  .use(
    payments({
      config: {
        payTo:
          (process.env.PAY_TO as `0x${string}` | undefined) ??
          "0x12d8FE51A6416672624E5690b1871A1353032870",
        network: (process.env.NETWORK as any) ?? "base",
        facilitatorUrl:
          (process.env.FACILITATOR_URL as any) ??
          "https://facilitator.daydreams.systems",
      },
    })
  )
  .build();

// Security configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];
const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // per window

// Payment gateway configuration - SECURITY: Always allow payment gateway for payment processing
const FACILITATOR_URL = (process.env.FACILITATOR_URL as string) ?? "https://facilitator.daydreams.systems";
const PAYMENT_GATEWAY_ORIGINS = [
  FACILITATOR_URL,
  "https://facilitator.daydreams.systems",
  "https://gateway.daydreams.systems",
  ...ALLOWED_ORIGINS,
];

// Simple in-memory rate limiter (for production, use Redis or similar)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function getRateLimitKey(c: any): string {
  // Use IP address for rate limiting
  const forwarded = c.req.header("X-Forwarded-For");
  const ip = forwarded ? forwarded.split(",")[0].trim() : c.req.header("CF-Connecting-IP") || "unknown";
  return ip;
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(key);
  
  // SECURITY: Clean up expired entries to prevent memory leak
  if (rateLimitMap.size > 10000) {
    // If map gets too large, clean up expired entries
    for (const [k, v] of rateLimitMap.entries()) {
      if (now > v.resetAt) {
        rateLimitMap.delete(k);
      }
    }
  }
  
  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  
  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  
  record.count++;
  return true;
}

function isPaymentRequest(c: any): boolean {
  // SECURITY: Identify payment-related requests
  // Payment requests include:
  // 1. Requests to entrypoint routes (payment-protected)
  // 2. Requests with X-PAYMENT header (payment gateway callbacks)
  // 3. Requests with X-Payment-Response header (payment responses)
  const path = c.req.path || "";
  const hasPaymentHeader = Boolean(c.req.header("X-PAYMENT") || c.req.header("X-Payment-Response"));
  const isEntrypointRoute = path.includes("/entrypoints");
  return isEntrypointRoute || hasPaymentHeader;
}

function isValidOrigin(origin: string | null, isPayment: boolean): boolean {
  // SECURITY: Payment gateway requests must be allowed for payment processing
  if (isPayment && !origin) {
    // Payment gateway callbacks may not have origin - allow for payment requests
    return true;
  }
  
  if (!origin) return false;
  
  // SECURITY: Always allow payment gateway origins
  if (PAYMENT_GATEWAY_ORIGINS.some(allowed => origin === allowed || origin.startsWith(allowed))) {
    return true;
  }
  
  if (ALLOWED_ORIGINS.length === 0) {
    // If no allowed origins configured, allow any HTTPS origin
    try {
      const url = new URL(origin);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }
  return ALLOWED_ORIGINS.includes(origin);
}

function sanitizeError(error: unknown): string {
  // SECURITY: Don't leak internal error details
  if (error instanceof Error) {
    // Only return generic error messages
    if (error.message.includes("fetch")) {
      return "External service unavailable";
    }
    if (error.message.includes("parse") || error.message.includes("JSON")) {
      return "Invalid response format";
    }
    return "Internal server error";
  }
  return "Internal server error";
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow HTTPS URLs
    if (parsed.protocol !== "https:") {
      return false;
    }
    // Prevent SSRF: block private/internal IPs
    const hostname = parsed.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("172.16.") ||
      hostname.startsWith("172.17.") ||
      hostname.startsWith("172.18.") ||
      hostname.startsWith("172.19.") ||
      hostname.startsWith("172.20.") ||
      hostname.startsWith("172.21.") ||
      hostname.startsWith("172.22.") ||
      hostname.startsWith("172.23.") ||
      hostname.startsWith("172.24.") ||
      hostname.startsWith("172.25.") ||
      hostname.startsWith("172.26.") ||
      hostname.startsWith("172.27.") ||
      hostname.startsWith("172.28.") ||
      hostname.startsWith("172.29.") ||
      hostname.startsWith("172.30.") ||
      hostname.startsWith("172.31.")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// SECURITY: Add security middleware that doesn't interfere with payment library
const { app, addEntrypoint, runtime } = await createAgentApp(agent, {
  beforeMount: (app) => {
    // SECURITY: Security headers - apply to all routes but don't interfere with payment library
    app.use("*", async (c, next) => {
      const isPayment = isPaymentRequest(c);
      
      // Basic security headers that don't interfere with payment processing
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-XSS-Protection", "1; mode=block");
      c.header("Referrer-Policy", "strict-origin-when-cross-origin");
      
      // HSTS - only if HTTPS
      if (c.req.header("X-Forwarded-Proto") === "https" || c.req.url.startsWith("https://")) {
        c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
      
      // SECURITY: Don't set X-Frame-Options or CSP for payment routes - payment library handles it
      // SECURITY: For non-payment routes, apply strict security
      if (!isPayment) {
        c.header("X-Frame-Options", "DENY");
        c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
        c.header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none';"
        );
      }
      
      await next();
    });

    // SECURITY: Rate limiting - skip for payment routes (payment library handles it)
    app.use("*", async (c, next) => {
      const isPayment = isPaymentRequest(c);
      if (!isPayment) {
        const key = getRateLimitKey(c);
        if (!checkRateLimit(key)) {
          return c.json({ error: "Too many requests" }, 429);
        }
      }
      await next();
    });

    // SECURITY: Request size limit - apply to all routes
    // Note: This checks Content-Length header, but actual body size should also be validated
    app.use("*", async (c, next) => {
      const contentLength = c.req.header("Content-Length");
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (isNaN(size) || size < 0 || size > MAX_REQUEST_SIZE) {
          return c.json({ error: "Request too large" }, 413);
        }
      }
      await next();
    });

    // SECURITY: CORS - payment library handles payment routes, but we add fallback for payment gateway
    app.use("*", async (c, next) => {
      const isPayment = isPaymentRequest(c);
      const origin = c.req.header("Origin");
      const method = c.req.method;
      
      // SECURITY: For payment routes, allow payment gateway origins (fallback if library doesn't handle it)
      if (isPayment && origin && isValidOrigin(origin, true)) {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
        c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PAYMENT, X-Payment-Response");
        c.header("Access-Control-Max-Age", "86400");
      } else if (!isPayment && origin) {
        // SECURITY: For non-payment routes, validate origin strictly
        if (isValidOrigin(origin, false)) {
          c.header("Access-Control-Allow-Origin", origin);
          c.header("Access-Control-Allow-Credentials", "true");
          c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
          c.header("Access-Control-Max-Age", "86400");
        } else if (method === "OPTIONS") {
          return new Response(null, { status: 403 });
        }
      } else if (isPayment && !origin) {
        // SECURITY: Payment gateway callbacks may not have origin - allow but don't set CORS headers
        // The payment library will handle this
      }
      
      if (method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      
      await next();
    });
  },
  afterMount: (app) => {
    // CRITICAL FIX: Payment gateway makes HEAD/GET requests after payment
    // Handle these requests properly to avoid 404/500 errors
    
    // HEAD handler - payment gateway checks if endpoint exists
    app.on(["HEAD"], "/entrypoints/:key/invoke", async (c: any) => {
      return new Response(null, { status: 200 });
    });
    
    // GET handler with X-PAYMENT header - payment gateway invokes after payment
    // The payment library handles POST, but gateway sends GET with X-PAYMENT
    app.get("/entrypoints/:key/invoke", async (c: any) => {
      const hasPayment = !!c.req.header("X-PAYMENT");
      
      // If no X-PAYMENT header, let payment library handle it (should return 402 HTML)
      // But if we reach here, payment library didn't handle it, so return 402
      if (!hasPayment) {
        // Payment library should have handled this, but if not, return 402
        return c.json({ error: "Payment required" }, 402);
      }
      
      // GET with X-PAYMENT - invoke the entrypoint
      // Extract input from query params or body
      const key = c.req.param("key");
      let input: any = undefined;
      
      try {
        // Try to get input from query params
        const inputParam = c.req.query("input");
        if (inputParam) {
          input = JSON.parse(inputParam);
        }
      } catch {
        // Invalid JSON, use undefined
      }
      
      if (!runtime?.handlers) {
        console.error("[entrypoint-error] Runtime handlers not available");
        return c.json({ error: "Runtime handlers not available" }, 500);
      }
      
      try {
        // Create a POST-like request for the handler
        // The handler expects a Request object, so we'll create one
        const handlerRequest = new Request(c.req.url, {
          method: "POST",
          headers: c.req.raw.headers,
          body: input ? JSON.stringify({ input }) : undefined,
        });
        
        // Invoke the entrypoint handler
        const response = await runtime.handlers.invoke(handlerRequest, { key });
        
        // Ensure we return a proper Response
        if (response instanceof Response) {
          return response;
        }
        
        // If handler returns an object, convert to JSON response
        return c.json(response);
      } catch (error) {
        console.error(`[entrypoint-error] Error invoking entrypoint ${key}:`, error);
        if (error instanceof Error) {
          console.error(`[entrypoint-error] Error stack:`, error.stack);
        }
        const sanitizedError = sanitizeError(error);
        return c.json({ error: sanitizedError }, 500);
      }
    });
  },
});

addEntrypoint({
  key: "latest-daydreams-news",
  description:
    "Fetch and summarise the latest Daydreams news items into a short briefing.",
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Maximum number of news items to include (default 5)."),
  }),
  price: "0.05",
  output: z.object({
    summary: z.string(),
    highlights: z.array(z.string()),
    sources: z.array(
      z.object({
        title: z.string(),
        summary: z.string().optional(),
        url: z.string().optional(),
        publishedAt: z.string().optional(),
        source: z.string().optional(),
      })
    ),
  }),
  async handler(ctx: any) {
    try {
      // SECURITY: Validate and sanitize all inputs
    const limitInput = ctx.input?.limit;
      let limit = 5; // default
      
      if (limitInput !== undefined && limitInput !== null) {
        if (typeof limitInput === "number" && Number.isInteger(limitInput) && !Number.isNaN(limitInput) && Number.isFinite(limitInput)) {
          limit = clamp(limitInput, 1, 10);
        } else {
          // SECURITY: Invalid input - use default instead of throwing to prevent information leakage
          limit = 5;
        }
      }

    const newsItems = await fetchLatestDaydreamsNews(limit);
    const llm = axClient.ax;
    const articlesContext = buildArticlesContext(newsItems);

    if (!llm) {
      const fallbackSummary = buildFallbackSummary(newsItems);
      return {
        output: {
          summary: fallbackSummary,
          highlights: newsItems.map((item) => item.title),
          sources: newsItems,
        },
        model: "axllm-fallback",
      };
    }

    const result = await daydreamsNewsFlow.forward(llm, {
      articles: articlesContext,
    });
    const usageEntry = daydreamsNewsFlow.getUsage().at(-1);
    daydreamsNewsFlow.resetUsage();

    return {
      output: {
        summary: result.summary ?? "",
        highlights: Array.isArray(result.highlights) ? result.highlights : [],
        sources: newsItems,
      },
      model: usageEntry?.model,
    };
    } catch (error) {
      // SECURITY: Sanitize all errors before returning
      const sanitizedError = sanitizeError(error);
      throw new Error(sanitizedError);
    }
  },
});

function buildFallbackSummary(items: DaydreamsNewsItem[]): string {
  const titles = items.map((item) => item.title).join("; ");
  return `Latest Daydreams updates include: ${titles}.`;
}

async function fetchLatestDaydreamsNews(
  limit: number
): Promise<DaydreamsNewsItem[]> {
  const endpoint = process.env.DAYDREAMS_NEWS_URL ?? DEFAULT_NEWS_URL;

  // SECURITY: Validate URL to prevent SSRF attacks
  if (!validateUrl(endpoint)) {
    throw new Error("Invalid endpoint URL");
  }

  // SECURITY: Add timeout to prevent hanging requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(process.env.DAYDREAMS_NEWS_API_KEY
          ? { Authorization: `Bearer ${process.env.DAYDREAMS_NEWS_API_KEY}` }
          : {}),
      },
    });
    clearTimeout(timeoutId);
  } catch (error) {
    clearTimeout(timeoutId);
    // SECURITY: Don't expose endpoint URL in error messages
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timeout");
    }
    throw new Error("External service unavailable");
  }

  if (!response.ok) {
    // SECURITY: Don't expose endpoint details or status codes
    throw new Error("External service error");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // SECURITY: Don't expose parsing errors
    throw new Error("Invalid response format");
  }

  const collections = [
    Array.isArray(payload) ? payload : null,
    Array.isArray((payload as any)?.items)
      ? ((payload as any).items as unknown[])
      : null,
    Array.isArray((payload as any)?.articles)
      ? ((payload as any).articles as unknown[])
      : null,
    Array.isArray((payload as any)?.data)
      ? ((payload as any).data as unknown[])
      : null,
    Array.isArray((payload as any)?.results)
      ? ((payload as any).results as unknown[])
      : null,
  ].find((value): value is unknown[] => Array.isArray(value));

  const rawItems = (collections ?? []).slice(0, limit);
  const normalized = rawItems
    .map((item) => normalizeDaydreamsNewsItem(item))
    .filter((item): item is DaydreamsNewsItem => Boolean(item));

  if (!normalized.length) {
    // SECURITY: Don't expose endpoint URL or limit in error
    throw new Error("No news entries available");
  }

  return normalized;
}

function normalizeDaydreamsNewsItem(raw: unknown): DaydreamsNewsItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const title =
    takeString(record.title) ??
    takeString(record.headline) ??
    takeString(record.name);

  if (!title) {
    return null;
  }

  const summary =
    takeString(record.summary) ??
    takeString(record.description) ??
    takeString(record.body) ??
    takeString(record.contentSnippet);

  const url =
    takeString(record.url) ??
    takeString(record.link) ??
    takeString(record.permalink);

  const publishedRaw =
    takeString(record.publishedAt) ??
    takeString(record.published_at) ??
    takeString(record.date) ??
    takeString(record.timestamp);

  const publishedAt =
    publishedRaw && isValidDate(publishedRaw)
      ? new Date(publishedRaw).toISOString()
      : undefined;

  const source =
    takeString(record.source) ??
    takeString(record.feed) ??
    takeString(record.channel) ??
    takeString(record.author);

  return {
    title,
    summary,
    url,
    publishedAt,
    source,
  };
}

function buildArticlesContext(items: DaydreamsNewsItem[]): string {
  return items
    .map((item, index) => {
      const parts = [`${index + 1}. ${item.title}`];
      if (item.source) {
        parts.push(`Source: ${item.source}`);
      }
      if (item.publishedAt) {
        parts.push(`Published: ${item.publishedAt}`);
      }
      if (item.summary) {
        parts.push(`Summary: ${truncate(item.summary, 600)}`);
      }
      if (item.url) {
        parts.push(`Link: ${item.url}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function takeString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function isValidDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Add root route handler for health checks
app.get("/", (c: any) => {
  return c.json({
    status: "ok",
    service: "daydreams-news-agent",
    version: "0.1.0",
    endpoints: {
      agent: "/.well-known/agent.json",
    },
  });
});


export { app };
