import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ASK_AGAIN, normalizeToken, parseConfirm } from '../lib/token.js'

// D4 的口径是「只认原文那条判法」。这里把能想到的乱输入全摆上，
// 一条都不许过——门禁一旦松一格，后面每次「替你按一下」都显得合理。

const REFUSE = ['对', '好', '可以', '嗯', 'OK', 'ok', '继续', '行', '是的', '没问题', '', '   ', '确定', '确认', '确定阶段', '确定工序 3']

test('纯肯定词与沉默一律不认', () => {
  for (const raw of REFUSE) {
    const result = parseConfirm(raw, { pending: 3 })
    assert.equal(result.ok, false, `「${raw}」不该通过门禁`)
    assert.ok(result.reason, '拒绝要给理由码，别静默')
  }
})

test('阶段号必须等于当前待确认的号', () => {
  assert.equal(parseConfirm('确定stage 3 阶段', { pending: 3 }).ok, true)
  assert.equal(parseConfirm('确定stage 2 阶段', { pending: 3 }).ok, false)
  assert.equal(parseConfirm('确定stage 3 阶段', { pending: 3 }).reason, undefined)
  assert.equal(parseConfirm('确定stage 2 阶段', { pending: 3 }).reason, 'wrong-stage')
})

test('没有待确认项时，谁来按都不算', () => {
  const result = parseConfirm('确定stage 1 阶段', { pending: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'nothing-pending')
})

test('全半角、大小写、空格都归一', () => {
  for (const raw of ['确定stage 3 阶段', '确定 Stage3 阶段', '确定ｓｔａｇｅ ３ 阶段', '  确定  stage  3  阶段  ', '确认stage3阶段']) {
    assert.equal(parseConfirm(raw, { pending: 3 }).ok, true, `「${raw}」应当认`)
  }
})

test('汉字阶段号也认', () => {
  for (const [raw, n] of [['确定三阶段', 3], ['确认 stage 六 阶段', 6], ['确定一阶段', 1]]) {
    assert.equal(parseConfirm(raw, { pending: n }).ok, true, `「${raw}」应当认`)
  }
})

test('确定工序 M 是另一套号，不与阶段口令混用', () => {
  const result = parseConfirm('确定工序 3', { pending: 3 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'workstep-token')
})

test('回问只有一句，不改口也不解释', () => {
  assert.match(ASK_AGAIN, /确定stage/u)
  assert.equal(normalizeToken('  确定 Stage 3 阶段 '), '确定stage3阶段')
})

test('口令夹在整句里也算：D4 的口径是「含」', () => {
  assert.deepEqual(parseConfirm('按你的理解，没问题；确定stage 4 阶段', { pending: 4 }), { ok: true, stage: 4 })
  assert.deepEqual(parseConfirm('三种安装形态按你的理解；确定stage 2 阶段', { pending: 2 }), { ok: true, stage: 2 })
})

test('前面挂否定词的不算：那是犹豫，不是按了', () => {
  assert.equal(parseConfirm('我不确定stage 4 阶段', { pending: 4 }).reason, 'not-a-token')
  assert.equal(parseConfirm('还没确定stage 4 阶段', { pending: 4 }).reason, 'not-a-token')
  assert.equal(parseConfirm('别确定stage 4 阶段', { pending: 4 }).reason, 'not-a-token')
})

test('只说了「确定」没给阶段号：按没说清处理', () => {
  assert.equal(parseConfirm('确定一下', { pending: 4 }).reason, 'no-stage')
  assert.equal(parseConfirm('确定可以', { pending: 4 }).reason, 'no-stage')
})
