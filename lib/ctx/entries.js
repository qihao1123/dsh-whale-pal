/**
 * 条目抽取与渲染：四类条目、rule/model 两路合并、五列 Markdown 表。
 *
 * 口径出处：`融合计划-v2.md` §16.5.1；表头与取值范围见
 * `docs/P35-补全.md` 第三节（类型只许 事实/决定/待办/偏好，方式只许 rule/model）。
 * 合并口径：同 `type` 且同 `content` 的行，model 覆盖 rule；输出 rule 在前，
 * model 新增在后。序号由渲染时按顺序重排。
 *
 * 纯函数：不读盘、不读环境变量、不看时钟。坏行直接跳过，不抛异常。
 */

export const TYPES = Object.freeze(['事实', '决定', '待办', '偏好'])
export const WAYS = Object.freeze(['rule', 'model'])

const TYPE_SET = new Set(TYPES)
const WAY_SET = new Set(WAYS)

function normalizeRow(row, fallbackWay) {
  if (row === null || typeof row !== 'object') return null
  if (!TYPE_SET.has(row.type)) return null
  if (typeof row.content !== 'string') return null

  const content = row.content.trim()
  if (content === '') return null

  const way = WAY_SET.has(row.way) ? row.way : fallbackWay
  return { ...row, type: row.type, content, way }
}

export function extractRules(text) {
  const source = typeof text === 'string' ? text : ''
  const rows = []

  for (const line of source.split(/\r?\n/)) {
    const matched = /^\s*(?:[-*]\s*)?(事实|决定|待办|偏好)\s*[：:]\s*(.*)$/.exec(line)
    if (!matched) continue
    const content = matched[2].trim()
    if (content === '') continue
    rows.push({ type: matched[1], content })
  }

  return rows
}

export function mergeEntries(ruleRows, modelRows) {
  const merged = []
  const index = new Map()

  const keyOf = (row) => `${row.type}\u0000${row.content}`

  for (const row of Array.isArray(ruleRows) ? ruleRows : []) {
    const normalized = normalizeRow(row, 'rule')
    if (normalized === null) continue
    const key = keyOf(normalized)
    if (index.has(key)) continue
    index.set(key, merged.length)
    merged.push(normalized)
  }

  for (const row of Array.isArray(modelRows) ? modelRows : []) {
    const normalized = normalizeRow(row, 'model')
    if (normalized === null) continue
    const key = keyOf(normalized)
    if (index.has(key)) {
      const at = index.get(key)
      merged[at] = { ...merged[at], ...normalized }
      continue
    }
    index.set(key, merged.length)
    merged.push(normalized)
  }

  return merged
}

const cell = (value) => String(value).replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|')

/**
 * 模型补的那几行：一行一条，「类型：内容」。
 *
 * 存回卡片正文里（两格缩进的续行，跟摘要同一套写法），所以内容里可以有空格和标点，
 * 只是不能换行——换行会把续行拆散。返回的是行数组，落盘的事归 store。
 */
export function encodeEntries(rows) {
  const lines = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeRow(row, 'model')
    if (normalized === null) continue
    lines.push(`${normalized.type}：${normalized.content}`)
  }
  return lines
}

/**
 * 反着来：把那几行读回条目行。
 *
 * 认不出类型的行跳过——一行脏字不该让整张卡读不出来；`way` 一律标 `model`。
 */
export function decodeEntries(lines) {
  const rows = []
  for (const line of Array.isArray(lines) ? lines : []) {
    const matched = /^\s*(?:[-*]\s*)?(事实|决定|待办|偏好)\s*[：:]\s*(.*)$/.exec(String(line ?? ''))
    if (!matched) continue
    const content = matched[2].trim()
    if (content === '') continue
    rows.push({ type: matched[1], content, way: 'model' })
  }
  return rows
}
export function renderEntries(rows) {
  const lines = ['| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |', '|---|---|---|---|---|']
  let sequence = 0

  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (!TYPE_SET.has(row.type)) continue

    const content = typeof row.content === 'string' ? row.content.trim() : ''
    if (content === '') continue

    sequence += 1
    const sourceId = typeof row.sourceId === 'string' ? row.sourceId.trim() : ''
    const way = WAY_SET.has(row.way) ? row.way : 'rule'
    lines.push(`| ${sequence} | ${row.type} | ${cell(content)} | ${cell(sourceId)} | ${way} |`)
  }

  return `${lines.join('\n')}\n`
}
