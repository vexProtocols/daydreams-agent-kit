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
if (process.env.PRIVATE_KEY) {
  const rawKey = process.env.PRIVATE_KEY;
  // Remove any existing 0x, normalize, then add 0x back
  const normalized = rawKey.trim().replace(/^0x/i, "").replace(/\s+/g, "").replace(/['"]/g, "");
  
  if (normalized.length === 64 && /^[0-9a-fA-F]+$/.test(normalized)) {
    const hexString = normalized.toLowerCase();
    // Library expects 0x prefix - add it back
    process.env.PRIVATE_KEY = `0x${hexString}`;
    console.log(`[daydreams-news] Private key normalized with 0x prefix: 0x${hexString.substring(0, 8)}...${hexString.substring(56)}`);
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
          "0xb7f90d83b371aee1250021732b8e5ac05198940f",
        network: (process.env.NETWORK as any) ?? "base",
        facilitatorUrl:
          (process.env.FACILITATOR_URL as any) ??
          "https://facilitator.daydreams.systems",
      },
    })
  )
  .build();

const { app, addEntrypoint } = await createAgentApp(agent, {
  beforeMount: (app) => {
    // Add CORS support for payment gateway
    app.use("*", async (c, next) => {
      const origin = c.req.header("Origin");
      if (origin) {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Credentials", "true");
      } else {
        c.header("Access-Control-Allow-Origin", "*");
      }
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH, HEAD");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PAYMENT, X-Payment-Response");
      c.header("Access-Control-Max-Age", "86400");
      
      if (c.req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      await next();
    });
  },
  // Removed afterMount handler - let the library handle all routes
  // The library should handle HEAD/GET/POST requests for entrypoints
  // Custom handlers were causing 404 errors by interfering with library routing
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
    const limitInput = ctx.input?.limit;
    const limit =
      typeof limitInput === "number" && Number.isInteger(limitInput)
        ? clamp(limitInput, 1, 10)
        : 5;

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

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        ...(process.env.DAYDREAMS_NEWS_API_KEY
          ? { Authorization: `Bearer ${process.env.DAYDREAMS_NEWS_API_KEY}` }
          : {}),
      },
    });
  } catch (error) {
    throw new Error(
      `[daydreams-news] Failed to reach ${endpoint}: ${
        (error as Error).message
      }`
    );
  }

  if (!response.ok) {
    throw new Error(
      `[daydreams-news] ${endpoint} responded with ${response.status} ${response.statusText}`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `[daydreams-news] Unable to parse response from ${endpoint}: ${
        (error as Error).message
      }`
    );
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
    throw new Error(
      `[daydreams-news] No news entries returned from ${endpoint} (limit=${limit}).`
    );
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
