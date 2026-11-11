/**
 * 索引.md 的渲染与解析（八列表）。
 *
 * 口径出处：`融合计划-v2.md` §16.5；表结构与编号规则见 `docs/P35-补全.md` 第四节。
 *   - `索引.md` 是一张八列表，按编号升序；来源只允许 native / occupied / self，
 *     状态只允许 已压缩 / 待确认。
 *   - 单元格里的 `|` 一律转义成 `\|`，否则整行会被拆错列；反斜杠同时转义，解开时按序还原。
 *   - 索引是派生物：能从档案重建（见 `rebuild.js`），不是唯一源。
 *   - 关键词表已删（全仓没有读侧）；这一层只管索引那一张八列表。
 *
 * 纯函数：不读盘、不读环境变量、不看时钟（时间由调用方写进 `at`）。
 */

/** 八列表头，逐字不动（字符串不可 freeze，按常量用即可）。 */
export const INDEX_HEADER = '| 编号 | 时间 | 范围 | 主题 | 关键词 | 来源 | 状态 | 摘要文件 |'

/** 表头下的分隔行，八格。 */
export const INDEX_DIVIDER = '|---|---|---|---|---|---|---|---|'

/** 一行八格，`renderIndexRow` 只认这八个字段名。 */
const ROW_KEYS = Object.freeze(['id', 'at', 'range', 'topic', 'keywords', 'source', 'status', 'file'])

/** 多值单元格与关键词表用的分隔符。 */
const KEYWORD_SEP = '、'

/** 分隔行的一格：`---` / `:---:` / `---:`。 */
const DASH_CELL = /^:?-{3,}:?$/u

/** 卡片状态只两值：默认已压缩，卡片显式标了待确认就照抄。 */
export const STATUS_DONE = '已压缩'
export const STATUS_PENDING = '待确认'

/** 单元格转义：换行压成空格，反斜杠先转，竖线后转。 */
function escapeCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/gu, ' ')
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
}

/** 按一行拆格，`\|` 与 `\\` 不参与分列。 */
function splitCells(line) {
  const text = line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  const cells = []
  let buffer = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1]
      buffer += next === '|' || next === '\\' ? next : char + next
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += char
  }
  cells.push(buffer.trim())
  return cells
}

/** 表头行：首格是「编号」。 */
function isHeader(cells) {
  return cells.length >= 1 && cells[0] === '编号'
}

/** 分隔行：每一格都是 `---` 形状。 */
function isDivider(cells) {
  return cells.length > 0 && cells.every((cell) => DASH_CELL.test(cell))
}

/** 多值输入归一成字符串数组：数组 / Set / 顿号串 / 单值。 */
function idList(value) {
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    for (const piece of String(item ?? '').split(KEYWORD_SEP)) {
      const text = piece.trim()
      if (text !== '' && !out.includes(text)) out.push(text)
    }
  }
  return out
}

/** 单元格取值：多值按顿号连。 */
function cellOf(value) {
  if (Array.isArray(value) || value instanceof Set) return idList(value).join(KEYWORD_SEP)
  return String(value ?? '')
}

/**
 * 编号比较：同前缀同宽度不等的数字按数值排（C010 在 C002 后、C1000 在 C999 后），
 * 其余按码位比。入参乱序时靠它定序，结果与入参顺序无关。
 */
export function compareId(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  const pa = /^([A-Za-z]*)(\d+)$/u.exec(a)
  const pb = /^([A-Za-z]*)(\d+)$/u.exec(b)
  if (pa && pb && pa[1] === pb[1]) {
    const diff = Number(pa[2]) - Number(pb[2])
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 把一行对象渲染成表格行；缺字段留空格，竖线转义。 */
export function renderIndexRow(row) {
  const source = row ?? {}
  const cells = ROW_KEYS.map((key) => escapeCell(cellOf(source[key])))
  return `| ${cells.join(' | ')} |`
}

/**
 * 解析索引表。
 *
 * @param {string} text 索引全文
 * @returns {{ ok: boolean, rows: Array, skipped: number, reason?: string }}
 *   rows 里 keywords 是数组；表头行与分隔行不算不合法；坏行只计数，不抛。
 */
export function parseIndex(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text', rows: [], skipped: 0 }
  const rows = []
  let skipped = 0
  for (const line of text.split(/\r?\n/gu)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('|')) {
      skipped += 1
      continue
    }
    const cells = splitCells(trimmed)
    if (isHeader(cells) || isDivider(cells)) continue
    if (cells.length !== ROW_KEYS.length) {
      skipped += 1
      continue
    }
    const [id, at, range, topic, keywords, source, status, file] = cells
    if (id === '') {
      skipped += 1
      continue
    }
    rows.push({
      id,
      at,
      range,
      topic,
      keywords: idList(keywords),
      source,
      status,
      file,
    })
  }
  return { ok: true, rows, skipped }
}

/** 表头 + 分隔行 + 各行，末尾恰好一个换行。 */
export function renderIndex(rows) {
  const list = Array.isArray(rows) ? rows : []
  const lines = [INDEX_HEADER, INDEX_DIVIDER, ...list.map((row) => renderIndexRow(row))]
  return `${lines.join('\n')}\n`
}

/** 卡片状态 → 索引状态列。 */
export function statusOf(card) {
  return card?.status === STATUS_PENDING ? STATUS_PENDING : STATUS_DONE
}

/** 卡片对象折成一行对象；摘要文件按 blockId 定名。 */
export function rowOf(card) {
  const fields = card?.fields ?? {}
  const blockId = String(card?.blockId ?? card?.id ?? '')
  return {
    id: String(card?.id ?? ''),
    at: String(card?.at ?? ''),
    range: String(fields.range ?? ''),
    topic: String(fields.topic ?? ''),
    keywords: idList(fields.keywords),
    source: String(card?.source ?? ''),
    status: statusOf(card),
    file: `${blockId}.md`,
  }
}
