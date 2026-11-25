/**
 * lapse 交接：把 audit.jsonl 里的 lapsed 事件挑出来，变成待交接的一行。
 *
 * 口径出处：`融合计划-v2.md` §3.2——人格内核侧不动、lapse 照旧；
 * 插件把 audit 里的 lapsed 事件写进 `台账/待交接.md`，人确认后才结。
 * §17.2 把「答应的事没忘」记成台账承诺 + 交接条，这条链路就是那份底账。
 *
 * audit 的真实形状（真机核过）：一行一条 JSON，`{seq, at, type, detail}`；
 * lapse 不是单独一类事件，而是 `type:"update"` 里 `detail.changes[]` 的一条
 * `{kind:"commitment", op:"lapsed", to:"答应过的事"}`。所以判据是「变更项」而不是事件类型。
 *
 * 扫法（2026-11-21 改成按需，不再有游标）：每次从 0 扫，靠待交接账上那列幂等键去重，
 * 所以重扫不会重复写；「首次/每次都只接最近一批」由地板管（见 `scanLapsed`）。
 * 没有游标就没有「推进到哪」的状态文件——没人看的时候也不会有东西自己往库里写。
 *
 * 纯模块：不碰盘、不读环境变量、不看时钟。
 */
import { cellsOf } from './books.js';

export const LAPSE_KIND = 'commitment';
export const LAPSE_OP = 'lapsed';

/** 幂等键：同一个 audit 序号里的第几条变更。重扫、重跑都认这一个键。 */
export function handoffKey({ seq = 0, i = 0 } = {}) {
  return `lapse:${Number(seq) || 0}#${Number(i) || 0}`;
}

/** 一条 audit 记录里的 lapsed 变更。没有就回空数组。 */
export function lapsedItems(record) {
  const changes = record?.detail?.changes;
  if (!Array.isArray(changes)) return [];
  const seq = Number(record?.seq) || 0;
  const at = typeof record?.at === 'string' ? record.at : '';
  const out = [];
  for (let i = 0; i < changes.length; i += 1) {
    const change = changes[i];
    if (change?.kind !== LAPSE_KIND || change?.op !== LAPSE_OP) continue;
    const text = String(change?.to ?? '').trim();
    // 没有正文的 lapsed 事件接不住（待交接那一行会缺「答应过的事」），跳过但不编一个标题出来。
    if (text === '') continue;
    out.push({ seq, i, at, text, key: handoffKey({ seq, i }) });
  }
  return out;
}

/**
 * 从一批 audit 记录里挑出 lapsed 事件。
 *
 * 回 `{items, maxSeq, from, floored}`：`maxSeq` 是盘上见到的最大序号，
 * `from` 是这次实际用的下界，`floored` 表示下界被地板抬起来了（见下）。
 *
 * 地板（`firstFloor`）：每次都是从 0 扫，如果直接把最近几百条以前的历史全灌进来，
 * 第一次在真机上跑就把 `台账/待交接.md` 灌了 34 条几个月前的旧承诺（2026-11-05 事故）。
 * 所以只认「最大序号往前 firstFloor 条」，更早的算历史、不补账。
 * 传 `firstFloor: 0` 可以关掉地板（测试与「确实要全量重扫」时用）。
 */
export function scanLapsed({ records = [], firstFloor = 0 } = {}) {
  let maxSeq = 0;
  const parsed = [];
  for (const record of Array.isArray(records) ? records : []) {
    const seq = Number(record?.seq);
    if (Number.isFinite(seq) === false) continue;
    if (seq > maxSeq) maxSeq = seq;
    parsed.push({ record, seq });
  }

  const floor = Math.max(0, Math.floor(Number(firstFloor) || 0));
  const floored = floor > 0 && maxSeq > floor;
  const from = floored ? maxSeq - floor : 0;

  const items = [];
  for (const { record, seq } of parsed) {
    if (seq <= from) continue;
    for (const item of lapsedItems(record)) items.push(item);
  }
  return { items, maxSeq, from, floored };
}

/** 一条 lapsed 事件 → 待交接的一行（状态走默认的「待处理」）。 */
export function handoffCells({ item, at = '' } = {}) {
  return cellsOf('待交接', {
    时间: at === '' ? (item?.at ?? '') : at,
    键: item?.key ?? '',
    答应过的事: item?.text ?? '',
  });
}

// ------------------------------------------------------------------ 未完结三类

/**
 * 未完结的三类（方案 §3c）。
 *
 * 为什么分三类而不是一个「未完成」：这三种的**下次动作完全不同**，
 * 混成一类就分不清该催谁。
 *   - `startedNotDone` 开始了没做完 —— 是我的动作没走完，下次继续做；
 *   - `deferred` 他说「回头再说」 —— 是他按了暂停，下次别再提；
 *   - `unanswered` 我提了他没回 —— 是悬着的，下次可以再问一句。
 */
export const OPEN_KIND = {
  STARTED_NOT_DONE: '开始了没做完',
  DEFERRED: '他说回头再说',
  UNANSWERED: '我提了他没回',
}

/** 三类各自下一次该做什么。写在这里而不是散在提示词里：规则要能测。 */
export const OPEN_KIND_NEXT = {
  [OPEN_KIND.STARTED_NOT_DONE]: '继续做，别重开一遍',
  [OPEN_KIND.DEFERRED]: '别再提，等他先说',
  [OPEN_KIND.UNANSWERED]: '可以再问一句，问完就走',
}

/**
 * 判断一条未结属于哪一类。判据只看文本里的可观测线索，不猜心理：
 *   - 出现「回头再说 / 以后再说 / 先放放 / 改天」→ 他按了暂停（**先判这个**：
 *     「先放放，回头再说」同时像个悬着的事，但人明确按了暂停）；
 *   - 出现「等…回复 / 没回 / 没答复 / 我问了」→ 悬着的，我在等对方；
 *   - 其余有动作痕迹的都是「开始了没做完」。
 * 拿不准就归到「开始了没做完」—— 那类最少冒犯（继续做事，不是催人）。
 *
 * 「等 X 回复」用 `等[^，。；]{0,6}回复` 而不是写死「等你回复」：
 * 2026-11-07 实测「等用户回复」没被命中，而「等确认」（他等的是我）
 * 却被判成悬着 —— 方向判错的代价是动作做反（该干活时去催人）。
 */
export function classifyOpen(item) {
  const text = String(typeof item === 'string' ? item : (item?.text ?? ''))
  if (/回头再说|以后再说|先放|改天|等有空|不着急/u.test(text)) return OPEN_KIND.DEFERRED
  if (/等[^，。；]{0,6}回复|没回|没答复|我问了|问了他/u.test(text)) return OPEN_KIND.UNANSWERED
  return OPEN_KIND.STARTED_NOT_DONE
}

/** 幂等键：按类别 + 文本算，同一件事重扫不会写第二行。 */
export function openKey(kind, text) {
  return `open:${kind}:${String(text ?? '').trim().slice(0, 40)}`
}

/**
 * 未结条目 → 待交接的行。
 *
 * 落点沿用 `待交接.md`（P4 已有这张表），不新开账本：
 * 键里带类别，所以同一个文本换类会另起一行 —— 那是真的变了，不算重复。
 */
export function openHandoffCells({ item, at = '', kind = '' } = {}) {
  const text = String(typeof item === 'string' ? item : (item?.text ?? '')).trim()
  if (text === '') return null
  const which = kind === '' ? classifyOpen(item) : kind
  const stamp = at === '' ? (typeof item === 'object' && item !== null && typeof item.at === 'number' ? new Date(item.at).toISOString() : '') : at
  return cellsOf('待交接', {
    时间: stamp,
    键: openKey(which, text),
    答应过的事: `［${which}］${text}`,
  })
}
