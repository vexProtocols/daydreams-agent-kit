// Normalize private key BEFORE any imports that might read it
// Convert to Uint8Array format (32 bytes) that the library expects
if (process.env.PRIVATE_KEY) {
  const rawKey = process.env.PRIVATE_KEY;
  const normalized = rawKey.trim().replace(/^0x/i, "").replace(/\s+/g, "").replace(/['"]/g, "");
  
  if (normalized.length === 64 && /^[0-9a-fA-F]+$/.test(normalized)) {
    const hexString = normalized.toLowerCase();
    // Convert hex string to Uint8Array (32 bytes)
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hexString.slice(i * 2, i * 2 + 2), 16);
    }
    // Convert back to hex string (without 0x) for the library
    // The library should accept this format
    process.env.PRIVATE_KEY = hexString;
    console.log(`[daydreams-news] Private key normalized: ${hexString.substring(0, 8)}...${hexString.substring(56)} (${hexString.length} chars)`);
  } else {
    console.warn(
      `[daydreams-news] Invalid private key format: expected 64-char hex, got "${normalized.substring(0, 20)}..." (length: ${normalized.length}). Clearing PRIVATE_KEY.`
    );
    delete process.env.PRIVATE_KEY;
  }
} else {
  console.warn(`[daydreams-news] PRIVATE_KEY environment variable not set - LLM features will be disabled`);
}

import { z } from "zod";
import {
  createAgentApp,
  createAxLLMClient,
  AgentKitConfig,
} from "@lucid-dreams/agent-kit";
import { flow } from "@ax-llm/ax";

type DaydreamsNewsItem = {
  title: string;
  summary?: string;
  url?: string;
  publishedAt?: string;
  source?: string;
};

const DEFAULT_NEWS_URL = "https://daydreams.systems/api/news/latest";

const configOverrides: AgentKitConfig = {
  payments: {
    facilitatorUrl:
      (process.env.FACILITATOR_URL as any) ??
      "https://facilitator.daydreams.systems",
    payTo:
      (process.env.PAY_TO as `0x${string}` | undefined) ??
      "0xb308ed39d67D0d4BAe5BC2FAEF60c66BBb6AE429",
    network: (process.env.NETWORK as any) ?? "base",
    defaultPrice: process.env.DEFAULT_PRICE ?? "0.1",
  },
};


// Convert private key to Uint8Array (32 bytes) format that the library expects
// The library's normPrivateKeyToScalar function rejects plain strings
let privateKeyBytes: Uint8Array | undefined = undefined;
const privateKeyValue = process.env.PRIVATE_KEY;

if (privateKeyValue && privateKeyValue.length === 64) {
  try {
    // Convert hex string to Uint8Array (32 bytes)
    privateKeyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      privateKeyBytes[i] = parseInt(privateKeyValue.slice(i * 2, i * 2 + 2), 16);
    }
    console.log(`[daydreams-news] Private key converted to Uint8Array (${privateKeyBytes.length} bytes)`);
  } catch (error) {
    console.warn(`[daydreams-news] Failed to convert private key to bytes:`, error);
  }
}

let axClientConfig: any = {
  logger: {
    warn(message, error) {
      if (error) {
        console.warn(`[daydreams-news] ${message}`, error);
      } else {
        console.warn(`[daydreams-news] ${message}`);
      }
    },
  },
};

// Pass as Uint8Array if available, otherwise let library read from env
if (privateKeyBytes) {
  axClientConfig.privateKey = privateKeyBytes;
  // Also keep it in env as fallback
  process.env.PRIVATE_KEY = privateKeyValue;
}

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

const { app, addEntrypoint } = createAgentApp(
  {
    name: "daydreams-news-agent",
    version: "0.1.0",
    description:
      "Summarises the latest Daydreams ecosystem news with AxFlow each time it is called.",
  },
  {
    config: configOverrides,
  }
);

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
  async handler(ctx) {
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

export { app };
