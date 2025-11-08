const DEFAULT_PORT = Number(process.env.PREFERRED_PORT ?? 8787);
const PORT_SCAN_LIMIT = 20;

// Railway requires proper error handling and startup logging
process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

async function startServer() {
  try {
    const { app } = await import("./agent");
    const hostname = process.env.HOSTNAME ?? "0.0.0.0";

    const { server, port } = createServerWithFallback(app.fetch, hostname);

    console.log(`[startup] Starting server on ${hostname}:${port}...`);
    console.log(`[startup] PORT=${port}, HOSTNAME=${hostname}`);
    console.log("[startup] ✅ Server started successfully");
    console.log(
      `[startup] 🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
    );
    console.log(`[startup] Health check: http://${server.hostname}:${server.port}/`);

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.log("[shutdown] SIGTERM received, shutting down gracefully...");
      server.stop();
      process.exit(0);
    });

    process.on("SIGINT", () => {
      console.log("[shutdown] SIGINT received, shutting down gracefully...");
      server.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error("[FATAL] Failed to start server:", error);
    if (error instanceof Error) {
      console.error("[FATAL] Error stack:", error.stack);
    }
    process.exit(1);
  }
}

type FetchHandler = (req: Request) => Response | Promise<Response>;

function createServerWithFallback(fetchHandler: FetchHandler, hostname: string) {
  const envPort = process.env.PORT;
  const parsedPort = Number(envPort ?? DEFAULT_PORT);
  const startPort = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
  const forcePort = Boolean(
    envPort &&
      (process.env.RAILWAY_PROJECT_ID ||
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.CI ||
        process.env.FORCE_PORT === "true")
  );

  if (envPort && !Number.isFinite(parsedPort)) {
    console.warn(`[startup] Provided PORT "${envPort}" is not numeric. Falling back to ${startPort}.`);
  }

  let attemptPort = startPort;
  let attemptsLeft = forcePort ? 1 : PORT_SCAN_LIMIT;
  let lastError: unknown;

  while (attemptsLeft > 0) {
    try {
      const server = Bun.serve({
        port: attemptPort,
        hostname,
        fetch: fetchHandler,
        error(error) {
          console.error("[server] Request error:", error);
          return new Response("Internal Server Error", { status: 500 });
        },
      });

      if (!forcePort && attemptPort !== startPort) {
        console.warn(
          `[startup] Port ${startPort} unavailable, using ${attemptPort} instead. ` +
            `Set FORCE_PORT=true if you require a fixed port.`
        );
      }

      return { server, port: attemptPort };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;
      if (!forcePort && err?.code === "EADDRINUSE") {
        attemptsLeft -= 1;
        attemptPort += 1;
        console.warn(`[startup] Port ${attemptPort - 1} in use, retrying on ${attemptPort}...`);
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error(`[startup] Unable to acquire a free port after ${PORT_SCAN_LIMIT} attempts.`);
}

startServer();
