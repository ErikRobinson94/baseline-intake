// lib/web-demo-live.cjs
// Browser <-> Server <-> Deepgram Agent bridge
const { WebSocketServer } = require("ws");
const WS = require("ws");
const url = require("url");
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

  // ENV (works with or without Agent ID — ID is optional)
  const DG_URL = process.env.DG_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
  const DG_KEY = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY || "";
  const DG_AGENT_ID = process.env.DG_AGENT_ID || "";        // optional
  const DG_PROJECT_ID = process.env.DG_PROJECT_ID || "";    // optional

  // Optional inline agent config (your .env shows these)
  const AGENT_NAME = process.env.AGENT_NAME || "Agent";
  const AGENT_GREETING = process.env.AGENT_GREETING || "";
  const DG_STT_MODEL = process.env.DG_STT_MODEL || "nova-2";
  const DG_TTS_VOICE = process.env.DG_TTS_VOICE || "aura-2-odysseus-en";
  const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
  const FIRM_NAME = process.env.FIRM_NAME || "";

  log("info", "web_demo_live_ready", { route });
  log("info", "dg_config", {
    url: DG_URL,
    key: maskKey(DG_KEY),
    hasAgentId: Boolean(DG_AGENT_ID),
    hasProjectId: Boolean(DG_PROJECT_ID),
  });

  // Upgrade only for our route
  server.on("upgrade", (req, socket, head) => {
    try {
      const { pathname } = url.parse(req.url || "/");
      if (pathname !== route) return;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  // Client connects
  wss.on("connection", (client, req) => {
    const connId = crypto.randomBytes(4).toString("base64url");
    log("info", "CLIENT→SERVER.open", { route, connId, ua: req.headers["user-agent"] || "" });

    // Fail fast if no key
    if (!DG_KEY) {
      const msg = "Deepgram API key missing (set DG_API_KEY or DEEPGRAM_API_KEY)";
      try { client.send(JSON.stringify({ type: "error", error: { message: msg } })); } catch {}
      client.close(1011, "Missing DG API key");
      return;
    }

    // Prepare headers
    const headers = {
      Authorization: `Token ${DG_KEY}`,
      Origin: "https://baseline-intake.onrender.com",
    };
    if (DG_AGENT_ID) headers["x-dg-agent-id"] = DG_AGENT_ID;
    if (DG_PROJECT_ID) headers["x-dg-project-id"] = DG_PROJECT_ID;

    // Allow optional agent_id via query if not using header
    let upstreamUrl = DG_URL;
    if (!DG_AGENT_ID && process.env.DG_AGENT_QS_ID) {
      try {
        const u = new URL(DG_URL);
        if (!u.searchParams.get("agent_id")) {
          u.searchParams.set("agent_id", process.env.DG_AGENT_QS_ID);
        }
        upstreamUrl = u.toString();
      } catch {}
    }

    log("info", "DG.handshake_try", { url: upstreamUrl });

    // Connect upstream
    const upstream = new WS(upstreamUrl, { headers });

    // Surface HTTP errors (401/403/etc.) instead of generic 1006
    upstream.on("unexpected-response", (req2, res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => {
        log("warn", "DG.unexpected_response", {
          status: res.statusCode,
          headers: Object.fromEntries(Object.entries(res.headers || {})),
          body: body?.slice(0, 1000),
        });
        try {
          client.send(JSON.stringify({
            type: "error",
            error: { message: `DG HTTP ${res.statusCode}`, body: body?.slice(0, 500) }
          }));
        } catch {}
        try { client.close(1011, "upstream_http_error"); } catch {}
      });
    });

    // Keep both sockets fresh
    let pingTimer = null;
    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        try { client.ping(); } catch {}
        try { upstream.ping(); } catch {}
      }, 15000);
    };
    const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

    // When upstream opens, optionally send inline agent config (no agent_id required)
    upstream.on("open", () => {
      log("info", "DG→SERVER.open", { connId });
      startPing();

      // Send a minimal “start/hello” payload compatible with Agent-style sessions.
      // If your Agent expects different keys, it will just ignore unknown fields.
      const hello = {
        type: "start",
        payload: {
          agent: {
            name: AGENT_NAME,
            greeting: AGENT_GREETING,
            firm_name: FIRM_NAME,
          },
          stt: { model: DG_STT_MODEL },
          tts: { voice: DG_TTS_VOICE },
          llm: { model: LLM_MODEL },
          // We’ll send raw PCM16@16k in binary frames.
          audio: { encoding: "linear16", sample_rate: 16000, channels: 1 },
        },
      };
      try { upstream.send(JSON.stringify(hello)); } catch {}

      // Let the browser know upstream is ready
      try { client.send(JSON.stringify({ type: "status", text: "upstream_open" })); } catch {}
    });

    // Browser → Upstream (binary or JSON)
    client.on("message", (data, isBinary) => {
      if (upstream.readyState !== upstream.OPEN) return;
      try {
        // Forward as-is: binary = audio frames; string = control JSON (e.g., your {type:"start", voiceId})
        upstream.send(data, { binary: isBinary });
      } catch {}
    });

    // Upstream → Browser (binary or JSON)
    upstream.on("message", (data, isBinary) => {
      try { client.send(data, { binary: isBinary }); } catch {}
    });

    // Clean up on either side closing
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
