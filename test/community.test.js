import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/community.js';
import { checkTip, contextMessage, factChunks, matchFacts } from '../lib/text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEET = readFileSync(path.join(ROOT, 'knowledge', 'gta-vi-faq.md'), 'utf8');
const CHUNKS = factChunks(SHEET);
const TIP = 'Duck into an alley and stay out of sight until the wanted stars blink off.';

function store(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'leonida-'));
  const file = path.join(dir, 'community.db');
  const db = createStore(file, {
    factChunks: CHUNKS,
    dailyCap: 10,
    tipLimit: 20,
    questionLimit: 20,
    ...extra,
  });
  db.file = file;
  return db;
}

test('fact sheet coverage stays narrow', () => {
  assert.equal(matchFacts('When did GTA VI come out?', CHUNKS).covered, true);
  assert.equal(matchFacts('Who are Jason and Lucia?', CHUNKS).covered, true);
  assert.equal(matchFacts('Is the PC date confirmed?', CHUNKS).covered, true);
  assert.equal(matchFacts('How much does the Ultimate Edition cost?', CHUNKS).covered, true);
  assert.equal(matchFacts('How do I lose a five star wanted level?', CHUNKS).covered, false);
  assert.equal(matchFacts('What is a fast way to make money early?', CHUNKS).covered, false);
});

test('rules block links, slurs, and thin tips', () => {
  assert.equal(checkTip('How do I lose the cops?', TIP, 'ViceKid').ok, true);
  assert.equal(checkTip('How do I lose the cops?', 'visit https://spam.example/free and click', '').ok, false);
  assert.equal(checkTip('How do I lose the cops?', 'This fucking alley trick is the one that works every time', '').ok, false);
  assert.equal(checkTip('How do I lose the cops?', 'too short', '').ok, false);
  assert.equal(checkTip('How do I lose the cops?', TIP, 'drop table;').ok, false);
});

test('votes trust, dedupe, and hide without storing raw IPs', async () => {
  const db = store();
  const ip = '203.0.113.50';
  const maker = randomUUID();
  const tip = await db.submit({
    question: 'How do I lose the cops?', body: TIP, topic: 'heat', nickname: 'ViceKid', clientId: maker, ip,
  });
  assert.equal(tip.status, 'unverified');
  const raw = readFileSync(db.file);
  assert.equal(raw.includes(ip), false);

  const voters = [randomUUID(), randomUUID(), randomUUID()];
  let current = tip;
  for (const clientId of voters) current = db.vote({ id: tip.id, clientId, ip: `203.0.113.${voters.indexOf(clientId) + 10}`, kind: 'up' });
  assert.equal(current.status, 'trusted');
  assert.equal(current.upvotes, 3);
  const toggled = db.vote({ id: tip.id, clientId: voters[0], ip: '203.0.113.10', kind: 'up' });
  assert.equal(toggled.upvotes, 2);
  assert.equal(toggled.status, 'unverified');
  db.vote({ id: tip.id, clientId: voters[0], ip: '203.0.113.10', kind: 'up' });

  const flagged = store();
  const other = await flagged.submit({
    question: 'Where is a quiet garage?', body: 'The garage behind the marina lets you store a car once you own it.', topic: 'vehicles', nickname: '', clientId: randomUUID(), ip,
  });
  for (let i = 0; i < 3; i++) flagged.vote({ id: other.id, clientId: randomUUID(), ip: `198.51.100.${i + 2}`, kind: 'flag' });
  assert.equal(flagged.list({}).some((row) => row.id === other.id), false);

  const found = db.retrieve('How do I lose the cops after a chase?');
  assert.equal(found.tips.length, 1);
  assert.equal(found.tips[0].nickname, 'ViceKid');
  assert.equal(found.unknown, false);
  const note = db.contextMessage(found);
  assert.match(note.content, /tip from the community \(ViceKid\)/);
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(note.content), false);
  const bare = db.contextMessage(db.retrieve('When did GTA VI come out?'));
  assert.equal(bare, null);

  const calls = { n: 0 };
  const moderated = store({
    moderate: async () => { calls.n++; return 'reject'; },
  });
  const bad = 'Buy coins now this is a spam tip and not a real gameplay note.';
  await assert.rejects(() => moderated.submit({
    question: 'How do I get rich quick?', body: bad, topic: 'money', nickname: 'Spam', clientId: randomUUID(), ip, 
  }), /automatic check/);
  await assert.rejects(() => moderated.submit({
    question: 'How do I get rich quick?', body: bad, topic: 'money', nickname: 'Spam', clientId: randomUUID(), ip: '203.0.113.77',
  }), /automatic check/);
  assert.equal(calls.n, 1);

  const capped = store({ dailyCap: 1 });
  assert.equal(capped.trySpend(), true);
  assert.equal(capped.trySpend(), false);
  db.close();
  flagged.close();
  moderated.close();
  capped.close();
});

test('chat keeps the system prompt stable and falls back when the cap is hit', async () => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    if (body.stream === false) {
      const tip = body.messages?.at(-1)?.content || '';
      const word = /spam tip/i.test(tip) ? 'REJECT' : 'ALLOW';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: word } }] }));
      return;
    }
    const note = body.messages.find((m, i) => i > 0 && m.role === 'system')?.content || '';
    const text = note.includes('ViceKid')
      ? 'Stay out of sight until the stars drop. tip from the community (ViceKid).'
      : note.includes('[[ADD_ONE]]')
        ? 'We do not have that yet.\n[[ADD_ONE]]'
        : 'GTA VI came out on 19 November 2026.';
    const payload = JSON.stringify({ choices: [{ delta: { content: text } }] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Cache-Hit': 'true' });
    res.end(`data: ${payload}\n\ndata: [DONE]\n\n`);
  });
  const mockPort = await new Promise((resolve) => mock.listen(0, '127.0.0.1', () => resolve(mock.address().port)));
  const appPort = 26000 + (process.pid % 8000);
  const dbPath = path.join(os.tmpdir(), `leonida-http-${process.pid}.db`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      BETTERPROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      BETTERPROXY_API_KEY: 'test-not-a-real-key',
      BETTERPROXY_MODEL: 'gpt-5.4',
      COMMUNITY_DB: dbPath,
      CACHE_LOG_FILE: path.join(os.tmpdir(), `leonida-cache-${process.pid}.jsonl`),
      DAILY_REQUEST_CAP: '5',
      MODERATION_LLM: '1',
      QUESTION_LIMIT: '30',
      TIP_LIMIT: '10',
      MONITOR_TOKEN: '',
    },
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  try {
    let health;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
        if (res.ok) { health = await res.json(); break; }
      } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(health, logs);
    assert.equal(health.model, 'gpt-5.4');

    const chat = async (content) => {
      const res = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: randomUUID(), messages: [{ role: 'user', content }] }),
      });
      const raw = await res.text();
      const events = raw.split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
      return events;
    };

    const known = await chat('When did GTA VI come out?');
    const unknown = await chat('How do I lose a five star wanted level?');
    assert.equal(seen[0].messages.length, 2);
    assert.equal(seen[0].messages[0].role, 'system');
    assert.equal(seen[1].messages[0].content, seen[0].messages[0].content);
    assert.equal(seen[1].messages[1].role, 'system');
    assert.match(seen[1].messages[1].content, /\[\[ADD_ONE\]\]/);
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(seen[0].messages[0].content), false);
    assert.equal(known.at(-1).unknown, false);
    assert.equal(unknown.at(-1).unknown, true);
    assert.equal(known.at(-1).cacheHit, true);

    const clientId = randomUUID();
    const addedRes = await fetch(`http://127.0.0.1:${appPort}/api/community/tips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ question: 'How do I lose the cops?', body: TIP, topic: 'heat', nickname: 'ViceKid', clientId }),
    });
    const addedBody = await addedRes.json();
    assert.equal(addedRes.status, 201, JSON.stringify(addedBody));
    const spam = {
      question: 'How do I get rich quick?',
      body: 'Buy coins now this is a spam tip and not a real gameplay note.',
      topic: 'money', nickname: 'Nope',
    };
    const rejected = await fetch(`http://127.0.0.1:${appPort}/api/community/tips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
      body: JSON.stringify({ ...spam, clientId: randomUUID() }),
    });
    assert.equal(rejected.status, 400);
    const rejectedAgain = await fetch(`http://127.0.0.1:${appPort}/api/community/tips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ ...spam, clientId: randomUUID() }),
    });
    assert.equal(rejectedAgain.status, 400);
    assert.equal(seen.filter((body) => body.stream === false).length, 2);

    for (let i = 0; i < 3; i++) {
      const vote = await fetch(`http://127.0.0.1:${appPort}/api/community/tips/${addedBody.tip.id}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 2}` },
        body: JSON.stringify({ clientId: randomUUID(), kind: 'up' }),
      });
      assert.equal(vote.status, 200);
    }
    const withTip = await chat('How do I lose the cops after a chase?');
    const tipCall = seen.find((body) => body.stream !== false && body.messages.some((m) => m.content?.includes('ViceKid')));
    assert.ok(tipCall);
    assert.equal(tipCall.messages[0].content, seen[0].messages[0].content);
    assert.equal(tipCall.model, 'gpt-5.4');
    assert.equal(withTip.at(-1).tips[0].nickname, 'ViceKid');
    const beforeCap = seen.length;
    const rested = await chat('How do I lose the cops after a chase?');
    assert.equal(seen.length, beforeCap);
    assert.equal(rested.at(-1).capped, true);
    assert.match(rested.find((e) => e.type === 'delta').text, /tip from the community \(ViceKid\)/);
    const page = await (await fetch(`http://127.0.0.1:${appPort}/playbook`)).text();
    assert.match(page, /Powered by <strong>BetterProxy<\/strong>/);
    assert.match(page, /Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive/);
    assert.match(page, /Players helping players/);
  } finally {
    child.kill('SIGTERM');
    mock.close();
  }
});
