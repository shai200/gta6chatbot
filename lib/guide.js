// Published guide tips. Loaded once from knowledge/gta-vi-tips.json.
// Retrieval is keyword scoring over the question, tags, and answer.

import { rankDocuments, tokens } from './text.js';

export const GUIDE_CATEGORIES = [
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

const OUTLETS = {
  'polygon.com': 'Polygon',
  'gamespot.com': 'GameSpot',
  'gamesradar.com': 'GamesRadar',
  'theguardian.com': 'The Guardian',
  'pcgamer.com': 'PC Gamer',
  'movieweb.com': 'MovieWeb',
  'redbull.com': 'Red Bull',
  'powerpyx.com': 'PowerPyx',
  'gta.tech4gamers.com': 'Tech4Gamers',
  'gtapoint.com': 'GTA Point',
  'gtabase.com': 'GTABase',
  'shacknews.com': 'Shacknews',
  'gamerant.com': 'GameRant',
  'leonipedia.com': 'Leonipedia',
  'rockstargames.com': 'Rockstar',
  'pushsquare.com': 'Push Square',
  'independent.co.uk': 'The Independent',
};

export function outletName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (OUTLETS[host]) return OUTLETS[host];
    const label = host.split('.')[0];
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'a guide';
  } catch {
    return 'a guide';
  }
}

export function outletNames(sources) {
  return [...new Set((sources || []).map(outletName))];
}

/** Top guide tips for a question. Empty when nothing shares a real term. */
export function matchGuide(query, tips, limit = 5) {
  const wanted = new Set(tokens(query));
  if (!wanted.size) return [];
  const docs = tips.map((tip) => ({
    ...tip,
    text: `${tip.question}\n${tip.question}\n${(tip.tags || []).join(' ')}\n${tip.answer}`,
  }));
  const ranked = rankDocuments(query, docs);
  const kept = [];
  for (const row of ranked) {
    const focus = tokens(`${row.question} ${(row.tags || []).join(' ')}`);
    const hits = focus.filter((token) => wanted.has(token));
    const strong = hits.length >= 2 || hits.some((token) => token.length >= 5);
    if (!strong || row.score <= 0) continue;
    kept.push(row);
    if (kept.length >= limit) break;
  }
  return kept.map(({ text, score, hits, df, ...tip }) => tip);
}

export function guideLines(tips) {
  if (!tips?.length) return [];
  const lines = [
    'Guide tips from published walkthroughs. The fact sheet wins wherever a guide tip disagrees with it, including rumours. When you use a guide tip, cite the outlet name (not the URL) in the answer. Do not add steps the tip does not state.',
  ];
  for (const tip of tips) {
    const names = outletNames(tip.sources);
    lines.push(`- (${tip.id}) ${tip.question} ${tip.answer} Sources: ${names.join(', ') || 'a guide'}.`);
  }
  return lines;
}

export function guideRefs(tips) {
  return (tips || []).map((tip) => ({ id: tip.id, category: tip.category, question: tip.question }));
}
