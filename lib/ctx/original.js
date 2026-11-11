// 按 seq 回原文：记忆条目的 `ref.seq` → 档案里那句原话（2026-11-09，判据 4 级二）。
//
// 三条硬规矩：
//   1. 找不到就说找不到（no-card / no-raw / no-section），**不拿相邻那段顶**；
//   2. 只读，一个字节都不改档案；
//   3. 不猜「大概在哪张卡」：卡片字段 `range` 写着它覆盖的 seq 区间，只按区间找；
//      区间重叠时取最窄的那张（再压一次档案会留下更小范围的卡）。
//
// 为什么单独一层：「编号 → 正文」（retrieve.js）和「正文 → 原话」（这里）是两步，
// 各有各的失败理由；混在一起，取回失败时说不清是哪一步没成。

import { readCards, rawFileOf, readTextFile } from './store.js';

/** 卡片范围：`19–3859`（En dash，来自 watch.rangeOf）、`19-3859`、单独一个数。 */
const RANGE_PAIR = /(\d+)\s*(?:–|—|-|~|至|到)\s*(\d+)/u;
const RANGE_SINGLE = /^(\d+)$/u;

/** 原文里一小节的抬头；seq 是回捞的钥匙。 */
const SECTION_HEAD = '### [seq ';

export function parseRange(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const pair = text.match(RANGE_PAIR);
  if (pair) {
    const start = Number(pair[1]);
    const end = Number(pair[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return { start, end };
  }
  const single = text.match(RANGE_SINGLE);
  if (single) {
    const at = Number(single[1]);
    return { start: at, end: at };
  }
  return null;
}

/** 哪张卡覆盖这个 seq；没有就 null。 */
export function cardForSeq(cards, seq) {
  const list = Array.isArray(cards) ? cards : [];
  const want = Math.floor(Number(seq) || 0);
  if (want <= 0) return null;
  let best = null;
  let bestWidth = Infinity;
  for (const card of list) {
    const range = parseRange(card?.fields?.range);
    if (range === null) continue;
    if (want < range.start || want > range.end) continue;
    const width = range.end - range.start;
    if (width < bestWidth) {
      best = card;
      bestWidth = width;
    }
  }
  return best;
}

/** 从一份原文里取 `### [seq N]` 那一节（不含抬头）；没有就 null。 */
export function sectionOfSeq(rawText, seq) {
  const want = Math.floor(Number(seq) || 0);
  if (want <= 0) return null;
  const text = String(rawText ?? '');
  const marker = `${SECTION_HEAD}${want}]`;
  // 只认行首：正文里恰好出现这串字不算一节；所以不能取第一处就收，得往后找到真的抬头。
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) return null;
    if (at === 0 || text[at - 1] === '\n') {
      const headEnd = text.indexOf('\n', at);
      if (headEnd < 0) return null;
      const next = text.indexOf('\n### ', headEnd);
      const body = text.slice(headEnd + 1, next < 0 ? text.length : next);
      const trimmed = body.trim();
      return trimmed === '' ? null : trimmed;
    }
    from = at + marker.length;
  }
}

/**
 * 按 seq 回原话。root 是 `ctxRoot(vaultPath)`（`_上下文` 那一层）。
 * 返回 `{ ok: true, text, cardId, blockId }` 或 `{ ok: false, reason }`。
 */
export function originalAt(root, seq) {
  const want = Math.floor(Number(seq) || 0);
  if (want <= 0) return { ok: false, reason: 'no-seq' };
  const card = cardForSeq(readCards(root), want);
  if (card === null) return { ok: false, reason: 'no-card' };
  const raw = readTextFile(rawFileOf(root, card.blockId, card.gen));
  if (raw === null) return { ok: false, reason: 'no-raw', cardId: card.id, blockId: card.blockId };
  const text = sectionOfSeq(raw, want);
  if (text === null) return { ok: false, reason: 'no-section', cardId: card.id, blockId: card.blockId };
  return { ok: true, text, cardId: card.id, blockId: card.blockId };
}
