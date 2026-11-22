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
  let answer = '', failed = null, pending = false, fromCache = false;
  let settled = false;
  const paint = () => {
    pending = false;
    if (settled) return;
    const stick = nearBottom();
    bubble.innerHTML = markdown(answer);
    bubble.classList.add('cursor');
    if (stick) toBottom();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
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
        } else if (evt.type === 'done') fromCache = evt.cacheHit === true;
        else if (evt.type === 'error') failed = evt.message;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') failed = e.message || 'Connection lost';
  }

  settled = true;
  bubble.classList.remove('cursor');
  if (answer) {
    bubble.innerHTML = markdown(answer);
    if (fromCache) {
      const tag = document.createElement('div');
      tag.className = 'instant';
      tag.title = 'Served from the BetterProxy cache';
      tag.innerHTML = '<span aria-hidden="true">⚡</span> instant';
      bubble.append(tag);
    }
    history.push({ role: 'assistant', content: answer });
  } else {
    bubble.parentElement.remove();
    if (!failed) history.pop(); // stopped before anything arrived
  }
  if (failed) {
    if (!answer) history.pop();
    addMsg('bot error', `<p><strong>Signal dropped.</strong> ${esc(failed)}</p>`);
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

refreshSend();
