// Local community tips. SQLite via Node's built-in driver, so there is no
// database account and nothing to pay for. One file, created on first use.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  TOPICS, checkTip, contextMessage, creditName, guessTopic, localAnswer, matchFacts, matchTips, normalize,
} from './text.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validClientId(value) {
  return typeof value === 'string' && UUID.test(value);
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function statusFor(upvotes, flags, trustUpvotes, hideFlags) {
  if (flags >= hideFlags) return 'hidden';
  if (upvotes + flags >= 4 && flags > upvotes) return 'hidden';
  if (upvotes - flags >= trustUpvotes) return 'trusted';
  return 'unverified';
}

export function createStore(file, options = {}) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tips (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      body TEXT NOT NULL,
      norm TEXT NOT NULL,
      topic TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      spoiler INTEGER NOT NULL DEFAULT 0,
      client_id TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unverified',
      upvotes INTEGER NOT NULL DEFAULT 0,
      flags INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tips_status ON tips(status);
    CREATE INDEX IF NOT EXISTS tips_norm ON tips(norm);
    CREATE TABLE IF NOT EXISTS votes (
      tip_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (tip_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS moderation (hash TEXT PRIMARY KEY, verdict TEXT NOT NULL);
  `);

  let saltRow = db.prepare(`SELECT value FROM meta WHERE key = 'ip_salt'`).get();
  if (!saltRow) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('ip_salt', ?)`).run(randomBytes(16).toString('hex'));
    saltRow = db.prepare(`SELECT value FROM meta WHERE key = 'ip_salt'`).get();
  }
  const salt = saltRow.value;
  const hashIp = (ip) => createHash('sha256').update(`${salt}\n${ip || 'unknown'}`).digest('hex');
  const trustUpvotes = options.trustUpvotes ?? 3;
  const hideFlags = options.hideFlags ?? 3;
  const questionLimit = options.questionLimit ?? 20;
  const questionWindowMs = (options.questionWindowSec ?? 600) * 1000;
  const tipLimit = options.tipLimit ?? 8;
  const tipWindowMs = (options.tipWindowSec ?? 3600) * 1000;
  const voteLimit = options.voteLimit ?? 60;
  const voteWindowMs = (options.voteWindowSec ?? 3600) * 1000;
  const dailyCap = options.dailyCap ?? 150;
  const factSheetChunks = options.factChunks || [];

  function takeSlot(key, limit, windowMs) {
    const now = Date.now();
    const row = db.prepare(`SELECT window_start, count FROM limits WHERE key = ?`).get(key);
    if (!row || now - row.window_start >= windowMs) {
      db.prepare(`
        INSERT INTO limits (key, window_start, count) VALUES (?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1
      `).run(key, now);
      return true;
    }
    if (row.count >= limit) return false;
    db.prepare(`UPDATE limits SET count = count + 1 WHERE key = ?`).run(key);
    return true;
  }

  function allow(ip, clientId, action, limit, windowMs) {
    const ipOk = takeSlot(`ip:${action}:${hashIp(ip)}`, limit, windowMs);
    if (!ipOk) return false;
    if (!clientId) return true;
    const clientOk = takeSlot(`client:${action}:${clientId}`, limit, windowMs);
    if (!clientOk) return false;
    return true;
  }

  function publicTip(row, clientId) {
    const vote = clientId
      ? db.prepare(`SELECT kind FROM votes WHERE tip_id = ? AND client_id = ?`).get(row.id, clientId)
      : null;
    return {
      id: row.id,
      question: row.question,
      body: row.body,
      topic: row.topic,
      nickname: row.nickname,
      credit: creditName(row.nickname),
      spoiler: Boolean(row.spoiler),
      status: row.status,
      upvotes: row.upvotes,
      flags: row.flags,
      createdAt: row.created_at,
      myVote: vote?.kind || null,
    };
  }

  function refreshStatus(id) {
    const row = db.prepare(`SELECT upvotes, flags FROM tips WHERE id = ?`).get(id);
    if (!row) return null;
    const status = statusFor(row.upvotes, row.flags, trustUpvotes, hideFlags);
    db.prepare(`UPDATE tips SET status = ? WHERE id = ?`).run(status, id);
    return status;
  }

  return {
    hashIp,
    contextMessage,
    localAnswer,
    close() { db.close(); },

    questionAllowed(ip, clientId) {
      return allow(ip, validClientId(clientId) ? clientId : '', 'question', questionLimit, questionWindowMs);
    },

    trySpend() {
      if (dailyCap <= 0) return false;
      const day = dayKey();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare(`SELECT count FROM usage WHERE day = ?`).get(day);
        if (row && row.count >= dailyCap) {
          db.exec('ROLLBACK');
          return false;
        }
        if (!row) db.prepare(`INSERT INTO usage (day, count) VALUES (?, 1)`).run(day);
        else db.prepare(`UPDATE usage SET count = count + 1 WHERE day = ?`).run(day);
        db.exec('COMMIT');
        return true;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already closed */ }
        throw error;
      }
    },

    usage() {
      const row = db.prepare(`SELECT count FROM usage WHERE day = ?`).get(dayKey());
      return { day: dayKey(), count: row?.count || 0, cap: dailyCap };
    },

    retrieve(question) {
      const facts = matchFacts(question, factSheetChunks);
      const rows = db.prepare(`SELECT * FROM tips WHERE status = 'trusted'`).all();
      const tips = matchTips(question, rows.map((row) => publicTip(row)));
      return {
        facts: facts.hits,
        covered: facts.covered,
        tips,
        unknown: !facts.covered && tips.length === 0,
      };
    },

    async submit({ question, body, topic, nickname, spoiler, clientId, ip }) {
      if (!validClientId(clientId)) throw new HttpError(400, 'Missing a client id. Reload the page and try again.');
      const checked = checkTip(question, body, nickname);
      if (!checked.ok) throw new HttpError(400, checked.error);
      if (!allow(ip, clientId, 'tip', tipLimit, tipWindowMs)) {
        throw new HttpError(429, "That's plenty of tips for now. Give it a little while before adding another.");
      }
      const duplicate = db.prepare(`SELECT id FROM tips WHERE norm = ?`).get(checked.norm);
      if (duplicate) throw new HttpError(400, 'That tip is already in the playbook.');
      const chosen = TOPICS.includes(topic) ? topic : guessTopic(`${checked.question} ${checked.body}`);
      if (options.moderate) {
        const hash = createHash('sha256').update(checked.norm).digest('hex');
        const cached = db.prepare(`SELECT verdict FROM moderation WHERE hash = ?`).get(hash);
        let verdict = cached?.verdict || null;
        if (!verdict) {
          verdict = await options.moderate(checked.question, checked.body);
          if (verdict === 'allow' || verdict === 'reject') {
            db.prepare(`INSERT OR REPLACE INTO moderation (hash, verdict) VALUES (?, ?)`).run(hash, verdict);
          }
        }
        if (verdict === 'reject') throw new HttpError(400, "That one didn't pass the automatic check. Try a plain gameplay tip.");
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO tips (id, question, body, norm, topic, nickname, spoiler, client_id, ip_hash, status, upvotes, flags, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 0, 0, ?)
      `).run(
        id, checked.question, checked.body, checked.norm, chosen, checked.nickname,
        spoiler ? 1 : 0, clientId, hashIp(ip), new Date().toISOString(),
      );
      return publicTip(db.prepare(`SELECT * FROM tips WHERE id = ?`).get(id), clientId);
    },

    vote({ id, clientId, ip, kind }) {
      if (!validClientId(clientId)) throw new HttpError(400, 'Missing a client id. Reload the page and try again.');
      if (kind !== 'up' && kind !== 'flag') throw new HttpError(400, 'Vote with up or flag.');
      const tip = db.prepare(`SELECT * FROM tips WHERE id = ?`).get(id);
      if (!tip || tip.status === 'hidden') throw new HttpError(404, 'That tip is not on the board.');
      if (!allow(ip, clientId, 'vote', voteLimit, voteWindowMs)) {
        throw new HttpError(429, 'Too many votes in a short stretch. Try again shortly.');
      }
      const existing = db.prepare(`SELECT kind FROM votes WHERE tip_id = ? AND client_id = ?`).get(id, clientId);
      if (existing?.kind === kind) {
        db.prepare(`DELETE FROM votes WHERE tip_id = ? AND client_id = ?`).run(id, clientId);
        const column = kind === 'up' ? 'upvotes' : 'flags';
        db.prepare(`UPDATE tips SET ${column} = MAX(${column} - 1, 0) WHERE id = ?`).run(id);
      } else {
        if (existing) {
          const previous = existing.kind === 'up' ? 'upvotes' : 'flags';
          db.prepare(`UPDATE tips SET ${previous} = MAX(${previous} - 1, 0) WHERE id = ?`).run(id);
          db.prepare(`UPDATE votes SET kind = ? WHERE tip_id = ? AND client_id = ?`).run(kind, id, clientId);
        } else {
          db.prepare(`INSERT INTO votes (tip_id, client_id, kind) VALUES (?, ?, ?)`).run(id, clientId, kind);
        }
        const column = kind === 'up' ? 'upvotes' : 'flags';
        db.prepare(`UPDATE tips SET ${column} = ${column} + 1 WHERE id = ?`).run(id);
      }
      refreshStatus(id);
      const next = db.prepare(`SELECT * FROM tips WHERE id = ?`).get(id);
      return publicTip(next, clientId);
    },

    list({ topic = '', q = '', clientId = '' } = {}) {
      const wanted = TOPICS.includes(topic) ? topic : '';
      const needle = normalize(q);
      const rows = db.prepare(`
        SELECT * FROM tips WHERE status != 'hidden' AND (? = '' OR topic = ?)
        ORDER BY upvotes DESC, created_at DESC LIMIT 200
      `).all(wanted, wanted);
      const filtered = needle
        ? rows.filter((row) => normalize(`${row.question} ${row.body} ${row.nickname}`).includes(needle))
        : rows;
      return filtered.slice(0, 80).map((row) => publicTip(row, validClientId(clientId) ? clientId : ''));
    },

    stats() {
      const shared = db.prepare(`SELECT COUNT(*) AS n FROM tips WHERE status != 'hidden'`).get().n;
      const trusted = db.prepare(`SELECT COUNT(*) AS n FROM tips WHERE status = 'trusted'`).get().n;
      const contributors = db.prepare(`
        SELECT nickname, COUNT(*) AS tips, SUM(upvotes) AS upvotes
        FROM tips WHERE status != 'hidden' AND nickname != ''
        GROUP BY nickname
        ORDER BY upvotes DESC, tips DESC, nickname ASC
        LIMIT 5
      `).all();
      return { shared, trusted, contributors };
    },
  };
}

export { TOPICS, creditName, guessTopic, localAnswer, contextMessage };
