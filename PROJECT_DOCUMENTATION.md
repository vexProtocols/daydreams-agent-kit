# Daydreams News Agent - Project Documentation

## Project Goal

Build a Daydreams agent that fetches and summarizes the latest Daydreams ecosystem news using the x402 payment protocol. Users pay $0.05 USDC (Base network) to invoke the agent and receive a concise briefing with highlights and sources.

**Agent Name:** `daydreams-news-agent`  
**Version:** `0.1.0`  
**Deployment URL:** `https://daydreams-agent-kit-production.up.railway.app`

---

## Initial Scaffolding

The project was initially scaffolded using `create-agent-kit` which generated a basic Daydreams agent structure. The project was then migrated from `@lucid-dreams/agent-kit` to the newer modular `@lucid-agents` packages.

**Original scaffold command:**
```bash
create-agent-kit
```

**Migration:** Migrated from `@lucid-dreams/agent-kit` to `@lucid-agents/core`, `@lucid-agents/hono`, `@lucid-agents/http`, and `@lucid-agents/payments`.

---

## Folder Structure

```
daydreams-agent-kit/
├── dreams/                    # Main agent application
│   ├── src/
│   │   ├── agent.ts          # Agent definition, entrypoints, and business logic
│   │   └── index.ts          # Server startup and HTTP server configuration
│   ├── package.json          # Dependencies and scripts
│   ├── tsconfig.json         # TypeScript configuration
│   ├── bun.lock              # Bun lockfile
│   ├── nixpacks.toml         # Railway deployment configuration
│   ├── railway.json          # Railway-specific configuration
│   ├── Procfile              # Process file for Railway
│   └── README.md             # Project README
├── .cursor/
│   └── rules/
│       └── ai-rules.mdc      # Cursor IDE rules for AI assistant
├── .gitignore                # Git ignore patterns (includes comprehensive security patterns)
├── LICENSE                   # Project license
├── README.md                 # Root README
├── nixpacks.toml             # Root-level Railway config
├── Procfile                  # Root-level process file
└── test-agent.sh            # Test script for the agent
```

---

## Dependencies

### Production Dependencies

```json
{
  "@lucid-agents/core": "^1.9.1",
  "@lucid-agents/hono": "^0.7.2",
  "@lucid-agents/http": "^1.9.1",
  "@lucid-agents/payments": "^1.9.1",
  "@lucid-agents/types": "^1.5.0",
  "zod": "^4.1.12"
}
```

**Package Details:**
- `@lucid-agents/core`: Core agent functionality and AxLLM client
- `@lucid-agents/hono`: Hono framework integration for HTTP server
- `@lucid-agents/http`: HTTP protocol support
- `@lucid-agents/payments`: x402 payment protocol integration
- `@lucid-agents/types`: TypeScript type definitions
- `zod`: Schema validation for inputs/outputs

### Dev Dependencies

```json
{
  "@types/node": "^24.10.1",
  "bun-types": "^1.3.2",
  "typescript": "^5.9.3"
}
```

**Runtime:** Bun >= 1.1.0

---

## Environment Variables

### Required Variables

| Variable | Description | Example | Required |
|----------|-------------|---------|----------|
| `PRIVATE_KEY` | Wallet private key for AxLLM (64-char hex, with or without 0x prefix) | `0x1234...abcd` | Yes (for LLM features) |
| `PAY_TO` | Wallet address to receive payments (Base network) | `0x12d8FE51A6416672624E5690b1871A1353032870` | No (has default) |

### Optional Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NETWORK` | Blockchain network for payments | `base` | No |
| `FACILITATOR_URL` | x402 payment facilitator URL | `https://facilitator.daydreams.systems` | No |
| `DAYDREAMS_NEWS_URL` | News API endpoint | `https://daydreams.systems/api/news/latest` | No |
| `DAYDREAMS_NEWS_API_KEY` | API key for news endpoint (if required) | - | No |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | - | No |
| `PORT` | Server port | `8787` (or Railway-provided) | No |
| `HOSTNAME` | Server hostname | `0.0.0.0` | No |
| `NODE_ENV` | Environment mode | - | No |

### Railway-Specific Variables

Railway automatically provides:
- `PORT` - Server port
- `RAILWAY_PROJECT_ID` - Project identifier
- `RAILWAY_ENVIRONMENT` - Environment name
- `RAILWAY_SERVICE_NAME` - Service name

**Note:** The code automatically detects Railway and forces `hostname` to `0.0.0.0` for proper routing.

---

## Related Documentation Links

### Daydreams / Lucid Agents

- **GitHub Repository:** https://github.com/daydreamsai/lucid-agents
- **Latest Releases:** https://github.com/daydreamsai/lucid-agents/releases
- **NPM Packages:**
  - [@lucid-agents/core](https://www.npmjs.com/package/@lucid-agents/core)
  - [@lucid-agents/hono](https://www.npmjs.com/package/@lucid-agents/hono)
  - [@lucid-agents/http](https://www.npmjs.com/package/@lucid-agents/http)
  - [@lucid-agents/payments](https://www.npmjs.com/package/@lucid-agents/payments)

### Payment Protocol

- **x402 Protocol:** Payment protocol used by Daydreams agents
- **Facilitator URL:** `https://facilitator.daydreams.systems`
- **Payment Gateway:** `https://gateway.daydreams.systems`

### Deployment

- **Railway.app:** https://railway.app
- **Bun Runtime:** https://bun.sh

### Agent Discovery

- **Agent Manifest:** `/.well-known/agent.json`
- **Public URL:** `https://daydreams-agent-kit-production.up.railway.app/.well-known/agent.json`

---

## Key Instructions from Daydreams Docs

### Agent Creation Pattern

```typescript
const agent = await createAgent({
  name: "daydreams-news-agent",
  version: "0.1.0",
  description: "Summarises the latest Daydreams ecosystem news with AxFlow each time it is called.",
})
  .use(http())
  .use(payments({
    config: {
      payTo: "0x12d8FE51A6416672624E5690b1871A1353032870",
      network: "base",
      facilitatorUrl: "https://facilitator.daydreams.systems",
    },
  }))
  .build();
```

### Entrypoint Definition

```typescript
addEntrypoint({
  key: "latest-daydreams-news",
  description: "Fetch and summarise the latest Daydreams news items into a short briefing.",
  input: z.object({ /* ... */ }),
  price: "0.05", // USDC amount
  output: z.object({ /* ... */ }),
  async handler(ctx) { /* ... */ },
});
```

### Payment Flow

1. User requests entrypoint → Returns 402 HTML (payment UI)
2. User connects wallet and pays → Payment gateway verifies payment
3. Payment gateway makes GET request with `X-PAYMENT` header → Agent invokes handler
4. Agent returns result → User receives news summary

**Important:** The payment library handles all entrypoint routes. Do NOT add custom GET/POST handlers that interfere with the payment flow.

### AxLLM Integration

```typescript
import { createAxLLMClient } from "@lucid-agents/core/axllm";

const axClient = createAxLLMClient({
  // PRIVATE_KEY is read from environment automatically
});

// Use in AxFlow
const result = await flow.forward(axClient.ax, { /* ... */ });
```

### Security Best Practices

1. **Never commit private keys or secrets** - Use environment variables
2. **Validate all inputs** - Use Zod schemas
3. **Sanitize error messages** - Don't expose internal details
4. **Rate limiting** - Implement for production
5. **CORS configuration** - Allow payment gateway origins
6. **Request size limits** - Prevent DoS attacks
7. **URL validation** - Prevent SSRF attacks

---

## High-Level Notes

### Agent Functionality

**This agent produces a news summary when called with:**
- **Input:** Optional `limit` parameter (1-10, default 5) specifying number of news items
- **Output:** 
  - `summary`: Two-sentence summary of latest Daydreams updates
  - `highlights`: Array of up to 5 bullet highlights
  - `sources`: Array of news items with title, summary, URL, publishedAt, source

**Payment:** $0.05 USDC (Base network) per invocation

**LLM Integration:**
- Uses AxFlow with AxLLM for intelligent summarization
- Falls back to scripted summary if LLM not configured
- Supports OpenAI GPT models via AxLLM

### Technical Architecture

1. **Server:** Bun HTTP server with Hono framework
2. **Payment:** x402 protocol via `@lucid-agents/payments`
3. **LLM:** AxLLM client for AI-powered summarization
4. **Flow:** AxFlow for multi-step LLM processing
5. **Security:** Comprehensive middleware for security headers, rate limiting, CORS, etc.

### Deployment

- **Platform:** Railway.app
- **Runtime:** Bun
- **Build:** Nixpacks (automatic Bun detection)
- **Start Command:** `bun run src/index.ts`
- **Port Binding:** Automatically binds to `0.0.0.0` on Railway

### Known Issues & Solutions

1. **502 Bad Gateway:** Fixed by forcing `hostname` to `0.0.0.0` on Railway
2. **404 After Payment:** Fixed by letting payment library handle all entrypoint routes
3. **Payment Wallet Address:** Configured via `PAY_TO` environment variable (default: `0x12d8FE51A6416672624E5690b1871A1353032870`)

### Development Commands

```bash
# Install dependencies
bun install

# Development (watch mode)
bun run dev

# Production start
bun run start

# Type checking
bun run typecheck

# Test agent
./test-agent.sh
```

### Security Configuration

- **Private Key Normalization:** Automatically normalizes `PRIVATE_KEY` to include `0x` prefix
- **Git Ignore:** Comprehensive patterns for `.env`, secrets, keys, credentials
- **Error Sanitization:** All errors sanitized before returning to clients
- **Rate Limiting:** In-memory rate limiter (100 requests/minute per IP)
- **Request Size Limit:** 1MB maximum
- **CORS:** Payment gateway origins always allowed

---

## Version History

- **v0.1.0** - Initial release
  - Migrated from `@lucid-dreams/agent-kit` to `@lucid-agents/*` packages
  - Updated to latest package versions (core@1.9.1, hono@0.7.2, http@1.9.1, payments@1.9.1)
  - Configured payment wallet address
  - Implemented comprehensive security measures
  - Fixed Railway deployment issues

---

## Contact & Support

- **GitHub Repository:** `vexProtocols/daydreams-agent-kit`
- **Deployed Agent:** https://daydreams-agent-kit-production.up.railway.app
- **Agent Manifest:** https://daydreams-agent-kit-production.up.railway.app/.well-known/agent.json

