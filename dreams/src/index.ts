import { app } from "./agent";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
});

console.log(
  `🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
);
