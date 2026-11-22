const CATEGORIES = [
  ['', 'All'],
  ['beginner_tips', 'Getting started', 'other'],
  ['money', 'Money', 'money'],
  ['cheats', 'Cheats', 'secrets'],
  ['characters_controls_settings', 'Characters & settings', 'setup'],
  ['vehicles', 'Vehicles', 'vehicles'],
  ['weapons', 'Weapons', 'other'],
  ['collectibles', 'Collectibles', 'secrets'],
  ['map_secrets_easter_eggs', 'Map & secrets', 'secrets'],
  ['missions_story', 'Missions', 'missions'],
  ['online', 'Online', 'other'],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function words(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

function edit1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || a.length < 5) return false;
  let i = 0;
  let j = 0;
  let used = false;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (used) return false;
    used = true;
    if (a.length === b.length) { i++; j++; }
    else if (a.length > b.length) i++;
    else j++;
  }
  return true;
}

function hit(word, text) {
  const lower = text.toLowerCase();
  if (lower.includes(word)) return true;
  return words(lower).some((part) => edit1(word, part));
}

export function searchTips(tips, query) {
  const parts = words(query);
  if (!parts.length) return tips.map((tip) => ({ tip, score: 1 }));
  const found = [];
  for (const tip of tips) {
    const question = tip.question || '';
    const tags = (tip.tags || []).join(' ');
    const answer = tip.answer || '';
    let score = 0;
    let ok = true;
    for (const part of parts) {
      if (hit(part, question)) score += 5;
      else if (hit(part, tags)) score += 3;
      else if (hit(part, answer)) score += 1;
      else { ok = false; break; }
    }
    if (ok && score > 0) found.push({ tip, score });
  }
  found.sort((a, b) => b.score - a.score || a.tip.question.localeCompare(b.tip.question));
  return found;
}

function labelFor(id) {
  return CATEGORIES.find((row) => row[0] === id)?.[1] || 'All';
}

function topicFor(id) {
  return CATEGORIES.find((row) => row[0] === id)?.[2] || 'other';
}

export function mountGuide({ onAdd } = {}) {
  const root = document.getElementById('guide');
  const chips = document.getElementById('guideChips');
  const cards = document.getElementById('guideCards');
  const add = document.getElementById('guideAdd');
  const formHost = document.getElementById('guideAddForm');
  const search = document.getElementById('guideSearch');
  let tips = [];
  let category = '';
  let openId = '';
  let query = '';

  function parseHash() {
    const raw = location.hash.replace(/^#/, '');
    const [view, cat, id] = raw.split('/');
    if (view !== 'guide') return null;
    return { cat: decodeURIComponent(cat || ''), id: decodeURIComponent(id || '') };
  }

  function drawChips() {
    const counts = {};
    for (const tip of tips) counts[tip.category] = (counts[tip.category] || 0) + 1;
    chips.innerHTML = '';
    for (const [id, label] of CATEGORIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chip${id === category && !query ? ' on' : ''}`;
      const n = id ? (counts[id] || 0) : tips.length;
      button.textContent = `${label} ${n}`;
      button.addEventListener('click', () => {
        query = '';
        search.value = '';
        formHost.hidden = true;
        location.hash = id ? `#guide/${id}` : '#guide';
      });
      chips.append(button);
    }
  }

  function card(tip) {
    const el = document.createElement('article');
    el.className = 'card guide-card';
    el.id = `guide-${tip.id}`;
    const open = tip.id === openId;
    const sources = (tip.sources || []).map((url) => {
      let name = url;
      try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep url */ }
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`;
    }).join('');
    el.innerHTML = `
      <button type="button" class="guide-q" aria-expanded="${open}">
        <h2>${esc(tip.question)}</h2>
        <span class="badge-${tip.confidence === 'confirmed' ? 'trusted' : 'unverified'}">${tip.confidence === 'confirmed' ? 'Confirmed' : 'Single source'}</span>
      </button>
      <div class="guide-body"${open ? '' : ' hidden'}>
        <p>${esc(tip.answer)}</p>
        <p class="guide-sources"><span>Sources</span> ${sources}</p>
      </div>`;
    el.querySelector('.guide-q').addEventListener('click', () => {
      const nextId = openId === tip.id ? '' : tip.id;
      const base = category || tip.category;
      location.hash = nextId ? `#guide/${base}/${nextId}` : (category ? `#guide/${category}` : '#guide');
    });
    return el;
  }

  function draw() {
    drawChips();
    const pool = category ? tips.filter((tip) => tip.category === category) : tips;
    const shown = query ? searchTips(pool.length && category ? pool : tips, query).map((row) => row.tip) : pool;
    cards.innerHTML = '';
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nothing in the guide matches that.';
      cards.append(empty);
    } else {
      for (const tip of shown) cards.append(card(tip));
    }
    const named = category && labelFor(category) !== 'All';
    add.hidden = !named;
    if (named) {
      add.innerHTML = `Know something we don't? <button type="button">Add a tip</button> about ${esc(labelFor(category))}.`;
      add.querySelector('button').addEventListener('click', () => {
        formHost.hidden = false;
        onAdd?.({
          category,
          topic: topicFor(category),
          label: labelFor(category),
          host: formHost,
        });
        formHost.scrollIntoView({ block: 'nearest' });
      });
    } else {
      formHost.hidden = true;
    }
    const opened = openId && document.getElementById(`guide-${openId}`);
    if (opened) opened.scrollIntoView({ block: 'nearest' });
  }

  search.addEventListener('input', () => {
    query = search.value.trim();
    openId = '';
    draw();
  });
  document.getElementById('guideSearchForm').addEventListener('submit', (e) => e.preventDefault());

  return {
    async load() {
      const res = await fetch('/api/guide');
      const data = await res.json();
      tips = data.tips || [];
      const parsed = parseHash();
      if (parsed) {
        category = CATEGORIES.some((row) => row[0] === parsed.cat) ? parsed.cat : '';
        openId = parsed.id || '';
      }
      draw();
    },
    showFromHash() {
      const parsed = parseHash();
      if (!parsed) return false;
      category = CATEGORIES.some((row) => row[0] === parsed.cat) ? parsed.cat : '';
      openId = parsed.id || '';
      root.hidden = false;
      draw();
      return true;
    },
    hide() { root.hidden = true; },
  };
}
