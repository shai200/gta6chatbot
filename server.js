// Leonida Intel — GTA VI companion chatbot.
// Zero-dependency Node server: serves the UI, streams chat completions from
// BetterProxy, and records BetterProxy's cache behaviour for every request.

import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BETTERPROXY_BASE_URL || 'https://api.betterproxy.ai/v1').replace(/\/+$/, '');
const API_KEY = process.env.BETTERPROXY_API_KEY || '';
const MODEL = process.env.BETTERPROXY_MODEL || 'gpt-4o-mini';
const MONITOR_TOKEN = process.env.MONITOR_TOKEN || '';
const LOG_FILE = path.resolve(ROOT, process.env.CACHE_LOG_FILE || 'logs/cache.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_HISTORY = 30;
const RECENT_LIMIT = 200;

const SYSTEM_PROMPT = `You are "Leonida Intel", an unofficial fan-made companion for Grand Theft Auto VI players.

Voice: confident, street-smart, a little playful — like a well-connected fixer who knows the state of Leonida. Keep it helpful first; never let the persona get in the way of a clear answer.

What you help with: missions and story progress, the map and its regions (Vice City, the Leonida Keys, Grassrivers, Port Gellhorn, Ambrosia, Mount Kalaga), protagonists Jason Duval and Lucia Caminos and other characters, vehicles, weapons, money-making, heists, wanted-level mechanics, collectibles, settings and performance on PS5 and Xbox Series X|S, and general tips.

Rules:
- Be accurate. If you are not sure about a specific detail (exact locations, prices, cheat codes, mission names, unlock requirements), say so plainly instead of inventing it, and suggest how the player could check in-game.
- Never fabricate cheat codes or glitches.
- Avoid story spoilers unless the player asks for them; warn before spoiling major plot points.
- Keep answers tight: lead with the answer, then short steps or bullets. Use markdown (bold, lists) sparingly.
- Everything is about the game. If a question is about committing real-world crimes or harming real people, decline and steer back to the game.
- If asked about something unrelated to GTA, answer briefly and bring it back to Leonida.`;

// ───────────────────────── cache monitor ─────────────────────────

const recent = []; // newest last
const stats = newStats();

function newStats() {
  return {
    since: new Date().toISOString(),
    requests: 0, hits: 0, misses: 0, unknown: 0, errors: 0,
    tokensCharged: 0, tokensChargedOnHits: 0, rtkSavedTokens: 0,
    hitTotalMs: 0, missTotalMs: 0, hitTtfbMs: 0, missTtfbMs: 0,
    creditsRemaining: null, billingMode: null, lastRequestAt: null,
  };
}

function applyToStats(r) {
  stats.requests++;
  stats.lastRequestAt = r.ts;
  if (r.error) stats.errors++;
  if (r.cacheHit === true) {
    stats.hits++; stats.hitTotalMs += r.totalMs || 0; stats.hitTtfbMs += r.ttfbMs || 0;
    stats.tokensChargedOnHits += r.tokensCharged || 0;
  } else if (r.cacheHit === false) {
    stats.misses++; stats.missTotalMs += r.totalMs || 0; stats.missTtfbMs += r.ttfbMs || 0;
  } else stats.unknown++;
  stats.tokensCharged += r.tokensCharged || 0;
  stats.rtkSavedTokens += r.rtkSavedTokens || 0;
  if (r.creditsRemaining != null) stats.creditsRemaining = r.creditsRemaining;
  if (r.billingMode) stats.billingMode = r.billingMode;
  recent.push(r);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

// Rebuild counters from the log so monitoring survives restarts.
if (existsSync(LOG_FILE)) {
  for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { applyToStats(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  if (recent[0]) stats.since = recent[0].ts;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read BetterProxy's documented observability headers off a response. */
function readCacheHeaders(h) {
  const hit = h.get('x-cache-hit');
  const status = h.get('x-cache-status');
  let cacheHit = null;
  if (hit != null) cacheHit = hit.trim().toLowerCase() === 'true';
  else if (status != null) cacheHit = status.trim().toUpperCase() === 'HIT';
  return {
    cacheHit,
    cacheStatus: status ? status.trim().toUpperCase() : null,
    proxyLatencyMs: num(h.get('x-latency-ms')),
    tokensCharged: num(h.get('x-tokens-charged')),
    creditsRemaining: num(h.get('x-credits-remaining')),
    billingMode: h.get('x-billing-mode'),
    rtkSavedTokens: num(h.get('x-rtk-saved-tokens')),
  };
}

async function record(r) {
  applyToStats(r);
  const tag = r.error ? 'ERROR' : r.cacheHit === true ? 'HIT  ' : r.cacheHit === false ? 'MISS ' : '?    ';
  console.log(
    `[cache] ${tag} status=${r.httpStatus ?? '-'} ttfb=${r.ttfbMs ?? '-'}ms total=${r.totalMs}ms ` +
    `proxy=${r.proxyLatencyMs ?? '-'}ms tokens=${r.tokensCharged ?? '-'} credits=${r.creditsRemaining ?? '-'} ` +
    `"${r.promptPreview}"${r.error ? ` err=${r.error}` : ''}`
  );
  try {
    await mkdir(path.dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(r) + '\n');
  } catch (e) {
    console.error('[cache] could not write log:', e.message);
  }
}

function summary() {
  const known = stats.hits + stats.misses;
  const avg = (sum, n) => (n ? Math.round(sum / n) : null);
  return {
    ...stats,
    hitRate: known ? stats.hits / known : null,
    avgHitMs: avg(stats.hitTotalMs, stats.hits),
    avgMissMs: avg(stats.missTotalMs, stats.misses),
    avgHitTtfbMs: avg(stats.hitTtfbMs, stats.hits),
    avgMissTtfbMs: avg(stats.missTtfbMs, stats.misses),
    model: MODEL, baseUrl: BASE_URL, logFile: LOG_FILE,
  };
}

// ───────────────────────── chat ─────────────────────────

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }); }

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return json(res, 400, { error: 'No user message' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const rec = {
    ts: new Date().toISOString(), id: randomUUID(), model: MODEL,
    promptPreview: lastUser.content.replace(/\s+/g, ' ').slice(0, 80),
    promptChars: lastUser.content.length, turns: messages.length,
    httpStatus: null, cacheHit: null, cacheStatus: null, proxyLatencyMs: null,
    ttfbMs: null, totalMs: null, tokensCharged: null, creditsRemaining: null,
    billingMode: null, rtkSavedTokens: null, outputChars: 0, aborted: false, error: null,
  };
  const started = performance.now();
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) { rec.aborted = true; ac.abort(); } });

  try {
    if (!API_KEY) throw new Error('BETTERPROXY_API_KEY is not set on the server. Add it to .env and restart.');

    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] }),
    });
    rec.httpStatus = upstream.status;
    Object.assign(rec, readCacheHeaders(upstream.headers));

    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 500);
      throw new Error(`BetterProxy returned ${upstream.status}: ${text}`);
    }

    const emit = (text) => {
      if (!text) return;
      if (rec.ttfbMs == null) rec.ttfbMs = Math.round(performance.now() - started);
      rec.outputChars += text.length;
      send({ type: 'delta', text });
    };

    if ((upstream.headers.get('content-type') || '').includes('application/json')) {
      // Some gateways answer cache hits with a plain JSON body even when stream=true.
      const data = await upstream.json();
      emit(data?.choices?.[0]?.message?.content || '');
    } else {
      const decoder = new TextDecoder();
      let buf = '';
      outer: for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') break outer;
          try {
            const evt = JSON.parse(payload);
            if (evt.error) throw new Error(evt.error.message || JSON.stringify(evt.error));
            emit(evt.choices?.[0]?.delta?.content);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
          }
        }
      }
    }
    send({ type: 'done' });
  } catch (e) {
    if (!rec.aborted) {
      rec.error = e.message;
      send({ type: 'error', message: e.message });
    }
  } finally {
    finished = true;
    rec.totalMs = Math.round(performance.now() - started);
    res.end();
    record(rec);
  }
}

// ───────────────────────── http ─────────────────────────

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/monitor' ? 'monitor.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const monitorAllowed = (url) => !MONITOR_TOKEN || url.searchParams.get('token') === MONITOR_TOKEN;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/chat') return await handleChat(req, res);
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, configured: Boolean(API_KEY), model: MODEL });
    if (req.method === 'GET' && (p === '/api/cache/stats' || p === '/api/cache/logs' || p === '/monitor')) {
      if (!monitorAllowed(url)) return json(res, 401, { error: 'Monitor token required (?token=...)' });
      if (p === '/api/cache/stats') return json(res, 200, { stats: summary(), recent: recent.slice(-50).reverse() });
      if (p === '/api/cache/logs') return json(res, 200, { entries: recent.slice().reverse() });
    }
    if (req.method === 'GET') return await serveStatic(res, p);
    json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' }); else res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`Leonida Intel running → http://localhost:${PORT}`);
  console.log(`Cache monitor         → http://localhost:${PORT}/monitor`);
  console.log(`BetterProxy           → ${BASE_URL}  (model: ${MODEL})`);
  console.log(`Cache log             → ${LOG_FILE}`);
  if (!API_KEY) console.warn('⚠  BETTERPROXY_API_KEY is not set — chat requests will fail until you add it to .env');
});
