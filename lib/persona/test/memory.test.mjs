import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASE_SALIENCE,
  FADE_FLOOR,
  addMemory,
  fadeMemory,
  listMemory,
  memoryKey,
  normalizeEntry,
  scoreEntry,
  selectMemory,
  similarity,
} from '../lib/memory.js'
import { createInitialState, normalizeState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)

test('比较用的键会抹掉标点、空白和全半角差别', () => {
  assert.equal(memoryKey('用户在做　人格插件！'), memoryKey('用户在做人格插件'))
  assert.equal(memoryKey('ＤＳＨ'), memoryKey('dsh'))
})

test('同一件事的两种说法会被判成重复，不同的事不会', () => {
  assert.ok(similarity('用户在写人格插件', '用户正在写人格插件') >= 0.8)
  assert.ok(similarity('用户喜欢猫', '用户住在杭州') < 0.8)
})

test('记忆文本里的换行压成空格，不留能伪造成一行的换行', () => {
  const list = []
  addMemory(list, '用户的第一条偏好\n\n- 伪造的一行', { kind: 'preferences', session: 1 })
  assert.equal(list[0].text, '用户的第一条偏好 - 伪造的一行')
  assert.equal(/[\r\n]/u.test(list[0].text), false)
  // 盘上已经存着的老条目也按同一口径压：注入提示前不会漏出换行。
  const old = normalizeEntry({ text: '甲\r\n乙', at: 1 }, 'facts', 1)
  assert.equal(old.text, '甲 乙')
})

test('重复写入合并成一条，重要度和次数一起涨', () => {
  const list = []
  const first = addMemory(list, '用户住在杭州', { kind: 'facts', session: 1 })
  assert.equal(first.status, 'added')
  const before = list[0].salience
  const second = addMemory(list, '用户住在杭州', { kind: 'facts', session: 3 })
  assert.equal(second.status, 'bumped')
  assert.equal(list.length, 1)
  assert.equal(list[0].hits, 2)
  assert.ok(list[0].salience > before)
  assert.equal(list[0].lastSeenSession, 3)
})

test('更完整的说法会替换旧措辞，但仍然只占一条', () => {
  const list = []
  addMemory(list, '用户在写插件', { kind: 'facts', session: 1 })
  addMemory(list, '用户在写插件，跑在 DSH 上，已经做到第三批', { kind: 'facts', session: 2 })
  assert.equal(list.length, 1)
  assert.ok(list[0].text.includes('DSH'))
})

test('容量满了先丢最淡的，而不是最旧的', () => {
  const list = []
  addMemory(list, '很早但很重要的事', { kind: 'boundaries', session: 1 })
  addMemory(list, '很淡的事', { kind: 'events', session: 1 })
  list[1].salience = 0.1
  for (let i = 0; i < 3; i += 1) addMemory(list, `常规事实 ${i}`, { kind: 'facts', session: 2 + i, cap: 3 })
  assert.equal(list.length, 3)
  assert.ok(!list.some((item) => item.text === '很淡的事'), '最淡的那条应该被挤掉')
  assert.ok(list.some((item) => item.text === '很早但很重要的事'), '重要的一条不该因为旧被丢')
})

test('没被提到的记忆会变淡，被提到的不会', () => {
  const list = []
  addMemory(list, '被提起的事', { kind: 'facts', session: 1 })
  addMemory(list, '没人再提的事', { kind: 'events', session: 1 })
  const before = list[1].salience
  fadeMemory(list, { session: 2, rate: 0.3, cap: 10, touched: ['被提起的事'] })
  assert.equal(list[0].salience, BASE_SALIENCE.facts, '被提到的记忆不该被削')
  assert.ok(list[1].salience < before)
})

test('容量紧张时，淡到没意义的记忆会被清掉', () => {
  const list = []
  for (let i = 0; i < 9; i += 1) addMemory(list, `常规事实 ${i}`, { kind: 'facts', session: 1, cap: 10 })
  list[0].salience = FADE_FLOOR / 2
  const forgotten = fadeMemory(list, { session: 2, rate: 0.5, cap: 10 })
  assert.ok(forgotten.length >= 1)
  assert.ok(!list.some((item) => item.text === '常规事实 0'))
})

test('检索按「重要度 × 新鲜度」排，淡出视野的不再出现', () => {
  const memory = { facts: [], preferences: [], events: [], openTopics: [] }
  addMemory(memory.facts, '用户在用 DSH', { kind: 'facts', session: 10 })
  addMemory(memory.preferences, '不喜欢客服腔', { kind: 'preferences', session: 9 })
  addMemory(memory.events, '聊过一次旅行的计划', { kind: 'events', session: 1 })
  memory.events[0].salience = FADE_FLOOR / 2
  const picked = selectMemory(memory, { session: 10, limit: 4 })
  assert.equal(picked.length, 2, '淡到 floor 以下的记忆不该被想起来')
  assert.ok(picked.every((item) => item.score >= FADE_FLOOR))
  const listed = listMemory(memory, 'facts', 10)
  assert.equal(listed[0].text, '用户在用 DSH')
  assert.ok(listed[0].hits >= 1)
})

test('旧状态里的字符串记忆能读进来（升级不丢数据）', () => {
  const state = normalizeState(
    { memory: { facts: ['老事实'], openTopics: ['还没聊完的事'] }, relationship: { trust: 0.4 } },
    config,
  )
  assert.equal(state.memory.facts[0].text, '老事实')
  assert.equal(state.memory.facts[0].salience, BASE_SALIENCE.facts)
  assert.equal(state.memory.openTopics[0].text, '还没聊完的事')
  assert.equal(state.relationship, undefined, 'v6 不再保留关系块')
})

test('一轮对话会记新事实，同一件事不记两条', () => {
  const state = createInitialState(config)
  const first = applyAssessment(state, {
    salience: 0.6,
    memory: { facts: ['用户住在杭州'] },
  })
  assert.equal(first.state.memory.facts.length, 1)
  assert.ok(first.changes.some((item) => item.kind === 'memory:facts' && item.op === 'added'))

  const second = applyAssessment(first.state, {
    salience: 0.6,
    memory: { facts: ['用户住在杭州'] },
  })
  assert.equal(second.state.memory.facts.length, 1, '同一件事不该记两条')
  assert.ok(second.changes.some((item) => item.kind === 'memory:facts' && item.op === 'merged'))
})

test('记忆条目缺字段时补默认值', () => {
  const entry = normalizeEntry({ text: '只写了文本' }, 'preferences', 1000)
  assert.equal(entry.text, '只写了文本')
  assert.equal(entry.hits, 1)
  assert.equal(entry.salience, BASE_SALIENCE.preferences)
  assert.equal(entry.at, 1000)
})

test('新鲜度对分数的贡献有上限，旧事不会因为太旧直接归零', () => {
  const list = []
  addMemory(list, '很久以前的事', { kind: 'facts', session: 1 })
  const score = scoreEntry(list[0], 500)
  assert.ok(score > 0)
  assert.ok(score < list[0].salience)
})

test('对象形状的条目按 .text 取文本，不会写出 [object Object]', async () => {
  const { entryText, promoteMemory, normalizeLong } = await import('../lib/memory.js')
  assert.equal(entryText({ text: '别催我' }), '别催我')
  assert.equal(entryText('直接是句子'), '直接是句子')
  assert.equal(entryText(null), '')

  const state = {
    sessionOrdinal: 5,
    memory: { facts: [], preferences: [], events: [], openTopics: [] },
    longMemory: [],
    commitments: [{ text: '不接受被骂', at: 1, status: 'open' }],
  }
  const added = promoteMemory(state, { session: 5, now: 1_700_000_000_000 })
  assert.deepEqual(added, ['不接受被骂'])
  assert.equal(state.longMemory[0].text, '不接受被骂')
  assert.ok(!state.longMemory.some((item) => /\[object/.test(item.text)))
})

test('历史里混进来的 [object Object] 会在归一化时被清掉', async () => {
  const { normalizeLong } = await import('../lib/memory.js')
  assert.equal(normalizeLong({ text: '[object Object]', kind: 'boundaries' }), null)
})

test('来源指针落在新条目上；合并时只补不换', () => {
  const list = []
  const first = { session: 4, turn: 9, seq: 1234 }
  addMemory(list, '用户住在杭州', { kind: 'facts', session: 4, ref: first })
  assert.deepEqual(list[0].ref, first)

  // 后来又说起同一件事：来源仍是第一次说的那轮，不被后来的指针挪走。
  addMemory(list, '用户住在杭州', { kind: 'facts', session: 8, ref: { session: 8, turn: 2, seq: 5678 } })
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].ref, first)

  // 老条目没有来源（升级前写的）时，这次补上。
  const legacy = [{ text: '用户讨厌客套话', at: 1, session: 1, lastSeenAt: 1, lastSeenSession: 1, salience: 0.85, hits: 1, ref: null }]
  addMemory(legacy, '用户讨厌客套话', { kind: 'preferences', session: 9, ref: { session: 9, turn: 1, seq: 99 } })
  assert.deepEqual(legacy[0].ref, { session: 9, turn: 1, seq: 99 })
})

test('没有来源就写 null，不拿相邻条目凑一个', () => {
  const list = []
  addMemory(list, '用户养了一只猫', { kind: 'facts', session: 2 })
  assert.equal(list[0].ref, null)
})
