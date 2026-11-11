import assert from 'node:assert/strict'
import { test } from 'node:test'

import { batchId, cardsOfBatch, groupByBatch, nextBatch, rollbackBatch } from '../lib/ctx/batch.js'

// 批次的硬伤只有两处：自增算错，回滚误伤别批。两条都锁死。

const cardOf = (id, batch) => ({ id, blockId: id, batch, gen: 1, source: 'native' })

test('空数组从 B001 起', () => {
  assert.equal(nextBatch([]), 'B001')
  assert.equal(nextBatch(undefined), 'B001')
  assert.equal(nextBatch(['乱七八糟']), 'B001')
})

test('接着最大的往下走：B004 后面是 B005', () => {
  assert.equal(nextBatch(['B001', 'B004']), 'B005')
  assert.equal(nextBatch(['B004', 'B001', 'B002']), 'B005')
  assert.equal(nextBatch(['B009', 'B010']), 'B011', '按数值比，不按字面比')
})

test('补零三位，过 999 自然变四位', () => {
  assert.equal(nextBatch(['B999']), 'B1000')
  assert.equal(batchId({ seq: 7 }), 'B007')
  assert.equal(batchId({ seq: 1000 }), 'B1000')
})

test('batchId 只认 seq，不读 now', () => {
  assert.equal(batchId({ now: '2026-11-04T05:00:00Z', seq: 12 }), 'B012')
  assert.equal(batchId({ now: '2000-01-01T00:00:00Z', seq: 12 }), 'B012')
  assert.equal(batchId({ seq: 0 }), null)
  assert.equal(batchId({ seq: undefined }), null)
  assert.equal(batchId({}), null, '序号由调用方数好，本文件不自己数')
})

test('回滚只摘本批，别批一个不动', () => {
  const cards = [cardOf('C001', 'B001'), cardOf('C002', 'B002'), cardOf('C003', 'B001')]
  const result = rollbackBatch({ cards, batch: 'B001' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.removed, ['C001', 'C003'])
  assert.deepEqual(result.kept.map((card) => card.id), ['C002'])
})

test('回滚不改入参，两个数组都是新的', () => {
  const cards = [cardOf('C001', 'B001'), cardOf('C002', 'B002')]
  const before = JSON.stringify(cards)
  const keptRef = cards
  const result = rollbackBatch({ cards, batch: 'B002' })
  assert.equal(JSON.stringify(cards), before)
  assert.equal(cards, keptRef)
  assert.notEqual(result.kept, cards)
  assert.notEqual(result.removed, cards)
})

test('回滚：一批都没命中时 kept 原样，removed 空', () => {
  const cards = [cardOf('C001', 'B001')]
  const result = rollbackBatch({ cards, batch: 'B099' })
  assert.deepEqual(result.removed, [])
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0].id, 'C001')
})

test('回滚：坏入参回 ok:false，不抛', () => {
  assert.deepEqual(rollbackBatch({ cards: undefined, batch: 'B001' }), { ok: false, reason: 'not-array' })
  assert.deepEqual(rollbackBatch({ cards: [], batch: '' }), { ok: false, reason: 'no-batch' })
  assert.doesNotThrow(() => rollbackBatch())
})

test('归堆：批次号升序，没有号的归到最后', () => {
  const cards = [cardOf('C003', 'B002'), cardOf('C001', 'B001'), cardOf('C002', 'B001'), cardOf('C004', '')]
  const groups = groupByBatch(cards)
  assert.deepEqual(groups.map((group) => group.batch), ['B001', 'B002', ''])
  assert.deepEqual(groups[0].cards.map((card) => card.id), ['C001', 'C002'])
  assert.deepEqual(groups[2].cards.map((card) => card.id), ['C004'])
  assert.deepEqual(groupByBatch(undefined), [])
})

test('归堆：B009 排在 B010 前面，按数值不按字面', () => {
  const groups = groupByBatch([cardOf('C001', 'B010'), cardOf('C002', 'B009')])
  assert.deepEqual(groups.map((group) => group.batch), ['B009', 'B010'])
})

test('按批次摘卡片：空号回空数组，不改入参', () => {
  const cards = [cardOf('C001', 'B001'), cardOf('C002', 'B002')]
  const before = JSON.stringify(cards)
  assert.deepEqual(cardsOfBatch({ cards, batch: 'B002' }).map((card) => card.id), ['C002'])
  assert.deepEqual(cardsOfBatch({ cards, batch: '  ' }), [])
  assert.deepEqual(cardsOfBatch({ cards, batch: 'B099' }), [])
  assert.equal(JSON.stringify(cards), before)
})
