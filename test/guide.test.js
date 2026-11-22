import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { guideLines, matchGuide, outletNames } from '../lib/guide.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPS = JSON.parse(readFileSync(path.join(ROOT, 'knowledge', 'gta-vi-tips.json'), 'utf8'));

test('the guide file is the 139 published tips', () => {
  assert.equal(Array.isArray(TIPS), true);
  assert.equal(TIPS.length, 139);
  assert.equal(TIPS[0].id, 'tip-001');
  assert.equal(TIPS.some((tip) => tip.question === 'Is GTA 6 on PC?'), true);
});

test('retrieval ranks the cash tip and the PC tip, and names the outlet', () => {
  const cash = matchGuide('How do I stop losing my cash when I die?', TIPS);
  assert.equal(cash[0].id, 'tip-001');
  assert.ok(cash.length <= 5);

  const pc = matchGuide('Is GTA 6 on PC?', TIPS);
  assert.equal(pc[0].id, 'tip-127');
  assert.match(guideLines(pc).join('\n'), /Polygon/);
  assert.deepEqual(outletNames(pc[0].sources).includes('Polygon'), true);

  const release = matchGuide('When did GTA VI come out?', TIPS);
  assert.equal(release.some((tip) => tip.id === 'tip-001'), false);
});
