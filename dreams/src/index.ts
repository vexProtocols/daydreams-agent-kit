// Railway requires proper error handling and startup logging
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function startServer() {
  try {
    const { app } = await import("./agent");
    
    const port = Number(process.env.PORT ?? 8787);
    const hostname = process.env.HOSTNAME ?? "0.0.0.0";

    console.log(`[startup] Starting server on ${hostname}:${port}...`);
    console.log(`[startup] PORT=${port}, HOSTNAME=${hostname}`);

    const server = Bun.serve({
      port,
      hostname,
      fetch: app.fetch,
      error(error) {
        console.error('[server] Request error:', error);
        return new Response('Internal Server Error', { status: 500 });
      },
    });

    console.log(`[startup] ✅ Server started successfully`);
    console.log(`[startup] 🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`);
    console.log(`[startup] Health check: http://${server.hostname}:${server.port}/`);
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('[shutdown] SIGTERM received, shutting down gracefully...');
      server.stop();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('[shutdown] SIGINT received, shutting down gracefully...');
      server.stop();
      process.exit(0);
    });

  } catch (error) {
    console.error('[FATAL] Failed to start server:', error);
    if (error instanceof Error) {
      console.error('[FATAL] Error stack:', error.stack);
    }
    process.exit(1);
  }
}

startServer();
