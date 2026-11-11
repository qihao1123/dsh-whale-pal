import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INDEX_DIVIDER,
  INDEX_HEADER,
  parseIndex,
  renderIndex,
  renderIndexRow,
  rowOf,
  statusOf,
} from '../lib/ctx/index3.js'

// 八列表是索引的唯一形状。这里锁的都是「拆格别拆错」这类硬伤：
// 一格写歪，整张表就错列，重建和自查都会跟着错。

const card = (over = {}) => ({
  id: 'C001',
  blockId: 'C001',
  gen: 1,
  batch: 'B001',
  source: 'native',
  at: '2026-11-04T05:00:00Z',
  fields: { range: 'm00010–m00080', topic: '主题', summary: '摘要', keywords: ['a', 'b', 'c'], unfinished: '' },
  ...over,
})

const rowOfCard = {
  id: 'C001',
  at: '2026-11-04T05:00:00Z',
  range: 'm00010–m00080',
  topic: '主题',
  keywords: ['a', 'b', 'c'],
  source: 'native',
  status: '已压缩',
  file: 'C001.md',
}

test('表头与分隔行都是八列，逐字不动', () => {
  assert.equal(INDEX_HEADER, '| 编号 | 时间 | 范围 | 主题 | 关键词 | 来源 | 状态 | 摘要文件 |')
  assert.equal(INDEX_DIVIDER.split('|').filter((piece) => piece !== '').length, 8)
  const parsed = parseIndex(`${INDEX_HEADER}\n${INDEX_DIVIDER}\n`)
  assert.deepEqual(parsed.rows, [])
  assert.equal(parsed.skipped, 0, '表头与分隔行不算坏行')
})

test('一行八格渲染逐字对齐，解析回来还是那八格', () => {
  const line = renderIndexRow(rowOfCard)
  assert.equal(line, '| C001 | 2026-11-04T05:00:00Z | m00010–m00080 | 主题 | a、b、c | native | 已压缩 | C001.md |')
  const parsed = parseIndex(`${INDEX_HEADER}\n${INDEX_DIVIDER}\n${line}\n`)
  assert.deepEqual(parsed.rows, [rowOfCard])
  assert.equal(parsed.skipped, 0)
})

test('主题与关键词里的竖线被转义，不会把一行拆成多列', () => {
  const row = { ...rowOfCard, topic: '主题|带竖线', keywords: ['a|b', 'c'] }
  const line = renderIndexRow(row)
  assert.ok(line.includes('主题\\|带竖线'), '竖线必须写成 \\|')
  assert.ok(line.includes('a\\|b、c'))
  const parsed = parseIndex(`${INDEX_HEADER}\n${INDEX_DIVIDER}\n${line}\n`)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].topic, '主题|带竖线')
  assert.deepEqual(parsed.rows[0].keywords, ['a|b', 'c'])
})

test('坏行跳过并计数，好行照收', () => {
  const text = [
    INDEX_HEADER,
    INDEX_DIVIDER,
    '| C001 | 只 | 六 | 格 |',
    '随便一句话',
    renderIndexRow(rowOfCard),
  ].join('\n')
  const parsed = parseIndex(text)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].id, 'C001')
  assert.equal(parsed.skipped, 2, '少列一行和散句各记一次')
})

test('空输入不抛：空表只出表头与分隔行', () => {
  assert.deepEqual(parseIndex(''), { ok: true, rows: [], skipped: 0 })
  assert.deepEqual(parseIndex(undefined), { ok: false, reason: 'not-text', rows: [], skipped: 0 })
  assert.equal(renderIndex([]), `${INDEX_HEADER}\n${INDEX_DIVIDER}\n`)
})

test('卡片折成一行：待确认照抄，文件名取 blockId', () => {
  assert.equal(statusOf(card()), '已压缩')
  assert.equal(statusOf(card({ status: '待确认' })), '待确认')
  assert.equal(statusOf(undefined), '已压缩')
  const row = rowOf(card({ id: 'C007', blockId: 'C007', status: '待确认' }))
  assert.deepEqual(row, { ...rowOfCard, id: 'C007', status: '待确认', file: 'C007.md' })
})
