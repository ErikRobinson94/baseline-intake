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

    // Health
    ex.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

    // Static (Next also serves /public, but these explicit mounts are fine)
    ex.use('/worklets', express.static(path.join(process.cwd(), 'public', 'worklets')));
    ex.use('/voices',   express.static(path.join(process.cwd(), 'public', 'voices')));

    // Create HTTP server so ws servers can share it
    const server = createServer(ex);

    // Attach Deepgram browser demo WS on BOTH routes so smoke + app work
    try {
      const { setupWebDemoLive } = require('./lib/web-demo-live.cjs');
      setupWebDemoLive(server, { route: '/audio-stream' });
      setupWebDemoLive(server, { route: '/web-demo/ws' });
    } catch (e) {
      jlog('warn', 'web_demo_live_not_loaded', { err: e?.message || String(e) });
    }

    // Simple WS echo/ping used by your smoke page
    const echoWSS = new WebSocket.Server({ noServer: true });
    echoWSS.on('connection', (ws) => {
      ws.on('message', (msg) => ws.send(msg));
    });

    const pingWSS = new WebSocket.Server({ noServer: true });
    pingWSS.on('connection', (ws) => {
      try { ws.send('pong'); } catch {}
    });

    // Only handle the two explicit WS routes here; leave others to modules
    server.on('upgrade', (req, socket, head) => {
      const { url } = req;
      if (url === '/ws-echo') {
        echoWSS.handleUpgrade(req, socket, head, (ws) => echoWSS.emit('connection', ws, req));
        return;
      }
      if (url === '/ws-ping') {
        pingWSS.handleUpgrade(req, socket, head, (ws) => pingWSS.emit('connection', ws, req));
        return;
      }
      // Do nothing for other paths: the WSS created in setupWebDemoLive
      // (with { server, path }) will receive the same 'upgrade' event and
      // accept those routes itself.
    });

    // ✅ Express 5 safe catch-all – DO NOT use '*' here
    ex.all('/(.*)', (req, res) => handle(req, res));

    const port = Number(process.env.PORT || 10000);
    server.listen(port, () => jlog('info', 'server_listen', { port, dev }));
  } catch (err) {
    jlog('error', 'server_boot_error', { err: err?.message || String(err), stack: err?.stack });
    process.exit(1);
  }
})();
