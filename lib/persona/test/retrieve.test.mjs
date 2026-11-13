import assert from 'node:assert/strict'
import test from 'node:test'

import { addMemory, assignMemoryIds, formatMemoryId, parseMemoryId } from '../lib/memory.js'
import { CAPS, createInitialState, normalizeState } from '../lib/state/schema.js'
import { DEFAULTS, normalize } from '../lib/config.js'
import {
  CATALOG_LIMIT,
  FETCH_MAX,
  TOPIC_MAX,
  catalogLine,
  catalogOf,
  listEntries,
  readEntry,
  renderCatalog,
  renderRead,
  searchEntries,
  topicOf,
} from '../lib/retrieve.js'

const config = normalize(DEFAULTS)

function stateWithFacts(texts) {
  const state = createInitialState(config)
  for (const text of texts) addMemory(state.memory.facts, text, { kind: 'facts', session: 1, cap: CAPS.facts })
  return normalizeState(state, config)
}

// ---------------------------------------------------------------- 编号

test('编号是 M-001 形状，与会话档案的 C001 一眼能分开', () => {
  assert.equal(formatMemoryId(1), 'M-001')
  assert.equal(formatMemoryId(37), 'M-037')
  assert.equal(parseMemoryId('M-037'), 37)
  // 认不出来的回 0：调用方据此判「没有这个编号」，不猜。
  assert.equal(parseMemoryId('C001'), 0)
  assert.equal(parseMemoryId('M037'), 0)
  assert.equal(parseMemoryId(''), 0)
})

test('补号只发一次：规范化两次编号不变', () => {
  const once = stateWithFacts(['用户在做插件'])
  const twice = normalizeState(JSON.parse(JSON.stringify(once)), config)
  assert.equal(once.memory.facts[0].id, twice.memory.facts[0].id)
})

test('编号不回收：删掉一条，新条目不会复用它的号', () => {
  const state = stateWithFacts(['第一件', '第二件'])
  const firstId = state.memory.facts[0].id
  state.memory.facts.splice(0, 1)
  addMemory(state.memory.facts, '第三件', { kind: 'facts', session: 2, cap: CAPS.facts })
  const again = normalizeState(state, config)
  const ids = again.memory.facts.map((item) => item.id)
  assert.equal(ids.includes(firstId), false, '被删条的号不该让给新条目')
  assert.equal(new Set(ids).size, ids.length, '编号不许重复')
})

test('老条目没有编号时按现有顺序补，不按时间戳重排', () => {
  const state = createInitialState(config)
  state.memory.facts = [
    { text: '较早的事', at: 100, session: 1, salience: 0.5, hits: 1 },
    { text: '较晚的事', at: 900, session: 5, salience: 0.5, hits: 1 },
  ]
  const { assigned } = assignMemoryIds(state, 1000)
  assert.equal(assigned.length, 2)
  assert.equal(state.memory.facts[0].id, 'M-001')
  assert.equal(state.memory.facts[1].id, 'M-002')
  assert.equal(state.memory.facts[0].text, '较早的事', '顺序不许被打乱')
})

// ---------------------------------------------------------------- 主题与目录

test('主题取正文首句，压到 ≤20 字', () => {
  const short = topicOf('用户讨厌客套话')
  assert.equal(short, '用户讨厌客套话')
  const long = topicOf('用户在做 DSH 的人格插件，目标是省钱与防失忆之间找平衡点，这件事已经做了三批')
  assert.equal(long.length <= TOPIC_MAX, true, `主题该 ≤${TOPIC_MAX} 字，实际 ${long.length}`)
  assert.equal(long.endsWith('…'), true)
})

test('目录一行是「编号 · 主题」，整行 ≤20 字', () => {
  const line = catalogLine('M-003', '用户在做 DSH 的人格插件，目标是在省钱与防失忆之间找平衡')
  assert.equal(line.startsWith('M-003 · '), true)
  assert.equal(line.length <= TOPIC_MAX, true, `目录一行该 ≤${TOPIC_MAX} 字，实际 ${line.length}：${line}`)
})

test('目录最多 5 行，空编号或空正文不进目录', () => {
  const entries = []
  for (let i = 1; i <= 9; i += 1) entries.push({ id: `M-00${i}`, text: `第 ${i} 件事` })
  entries.push({ id: '', text: '没有编号' })
  entries.push({ id: 'M-100', text: '' })
  const lines = renderCatalog(entries)
  assert.equal(lines.length, CATALOG_LIMIT)
  assert.equal(lines.every((line) => line.length <= TOPIC_MAX), true)
})

test('目录认两种形状：扁的 {id,text} 和 allMemoryEntries 的 {entry:{id,text}}', () => {
  // 只认一种会让调用方各写一遍 map，写漏一次就是「目录永远是空的」这种静默故障。
  const flat = renderCatalog([{ id: 'M-001', text: '扁形状的事' }])
  const nested = renderCatalog([{ kind: 'facts', scope: 'short', entry: { id: 'M-002', text: '嵌套形状的事' } }])
  assert.equal(flat.length, 1)
  assert.equal(nested.length, 1)
  assert.match(nested[0], /M-002/)
})

test('catalogOf 只列短期层：长期层已经在「一直记着」常驻，不再进目录', () => {
  const state = createInitialState(config)
  state.memory.facts = [{ id: 'M-001', text: '短期的事', at: 1, session: 1, salience: 0.5, hits: 1 }]
  state.longMemory = [{ id: 'M-002', text: '长期的事', kind: 'facts', at: 1, session: 1 }]
  const lines = catalogOf(state)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /M-001/)
  assert.equal(lines.some((line) => line.includes('M-002')), false, '长期层不该进目录')
})

test('catalogOf 跳过已做完与已晋升的条目', () => {
  const state = createInitialState(config)
  state.memory.openTopics = [
    { id: 'M-001', text: '做完的事', at: 1, session: 1, salience: 0.5, hits: 1, resolved: true },
    { id: 'M-002', text: '还在做的事', at: 1, session: 1, salience: 0.5, hits: 1 },
  ]
  const lines = catalogOf(state)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /M-002/)
})

test('catalogOf 的 exclude 按原文比对，躲开「同一件事付两次钱」', () => {
  const state = createInitialState(config)
  state.memory.facts = [
    { id: 'M-001', text: '已经在记得里露过的事', at: 1, session: 1, salience: 0.9, hits: 2 },
    { id: 'M-002', text: '还没露过的事', at: 1, session: 1, salience: 0.5, hits: 1 },
  ]
  const lines = catalogOf(state, { exclude: ['已经在记得里露过的事'] })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /M-002/)
})

// ---------------------------------------------------------------- list / read / search

test('list 列出编号与主题，不带正文', () => {
  const state = stateWithFacts(['用户讨厌客套话', '用户的编辑器是 neovim'])
  const result = listEntries(state)
  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.equal(result.rows.length, 2)
  // 按编号升序，人一眼能对上号。
  assert.deepEqual(result.rows.map((row) => row.id), ['M-001', 'M-002'])
  // 不带正文：只有 topic（≤20 字），没有 text 字段。
  assert.equal(result.rows[0].text, undefined)
  assert.equal(result.rows[0].topic.length <= TOPIC_MAX, true)
})

test('长期层没有 salience 也不许把 list 弄挂：缺省 0，输出仍是合法 JSON', () => {
  const state = stateWithFacts(['短期的一条'])
  // 长期层是「钉住的」，本来就没有打分字段——这才是本机真实的样子。
  state.longMemory = [{ id: 'M-002', text: '钉住的一条', kind: 'facts', at: 1, session: 1 }]
  const result = listEntries(state)
  assert.equal(result.ok, true)
  const row = result.rows.find((item) => item.id === 'M-002')
  assert.equal(row.salience, 0)
  // NaN 会被 JSON.stringify 变成 null，宿主随即判整个返回值 invalid output。
  // 拿回来跟原对象比一遍，就是「工具输出能过宿主那道关」的最小验证。
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('长期层条目 read 得出来，不会因为缺打分字段报错', () => {
  const state = stateWithFacts(['短期的一条'])
  state.longMemory = [{ id: 'M-002', text: '钉住的一条', kind: 'facts', at: 1, session: 1 }]
  const found = readEntry(state, 'M-002')
  assert.equal(found.ok, true)
  assert.equal(found.scope, 'long')
  assert.equal(found.salience, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(found)), found)
})

test('read 按编号取回正文；查不到就说查不到，不拿相似条目冒充', () => {
  const state = stateWithFacts(['用户讨厌客套话'])
  const found = readEntry(state, 'M-001')
  assert.equal(found.ok, true)
  assert.equal(found.text, '用户讨厌客套话')
  assert.equal(found.truncated, false)

  const missing = readEntry(state, 'M-999')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not-found')
  assert.equal(missing.text, undefined, '查不到时不许返回任何正文')
})

test('read 的整段输出 ≤2000 字，超了截断并注明原文多少字', () => {
  const state = createInitialState(config)
  const huge = '长'.repeat(5000)
  state.memory.facts = [{ id: 'M-001', text: huge, at: 1, session: 1, salience: 0.5, hits: 1 }]
  const result = readEntry(state, 'M-001')
  assert.equal(result.ok, true)
  assert.equal(result.truncated, true)
  assert.equal(result.fullLength, 5000)
  assert.match(result.note, /已截断，原文 5000 字/)
  const rendered = renderRead(result)
  assert.equal(rendered.length <= FETCH_MAX, true, `整段该 ≤${FETCH_MAX} 字，实际 ${rendered.length}`)
})

test('read 一条 300 字的记忆原样返回，不带截断提示', () => {
  const state = createInitialState(config)
  const text = '字'.repeat(300)
  state.memory.facts = [{ id: 'M-001', text, at: 1, session: 1, salience: 0.5, hits: 1 }]
  const result = readEntry(state, 'M-001')
  assert.equal(result.text.length, 300)
  assert.equal(result.truncated, false)
  assert.equal(result.note, '')
})

test('search 只返回编号与主题，不返回正文', () => {
  const state = stateWithFacts(['用户的编辑器是 neovim', '用户讨厌客套话'])
  const result = searchEntries(state, 'neovim')
  assert.equal(result.ok, true)
  assert.equal(result.total, 1)
  assert.equal(result.rows[0].id, 'M-001')
  assert.equal(result.rows[0].text, undefined)
  assert.equal(result.rows[0].topic.length <= TOPIC_MAX, true)
})

test('search 按标点切词，不要求整串出现', () => {
  const state = stateWithFacts(['用户的编辑器是 neovim'])
  // 「neovim 编辑器」整串不在正文里，但切开后两个词都能命中。
  const result = searchEntries(state, 'neovim，编辑器')
  assert.equal(result.total, 1)
  assert.equal(result.rows[0].matched, 2)
})

test('search 空词与过短词直接说不行，不返回全表', () => {
  const state = stateWithFacts(['用户讨厌客套话'])
  assert.equal(searchEntries(state, '').ok, false)
  assert.equal(searchEntries(state, '  ').ok, false)
  assert.equal(searchEntries(state, '的').ok, false)
})

test('read 把 ref 原样带出来；没有 ref 就是 null，不编造', () => {
  const state = createInitialState(config)
  state.memory.facts = [
    { id: 'M-001', text: '有出处的事', at: 1, session: 1, salience: 0.5, hits: 1, ref: { session: 3, turn: 7 } },
    { id: 'M-002', text: '没出处的事', at: 1, session: 1, salience: 0.5, hits: 1 },
  ]
  assert.deepEqual(readEntry(state, 'M-001').ref, { session: 3, turn: 7 })
  assert.equal(readEntry(state, 'M-002').ref, null)
})

test('取回带原话，原话追不到时写明是哪一步没成（不混成一句「取不到」）', () => {
  const withOriginal = renderRead({
    ok: true,
    id: 'M-001',
    text: '用户的编辑器是 neovim',
    original: '我的编辑器一直是 neovim，别给我换。',
  })
  assert.match(withOriginal, /^M-001\n用户的编辑器是 neovim\n原话：我的编辑器一直是 neovim，别给我换。$/u)

  const missing = renderRead({ ok: true, id: 'M-002', text: '用户讨厌客套话', originalMissing: 'no-raw' })
  assert.match(missing, /原话追不到：那张卡的原文没落盘（不拿别处的话顶）/u)

  // 没有 ref 的老条目：不写「追不到」——它压根没有来源，不该被当成故障。
  const legacy = renderRead({ ok: true, id: 'M-003', text: '用户养了一只猫' })
  assert.equal(legacy, 'M-003\n用户养了一只猫')
})
