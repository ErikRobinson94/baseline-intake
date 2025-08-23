// index.js
const http = require('http');
const next = require('next');
const { WebSocketServer } = require('ws');
const { URL } = require('url');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = process.env.PORT || 10000;

function log(kind, obj) {
  console.log(JSON.stringify({ t: new Date().toISOString(), kind, ...obj }));
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    // cheap health check so Render can mark deploy as live
    try {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
    } catch (_) {}

    // hand off to Next for everything else
    handle(req, res);
  });

  // One WS server, we’ll route upgrades by path
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    // Only accept our 3 WS paths
    if (pathname === '/ws-echo' || pathname === '/ws-ping' || pathname === '/web-demo/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.pathname = pathname;
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const path = ws.pathname || '';
    log('ws_conn', { path });

    if (path === '/ws-echo') {
      ws.on('message', (data) => ws.send(data));
    } else if (path === '/ws-ping') {
      const iv = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send('pong');
      }, 1000);
      ws.on('close', () => clearInterval(iv));
    } else if (path === '/web-demo/ws') {
      ws.send(JSON.stringify({ ok: true, msg: 'demo: handshake ok' }));
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    log('server_listen', { url: `http://0.0.0.0:${PORT}`, node: process.version });
  });
});
