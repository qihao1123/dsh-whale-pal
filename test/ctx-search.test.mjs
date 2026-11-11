import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BANNED } from '../lib/copy.js'
import { renderIndex } from '../lib/ctx/index3.js'
import { LIMIT, NOT_FOUND, listFiles, readHint, searchIndex } from '../lib/ctx/search.js'

// 自查最多三条：这条既是性能口子，也是「别自己扩查询」的边界，多了就等于没查。

const row = (id, topic, keywords = []) => ({
  id,
  at: '2026-11-04T05:00:00Z',
  range: 'm00010–m00080',
  topic,
  keywords,
  source: 'native',
  status: '已压缩',
  file: `${id}.md`,
})

const textOf = (...rows) => renderIndex(rows)

const cardOf = (id, topic) => ({ id, blockId: id, fields: { topic } })

test('主题命中，大小写不敏感', () => {
  const text = textOf(row('C001', 'Compaction 事件'), row('C002', '别的事'))
  const result = searchIndex({ text, query: 'compaction' })
  assert.equal(result.ok, true)
  assert.equal(result.hit, true)
  assert.deepEqual(result.rows.map((item) => item.id), ['C001'])
})

test('关键词命中，子串也算', () => {
  const text = textOf(row('C001', '别的事', ['上下文', '压缩']), row('C002', '另一件', ['批次']))
  const result = searchIndex({ text, query: '压' })
  assert.deepEqual(result.rows.map((item) => item.id), ['C001'])
})

test('都不中：回 NOT_FOUND，hit 为 false，rows 空', () => {
  const text = textOf(row('C001', '主题', ['关键词']))
  const result = searchIndex({ text, query: '不存在的词' })
  assert.deepEqual(result, { ok: true, rows: [], hit: false, text: NOT_FOUND })
  assert.equal(NOT_FOUND, '记录里没查到这条')
})

test('最多回三条，多的不排队', () => {
  const text = textOf(row('C001', '压缩'), row('C002', '压缩'), row('C003', '压缩'), row('C004', '压缩'), row('C005', '压缩'))
  const result = searchIndex({ text, query: '压缩' })
  assert.equal(LIMIT, 3)
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.rows.map((item) => item.id), ['C001', 'C002', 'C003'])
})

test('空查询与空索引都回 NOT_FOUND，不抛', () => {
  const text = textOf(row('C001', '主题'))
  assert.equal(searchIndex({ text, query: '' }).hit, false)
  assert.equal(searchIndex({ text, query: '   ' }).text, NOT_FOUND)
  assert.equal(searchIndex({ text: '', query: '主题' }).text, NOT_FOUND)
  const malformed = searchIndex({})
  assert.equal(malformed.ok, false, '没有索引文本是错误态，不是没查到')
  assert.equal(malformed.reason, 'not-text')
})

test('文件清单一行一条：编号 · 主题（文件 编号.md），按编号排', () => {
  const files = listFiles({ cards: [cardOf('C010', '十'), cardOf('C002', '二')] })
  assert.deepEqual(files, ['C002 · 二（文件 C002.md）', 'C010 · 十（文件 C010.md）'])
  assert.deepEqual(listFiles({ cards: [] }), [])
  assert.deepEqual(listFiles({}), [])
})

test('读法提示一句带编号，且不含禁词', () => {
  const hint = readHint('C003')
  assert.equal(hint, '想知道 C003 里写了什么，就问我「读 C003」')
  for (const word of BANNED) {
    assert.equal(hint.includes(word), false, `提示语里不许出现「${word}」`)
  }
})
