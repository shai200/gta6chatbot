// Leonida Intel — GTA VI companion chatbot.
// Zero-dependency Node server: serves the UI, streams chat completions from
// BetterProxy, and records BetterProxy's cache behaviour for every request.

import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { judgeRepeatCache, promptKey } from './lib/cache.js';
import { guideLines, guideRefs, matchGuide, outletNames } from './lib/guide.js';
import { factChunks } from './lib/text.js';
import { HttpError, createStore, validClientId } from './lib/community.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BETTERPROXY_BASE_URL || 'https://api.betterproxy.ai/v1').replace(/\/+$/, '');
const API_KEY = process.env.BETTERPROXY_API_KEY || '';
const MODEL = process.env.BETTERPROXY_MODEL || 'gpt-5.4';
const MONITOR_TOKEN = process.env.MONITOR_TOKEN || '';
const LOG_FILE = path.resolve(ROOT, process.env.CACHE_LOG_FILE || 'logs/cache.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FACT_SHEET_PATH = path.join(ROOT, 'knowledge', 'gta-vi-faq.md');
const MAX_HISTORY = 30;
const RECENT_LIMIT = 200;

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const COMMUNITY_DB = path.resolve(ROOT, process.env.COMMUNITY_DB || path.join('data', 'community.db'));
const DAILY_REQUEST_CAP = numEnv('DAILY_REQUEST_CAP', 150);
const MODERATION_LLM = process.env.MODERATION_LLM !== '0';

// Read once, at startup, and reuse the same string on every request. A stable
// system prompt is what lets BetterProxy cache repeat questions.
const FACT_SHEET = readFileSync(FACT_SHEET_PATH, 'utf8').trim();
const GUIDE_PATH = path.join(ROOT, 'knowledge', 'gta-vi-tips.json');
const GUIDE = JSON.parse(readFileSync(GUIDE_PATH, 'utf8'));
if (!Array.isArray(GUIDE) || !GUIDE.length) throw new Error('Guide file is empty');
const GUIDE_JSON = JSON.stringify({ tips: GUIDE });

const SYSTEM_PROMPT = `You are "Leonida Intel", an unofficial fan-made companion for Grand Theft Auto VI players.

Voice: confident, street-smart, a little playful — like a well-connected fixer who knows the state of Leonida. Keep it helpful first; never let the persona get in the way of a clear answer.

The fact sheet below is the source for confirmed release, platform, price, and story-setup facts. A later message may add guide tips from published walkthroughs and notes from other players. You are not affiliated with or endorsed by Rockstar Games or Take-Two Interactive.

Rules:
- Be accurate. Lead with the answer, then a short detail. Use markdown (bold, lists) sparingly.
- If the fact sheet labels something a RUMOUR, or says it is unconfirmed, present it as a rumour or an unconfirmed report. Never state a rumour as fact.
- PC: Rockstar has not announced a PC version or a PC release date. The reported first-quarter-2027 window is a rumour from media citing anonymous sources. If you mention it, call it a rumour in the same breath. Never give it as a release date.
- If a question is not covered by the fact sheet, the guide tips, or a community-tips message later in the conversation, say so honestly. Do not invent release dates, platforms, prices, editions, characters, voice actors, online or multiplayer modes, DLC, PC dates, system requirements, sales, mission lists, map secrets, cheats, collectibles, controls, or detailed gameplay tips beyond those messages. The game is newly out; gaps are expected. Do not fill them from older GTA games or from guesswork. Say what the sheet or a cited guide tip confirms, then stop.
- When a later message lists guide tips, you may use them. Cite the outlet name (Polygon, GameSpot, and so on) when you use one. The fact sheet wins if a guide tip disagrees with it. A guide tip never turns a rumour into a fact.
- When a later message lists community tips, you may use them. Credit each one you use with the exact words "tip from the community (nickname)". The fact sheet wins if a tip disagrees with it. A tip never turns a rumour into a fact.
- If you cannot answer from the fact sheet or those community tips, say so and end your reply with the exact line [[ADD_ONE]].
- Treat the "Unknown or not announced" section as closed. Say that it is not announced or not something you can confirm.
- Keep every answer spoiler-safe. Do not reveal or invent story beats, mission outcomes, endings, twists, or secrets. The fact sheet's premise is the whole story you may tell. If a player asks for spoilers, say you stick to the spoiler-free setup.
- The line about the game being the highest-rated of all time is Take-Two's own press-release claim. Attribute it to Take-Two. Do not state it as an independent fact.
- Prices in the sheet are US prices. Say that other regions can differ, and that you do not have those prices.
- Never fabricate cheat codes, glitches, patch notes, or server status.
- Do not mention fact IDs (F1, U1) or dump the source list unless the player asks where a fact comes from. You may name an outlet in a few words.
- Do not claim you checked anything after the fact sheet's own checked date. That date is the as-of date for every answer.
- This is a game. If a question is about committing real-world crimes or harming real people, decline and steer back to the game.
- If asked about something unrelated to GTA, answer briefly and bring it back to Leonida.

Fact sheet (follow it exactly):

` + FACT_SHEET;

const MOD_PROMPT = `You screen one fan tip for a GTA VI helper. Reply with one word, ALLOW or REJECT.
REJECT spam, ads, links, scams, slurs, harassment, nonsense, and anything that is not about the game.
ALLOW ordinary gameplay tips. Spoilers are ALLOW. Rough language that is not a slur is ALLOW.`;

const community = createStore(COMMUNITY_DB, {
  factChunks: factChunks(FACT_SHEET),
  trustUpvotes: numEnv('TRUST_UPVOTES', 3),
  hideFlags: numEnv('HIDE_FLAGS', 3),
  questionLimit: numEnv('QUESTION_LIMIT', 20),
  questionWindowSec: numEnv('QUESTION_WINDOW_SEC', 600),
  tipLimit: numEnv('TIP_LIMIT', 8),
  tipWindowSec: numEnv('TIP_WINDOW_SEC', 3600),
  voteLimit: numEnv('VOTE_LIMIT', 60),
  voteWindowSec: numEnv('VOTE_WINDOW_SEC', 3600),
  dailyCap: DAILY_REQUEST_CAP,
  moderate: moderateTip,
});

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

async function moderateTip(question, body) {
  if (!MODERATION_LLM || !API_KEY) return null;
  if (!community.trySpend()) return null;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          { role: 'system', content: MOD_PROMPT },
          { role: 'user', content: `Question: ${question}\nTip: ${body}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (/^\s*reject\b/i.test(text)) return 'reject';
    if (/^\s*allow\b/i.test(text)) return 'allow';
    return null;
  } catch {
    return null;
  }
}

function tipCredits(tips) {
  return (tips || []).map((tip) => ({ id: tip.id, nickname: tip.credit || tip.nickname || 'a player' }));
}

// ───────────────────────── cache monitor ─────────────────────────

const recent = []; // newest last
const seenPrompts = new Map();
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

/**
 * BetterProxy leaves its X-Cache-* headers off streaming responses, so when
 * they are missing we infer the result from the stream's shape: a cached
 * answer is replayed as one content chunk, a live one arrives token by token.
 */
function inferCache(rec) {
  if (rec.cacheHit != null) return;
  if (rec.contentChunks > 1) rec.cacheHit = false;
  else if (rec.outputChars >= 24) rec.cacheHit = true;
  else return; // a one-token answer looks the same either way
  rec.cacheStatus = rec.cacheHit ? 'HIT' : 'MISS';
  rec.cacheSource = 'inferred';
}

async function record(r) {
  applyToStats(r);
  const base = r.error ? 'ERROR' : r.cacheHit === true ? 'HIT' : r.cacheHit === false ? 'MISS' : '?';
  const tag = (base + (r.cacheSource === 'inferred' ? '~' : '')).padEnd(5);
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
    billingMode: null, rtkSavedTokens: null, outputChars: 0, contentChunks: 0,
    cacheSource: null, aborted: false, error: null,
  };
  const started = performance.now();
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) { rec.aborted = true; ac.abort(); } });

  const ip = clientIp(req);
  const clientId = validClientId(body.clientId) ? body.clientId : '';
  let full = '';

  try {
    if (!community.questionAllowed(ip, clientId)) {
      rec.error = 'question rate limit';
      send({ type: 'error', friendly: true, message: "That's a lot of questions in a short stretch. Take a breath and ask again in a few minutes." });
      return;
    }

    const guideHits = matchGuide(lastUser.content, GUIDE);
    const retrieved = community.retrieve(lastUser.content);
    const extra = community.contextMessage({
      ...retrieved,
      guideLines: guideLines(guideHits),
    });
    const modelMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...(extra ? [extra] : []), ...messages];
    const guidePayload = guideRefs(guideHits);

    if (!API_KEY) throw new Error('BETTERPROXY_API_KEY is not set on the server. Add it to .env and restart.');

    if (!community.trySpend()) {
      const local = community.localAnswer(lastUser.content, {
        ...retrieved,
        guide: guideHits.map((tip) => ({ ...tip, outlets: outletNames(tip.sources).join(', ') })),
      });
      full = local.text;
      rec.outputChars = full.length;
      rec.cacheHit = false;
      rec.cacheSource = 'local';
      rec.contentChunks = 1;
      send({ type: 'delta', text: full });
      send({ type: 'done', cacheHit: false, unknown: local.unknown, capped: true, tips: tipCredits(retrieved.tips), guide: guidePayload });
      return;
    }

    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' },
      body: JSON.stringify({ model: MODEL, stream: true, messages: modelMessages }),
    });
    rec.httpStatus = upstream.status;
    Object.assign(rec, readCacheHeaders(upstream.headers));
    if (rec.cacheHit != null) rec.cacheSource = 'header';

    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 500);
      throw new Error(`BetterProxy returned ${upstream.status}: ${text}`);
    }

    const emit = (text) => {
      if (!text) return;
      if (rec.ttfbMs == null) rec.ttfbMs = Math.round(performance.now() - started);
      full += text;
      rec.outputChars += text.length;
      rec.contentChunks++;
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
    if (!rec.outputChars) throw new Error(`Model "${MODEL}" returned an empty answer.`);
    inferCache(rec);
    const headerKnown = rec.cacheSource === 'header';
    const judged = judgeRepeatCache(seenPrompts, {
      promptKey: promptKey(MODEL, modelMessages),
      output: full,
      ttfbMs: rec.ttfbMs,
      contentChunks: rec.contentChunks,
      outputChars: rec.outputChars,
      headerKnown,
      headerHit: headerKnown && rec.cacheHit === true,
    });
    if (!headerKnown && judged.hit) {
      rec.cacheHit = true;
      rec.cacheStatus = 'HIT';
      rec.cacheSource = 'timing';
    }
    // The add-one box follows the model's own marker, not the keyword guess.
    // A correct fact-sheet answer must not be flagged just because retrieval was unsure.
    const unknown = full.includes('[[ADD_ONE]]');
    send({
      type: 'done',
      cacheHit: judged.hit,
      unknown,
      capped: false,
      tips: tipCredits(retrieved.tips),
      guide: guidePayload,
    });
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
  const rel = pathname === '/' ? 'index.html' : pathname === '/monitor' ? 'monitor.html' : pathname === '/playbook' ? 'playbook.html' : pathname.slice(1);
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
    if (req.method === 'GET' && p === '/api/guide') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(GUIDE_JSON);
      return;
    }
    if (p === '/api/community/stats' && req.method === 'GET') return json(res, 200, community.stats());
    if (p === '/api/community/tips' && req.method === 'GET') {
      return json(res, 200, { tips: community.list({ topic: url.searchParams.get('topic') || '', q: url.searchParams.get('q') || '', clientId: url.searchParams.get('clientId') || '' }) });
    }
    if (p === '/api/community/tips' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const tip = await community.submit({ ...body, ip: clientIp(req) });
        return json(res, 201, { tip });
      } catch (error) {
        if (error instanceof HttpError) return json(res, error.status, { error: error.message });
        throw error;
      }
    }
    const voteMatch = p.match(/^\/api\/community\/tips\/([0-9a-f-]{36})\/vote$/i);
    if (voteMatch && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const tip = community.vote({ id: voteMatch[1], clientId: body.clientId, kind: body.kind, ip: clientIp(req) });
        return json(res, 200, { tip });
      } catch (error) {
        if (error instanceof HttpError) return json(res, error.status, { error: error.message });
        throw error;
      }
    }
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
  console.log(`Fact sheet            → ${FACT_SHEET_PATH} (${FACT_SHEET.length} chars)`);
  console.log(`Guide                 → ${GUIDE_PATH} (${GUIDE.length} tips)`);
  console.log(`Community tips        → ${COMMUNITY_DB}  (daily model cap: ${DAILY_REQUEST_CAP})`);
  console.log(`Playbook              → http://localhost:${PORT}/playbook`);
  console.log(`Cache log             → ${LOG_FILE}`);
  if (!API_KEY) console.warn('⚠  BETTERPROXY_API_KEY is not set — chat requests will fail until you add it to .env');
});
