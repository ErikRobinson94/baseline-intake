/* index.cjs */
const path = require('path');
const express = require('express');
const next = require('next');
const { createServer } = require('http');
const WebSocket = require('ws');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

/* ---------- logging ---------- */
const LVL = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const THRESH = LVL[LOG_LEVEL] ?? LVL.info;

function jlog(level, evt, meta = {}) {
  const lvlNum = LVL[level] ?? LVL.info;
  if (lvlNum < THRESH) return;
  const rec = { ts: new Date().toISOString(), level, evt, ...meta };
  try { console.log(JSON.stringify(rec)); }
  catch { console.log(`[${level}] ${evt}`, meta); }
}

function maskKey(k) {
  if (!k) return '(unset)';
  const tail = k.slice(-6);
  return `***${tail} (len=${k.length})`;
}

/* ---------- deepgram probe utility ---------- */
function probeWS(url, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, { handshakeTimeout: 8000 });

    let body = '';
    ws.once('open', () => {
      try { ws.close(1000); } catch {}
      resolve({ url, ok: true });
    });

    ws.once('unexpected-response', (_req, res) => {
      // capture status, headers, and up to 1KB of body
      const status = res?.statusCode ?? 0;
      const headers = res?.headers || {};
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (typeof chunk === 'string' && body.length < 1024) {
          body += chunk;
        }
      });
      res.on('end', () => {
        resolve({ url, ok: false, kind: 'unexpected-response', status, headers, body: body.slice(0, 1024) });
      });
      try { ws.terminate(); } catch {}
    });

    ws.once('error', (e) => {
      resolve({
        url, ok: false, kind: 'error',
        code: e?.code || null, message: e?.message || String(e)
      });
      try { ws.terminate(); } catch {}
    });

    ws.once('close', (code, reason) => {
      resolve({ url, ok: false, kind: 'closed', code, reason: String(reason || '') });
    });
  });
}

/* ---------- app bootstrap ---------- */
(async () => {
  try {
    await app.prepare();
    const ex = express();

    // HTTP access log
    ex.use((req, res, nextMw) => {
      const t0 = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        jlog('info', 'http', {
          method: req.method, path: req.originalUrl || req.url,
          status: res.statusCode, ms: Math.round(ms)
        });
      });
      nextMw();
    });

    // health / diagnostics
    ex.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

    ex.get('/envz', (_req, res) => {
      res.json({
        node: process.version,
        has_DEEPGRAM_API_KEY: Boolean(process.env.DEEPGRAM_API_KEY),
        DEEPGRAM_API_KEY_masked: maskKey(process.env.DEEPGRAM_API_KEY || ''),
        DG_AGENT_URL: process.env.DG_AGENT_URL || '(unset)',
        DG_STT_MODEL: process.env.DG_STT_MODEL || 'nova-2',
        LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
        DG_TTS_VOICE: process.env.DG_TTS_VOICE || 'aura-2-odysseus-en',
        LOG_LEVEL: LOG_LEVEL,
      });
    });

    // Deepgram connectivity probe
    ex.get('/dg-check', async (_req, res) => {
      const key = process.env.DEEPGRAM_API_KEY || '';
      const protos = ['token', key];
      const candidates = [
        process.env.DG_AGENT_URL && process.env.DG_AGENT_URL.trim(),
        'wss://agent.deepgram.com/v1/agent/converse',
        'wss://agent.deepgram.com/v1/agent',
      ].filter(Boolean);

      const results = [];
      for (const url of candidates) { // sequential for clarity
        /* eslint-disable no-await-in-loop */
        const r = await probeWS(url, protos);
        results.push(r);
        if (r.ok) break;
      }
      res.json({ tried: results });
    });

    // static assets (explicit)
    ex.use('/worklets', express.static(path.join(process.cwd(), 'public', 'worklets')));
    ex.use('/voices',   express.static(path.join(process.cwd(), 'public', 'voices')));

    const server = createServer(ex);

    // WS bridges
    try {
      const { setupWebDemoLive } = require('./lib/web-demo-live.cjs');
      setupWebDemoLive(server, { route: '/audio-stream' });
      setupWebDemoLive(server, { route: '/web-demo/ws' });
    } catch (e) {
      jlog('warn', 'web_demo_live_not_loaded', { err: e?.message || String(e) });
    }

    server.on('upgrade', (req) => {
      if (req.url === '/audio-stream' || req.url === '/web-demo/ws') {
        jlog('info', 'WS.upgrade', { path: req.url, ua: req.headers['user-agent'] });
      }
    });

    // Next.js catch-all (Express 5)
    ex.use((req, res) => handle(req, res));

    const port = Number(process.env.PORT || 10000);
    server.listen(port, () => jlog('info', 'server_listen', { port, dev }));
  } catch (err) {
    jlog('error', 'server_boot_error', { err: err?.message || String(err), stack: err?.stack });
    process.exit(1);
  }
})();


