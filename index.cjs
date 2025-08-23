// index.cjs — Express + Next + WS (echo/ping) — CommonJS, Express 5 safe

'use strict';

const express = require('express');
const next = require('next');
const http = require('http');
const { WebSocketServer } = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const PORT = process.env.PORT || 10000;

const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

async function start() {
  console.log('[boot] starting', {
    node: process.version,
    NODE_ENV: process.env.NODE_ENV,
    PORT,
  });

  await nextApp.prepare();
  console.log('[boot] next_ready');

  const app = express();

  // Health check
  app.get('/healthz', (_req, res) => res.type('text/plain').send('OK'));

  // Extra simple echo endpoint for sanity over HTTP
  app.get('/echo-http', (_req, res) => res.type('text/plain').send('echo-ok'));

  // Create HTTP server (so WS shares port)
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
      // not one of our WS routes
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

  // ---- Catch-all for Next.js (Express 5 safe) ----
  // Use a middleware with no path to avoid path-to-regexp '*' issues
  app.use((req, res) => {
    return handle(req, res);
  });

  // Timeouts (nice to have on PaaS)
  server.keepAliveTimeout = 61_000;
  server.headersTimeout = 65_000;

  server.on('error', (err) => {
    console.error('[server] error', err);
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening http://0.0.0.0:${PORT}`);
  });
}

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e);
  process.exit(1);
});

start().catch((err) => {
  console.error('[boot] fatal', err);
  process.exit(1);
});
