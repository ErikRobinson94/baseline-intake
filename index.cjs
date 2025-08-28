/* index.cjs */
const path = require('path');
const express = require('express');
const next = require('next');
const { createServer } = require('http');
const WebSocket = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

function jlog(level, evt, meta = {}) {
  const rec = { ts: new Date().toISOString(), level, evt, ...meta };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`[${level}] ${evt}`, meta); }
}

(async () => {
  try {
    await app.prepare();

    const ex = express();

    // health + env sanity (no secrets)
    ex.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
    ex.get('/envz', (_req, res) => {
      res.json({
        has_DEEPGRAM_API_KEY: Boolean(process.env.DEEPGRAM_API_KEY),
        DG_AGENT_URL: process.env.DG_AGENT_URL || 'wss://agent.deepgram.com/v1/agent/converse',
        DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
      });
    });

    // static helpers (Next also serves /public)
    ex.use('/worklets', express.static(path.join(process.cwd(), 'public', 'worklets')));
    ex.use('/voices',   express.static(path.join(process.cwd(), 'public', 'voices')));

    const server = createServer(ex);

    // Browser mic<->DG agent bridge
    try {
      const { setupWebDemoLive } = require('./lib/web-demo-live.cjs');
      setupWebDemoLive(server, { route: '/audio-stream' });
      setupWebDemoLive(server, { route: '/web-demo/ws' });
    } catch (e) {
      jlog('warn', 'web_demo_live_not_loaded', { err: e?.message || String(e) });
    }

    // WS smoke utilities
    const echoWSS = new WebSocket.Server({ noServer: true });
    echoWSS.on('connection', (ws) => ws.on('message', (msg) => ws.send(msg)));

    const pingWSS = new WebSocket.Server({ noServer: true });
    pingWSS.on('connection', (ws) => { try { ws.send('pong'); } catch {} });

    server.on('upgrade', (req, socket, head) => {
      // log upgrades so we can see if the browser is actually hitting us
      if (req.url === '/audio-stream' || req.url === '/web-demo/ws') {
        jlog('info', 'WS.upgrade', { path: req.url, ua: req.headers['user-agent'] });
      }
      if (req.url === '/ws-echo') {
        echoWSS.handleUpgrade(req, socket, head, (ws) => echoWSS.emit('connection', ws, req));
        return;
      }
      if (req.url === '/ws-ping') {
        pingWSS.handleUpgrade(req, socket, head, (ws) => pingWSS.emit('connection', ws, req));
        return;
      }
      // The web-demo WSS instances (above) also have their own upgrade listeners.
    });

    // ✅ Express 5 safe catch-all (no path-to-regexp pattern)
    ex.use((req, res) => handle(req, res));

    const port = Number(process.env.PORT || 10000);
    server.listen(port, () => jlog('info', 'server_listen', { port, dev }));
  } catch (err) {
    jlog('error', 'server_boot_error', { err: err?.message || String(err), stack: err?.stack });
    process.exit(1);
  }
})();
