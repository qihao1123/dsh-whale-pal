import assert from 'node:assert/strict'
import { test } from 'node:test'

import { INDEX_DIVIDER, INDEX_HEADER, renderIndex } from '../lib/ctx/index3.js'
import { rebuildFromCards } from '../lib/ctx/rebuild.js'

// 重建只组装、不落盘：入参顺序不许影响结果，三份文本必须能直接写出去。
// 条目那一路用假模块锁形状，真人写的 entries.js 到位后换 import 也不改这些断言。

const card = (id, topic, keywords, summary = '摘要正文') => ({
  id,
  blockId: id,
  gen: 1,
  batch: 'B001',
  source: 'native',
  at: '2026-11-04T05:00:00Z',
  fields: { range: 'm00010–m00080', topic, summary, keywords, unfinished: '' },
})

const FAKE_ENTRIES = {
  extractRules: (text) =>
    String(text).startsWith('决定') ? [{ type: '决定', content: String(text).slice(0, 4) }] : [],
  renderEntries: (rows) =>
    [
      '| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |',
      '|---|---|---|---|---|',
      ...rows.map((row, index) => `| ${index + 1} | ${row.type} | ${row.content} | ${row.sourceId} | ${row.way} |`),
    ].join('\n') + '\n',
}

const idsOf = (indexText) =>
  indexText
    .split('\n')
    .filter((line) => line.startsWith('| C'))
    .map((line) => line.split('|')[1].trim())

test('两份文本一次装齐，编号全进索引', () => {
  const result = rebuildFromCards([card('C001', '主题一', ['上下文', '压缩'])], FAKE_ENTRIES)
  assert.equal(result.ok, true)
  assert.equal(result.reason, undefined)
  assert.ok(result.indexText.startsWith(INDEX_HEADER))
  assert.deepEqual(idsOf(result.indexText), ['C001'])
  assert.equal('keywordsText' in result, false)
})

test('C002 排在 C010 前：入参乱序不影响结果', () => {
  const shuffled = [card('C010', '十', ['k']), card('C002', '二', ['k']), card('C001', '一', ['k'])]
  const result = rebuildFromCards(shuffled, FAKE_ENTRIES)
  assert.deepEqual(idsOf(result.indexText), ['C001', 'C002', 'C010'])
})

test('条目走 rule 这一路：来源编号是本卡，抽取方式是 rule', () => {
  const result = rebuildFromCards([card('C002', '二', ['k'], '决定要拆模块')], FAKE_ENTRIES)
  assert.ok(result.entriesText.includes('| 1 | 决定 | 决定要拆 | C002 | rule |'))
  assert.equal(result.entriesText.startsWith('| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |'), true)
})

test('空卡片数组：都只剩表头形式', () => {
  const result = rebuildFromCards([], FAKE_ENTRIES)
  assert.equal(result.ok, true)
  assert.equal(result.indexText, renderIndex([]))
  assert.equal(result.entriesText, '| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |\n|---|---|---|---|---|\n')
  assert.equal(result.indexText, `${INDEX_HEADER}\n${INDEX_DIVIDER}\n`)
})

test('条目模块不在：只出五列表头，带 entries-unavailable，不抛', () => {
  const result = rebuildFromCards([card('C001', '主题一', ['k'])], {})
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'entries-unavailable')
  assert.ok(result.entriesText.startsWith('| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |'))
  assert.deepEqual(idsOf(result.indexText), ['C001'], '索引与关键词不受条目模块影响')
})

test('条目模块抛错也兜住，不让异常冒到调用方', () => {
  const broken = { ...FAKE_ENTRIES, extractRules: () => { throw new Error('坏掉了') } }
  assert.doesNotThrow(() => rebuildFromCards([card('C001', '主题一', ['k'])], broken))
  const result = rebuildFromCards([card('C001', '主题一', ['k'])], broken)
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'entries-unavailable')
})

test('不改入参，两次调用逐字一致', () => {
  const cards = [card('C002', '二', ['k']), card('C001', '一', ['k'])]
  const before = JSON.stringify(cards)
  const first = rebuildFromCards(cards, FAKE_ENTRIES)
  const second = rebuildFromCards(cards, FAKE_ENTRIES)
  assert.equal(JSON.stringify(cards), before)
  assert.deepEqual(first, second)
  assert.notEqual(first.indexText, undefined)
})

test('非数组入参回 ok:false，不抛', () => {
  assert.deepEqual(rebuildFromCards(undefined, FAKE_ENTRIES), { ok: false, reason: 'not-array' })
  assert.deepEqual(rebuildFromCards('C001', FAKE_ENTRIES), { ok: false, reason: 'not-array' })
})

// 模型补的那一路存在卡片里（`- 条目：` 那几行），重建时跟规则那一路合到一张表。
test('卡片里模型补的条目也进表：同「类型 + 内容」时 model 覆盖 rule', () => {
  const one = card('C001', '一', ['k'], '决定要拆模块')
  one.fields = { ...one.fields, entries: [{ type: '决定', content: '决定要拆', way: 'model' }] }
  const result = rebuildFromCards([one], FAKE_ENTRIES)

  assert.ok(result.entriesText.includes('| 1 | 决定 | 决定要拆 | C001 | model |'), 'model 覆盖 rule')
  assert.equal(result.entriesText.trim().split('\n').length, 3, '覆盖不是新增一行')
})

test('模型新补的排在规则后面，来源编号是本卡', () => {
  const one = card('C001', '一', ['k'], '决定要拆模块')
  one.fields = { ...one.fields, entries: [{ type: '待办', content: '把批次号接上' }] }
  const lines = rebuildFromCards([one], FAKE_ENTRIES).entriesText.trim().split('\n').slice(2)

  assert.equal(lines[0].includes('| rule |'), true)
  assert.equal(lines[1], '| 2 | 待办 | 把批次号接上 | C001 | model |')
})

test('脏条目行不进表，也不把整张表搞坏', () => {
  const one = card('C001', '一', ['k'], '普通摘要')
  one.fields = { ...one.fields, entries: [{ type: '瞎写', content: '甲' }, null, { type: '事实' }] }
  const result = rebuildFromCards([one], FAKE_ENTRIES)

  assert.equal(result.entriesText.trim().split('\n').length, 2, '只剩表头与分隔行')
  assert.equal(result.ok, true)
})
