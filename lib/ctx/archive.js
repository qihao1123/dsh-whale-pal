/**
 * 上下文档案：五格解析、编号、卡片渲染与读回。
 *
 * 口径出处：`融合计划-v2.md` §16.4（五格、摘要 200–2000 字）与
 * `docs/P35-补全.md` 第四节（`C001` 起三位，过 999 变四位）。
 * 卡片首行是 HTML 注释，存 block/id/gen/batch/source/at；正文五条
 * `- 标签：值`。`at` 是调用方给的 ISO 字符串，本模块不看时钟。
 *
 * 纯函数：不读盘、不读环境变量。解析不出来回 `{ok:false, reason}`，不抛异常。
 * 摘要字数按去首尾空白后的 Unicode 码点数算（一个码点算一个字符）。
 */

import { decodeEntries, encodeEntries, mergeEntries } from './entries.js'

export const FIELD_LABELS = Object.freeze(['范围', '主题', '摘要', '关键词', '没消化完的'])
export const RANGE_RE = Object.freeze(/^[A-Za-z]?\d+\s*[–\-~]\s*[A-Za-z]?\d+$/)

const ID_RE = Object.freeze(/^C\d{3,4}$/)
const SUMMARY_MIN = 200
const SUMMARY_MAX = 2000
const KEYWORD_MIN = 3
const KEYWORD_MAX = 5
const CARD_HEAD_RE = Object.freeze(/^<!-- whale-context block=([^\s]+) id=([^\s]+) gen=(\d+) batch=([^\s]+) source=([^\s]+) at=([^\s]+) -->$/)
const TITLE_RE = Object.freeze(/^### (C\d{3,4}) · (.+)$/)
const FIELD_LINE_RE = Object.freeze(/^- (范围|主题|摘要|关键词|没消化完的|条目)：(.*)$/)

const charCount = (text) => Array.from(text).length
const isText = (value) => typeof value === 'string' && value !== '' && !/\s/.test(value)

function splitKeywords(value) {
  if (typeof value !== 'string' || value === '') return []
  return value
    .split(/[、，,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

export function parseSummary(text) {
  const source = typeof text === 'string' ? text : ''
  const found = new Map()

  for (const line of source.split(/\r?\n/)) {
    const matched = /^\s*(?:[-*]\s*)?(范围|主题|摘要|关键词|没消化完的)\s*[：:]\s*(.*)$/.exec(line)
    if (matched && !found.has(matched[1])) found.set(matched[1], matched[2].trim())
  }

  const errors = []
  const read = (label) => {
    if (!found.has(label)) {
      errors.push(`缺 ${label}`)
      return ''
    }
    return found.get(label)
  }

  const range = read('范围')
  const topic = read('主题')
  const summary = read('摘要')
  const keywordText = read('关键词')
  const unfinishedRaw = read('没消化完的')

  if (found.has('范围') && !RANGE_RE.test(range)) errors.push('范围格式不对')
  if (found.has('主题') && topic === '') errors.push('主题为空')

  const summaryLength = charCount(summary)
  if (found.has('摘要') && (summaryLength < SUMMARY_MIN || summaryLength > SUMMARY_MAX)) {
    errors.push(`摘要字数 ${summaryLength} 不在 ${SUMMARY_MIN}–${SUMMARY_MAX}`)
  }

  const keywords = splitKeywords(keywordText)
  if (found.has('关键词') && (keywords.length < KEYWORD_MIN || keywords.length > KEYWORD_MAX)) {
    errors.push(`关键词 ${keywords.length} 个，需 ${KEYWORD_MIN}–${KEYWORD_MAX} 个`)
  }

  const unfinished = unfinishedRaw === '' ? '无' : unfinishedRaw

  return {
    ok: errors.length === 0,
    fields: { range, topic, summary, keywords, unfinished },
    errors,
  }
}

export function nextId(list) {
  if (!Array.isArray(list) || list.length === 0) return 'C001'

  const parse = (value) => {
    if (typeof value !== 'string') return null
    const matched = /^[A-Za-z]?(\d+)$/.exec(value.trim())
    if (!matched) return null
    const number = Number(matched[1])
    return Number.isSafeInteger(number) && number >= 0 ? number : null
  }

  let current = parse(list[list.length - 1])

  if (current === null) {
    current = 0
    for (const value of list) {
      const number = parse(value)
      if (number !== null && number > current) current = number
    }
  }

  return `C${String(current + 1).padStart(3, '0')}`
}

function normalizeFields(fields) {
  if (fields === null || typeof fields !== 'object') return null

  const range = typeof fields.range === 'string' ? fields.range.trim() : ''
  const topic = typeof fields.topic === 'string' ? fields.topic.trim() : ''
  const summary = typeof fields.summary === 'string' ? fields.summary.trim() : ''
  const keywords = Array.isArray(fields.keywords)
    ? fields.keywords.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
    : splitKeywords(fields.keywords)
  const unfinishedInput = fields.unfinished
  const unfinished =
    unfinishedInput === undefined || unfinishedInput === null || String(unfinishedInput).trim() === ''
      ? '无'
      : String(unfinishedInput).trim()

  if (!RANGE_RE.test(range)) return null
  if (topic === '') return null
  if (summary === '') return null
  // 200–2000 字与关键词 3–5 个是「按模板写摘要」那一路的校验（见 parseSummary），
  // 不是落档这一路的：宿主自动压缩给多长就存多长，多行也原样留着，
  // 关键词是算出来的，算不出三个就照实少写，不编。
  for (const value of [range, topic, unfinished]) {
    if (/[\r\n]/.test(value)) return null
  }

  return { range, topic, summary, keywords, unfinished, entries: mergeEntries([], fields.entries) }
}

export function renderCard(input) {
  if (input === null || typeof input !== 'object') return { ok: false, reason: 'card-incomplete' }

  const { id, blockId, batch, gen, source, at, fields } = input
  const normalized = normalizeFields(fields)

  if (normalized === null) return { ok: false, reason: 'card-incomplete' }
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: 'card-incomplete' }
  if (!isText(blockId) || !isText(batch) || !isText(source) || !isText(at)) {
    return { ok: false, reason: 'card-incomplete' }
  }
  if (!Number.isInteger(gen) || gen < 1) return { ok: false, reason: 'card-incomplete' }

  // 摘要可能多行：第二行起缩进两格，读回来再拼回去，一个字都不丢。
  const summaryLines = normalized.summary.split('\n')
  const summaryBlock = [
    `- 摘要：${summaryLines[0]}`,
    ...summaryLines.slice(1).map((line) => `  ${line}`),
  ]
  // 模型补的条目：有才写这一格，没有就不留空行（老卡片一个字节都不变）。
  const entryLines = encodeEntries(normalized.entries)
  const lines = [
    `<!-- whale-context block=${blockId} id=${id} gen=${gen} batch=${batch} source=${source} at=${at} -->`,
    `### ${id} · ${normalized.topic}`,
    `- 范围：${normalized.range}`,
    `- 主题：${normalized.topic}`,
    ...summaryBlock,
    `- 关键词：${normalized.keywords.join('、')}`,
    `- 没消化完的：${normalized.unfinished}`,
    ...(entryLines.length === 0 ? [] : ['- 条目：', ...entryLines.map((line) => `  - ${line}`)]),
  ]

  return `${lines.join('\n')}\n`
}

export function readCard(text) {
  if (typeof text !== 'string' || text === '') return { ok: false, reason: 'card-unreadable' }

  const lines = text.split(/\r?\n/)
  let head = null
  let title = null
  const values = new Map()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (head === null) {
      const matched = CARD_HEAD_RE.exec(line)
      if (matched) {
        head = matched
        continue
      }
    }
    if (title === null) {
      const matched = TITLE_RE.exec(line)
      if (matched) {
        title = matched
        continue
      }
    }
    const matched = FIELD_LINE_RE.exec(line)
    if (!matched) continue
    const label = matched[1]
    let value = matched[2].trim()
    if (label === '摘要') {
      // 摘要的第二行起是缩进两格的续行，原样拼回换行。
      const extra = []
      let cursor = index + 1
      while (cursor < lines.length && /^ {2}/.test(lines[cursor])) {
        extra.push(lines[cursor].slice(2))
        cursor += 1
      }
      if (extra.length > 0) {
        value = [value, ...extra].join('\n')
        index = cursor - 1
      }
    }
    if (label === '条目') {
      // 条目也是一串缩进两格的续行，每行一条「类型：内容」；这一格是数组，不是字符串。
      const extra = []
      let cursor = index + 1
      while (cursor < lines.length && /^ {2}/.test(lines[cursor])) {
        extra.push(lines[cursor].trim())
        cursor += 1
      }
      if (!values.has('条目')) values.set('条目', extra)
      index = cursor - 1
      continue
    }
    if (!values.has(label)) values.set(label, value)
  }

  if (head === null || title === null) return { ok: false, reason: 'card-unreadable' }
  if (head[2] !== title[1]) return { ok: false, reason: 'card-unreadable' }

  for (const label of FIELD_LABELS) {
    if (!values.has(label)) return { ok: false, reason: 'card-unreadable' }
  }

  const topic = values.get('主题')
  if (topic !== title[2].trim()) return { ok: false, reason: 'card-unreadable' }

  const keywords = splitKeywords(values.get('关键词'))

  return {
    ok: true,
    id: head[2],
    blockId: head[1],
    gen: Number(head[3]),
    batch: head[4],
    source: head[5],
    at: head[6],
    fields: {
      range: values.get('范围'),
      topic,
      summary: values.get('摘要'),
      keywords,
      unfinished: values.get('没消化完的'),
      // 只有模型补过才有这一行；老卡片上没这一格，读出来是空数组。
      entries: decodeEntries(values.get('条目')),
    },
  }
}
