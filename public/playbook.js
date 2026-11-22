const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TOPICS = [
  ['', 'All'],
  ['missions', 'Missions'],
  ['money', 'Money'],
  ['vehicles', 'Vehicles'],
  ['heat', 'Heat'],
  ['secrets', 'Secrets'],
  ['setup', 'Setup'],
  ['other', 'Other'],
];

let topic = '';
let q = '';

function clientId() {
  const key = 'leonida-client';
  let id = localStorage.getItem(key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '')) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function card(tip) {
  const el = document.createElement('article');
  el.className = 'card';
  const hidden = tip.spoiler ? 'hidden' : '';
  el.innerHTML = `
    <div class="meta">
      <span class="badge-${tip.status === 'trusted' ? 'trusted' : 'unverified'}">${tip.status === 'trusted' ? 'Trusted' : 'Unverified community tip'}</span>
      <span>${esc(tip.topic)}</span>
      <span class="card-credit">tip from the community (${esc(tip.credit || 'a player')})</span>
    </div>
    <h2>${esc(tip.question)}</h2>
    <p class="body" ${hidden}>${esc(tip.body)}</p>
    ${tip.spoiler ? '<button type="button" class="reveal">Show spoiler</button>' : ''}
    <div class="card-actions">
      <button type="button" class="vote ${tip.myVote === 'up' ? 'on' : ''}">▲ ${tip.upvotes}</button>
      <button type="button" class="flag ${tip.myVote === 'flag' ? 'on' : ''}">Flag ${tip.flags}</button>
    </div>`;
  const reveal = el.querySelector('.reveal');
  if (reveal) {
    reveal.addEventListener('click', () => {
      el.querySelector('.body').hidden = false;
      reveal.remove();
    });
  }
  el.querySelector('.vote').addEventListener('click', () => cast(tip.id, 'up', el));
  el.querySelector('.flag').addEventListener('click', () => cast(tip.id, 'flag', el));
  return el;
}

async function cast(id, kind, el) {
  el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch(`/api/community/tips/${id}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientId(), kind }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Vote failed');
    if (data.tip.status === 'hidden') el.remove();
    else el.replaceWith(card(data.tip));
    loadStats();
  } catch (error) {
    el.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    alert(error.message);
  }
}

async function loadStats() {
  const stats = await fetch('/api/community/stats').then((r) => r.json());
  $('shared').textContent = stats.shared;
  $('trusted').textContent = stats.trusted;
  const names = stats.contributors || [];
  $('names').innerHTML = names.length
    ? names.map((c) => `<li>${esc(c.nickname)} · ${c.upvotes}</li>`).join('')
    : '<li>No named tips yet</li>';
}

async function loadTips() {
  const params = new URLSearchParams({ topic, q, clientId: clientId() });
  const data = await fetch(`/api/community/tips?${params}`).then((r) => r.json());
  const cards = $('cards');
  cards.innerHTML = '';
  if (!data.tips.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No tips in this lane yet. Ask in the chat, and if Leonida Intel does not know, add what you found.';
    cards.append(empty);
    return;
  }
  for (const tip of data.tips) cards.append(card(tip));
}

for (const [id, label] of TOPICS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `chip${id === topic ? ' on' : ''}`;
  button.textContent = label;
  button.addEventListener('click', () => {
    topic = id;
    for (const chip of $('chips').children) chip.classList.toggle('on', chip === button);
    loadTips();
  });
  $('chips').append(button);
}

let timer;
$('q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => { q = $('q').value.trim(); loadTips(); }, 150);
});
$('search').addEventListener('submit', (e) => { e.preventDefault(); q = $('q').value.trim(); loadTips(); });

loadStats();
loadTips();
