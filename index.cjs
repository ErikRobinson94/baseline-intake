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

    // health
    ex.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

    // static helpers (Next also serves /public, these are harmless)
    ex.use('/worklets', express.static(path.join(process.cwd(), 'public', 'worklets')));
    ex.use('/voices',   express.static(path.join(process.cwd(), 'public', 'voices')));

    const server = createServer(ex);

    // Attach the browser live demo bridge to BOTH routes
    try {
      const { setupWebDemoLive } = require('./lib/web-demo-live.cjs');
      setupWebDemoLive(server, { route: '/audio-stream' });
      setupWebDemoLive(server, { route: '/web-demo/ws' });
    } catch (e) {
      jlog('warn', 'web_demo_live_not_loaded', { err: e?.message || String(e) });
    }

    // Smoke-test WS: /ws-echo and /ws-ping
    const echoWSS = new WebSocket.Server({ noServer: true });
    echoWSS.on('connection', (ws) => ws.on('message', (msg) => ws.send(msg)));

    const pingWSS = new WebSocket.Server({ noServer: true });
    pingWSS.on('connection', (ws) => { try { ws.send('pong'); } catch {} });

    // Only take over the two explicit smoke routes; leave others to path-bound WSS
    server.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws-echo') {
        echoWSS.handleUpgrade(req, socket, head, (ws) => echoWSS.emit('connection', ws, req));
        return;
      }
      if (req.url === '/ws-ping') {
        pingWSS.handleUpgrade(req, socket, head, (ws) => pingWSS.emit('connection', ws, req));
        return;
      }
      // NOTE: web-demo-live creates WSS with { server, path }, so it will
      // accept upgrades for /audio-stream and /web-demo/ws directly.
    });

    // ✅ Express 5–safe catch-all (NO regex parens). Avoid '*'!
    ex.all('/:path(*)', (req, res) => handle(req, res));

    const port = Number(process.env.PORT || 10000);
    server.listen(port, () => jlog('info', 'server_listen', { port, dev }));
  } catch (err) {
    jlog('error', 'server_boot_error', { err: err?.message || String(err), stack: err?.stack });
    process.exit(1);
  }
})();

