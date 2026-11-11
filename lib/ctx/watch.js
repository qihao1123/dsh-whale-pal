// 口径出处：融合计划-v2.md §16.0（触发点是 DSH 原生 compaction/summary 事件）、
// §16.8 第⑦⑨条（投影每次会话加载都从事件日志重放一遍）。
//
// 这一层只负责「折叠」：把事件折成待写的档案队列。
// apply 里绝不写盘——写了就会把所有档案重写一遍、mtime 全变、前缀缓存全废。
// 落盘交给 store.drainQueue，只在真正消费队列的那一刻发生。

export const PROJECTION_KEY = 'whaleContext';
// 2：加 `seqs`（原文留存要按 seq 回捞），`at` 改成从 `time` 推。字段与折叠语义都变了。
export const STATE_VERSION = 2;
export const NON_TEXT = '[非文本块]';

// 会话事件信封里带的是 `time`（epoch 毫秒）和 `seq`，没有 `at`。
// 早期实现读 `event.at`，真机上永远是空串：卡片时间列空、`renderCard` 直接判不合法。
// 两种都收——`at` 还在（旧信封与单测）就优先用，没有就拿 `time` 转 ISO。
export function atOf(event) {
  if (typeof event?.at === 'string' && event.at !== '') return event.at;
  const ms = event?.time;
  if (Number.isFinite(ms)) {
    try {
      return new Date(ms).toISOString();
    } catch {
      return '';
    }
  }
  return '';
}

// 被这次压缩盖住的那批 seq。原文留存靠它回捞，所以只留整数，认不出来的丢掉。
export function seqsOf(data) {
  const raw = data?.shadowedSeqs;
  if (!Array.isArray(raw)) return [];
  const seqs = [];
  for (const item of raw) {
    if (Number.isFinite(item)) seqs.push(Math.trunc(item));
  }
  return seqs;
}

// 初始状态固定成这个形状；它必须能被 JSON 序列化（投影状态会被宿主存下来再喂回来）。
export function initialState() {
  return {
    version: STATE_VERSION,
    pendingArchives: [],
    seen: {},
    pruned: 0,
    source: 'native',
    lastAt: null,
  };
}

// summary 可能是纯字符串，也可能是 ContentBlock[]：文本块直接接，非文本块记一个占位。
export function summaryTextOf(summary) {
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  const parts = [];
  for (const block of summary) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text);
    } else {
      parts.push(NON_TEXT);
    }
  }
  return parts.join('\n');
}

export function rangeOf(shadowedRange) {
  if (!shadowedRange || typeof shadowedRange !== 'object') return '';
  const start = shadowedRange.start === undefined ? '' : String(shadowedRange.start);
  const end = shadowedRange.end === undefined ? '' : String(shadowedRange.end);
  if (start === '' || end === '') return '';
  return `${start}–${end}`;
}

export function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload-invalid' };
  }
  const tokens = Number.isFinite(payload.shadowedTokenCount) ? payload.shadowedTokenCount : 0;
  return {
    ok: true,
    text: summaryTextOf(payload.summary),
    range: rangeOf(payload.shadowedRange),
    tokens,
    provider: typeof payload.provider === 'string' ? payload.provider : '',
    model: typeof payload.model === 'string' ? payload.model : '',
    source: 'native',
  };
}

// 纯函数：不改入参，每次返回新状态。
export function foldEvent(state, event) {
  const base = state && typeof state === 'object' ? state : initialState();
  if (!event || typeof event !== 'object') return base;
  if (event.type === 'compaction/summary') {
    const data = event.data || {};
    const blockId = typeof data.compactionId === 'string' ? data.compactionId : '';
    if (blockId === '') return base;
    const parsed = summarizePayload(data);
    if (parsed.ok !== true) return base;
    const previous = Number.isFinite(base.seen?.[blockId]) ? base.seen[blockId] : 0;
    const gen = previous + 1;
    const at = atOf(event);
    const next = {
      ...base,
      pendingArchives: [
        ...(Array.isArray(base.pendingArchives) ? base.pendingArchives : []),
        {
          blockId,
          gen,
          at,
          text: parsed.text,
          range: parsed.range,
          seqs: seqsOf(data),
          tokens: parsed.tokens,
          provider: parsed.provider,
          model: parsed.model,
        },
      ],
      seen: { ...(base.seen || {}), [blockId]: gen },
      source: 'native',
      lastAt: at === '' ? (base.lastAt ?? null) : at,
    };
    return next;
  }
  if (event.type === 'compaction/prune') {
    // 信封被回收不算一次压缩：只记次数，不进档案队列。
    return { ...base, pruned: (Number.isFinite(base.pruned) ? base.pruned : 0) + 1 };
  }
  return base;
}

export function makeProjection() {
  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: {},
    init: initialState,
    apply: foldEvent,
  };
}

// 把队列原样交出去，同时给一个已清空队列的新状态；seen 要留着，下回再压还是同一份的下一代。
export function drainPlan(state) {
  const base = state && typeof state === 'object' ? state : initialState();
  const archives = Array.isArray(base.pendingArchives) ? base.pendingArchives.slice() : [];
  return { archives, nextState: { ...base, pendingArchives: [] } };
}
