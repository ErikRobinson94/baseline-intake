// lib/web-demo-live.cjs
// Browser <-> Server <-> Deepgram Agent bridge (PASSTHROUGH: audio only)
// - Does NOT forward client text control messages (start/stop/etc.)
// - Sends NO initial JSON to Deepgram (lets your Agent use server-side defaults)
// - Relays binary PCM both ways and surfaces HTTP errors if any.

const { WebSocketServer } = require("ws");
const WS = require("ws");
const crypto = require("crypto");

function log(level, evt, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, evt, ...extra }));
}

function maskKey(k) {
  if (!k) return "MISSING";
  if (k.length <= 8) return k.replace(/.(?=.{2})/g, "•");
  return k.slice(0, 4) + "••••" + k.slice(-4);
}

function bufToStr(buf) {
  if (!buf) return "";
  try {
    if (Buffer.isBuffer(buf)) return buf.toString("utf8");
    if (typeof buf === "string") return buf;
    return String(buf);
  } catch {
    return "";
  }
}

function setupWebDemoLive(server, { route = "/audio-stream" } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  const DG_URL = process.env.DG_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
  const DG_KEY = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY || "";
  const DG_AGENT_ID = process.env.DG_AGENT_ID || "";      // optional
  const DG_PROJECT_ID = process.env.DG_PROJECT_ID || "";  // optional

  log("info", "web_demo_live_ready", { route });
  log("info", "dg_config", {
    url: DG_URL,
    key: maskKey(DG_KEY),
    hasAgentId: Boolean(DG_AGENT_ID),
    hasProjectId: Boolean(DG_PROJECT_ID),
  });

  // Upgrade only for our route (WHATWG URL API; no deprecated url.parse)
  server.on("upgrade", (req, socket, head) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      if (u.pathname !== route) return;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  wss.on("connection", (client, req) => {
    const connId = crypto.randomBytes(4).toString("base64url");
    log("info", "CLIENT→SERVER.open", { route, connId, ua: req.headers["user-agent"] || "" });

    if (!DG_KEY) {
      const msg = "Deepgram API key missing (set DG_API_KEY or DEEPGRAM_API_KEY)";
      try { client.send(JSON.stringify({ type: "error", error: { message: msg } })); } catch {}
      client.close(1011, "Missing DG API key");
      return;
    }

    // Prepare headers
    const headers = {
      Authorization: `Token ${DG_KEY}`,
      // Origin usually not required, but harmless:
      Origin: "https://baseline-intake.onrender.com",
    };
    if (DG_AGENT_ID) headers["x-dg-agent-id"] = DG_AGENT_ID;
    if (DG_PROJECT_ID) headers["x-dg-project-id"] = DG_PROJECT_ID;

    // Optional agent id via query if not using header
    let upstreamUrl = DG_URL;
    if (!DG_AGENT_ID && process.env.DG_AGENT_QS_ID) {
      try {
        const u = new URL(DG_URL);
        if (!u.searchParams.get("agent_id")) u.searchParams.set("agent_id", process.env.DG_AGENT_QS_ID);
        upstreamUrl = u.toString();
      } catch {}
    }

    log("info", "DG.handshake_try", { url: upstreamUrl });

    const upstream = new WS(upstreamUrl, { headers });

    // Surface HTTP-level failures (401/403/etc.)
    upstream.on("unexpected-response", (_req2, res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => {
        log("warn", "DG.unexpected_response", {
          status: res.statusCode,
          headers: Object.fromEntries(Object.entries(res.headers || {})),
          body: body?.slice(0, 1000),
        });
        try { client.send(JSON.stringify({ type: "error", error: { message: `DG HTTP ${res.statusCode}`, body: body?.slice(0, 500) } })); } catch {}
        try { client.close(1011, "upstream_http_error"); } catch {}
      });
    });

    // Keep-alive both ways
    let pingTimer = null;
    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        try { client.ping(); } catch {}
        try { upstream.ping(); } catch {}
      }, 15000);
    };
    const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

    upstream.on("open", () => {
      log("info", "DG→SERVER.open", { connId });
      startPing();
      // Tell the browser upstream is ready (we intentionally send NO initial JSON to Deepgram)
      try { client.send(JSON.stringify({ type: "status", text: "upstream_open" })); } catch {}
    });

    // ===== Client -> Upstream =====
    // Filter *text* messages from the browser (start/stop/etc.) — do NOT forward, DG closed on those.
    client.on("message", (data, isBinary) => {
      if (upstream.readyState !== upstream.OPEN) return;

      if (!isBinary && typeof data === "string") {
        // swallow all text control from browser to avoid UNPARSABLE_CLIENT_MESSAGE
        try { client.send(JSON.stringify({ type: "status", text: "client_text_ignored" })); } catch {}
        return;
      }

      // Forward PCM audio frames unchanged
      try { upstream.send(data, { binary: isBinary }); } catch {}
    });

    // ===== Upstream -> Client =====
    upstream.on("message", (data, isBinary) => {
      try { client.send(data, { binary: isBinary }); } catch {}
    });

    // Cleanup
    client.on("close", (code, reason) => {
      log("info", "CLIENT→SERVER.close", { connId, code, reason: bufToStr(reason) });
      stopPing();
      try { upstream.close(); } catch {}
    });
    client.on("error", (err) => {
      log("warn", "CLIENT.error", { connId, err: String(err) });
      stopPing();
      try { upstream.close(); } catch {}
    });

    upstream.on("close", (code, reason) => {
      log("info", "DG→SERVER.close", { connId, code, reason: bufToStr(reason) });
      stopPing();
      try { client.send(JSON.stringify({ type: "error", error: { message: "upstream_closed", code, reason: bufToStr(reason) } })); } catch {}
      try { client.close(1011, "upstream_closed"); } catch {}
    });
    upstream.on("error", (err) => {
      log("warn", "DG.error_event", { err: String(err) });
      stopPing();
      try { client.send(JSON.stringify({ type: "error", error: { message: String(err) } })); } catch {}
      try { client.close(1011, "upstream_error"); } catch {}
    });
  });
}

module.exports = { setupWebDemoLive };
