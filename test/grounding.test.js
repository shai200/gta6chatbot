import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACT_SHEET = await readFile(path.join(ROOT, 'knowledge', 'gta-vi-faq.md'), 'utf8');

let mock;
let child;
let logs = '';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function sse(content, headers) {
  const payload = JSON.stringify({ choices: [{ delta: { content } }] });
  return {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
    body: `data: ${payload}\n\ndata: [DONE]\n\n`,
  };
}

async function chat(port, content) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  const raw = await res.text();
  const events = raw.split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
  return { status: res.status, events };
}

test('fact sheet is sent unchanged, and only a cache header marks a hit', async () => {
  const seen = [];
  mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const n = seen.length;
    let reply;
    if (n === 1) reply = sse('Out 19 November 2026 on PS5 and Xbox Series X|S.', { 'X-Cache-Hit': 'true', 'X-Cache-Status': 'HIT' });
    else if (n === 2) reply = sse('Same answer, but this one was not served from cache.');
    else reply = sse('Header status only.', { 'X-Cache-Status': 'HIT' });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });
  const mockPort = await listen(mock);
  const appPort = 25000 + (process.pid % 10000);

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      BETTERPROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      BETTERPROXY_API_KEY: 'test-not-a-real-key',
      BETTERPROXY_MODEL: 'gpt-5.4',
      CACHE_LOG_FILE: path.join(os.tmpdir(), `leonida-test-${process.pid}.jsonl`),
      COMMUNITY_DB: path.join(os.tmpdir(), `leonida-community-${process.pid}.db`),
      MODERATION_LLM: '0',
      DAILY_REQUEST_CAP: '50',
      MONITOR_TOKEN: '',
    },
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  let health;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      if (res.ok) { health = await res.json(); break; }
    } catch { /* server still binding */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(health, `server did not start\n${logs}`);
  assert.equal(health.model, 'gpt-5.4');
  assert.match(logs, /knowledge\/gta-vi-faq\.md/);

  const hit = await chat(appPort, 'When did GTA VI come out?');
  const miss = await chat(appPort, 'When did GTA VI come out?');
  const statusOnly = await chat(appPort, 'Is the PC date confirmed?');

  assert.equal(seen.length, 3);
  for (const body of seen) {
    assert.equal(body.model, 'gpt-5.4');
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, seen[0].messages[0].content);
  }

  const prompt = seen[0].messages[0].content;
  assert.equal(prompt.includes(FACT_SHEET.trim()), true);
  assert.match(prompt, /19 November 2026/);
  assert.match(prompt, /RUMOUR/);
  assert.match(prompt, /first-quarter-2027/);
  assert.match(prompt, /Never state a rumour as fact/);
  assert.match(prompt, /spoiler-safe/);
  assert.match(prompt, /Unknown or not announced/);
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(prompt), false);
  assert.equal(prompt.includes('When did GTA VI come out?'), false);

  assert.deepEqual(hit.events.map((e) => e.type), ['delta', 'done']);
  assert.equal(hit.events[1].cacheHit, true);
  assert.equal(miss.events[1].cacheHit, false);
  assert.equal(statusOnly.events[1].cacheHit, true);

  const html = await (await fetch(`http://127.0.0.1:${appPort}/`)).text();
  assert.match(html, /https:\/\/betterproxy\.ai/g);
  assert.match(html, /Powered by <strong>BetterProxy<\/strong>/);
  assert.match(html, /Built with <a href="https:\/\/betterproxy\.ai" target="_blank" rel="noopener noreferrer">BetterProxy<\/a>/);
  assert.match(html, /Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive/);

  const client = await readFile(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(client, /evt\.cacheHit === true/);
  assert.match(client, /className = 'instant'/);
});

after(() => {
  child?.kill('SIGTERM');
  mock?.close();
});
