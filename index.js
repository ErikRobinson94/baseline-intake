// index.js — Express + Next + WS (echo/ping)
// Node >=20

const express = require('express');
const next = require('next');
const http = require('http');
const { WebSocketServer } = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

const PORT = process.env.PORT || 10000;

async function main() {
  await nextApp.prepare();

  const app = express();

  // Health check ONLY on /healthz
  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('OK');
  });

  // Create HTTP server so WS can share the same port
  const server = http.createServer(app);

  // --- WebSocket endpoints ---
  const wssEcho = new WebSocketServer({ noServer: true });
  const wssPing = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url.startsWith('/ws-echo')) {
      wssEcho.handleUpgrade(req, socket, head, (ws) => {
        wssEcho.emit('connection', ws, req);
      });
    } else if (url.startsWith('/ws-ping')) {
      wssPing.handleUpgrade(req, socket, head, (ws) => {
        wssPing.emit('connection', ws, req);
      });
    } else {
      // Not one of our WS routes; let Next/Express handle via HTTP
      socket.destroy();
    }
  });

  // Echo: reflect text/binary
  wssEcho.on('connection', (ws) => {
    console.log('[ws-echo] open');
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.send(data, { binary: true });
      else ws.send(data.toString());
    });
    ws.on('close', () => console.log('[ws-echo] closed'));
    ws.on('error', (e) => console.warn('[ws-echo] error', e?.message));
  });

  // Ping: push "pong" every 5s
  wssPing.on('connection', (ws) => {
    console.log('[ws-ping] open');
    const timer = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send('pong');
    }, 5000);
    ws.on('close', () => {
      clearInterval(timer);
      console.log('[ws-ping] closed');
    });
    ws.on('error', (e) => console.warn('[ws-ping] error', e?.message));
  });

  // Let Next.js handle everything else (/, assets, app routes, etc.)
  app.all('*', (req, res) => handle(req, res));

  server.listen(PORT, () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT} (NODE_ENV=${process.env.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
