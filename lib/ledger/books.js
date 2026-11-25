/**
 * 四本台账的口径与行操作（纯逻辑）。
 *
 * 口径出处：`融合计划-v2.md` §11.6（事件六列、类型只四种、教训宁缺不凑、不当场定论）、
 * §7 第 5 条（台账只追加，不修改历史行）、§3.2（lapse 写进待交接）、§12（只留功能名）。
 *
 * 2026-11-21：第五本「待提醒」随节律一起砍了。提醒不再有自己的一本账，
 * 过期承诺只在人/模型说一声「扫一遍」时落进待交接。
 *
 * 两件自己定下的口径，理由写在这（任务允许自定，但必须说清）：
 *
 * 1. **补齐改的是同一行，不是另起一条。**
 *    理由：§11.6 要求「一行一条」，一个事件就该只占一行；另起一条会让同一个事件出现两行，
 *    「判断列抄当时原话」也就没了归属。为了不破「不改历史行」，把「行」分成两态：
 *    带 `待补` 的行是**未定稿**，补齐只允许把恰好是 `待补` 的那一格替换掉，其余字节一个都不动
 *    （`replaceRow` 是全模块唯一的改写口）；三格都填过、或者要改的不是占位符，一律拒绝。
 *    已定稿的行没人能动——「只追加」守的是这个。
 *
 * 2. **幂等键按行内容算，不另开一列藏机器码。**
 *    理由：台账要「普通人能读能删」，塞一个 UUID 列出来谁都不认识；而事件的时间+类型+内容
 *    本身就能识别同一条账（重跑同一件事，这三格逐字相同）。待交接那本账不同：
 *    它的键是 audit 序号，本来就该给人看见，所以单独占「键」一列。
 *
 * 纯模块：不碰盘、不读环境变量、不看时钟。
 */
import { PLACEHOLDER, ensureNewline, oneLine, parseRows, renderRow, renderSeparator, replaceRow } from './table.js';

/** 事件类型只有四种（§11.6）。第五种一律不收——类型一多，这本账就没法统计了。 */
export const EVENT_TYPES = Object.freeze(['任务', '纠正', '偏好', '观察']);

export const EVENT_TYPE_HINT = EVENT_TYPES.join(' / ');

/** 待交接的状态词。人确认过才往前推，插件不替他推。 */
export const HANDOFF_OPEN = '待处理';
export const HANDOFF_DONE = '已结';
export const HANDOFF_IGNORED = '已忽略';

const EVENT_BOOK = {
  name: '事件',
  file: '事件.md',
  title: '事件台账',
  columns: ['时间', '类型', '发生了什么', '当时的判断', '结果', '教训'],
  placeholders: ['当时的判断', '结果', '教训'],
  notes: [
    `一行一条：${['时间', '类型', '发生了什么', '当时的判断', '结果', '教训'].join(' | ')}。`,
    `类型只有四种：${EVENT_TYPE_HINT}；判断列抄当时原话，不美化，事后发现判错了另起一条「纠正」。`,
    '教训写不出具体动作就写「无新增」，不许凑。',
    '没当场定论的那几格先写「待补」；补齐只替换「待补」那一格，其余字节不动。',
    '这本账只追加：已定稿的行不改，也不删。',
  ],
  keyOf: (cells) => [cells[0], cells[1], cells[2]].join('|'),
  check: (cells) => (EVENT_TYPES.includes(cells[1]) ? null : 'bad-type'),
};

const DEVIATION_BOOK = {
  name: '偏离',
  file: '偏离.md',
  title: '偏离台账',
  columns: ['场景', '偏离', '原因', '改法'],
  placeholders: ['原因', '改法'],
  notes: [
    '一行一条：场景 | 偏离 | 原因 | 改法。',
    '偏离 = 该按说好的办、结果没办到；原因写当时为什么，改法写下次具体改哪一步。',
    '只追加，不改历史行；当时写不出改法就先写「待补」。',
  ],
  keyOf: (cells) => cells.join('|'),
};

const DISSENT_BOOK = {
  name: '异议',
  file: '异议.md',
  title: '异议台账',
  columns: ['时间', '议题', '我的看法', '你的看法', '处理'],
  placeholders: ['处理'],
  notes: [
    '一行一条：时间 | 议题 | 我的看法 | 你的看法 | 处理。',
    '看法真的不一样时记一笔，不抹平、不劝和；处理写最后怎么定的。',
    '只追加，不改历史行。',
  ],
  keyOf: (cells) => [cells[0], cells[1]].join('|'),
};

const HANDOFF_BOOK = {
  name: '待交接',
  file: '待交接.md',
  title: '待交接台账',
  columns: ['时间', '键', '答应过的事', '状态'],
  placeholders: [],
  defaults: { 状态: HANDOFF_OPEN },
  statusIndex: 3,
  openStatus: HANDOFF_OPEN,
  notes: [
    '一行一条：时间 | 键 | 答应过的事 | 状态。',
    '键来自 audit.jsonl 的 lapsed 事件（序号#位置），同一条只会有一行，重扫不重复写。',
    `状态：${HANDOFF_OPEN} → ${HANDOFF_DONE} / ${HANDOFF_IGNORED}；只改这一格，别的不动。`,
    '人格内核那边照旧过期，这里只是不让答应过的事静默消失。',
  ],
  keyOf: (cells) => cells[1],
};

export const BOOKS = Object.freeze([EVENT_BOOK, DEVIATION_BOOK, DISSENT_BOOK, HANDOFF_BOOK]);

/**
 * 按名字（`事件`）、文件名（`事件.md`）或账本对象本身取一本账；认不出来回 null，不抛。
 *
 * 三种都收，是因为内部调用常常手里已经是账本对象（`appendRow` 里就是这样），
 * 而外部调用只有名字——两个入口各自做一次字符串转换最容易出「[object Object]」那种静默失配。
 */
export function bookOf(name) {
  if (name !== null && typeof name === 'object') {
    if (BOOKS.includes(name)) return name;
    const byName = String(name.name ?? '').trim();
    return BOOKS.find((book) => book.name === byName) ?? null;
  }
  const want = String(name ?? '').trim();
  if (want === '') return null;
  return BOOKS.find((book) => book.name === want || book.file === want) ?? null;
}

/** 新建一本账时的内容：说明走 `>` 引用行，数据区是一张空表。 */
export function skeleton(book) {
  const target = bookOf(book);
  if (!target) return '';
  const lines = [`# ${target.title}`, ''];
  for (const note of target.notes) lines.push(`> ${note}`);
  lines.push('', renderRow(target.columns), renderSeparator(target.columns.length), '');
  return lines.join('\n');
}

/** 必填列：既不是占位格、也不是状态列的，空格一律不收。 */
export function requiredColumns(book) {
  const target = typeof book === 'string' ? bookOf(book) : book;
  if (!target) return [];
  return target.columns.filter((name, i) => {
    if (target.placeholders.includes(name)) return false;
    return target.statusIndex !== i;
  });
}

/** 把对象或数组归一成整行；空的占位格写 `待补`，空的状态列走默认值。 */
export function cellsOf(book, input = {}) {
  const target = bookOf(book);
  if (!target) return [];
  return target.columns.map((name, i) => {
    const value = Array.isArray(input) ? oneLine(input[i]) : oneLine(input?.[name]);
    if (value !== '') return value;
    if (target.placeholders.includes(name)) return PLACEHOLDER;
    return oneLine(target.defaults?.[name] ?? '');
  });
}

/** 这一行收不收。空必填列报 `missing:<列名>`，事件类型另有 `bad-type`。 */
export function validateCells(book, cells) {
  const target = bookOf(book);
  if (!target) return 'unknown-book';
  const row = Array.isArray(cells) ? cells : [];
  if (row.length !== target.columns.length) return 'bad-columns';
  for (const name of requiredColumns(target)) {
    const i = target.columns.indexOf(name);
    if (oneLine(row[i]) === '') return `missing:${name}`;
  }
  if (typeof target.check === 'function') {
    const problem = target.check(row.map(oneLine));
    if (problem) return problem;
  }
  return null;
}

/** 读出一本账的数据行（列数不足的补齐，多余的丢掉——手改坏了一行不该让整本读不出来）。 */
export function rowsOf(book, text) {
  const target = bookOf(book);
  if (!target) return [];
  return parseRows(text).map((row) => ({
    index: row.index,
    cells: target.columns.map((_, i) => oneLine(row.cells[i] ?? '')),
  }));
}

/**
 * 一条账的幂等键。
 *
 * 键是给人看、也要能对上的字符串（待交接那本账直接把它写进「键」列）；
 * JS 这一侧的格子本来就是原样文本（转义只在落盘那一下做），所以这里直接拼就行，
 * 不能再套一层转义——套了就会出现「行上算出来的键」和「调用方手里那个键」永远对不上。
 */
export function keyOfRow(book, cells) {
  const target = bookOf(book);
  if (!target) return '';
  const parts = (Array.isArray(cells) ? cells : []).map(oneLine);
  try {
    return oneLine(target.keyOf(parts));
  } catch {
    return '';
  }
}

export function findByKey(book, text, key) {
  const target = bookOf(book);
  const want = oneLine(key);
  if (!target || want === '') return null;
  const withKey = rowsOf(target, text).map((row) => ({ ...row, key: keyOfRow(target, row.cells) }));
  return withKey.find((row) => row.key === want) ?? null;
}

export function rowsWithStatus(book, text, status) {
  const target = bookOf(book);
  if (!target || typeof target.statusIndex !== 'number') return [];
  const want = oneLine(status);
  return rowsOf(target, text).filter((row) => row.cells[target.statusIndex] === want);
}

export function statusOf(book, cells) {
  const target = bookOf(book);
  if (!target || typeof target.statusIndex !== 'number') return '';
  return oneLine(Array.isArray(cells) ? cells[target.statusIndex] : '');
}

/**
 * 追加一行。同一幂等键已经在账上就跳过（跳过算成功，不算失败）——
 * 这两条正是验收里「台账重跑不重复写」要的：重复调用回 `wrote:false`，文件字节不动。
 */
export function appendRow({ book, text, cells } = {}) {
  const target = bookOf(book);
  if (!target) return { ok: false, reason: 'unknown-book' };
  const row = Array.isArray(cells) ? cells.map(oneLine) : cellsOf(target, cells);
  const problem = validateCells(target, row);
  if (problem) return { ok: false, reason: problem };

  const key = keyOfRow(target, row);
  const body = String(text ?? '');
  if (body !== '' && findByKey(target, body, key)) {
    return { ok: true, key, wrote: false, skipped: true, row };
  }
  const base = body.trim() === '' ? skeleton(target) : ensureNewline(body);
  return { ok: true, key, wrote: true, skipped: false, row, text: `${base}${renderRow(row)}\n` };
}

/**
 * 补齐：只把「待补」换成实词。
 *
 * 不是占位格、或者要写的值是空的，那一格就跳过；一格都没换成就整条拒绝，
 * 免得「补齐」变成一条能悄悄改历史的通路。
 */
export function fillRow({ book, text, key, patch } = {}) {
  const target = bookOf(book);
  if (!target) return { ok: false, reason: 'unknown-book' };
  const found = findByKey(target, text, key);
  if (!found) return { ok: false, reason: 'row-not-found' };

  const next = [...found.cells];
  const filled = [];
  const skipped = [];
  for (const [name, value] of Object.entries(patch ?? {})) {
    const i = target.columns.indexOf(name);
    if (i < 0) {
      skipped.push(name);
      continue;
    }
    const cell = oneLine(value);
    if (next[i] !== PLACEHOLDER || cell === '') {
      skipped.push(name);
      continue;
    }
    next[i] = cell;
    filled.push(name);
  }
  if (filled.length === 0) return { ok: false, reason: 'no-placeholder', filled, skipped };

  const out = replaceRow(String(text ?? ''), found.index, next);
  if (out === null) return { ok: false, reason: 'row-not-found' };
  return { ok: true, key, filled, skipped, text: out, row: next };
}

/**
 * 推一格状态（待处理 → 已结/已忽略）。
 *
 * 只认「当前还停在开头那个状态」的行：已经标结过的行再推一次是幂等（`changed:false`），
 * 但已忽略的行不许事后被改成已结——那种改动属于伪造处理记录。
 */
export function setStatus({ book, text, key, status, from = '' } = {}) {
  const target = bookOf(book);
  if (!target || typeof target.statusIndex !== 'number') return { ok: false, reason: 'no-status' };
  const want = oneLine(status);
  if (want === '') return { ok: false, reason: 'no-status-value' };
  const found = findByKey(target, text, key);
  if (!found) return { ok: false, reason: 'row-not-found' };

  const current = found.cells[target.statusIndex];
  if (current === want) return { ok: true, key, changed: false, status: want, text: String(text ?? '') };
  const expect = oneLine(from) === '' ? target.openStatus : oneLine(from);
  if (expect !== '' && current !== expect) return { ok: false, reason: 'not-open', status: current };

  const next = [...found.cells];
  next[target.statusIndex] = want;
  const out = replaceRow(String(text ?? ''), found.index, next);
  if (out === null) return { ok: false, reason: 'row-not-found' };
  return { ok: true, key, changed: true, status: want, text: out, row: next };
}
