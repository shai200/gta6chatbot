import { mountGuide } from './guide.js';

const $ = (id) => document.getElementById(id);
const chat = $('chat'), thread = $('thread'), hero = $('hero'), input = $('input');
const sendBtn = $('send'), side = $('side'), scrim = $('scrim'), statusEl = document.querySelector('.status');

const STARTERS = [
  ['Release', 'When did GTA VI come out, and which consoles is it on?'],
  ['Story', 'Who are Jason and Lucia? Keep it spoiler-free.'],
  ['Editions', 'What is the difference between the Standard and Ultimate editions?'],
  ['PC & online', 'Is there a PC version, and is there a multiplayer mode?'],
];
const TOPICS = {
  'Release': ['When did GTA VI release?', 'Is it on PS4 or Xbox One?', 'Is there a PC version?', 'Can I play it through Xbox Game Pass?'],
  'Story': ['Who are Jason and Lucia?', 'Give me a spoiler-free overview of the story setup.', 'Do I need to have played the earlier GTA games?'],
  'Editions': ['How much does GTA VI cost in the US?', 'What is in the Ultimate Edition?', 'What did pre-orders include?'],
  'On the console': ['What frame rate does it run at?', 'Which console runs it best?', 'How much storage should I reserve?'],
  'Music': ['Who did the score?', 'What radio stations are in the game?'],
};

let history = [];       // {role, content}
let controller = null;  // AbortController while streaming

// ── tiny safe markdown renderer ──
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em style="font-style:italic">$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function markdown(src) {
  const out = []; let list = null, para = [], code = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split('\n')) {
    if (code !== null) {
      if (raw.trim().startsWith('```')) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    let m;
    if (line.trim().startsWith('```')) { flushPara(); flushList(); code = []; }
    else if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length < 3 ? 3 : 4}>${inline(m[2])}</h${m[1].length < 3 ? 3 : 4}>`); }
    else if ((m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const kind = m[1] ? 'ol' : 'ul';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[2])}</li>`);
    }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushPara(); flushList();
  return out.join('');
}

// ── UI helpers ──
const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
const toBottom = () => { chat.scrollTop = chat.scrollHeight; };

function addMsg(role, html) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role !== 'user') {
    const av = document.createElement('div');
    av.className = 'avatar'; av.textContent = 'LI';
    el.append(av);
  }
  if (role === 'user') bubble.textContent = html; else bubble.innerHTML = html;
  el.append(bubble);
  thread.append(el);
  toBottom();
  return bubble;
}

function setStreaming(on) {
  sendBtn.classList.toggle('streaming', on);
  sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  statusEl.classList.toggle('busy', on);
  $('statusText').textContent = on ? 'Pulling intel…' : 'On the line';
  refreshSend();
}
const refreshSend = () => { sendBtn.disabled = !controller && !input.value.trim(); };

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

function closeSide() { side.classList.remove('open'); scrim.classList.remove('open'); }

// ── chat ──
async function ask(text) {
  text = text.trim();
  if (!text || controller) return;
  closeSide();
  hero.classList.add('hidden');
  input.value = ''; autosize();

  history.push({ role: 'user', content: text });
  addMsg('user', text);
  const bubble = addMsg('bot', '<span class="stars" aria-label="Thinking"><i>★</i><i>★</i><i>★</i><i>★</i><i>★</i></span>');

  controller = new AbortController();
  setStreaming(true);
  let answer = '', failed = null, pending = false, fromCache = false, friendly = false;
  let replyUnknown = false, replyTips = [], replyGuide = [];
  let settled = false;
  const paint = () => {
    pending = false;
    if (settled) return;
    const stick = nearBottom();
    bubble.innerHTML = markdown(stripMarker(answer) || '…');
    bubble.classList.add('cursor');
    if (stick) toBottom();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, clientId: clientId() }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!frame.startsWith('data:')) continue;
        const evt = JSON.parse(frame.slice(5));
        if (evt.type === 'delta') {
          answer += evt.text;
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (evt.type === 'done') {
          fromCache = evt.cacheHit === true;
          replyUnknown = evt.unknown === true;
          replyTips = Array.isArray(evt.tips) ? evt.tips : [];
          replyGuide = Array.isArray(evt.guide) ? evt.guide : [];
        } else if (evt.type === 'error') {
          failed = evt.message;
          friendly = evt.friendly === true;
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') failed = e.message || 'Connection lost';
  }

  settled = true;
  bubble.classList.remove('cursor');
  const shown = stripMarker(answer);
  const unknown = replyUnknown || answer.includes('[[ADD_ONE]]');
  if (shown || unknown) {
    const textOut = shown || "We don't have this one yet. If you've seen it in Leonida, add it for the next player.";
    bubble.innerHTML = markdown(textOut);
    if (fromCache) {
      const tag = document.createElement('div');
      tag.className = 'instant';
      tag.title = 'Served from the BetterProxy cache';
      tag.innerHTML = '<span aria-hidden="true">⚡</span> instant';
      bubble.append(tag);
    }
    if (replyTips.length) {
      const credit = document.createElement('div');
      credit.className = 'tip-credits';
      credit.innerHTML = replyTips.map((tip) => `<span>tip from the community (${esc(tip.nickname || 'a player')})</span>`).join('');
      bubble.append(credit);
    }
    if (replyGuide.length) {
      const related = document.createElement('div');
      related.className = 'related';
      related.innerHTML = `<span>Related in Guide</span>${replyGuide.map((tip) => `<a href="#guide/${encodeURIComponent(tip.category)}/${encodeURIComponent(tip.id)}">${esc(tip.question)}</a>`).join('')}`;
      bubble.append(related);
    }
    history.push({ role: 'assistant', content: textOut });
    const follow = document.createElement('div');
    follow.className = 'msg-follow';
    follow.append(unknown ? tipForm(text, 'unknown') : suggestButton(text));
    bubble.parentElement.append(follow);
  } else {
    bubble.parentElement.remove();
    if (!failed) history.pop(); // stopped before anything arrived
  }
  if (failed) {
    if (!answer) history.pop();
    addMsg('bot error', friendly ? `<p>${esc(failed)}</p>` : `<p><strong>Signal dropped.</strong> ${esc(failed)}</p>`);
  }
  controller = null;
  setStreaming(false);
  if (matchMedia('(pointer: fine)').matches) input.focus();
}

// ── wiring ──
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) controller.abort(); else ask(input.value);
});
input.addEventListener('input', () => { autosize(); refreshSend(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    if (!controller) ask(input.value);
  }
});

$('newChat').addEventListener('click', () => {
  if (controller) controller.abort();
  history = []; thread.innerHTML = ''; hero.classList.remove('hidden'); closeSide(); input.focus();
});
$('menuBtn').addEventListener('click', () => { side.classList.add('open'); scrim.classList.add('open'); });
scrim.addEventListener('click', closeSide);

for (const [tag, q] of STARTERS) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'starter';
  b.innerHTML = `<b>${esc(tag)}</b><span>${esc(q)}</span>`;
  b.addEventListener('click', () => ask(q));
  $('starters').append(b);
}
for (const [group, qs] of Object.entries(TOPICS)) {
  const g = document.createElement('div');
  g.className = 'topic-group';
  g.innerHTML = `<h3>${esc(group)}</h3>`;
  for (const q of qs) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = q;
    b.addEventListener('click', () => ask(q));
    g.append(b);
  }
  $('topics').append(g);
}

fetch('/api/health').then((r) => r.json()).then((h) => {
  if (!h.configured) { statusEl.classList.add('down'); $('statusText').textContent = 'API key missing'; }
}).catch(() => {});

const TOPIC_OPTIONS = [
  ['missions', 'Missions'],
  ['money', 'Money'],
  ['vehicles', 'Vehicles'],
  ['heat', 'Heat / wanted'],
  ['secrets', 'Secrets'],
  ['setup', 'Setup'],
  ['other', 'Other'],
];

function clientId() {
  const key = 'leonida-client';
  let id = localStorage.getItem(key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function stripMarker(s) {
  return String(s || '').replace(/\[\[ADD_ONE\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function tipForm(question, mode, topicOverride) {
  const box = document.createElement('form');
  box.className = 'tip-form';
  box.innerHTML = `
    <p class="tip-form-title">${mode === 'unknown' ? "We don't know yet. Add one." : 'Suggest a tip or a correction.'}</p>
    <p class="tip-form-note">${mode === 'unknown' ? 'Seen it in Leonida? Leave it for the next player. No sign-up.' : 'Players helping players. No sign-up.'}</p>
    <label>Your tip<textarea name="body" required minlength="30" maxlength="700" placeholder="What worked for you, in a sentence or two."></textarea></label>
    <div class="tip-form-row">
      <label>Nickname <span>(optional)</span><input name="nickname" maxlength="20" placeholder="ViceKid" autocomplete="off"></label>
      <label>Topic<select name="topic">${TOPIC_OPTIONS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="spoiler"> This has spoilers</label>
    <button type="submit">Add this tip</button>
    <p class="tip-form-error" hidden></p>`;
  const topics = TOPIC_OPTIONS.map(([id]) => id);
  box.elements.topic.value = topics.includes(topicOverride) ? topicOverride : guessTopic(question);
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = box.querySelector('.tip-form-error');
    const button = box.querySelector('button');
    err.hidden = true;
    button.disabled = true;
    try {
      const res = await fetch('/api/community/tips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          body: box.elements.body.value,
          nickname: box.elements.nickname.value,
          topic: box.elements.topic.value,
          spoiler: box.elements.spoiler.checked,
          clientId: clientId(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not add that');
      const done = document.createElement('p');
      done.className = 'tip-form-done';
      done.textContent = 'Added. It shows on the playbook as an unverified community tip until other players upvote it.';
      box.replaceWith(done);
      refreshStats();
    } catch (error) {
      err.hidden = false;
      err.textContent = error.message;
      button.disabled = false;
    }
  });
  return box;
}

function guessTopic(text) {
  const rules = [
    ['heat', /cop|police|wanted|heat|busted/i],
    ['money', /money|cash|earn|dollar/i],
    ['vehicles', /car|vehicle|bike|garage|drive/i],
    ['secrets', /secret|collectible|cheat|hidden/i],
    ['setup', /setting|fps|graphics|storage|install/i],
    ['missions', /mission|heist|story|quest/i],
  ];
  return rules.find(([, re]) => re.test(text))?.[0] || 'other';
}

function suggestButton(question) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'suggest';
  button.textContent = 'Suggest a tip';
  button.addEventListener('click', () => button.replaceWith(tipForm(question, 'suggest')));
  return button;
}

async function refreshStats() {
  try {
    const stats = await fetch('/api/community/stats').then((r) => r.json());
    const label = `${stats.shared} tip${stats.shared === 1 ? '' : 's'} shared`;
    $('tipCount').textContent = label;
    $('tipCountBar').textContent = label;
    $('contributors').innerHTML = (stats.contributors || []).map((c) => `<li>${esc(c.nickname)} · ${c.upvotes} upvotes</li>`).join('');
  } catch { /* the chat still works if stats are briefly unavailable */ }
}

refreshStats();
setInterval(refreshStats, 30000);
refreshSend();

const guideView = mountGuide({
  onAdd({ topic, label, host }) {
    host.innerHTML = '';
    host.append(tipForm(`What else should players know about ${label}?`, 'suggest', topic));
  },
});
guideView.load().catch(() => {});

function showView(name) {
  const guideOn = name === 'guide';
  document.getElementById('guide').hidden = !guideOn;
  document.getElementById('chat').hidden = guideOn;
  document.getElementById('composer').hidden = guideOn;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.classList.toggle('on', tab.dataset.tab === (guideOn ? 'guide' : 'chat'));
  }
  if (guideOn) guideView.showFromHash();
}

function syncHash() {
  if (location.hash.startsWith('#guide')) showView('guide');
  else showView('chat');
}
window.addEventListener('hashchange', syncHash);
syncHash();
