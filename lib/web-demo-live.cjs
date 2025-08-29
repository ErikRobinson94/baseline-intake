// lib/web-demo-live.cjs
// Browser mic <-> Deepgram Agent bridge (no Twilio)
// - Sends REQUIRED "Settings" first (schema-minimal; no firm_name/name fields)
// - Queues mic frames until SettingsApplied
// - Forwards DG transcripts + TTS to the browser
// - Swallows any custom client text (start/stop/etc.), forwards only PCM binary

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
function sanitizeASCII(str) {
  if (!str) return "";
  return String(str)
    .replace(/[\u0000-\u001F\u007F-\uFFFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function bufToStr(buf) {
  if (!buf) return "";
  try {
    if (Buffer.isBuffer(buf)) return buf.toString("utf8");
    if (typeof buf === "string") return buf;
    return String(buf);
  } catch { return ""; }
}
function compactPrompt(s, max = 380) {
  const fallback =
    "You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.";
  if (!s) return fallback;
  const t = s.length <= max ? s : s.slice(0, max);
  return t.length >= 40 ? t : fallback;
}

function setupWebDemoLive(server, { route = "/audio-stream" } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  // ENV
  const DG_URL = process.env.DG_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
  const DG_KEY = process.env.DG_API_KEY || process.env.DEEPGRAM_API_KEY || "";
  const DG_AGENT_ID = process.env.DG_AGENT_ID || "";      // optional
  const DG_PROJECT_ID = process.env.DG_PROJECT_ID || "";  // optional

  // Models / persona
  const FIRM_NAME     = process.env.FIRM_NAME   || "Benji Personal Injury";
  const DG_STT_MODEL  = (process.env.DG_STT_MODEL  || "nova-2").trim();
  const DG_TTS_VOICE  = (process.env.DG_TTS_VOICE  || "aura-2-odysseus-en").trim();
  const LLM_MODEL     = (process.env.LLM_MODEL     || "gpt-4o-mini").trim();
  const LLM_TEMP      = Number(process.env.LLM_TEMPERATURE || "0.15");

  // Greeting + instructions (your exact prompt is the default)
  const DEFAULT_INSTRUCTIONS =
    "You are the intake specialist. Determine existing client vs accident. If existing: ask full name, best phone, and attorney; then say you will transfer. If accident: collect full name, phone, email, what happened, when, and city/state; confirm all; then say you will transfer. Be warm, concise, and stop speaking if the caller talks.";
  const AGENT_INSTRUCTIONS = compactPrompt(
    sanitizeASCII(process.env.AGENT_INSTRUCTIONS || DEFAULT_INSTRUCTIONS)
  );

  const DEFAULT_GREETING =
    `Thank you for calling ${FIRM_NAME}. Were you in an accident, or are you an existing client?`;
  const AGENT_GREETING = sanitizeASCII(process.env.AGENT_GREETING || DEFAULT_GREETING);

  log("info", "web_demo_live_ready", { route });
  log("info", "dg_config", {
    url: DG_URL,
    key: maskKey(DG_KEY),
    hasAgentId: Boolean(DG_AGENT_ID),
    hasProjectId: Boolean(DG_PROJECT_ID),
  });

  // Upgrade only for our route (WHATWG URL API)
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

    // Headers for Deepgram Agent
    const headers = { Authorization: `Token ${DG_KEY}`, Origin: "https://baseline-intake.onrender.com" };
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

    // HTTP failures
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

    // keepalive
    let pingTimer = null;
    const startPing = () => {
      stopPing();
      pingTimer = setInterval(() => {
        try { client.ping(); } catch {}
        try { upstream.ping(); } catch {}
      }, 15000);
    };
    const stopPing = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } };

    // send Settings FIRST (no name/firm_name keys)
    let settingsSent = false;
    let settingsApplied = false;

    function sendSettings() {
      if (settingsSent) return;
      const settings = {
        type: "Settings",
        audio: {
          input:  { encoding: "linear16", sample_rate: 16000 },
          output: { encoding: "linear16", sample_rate: 16000 },
        },
        agent: {
          greeting: AGENT_GREETING,
          // Optional: language is usually fine; remove if DG complains
          language: "en",
          listen: { provider: { type: "deepgram", model: DG_STT_MODEL, smart_format: true } },
          think:  { provider: { type: "open_ai", model: LLM_MODEL, temperature: LLM_TEMP }, prompt: AGENT_INSTRUCTIONS },
          speak:  { provider: { type: "deepgram", model: DG_TTS_VOICE } },
        },
      };
      try {
        upstream.send(JSON.stringify(settings));
        settingsSent = true;
        try {
          client.send(JSON.stringify({
            type: "settings",
            sttModel: DG_STT_MODEL,
            ttsVoice: DG_TTS_VOICE,
            llmModel: LLM_MODEL,
            temperature: LLM_TEMP,
            greeting: AGENT_GREETING,
            prompt_len: AGENT_INSTRUCTIONS.length
          }));
        } catch {}
      } catch {
        try { client.send(JSON.stringify({ type: "status", text: "Failed to send Settings to Deepgram." })); } catch {}
      }
    }

    upstream.on("open", () => {
      log("info", "DG→SERVER.open", { connId });
      startPing();
      sendSettings();
      try { client.send(JSON.stringify({ type: "status", text: "settings_sent" })); } catch {}
    });

    const preFrames = [];
    const MAX_PRE_FRAMES = 200; // ~4s

    function forwardTranscript(role, text, isFinal) {
      const payload = { type: "transcript", role, text, partial: !isFinal };
      try { client.send(JSON.stringify(payload)); } catch {}
    }

    upstream.on("message", (data) => {
      const isBuf = Buffer.isBuffer(data);

      if (!isBuf || (isBuf && data.length && data[0] === 0x7b)) {
        let evt = null; try { evt = JSON.parse(isBuf ? data.toString("utf8") : data); } catch {}
        if (!evt) return;

        switch (evt.type) {
          case "Welcome":
            // If DG re-sends Welcome, ensure Settings are sent
            sendSettings();
            break;
          case "SettingsApplied":
            settingsApplied = true;
            if (preFrames.length) {
              try { for (const fr of preFrames) upstream.send(fr); } catch {}
              preFrames.length = 0;
            }
            break;

          case "ConversationText":
          case "UserTranscript":
          case "UserResponse":
          case "Transcript":
          case "PartialTranscript":
          case "AgentTranscript":
          case "AgentResponse":
          case "AddUserMessage":
          case "AddAssistantMessage":
          case "AddPartialTranscript": {
            const roleRaw = String((evt.role || evt.speaker || evt.actor || "")).toLowerCase();
            const text = String(evt.content ?? evt.text ?? evt.transcript ?? evt.message ?? "").trim();
            const isFinal = evt.final === true || evt.is_final === true || evt.status === "final" || evt.type === "UserResponse";
            if (!text) break;
            const role = roleRaw.includes("agent") || roleRaw.includes("assistant") ? "Agent" : "User";
            forwardTranscript(role, text, isFinal);
            break;
          }

          case "AgentWarning":
            try { client.send(JSON.stringify({ type: "status", text: `Agent warning: ${evt.message || "unknown"}` })); } catch {}
            break;

          case "AgentError":
          case "Error":
            try { client.send(JSON.stringify({ type: "status", text: `Agent error: ${evt.description || evt.message || "unknown"}` })); } catch {}
            break;
        }

        // Also mirror JSON to the browser log pane
        try { client.send(isBuf ? data.toString("utf8") : data); } catch {}
        return;
      }

      // Binary from DG = TTS PCM16@16k → browser
      try { client.send(data, { binary: true }); } catch {}
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

    // Browser → DG (PCM only). Ignore client text; queue until SettingsApplied.
    const FRAME_MS = 20;
    const IN_RATE = 16000;
    const BYTES_PER_FRAME = Math.round(IN_RATE * 2 * (FRAME_MS / 1000)); // 640 bytes

    let micBuf = Buffer.alloc(0);

    client.on("message", (msg, isBinary) => {
      if (upstream.readyState !== WS.OPEN) return;

      if (!isBinary && typeof msg === "string") {
        try { client.send(JSON.stringify({ type: "status", text: "client_text_ignored" })); } catch {}
        return;
      }

      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      micBuf = Buffer.concat([micBuf, buf]);

      while (micBuf.length >= BYTES_PER_FRAME) {
        const frame = micBuf.subarray(0, BYTES_PER_FRAME);
        micBuf = micBuf.subarray(BYTES_PER_FRAME);
        if (!settingsSent || !settingsApplied) {
          preFrames.push(frame);
          if (preFrames.length > MAX_PRE_FRAMES) preFrames.shift();
        } else {
          try { upstream.send(frame); } catch {}
        }
      }
    });

    client.on("close", (code, reason) => {
      log("info", "CLIENT→SERVER.close", { connId, code, reason: bufToStr(reason) });
      stopPing();
      try { upstream.close(1000); } catch {}
    });
    client.on("error", () => {
      stopPing();
      try { upstream.close(1000); } catch {}
    });
  });
}

module.exports = { setupWebDemoLive };
