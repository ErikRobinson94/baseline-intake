// index.js
import http from 'http';
import morgan from 'morgan';
import { WebSocketServer } from 'ws';
import process from 'process';

const PORT = process.env.PORT || 10000;

const app = (req, res) => {
  if (req.url === '/' || req.url.startsWith('/web-smoke')) {
    // Next.js serves the UI; keep the HTTP side simple.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('OK');
    return;
  }
  res.statusCode = 200;
  res.end('OK');
};

const server = http.createServer(app);

// --- helpers
function u(req) {
  try { return new URL(req.url, 'http://x'); } catch { return null; }
}
function log(...args) { console.log(...args); }
function warn(...args) { console.warn(...args); }
function die(socket, code = 400, msg = 'Bad Request') {
  try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n${msg}`); } catch {}
  try { socket.destroy(); } catch {}
}

// Shared WS server; we’ll pick a route per-upgrade.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = u(req);
  if (!url) { warn('[upgrade] bad URL'); return die(socket, 400, 'Bad URL'); }

  const { pathname, searchParams } = url;
  const voiceId = searchParams.get('voiceId') || '0';
  log('[upgrade] path=%s voiceId=%s ua=%s', pathname, voiceId, req.headers['user-agent'] || '');

  const accept = () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._route = pathname;
      ws._voiceId = voiceId;
      wss.emit('connection', ws, req);
    });
  };

  if (pathname === '/ws-echo') return accept();
  if (pathname === '/ws-ping') return accept();
  if (pathname === '/web-demo/ws') return accept();

  warn('[upgrade] reject unknown path:', pathname);
  return die(socket, 404, 'Unknown WS route');
});

wss.on('connection', (ws) => {
  const route = ws._route;
  log('[conn] %s opened (voiceId=%s)', route, ws._voiceId);

  // Heartbeat to keep proxies happy
  const hb = setInterval(() => {
    try { ws.send('pong'); } catch {}
  }, 15000);

  ws.on('close', (code, reason) => {
    clearInterval(hb);
    log('[conn] %s closed code=%s reason=%s', route, code, reason?.toString() || '');
  });

  if (route === '/ws-echo') {
    ws.on('message', (data, isBinary) => {
      log('[echo] got %s (%sB)', isBinary ? 'binary' : 'text', isBinary ? data?.length ?? 0 : String(data).length);
      ws.send(data, { binary: isBinary });
      // Close immediately (keeps smoke logic as-is)
      try { ws.close(1000, 'clean'); } catch {}
    });
    return;
  }

  if (route === '/ws-ping') {
    // Just reply pong to any text
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const s = String(data || '').toLowerCase();
        if (s.includes('ping') || s.length === 0) ws.send('pong');
      }
    });
    return;
  }

  if (route === '/web-demo/ws') {
    let textCount = 0;
    let binCount = 0;

    ws.send(JSON.stringify({ type: 'hello', voiceId: ws._voiceId }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binCount++;
        // Ignore audio frames; just count them.
        if (binCount % 100 === 0) log('[demo] received %d binary frames', binCount);
        return;
      }
      textCount++;
      const s = String(data || '');
      log('[demo] text #%d: %s', textCount, s.slice(0, 120));

      // Simple protocol for the UI
      if (s === 'hello') ws.send('hello');
      else if (s === 'bye') try { ws.close(1000, 'client bye'); } catch {}
      else ws.send('string'); // For sanity / backwards compatibility
    });
    return;
  }

  // Shouldn’t get here because we gate in upgrade
  warn('[conn] unknown route??', route);
});

server.listen(PORT, () => {
  log('server_listen', { url: `http://0.0.0.0:${PORT}` });
  log('boot_env', { PORT, node: process.version });
});
