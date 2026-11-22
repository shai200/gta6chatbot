// Cache-hit decision for chat replies.
// BetterProxy's streaming responses do not carry X-Cache-* headers. A repeat
// is marked only when this process already completed the same prompt, the
// first token was very fast, and the body matches the previous answer or
// arrived as a single replayed chunk. The first time a prompt is seen is
// never called a hit.

import { createHash } from 'node:crypto';

export const FAST_REPEAT_TTFB_MS = 400;

export function promptKey(model, messages) {
  return createHash('sha256').update(JSON.stringify({ model, messages })).digest('hex');
}

export function judgeRepeatCache(seen, rec) {
  const outputHash = createHash('sha256').update(rec.output || '').digest('hex');
  const prior = seen.get(rec.promptKey);
  seen.set(rec.promptKey, { outputHash });
  if (seen.size > 400) seen.delete(seen.keys().next().value);
  if (rec.headerKnown) return { hit: rec.headerHit === true, source: 'header' };
  const fast = Number.isFinite(rec.ttfbMs) && rec.ttfbMs <= FAST_REPEAT_TTFB_MS;
  const replayed = rec.contentChunks === 1 && rec.outputChars >= 24;
  const sameText = prior?.outputHash === outputHash;
  const hit = Boolean(prior) && fast && (replayed || sameText);
  return { hit, source: hit ? 'timing' : 'none' };
}
