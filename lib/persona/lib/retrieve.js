/**
 * 取回：把「编号 → 原文」这一半做出来。
 *
 * 为什么要有它（判据 1 与判据 4 顶牛的地方）：
 *   常驻预算只够放目录（编号 + 一句主题），正文不该每轮都付钱。
 *   但记忆条目本身只有一句 `text`（≤300 字），够短、够小 —— 真正的长文在压缩档案里。
 *   所以这里的取回分两段：先按编号拿条目正文，条目带 `ref` 的再去档案里捞原文。
 *
 * 三条硬规则：
 *   1. **一次取回 ≤2000 字**，超了截断并注明「已截断，原文 N 字」——不许悄悄少给；
 *   2. **编号不许编造**：查不到就说查不到，不拿最像的那条顶上；
 *   3. 纯函数：不碰盘、不看时钟。盘上的事由调用方（host-bridge）做。
 */

import { allMemoryEntries, findMemoryById, findTombstone, memoryKey, TOMBSTONE_REASON_TEXT } from './memory.js'

/** 一次取回的字数上限（判据 2 第三条）。 */
export const FETCH_MAX = 2000

/** 目录一行的主题长度上限（判据 2 第二条：目录一行 ≤20 字）。 */
export const TOPIC_MAX = 20

/** 目录最多列几行：够指路，又不至于把常驻预算吃回去。 */
export const CATALOG_LIMIT = 5

/**
 * 工具输出里的打分：缺省按 0 算。
 *
 * 长期层没有 `salience` 这个字段（它是「钉住的」，不进淘汰评分），
 * 直接 `Number(undefined).toFixed(3)` 会得到 NaN。NaN 不是合法 JSON，
 * 宿主会把整个返回值判成 invalid output —— 一条长期记忆就能让 list 全废。
 * 「没有打分」是这个字段的真实含义，回 0，不回 NaN。
 */
function salienceOf(entry) {
  const n = Number(entry?.salience)
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0
}

function numberOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 墓碑上的时间戳 → 本地年月日。没有时间就说没有，不填今天的日子。 */
function dayOf(ms) {
  const at = numberOrZero(ms)
  if (at <= 0) return '（时间不明）'
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 一条记忆的「一句主题」：取正文首句，压到 ≤20 字。
 *
 * 为什么不另存一个 topic 字段：主题是正文的函数，存了就要维护两处，
 * 改了正文忘了主题就出现「目录说 A、点开是 B」。现算最省事。
 *
 * 截断时留 2 个字符给省略号：`max - 1` 会让「…」不算在 20 里，
 * 加上去就超了；而判据量的是整行，不是正文。
 */
export function topicOf(text, max = TOPIC_MAX) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (raw === '') return ''
  // 首句：遇到句末标点就断，但太短（<6 字）就再往后带一句，免得主题只有「好的」。
  const firstBreak = raw.search(/[。！？；\n]/u)
  let head = firstBreak >= 6 ? raw.slice(0, firstBreak) : raw
  if (head.length > max) head = `${head.slice(0, max - 1)}…`
  return head
}

/** 目录一行：`M-003 · 一句主题`。判据要求 ≤20 字，这里按整行算。 */
export function catalogLine(id, text, max = TOPIC_MAX) {
  const topic = topicOf(text, Math.max(4, max - String(id ?? '').length - 3))
  return `${id} · ${topic}`
}

/**
 * 目录：最多 `limit` 行，每行 ≤20 字。取谁由调用方排好序传进来，
 * 这里只负责「编号 + 主题」的成形，不重排（排序是另一件事，混在一起就分不清哪个错了）。
 *
 * 入参认两种形状：扁的 `{id, text}` 和 `allMemoryEntries` 出来的 `{entry: {id, text}}`。
 * 只认扁的会让调用方各写一遍 map，写漏一次就是「目录永远是空的」这种静默故障
 * （2026-11-07 真的踩了：传了嵌套形状，catalog 一直是 0 行，评估集也看不出来）。
 */
export function renderCatalog(entries, options = {}) {
  const { limit = CATALOG_LIMIT, max = TOPIC_MAX } = options
  const list = Array.isArray(entries) ? entries : []
  const lines = []
  for (const item of list) {
    if (lines.length >= limit) break
    const source = item && typeof item === 'object' && item.entry && typeof item.entry === 'object' ? item.entry : item
    const id = String(source?.id ?? '').trim()
    const text = String(source?.text ?? '').trim()
    if (id === '' || text === '') continue
    lines.push(catalogLine(id, text, max))
  }
  return lines
}

/**
 * 从状态直接出目录行：只列**短期层**里还有用的条目。
 *
 * 两条过滤的理由：
 *   - 长期层已经在「一直记着」那一行常驻了，再列进目录是同一件事付两次钱；
 *   - 已做完（resolved）的不该占目录，已晋升（promoted）的属于长期层。
 *
 * `exclude` 传已展示的正文（原文，不是加了标记的版本）—— 同一件事
 * 既在「记得」里露全文、又在目录里占一行，也是白付两次钱。
 */
export function catalogOf(state, options = {}) {
  const { limit = CATALOG_LIMIT, max = TOPIC_MAX, exclude = [] } = options
  const skip = new Set((Array.isArray(exclude) ? exclude : []).map((item) => memoryKey(item)))
  const rows = []
  for (const item of allMemoryEntries(state)) {
    // 只列短期层：长期层常驻在「一直记着」，不需要目录指路。
    if (item.scope === 'long') continue
    const entry = item.entry ?? {}
    const id = String(entry.id ?? '').trim()
    const text = String(entry.text ?? '').trim()
    if (id === '' || text === '') continue
    if (entry.resolved === true || entry.promoted === true) continue
    if (skip.has(memoryKey(text))) continue
    rows.push({ id, text })
    if (rows.length >= limit) break
  }
  return renderCatalog(rows, { limit, max })
}

/** `list`：全部编号 + 主题，不带正文。按编号升序，人一眼能对上号。 */
export function listEntries(state, options = {}) {
  const { limit = 200 } = options
  const rows = allMemoryEntries(state)
    .filter((item) => String(item.entry.id ?? '') !== '')
    .map((item) => ({
      id: item.entry.id,
      topic: topicOf(item.entry.text),
      kind: item.kind,
      scope: item.scope,
      at: Number(item.entry.at) || 0,
      session: Number(item.entry.session) || 0,
      hits: Number(item.entry.hits) || 0,
      salience: salienceOf(item.entry),
      pinned: item.entry.pinned === true,
      resolved: item.entry.resolved === true,
      hasRef: item.entry.ref !== null && item.entry.ref !== undefined,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { ok: true, total: rows.length, rows: rows.slice(0, limit) }
}

/**
 * `read`：按编号取一条正文。
 *
 * 返回 `{ ok, id, text, truncated, fullLength, ref, ... }`。
 * 查不到时 `ok: false, reason: 'not-found'` —— 不拿相似的那条冒充。
 *
 * 字数上限按**模型收到的整段**算，不是按正文算：判据量的是输出字数，
 * 所以头部那行和截断说明也占额度，正文留 `max - 头部预留`。
 */
export function readEntry(state, id, options = {}) {
  const { max = FETCH_MAX, reserve = 40 } = options
  const want = String(id ?? '').trim()
  if (want === '') return { ok: false, reason: 'no-id', message: '要给编号，例如 M-003。' }
  const found = findMemoryById(state, want)
  if (!found) {
    // 查不到分两种：从没记过，和记过、后来被淘汰了。墓碑就是用来分开这两句的。
    const gone = findTombstone(state, want)
    if (gone) {
      const why = TOMBSTONE_REASON_TEXT[gone.reason] ?? gone.reason
      const label = gone.id || want
      return {
        ok: false,
        reason: 'evicted',
        id: label,
        kind: gone.kind,
        message: `${label} 在 ${dayOf(gone.at)} 被移出记忆了（${why}）。当时记的是「${gone.topic}」，正文没留；要重新记住，就再说一遍。`,
        evicted: { at: numberOrZero(gone.at), reason: gone.reason, session: numberOrZero(gone.session) },
      }
    }
    return { ok: false, reason: 'not-found', id: want, message: `没有 ${want} 这条。先 list 看有哪些编号。` }
  }
  const entry = found.entry
  const text = String(entry.text ?? '')
  const budget = Math.max(1, max - reserve)
  const truncated = text.length > budget
  const body = truncated ? text.slice(0, budget) : text
  return {
    ok: true,
    id: entry.id,
    kind: found.kind,
    scope: found.scope,
    text: body,
    truncated,
    fullLength: text.length,
    note: truncated ? `（已截断，原文 ${text.length} 字）` : '',
    // ref 原样返回：拿不到就是 null，不编一个「大概在哪」。
    ref: entry.ref ?? null,
    pinned: entry.pinned === true,
    session: Number(entry.session) || 0,
    at: Number(entry.at) || 0,
    hits: Number(entry.hits) || 0,
    salience: salienceOf(entry),
  }
}

/**
 * `search`：词面搜索，返回命中编号 + 主题，不返回正文。
 *
 * 只做「词面包含」：记忆条目只有一句话，上分词器是过度设计。
 * 但要把查询按标点切开——「Node 版本」不该要求整串出现在正文里。
 */
export function searchEntries(state, query, options = {}) {
  const { limit = 20 } = options
  const raw = String(query ?? '').trim()
  if (raw === '') return { ok: false, reason: 'no-query', message: '要给搜索词。' }
  const words = raw
    .split(/[\s,，。；;：:！!？?、()（）[\]【】"'“”]+/u)
    .map((item) => memoryKey(item))
    .filter((item) => item.length >= 2)
  if (words.length === 0) return { ok: false, reason: 'no-query', message: '搜索词太短，两个字起。' }

  const hits = []
  for (const item of allMemoryEntries(state)) {
    const key = memoryKey(item.entry.text)
    const matched = words.filter((word) => key.includes(word))
    if (matched.length === 0) continue
    hits.push({
      id: item.entry.id,
      topic: topicOf(item.entry.text),
      kind: item.kind,
      scope: item.scope,
      matched: matched.length,
    })
  }
  hits.sort((a, b) => b.matched - a.matched || a.id.localeCompare(b.id))
  return { ok: true, query: raw, total: hits.length, rows: hits.slice(0, limit) }
}

/**
 * 把一次 `read` 的结果压成模型真收到的那段文本。
 *
 * 为什么在这里成形而不交给 JSON：取回的目的是「读原文」，
 * 一串 `{"ok":true,"text":"..."}` 里夹着转义和引号，读起来比原文更费钱。
 * 但字数上限仍按**整段**算（判据量的是模型收到的字数），所以头部也计入。
 */
const MISS_TEXT = {
  'no-seq': '条目没有来源指针',
  'no-card': '档案里没有覆盖这个位置的那张卡',
  'no-raw': '那张卡的原文没落盘',
  'no-section': '原文里没有这一段',
  'no-vault': '还没配笔记库，原话取不到',
  'no-room': '额度用满，装不下原话',
}

export function renderRead(result) {
  if (!result || result.ok !== true) return String(result?.message ?? '取回失败。')
  const head = `${result.id}${result.kind ? `（${result.kind}` : ''}${result.scope === 'long' ? '·长期层' : ''}${result.kind ? '）' : ''}`
  const lines = [head, result.text]
  // 原话与来源（2026-11-09）：取回不只给转述，能追回原文就给原文。
  // 追不到要明说，不能让读的人以为「这条没有来源」和「这条有来源但文件丢了」是一回事。
  if (result.original) lines.push(`原话：${result.original}`)
  if (result.originalMissing) lines.push(`原话追不到：${MISS_TEXT[result.originalMissing] ?? result.originalMissing}（不拿别处的话顶）`)
  if (result.note) lines.push(result.note)
  return lines.join('\n')
}
