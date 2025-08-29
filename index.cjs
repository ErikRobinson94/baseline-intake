// index.cjs
const http = require("http");
const express = require("express");
const next = require("next");
const path = require("path");
const { setupWebDemoLive } = require("./lib/web-demo-live.cjs");

const PORT = Number(process.env.PORT || 10000);
const dev = process.env.NODE_ENV !== "production";

function jlog(level, evt, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...extra }));
}

(async () => {
  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const ex = express();
  ex.set("trust proxy", true);

  // tiny request logger (structured)
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

  // health
  ex.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

  // public assets (voices, worklets)
  ex.use(express.static(path.join(__dirname, "public"), { maxAge: "1y", index: false }));

  // Next routes
  ex.all("*", (req, res) => handle(req, res));

  const server = http.createServer(ex);

  // WebSocket bridges
  setupWebDemoLive(server, { route: "/audio-stream" });
  setupWebDemoLive(server, { route: "/web-demo/ws" });

  server.listen(PORT, () => {
    jlog("info", "server_listen", { port: PORT, dev });
  });
})().catch((err) => {
  jlog("error", "server_boot_error", { err: String(err), stack: err?.stack });
  process.exit(1);
});
