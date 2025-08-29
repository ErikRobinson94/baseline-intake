// index.cjs
const http = require("http");
const express = require("express");
const next = require("next");
const path = require("path");
const { setupWebDemoLive } = require("./lib/web-demo-live.cjs");

const PORT = Number(process.env.PORT || 10000);
const dev = process.env.NODE_ENV !== "production";

function jlog(level, evt, extra = {}) {
  // keep logs single-line JSON for Render
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...extra }));
}

(async () => {
  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const ex = express();
  ex.set("trust proxy", true);

  // tiny request logger
  ex.use((req, res, nextMw) => {
    const start = Date.now();
    res.on("finish", () => {
      jlog("info", "http", {
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    nextMw();
  });

  // health first
  ex.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

  // static assets (no directory index)
  const pubDir = path.join(__dirname, "public");
  ex.use(express.static(pubDir, { maxAge: "1y", index: false }));
  jlog("info", "static_mounted", { dir: pubDir });

  // Hand off everything else to Next **without** using "*" (avoid path-to-regexp v6 wildcard issues)
  ex.use((req, res) => handle(req, res));
  // Alternatively, you could do:
  // ex.all("/*", (req, res) => handle(req, res));
  jlog("info", "next_handler_mounted", { pattern: "middleware_fallback" });

  const server = http.createServer(ex);

  // WebSocket bridges (mounted on the HTTP server's 'upgrade')
  const wsRoute1 = "/audio-stream";
  const wsRoute2 = "/web-demo/ws";
  setupWebDemoLive(server, { route: wsRoute1 });
  setupWebDemoLive(server, { route: wsRoute2 });
  jlog("info", "ws_routes_mounted", { routes: [wsRoute1, wsRoute2] });

  server.listen(PORT, () => {
    jlog("info", "server_listen", { port: PORT, dev });
  });
})().catch((err) => {
  jlog("error", "server_boot_error", { err: String(err), stack: err?.stack });
  process.exit(1);
});