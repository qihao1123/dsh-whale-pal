import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TYPES, WAYS, decodeEntries, encodeEntries, extractRules, mergeEntries, renderEntries } from '../lib/ctx/entries.js'

describe('条目抽取与合并', () => {
  it('TYPES 与 WAYS 的取值固定且冻结', () => {
    assert.deepEqual(TYPES, ['事实', '决定', '待办', '偏好'], '四类条目')
    assert.deepEqual(WAYS, ['rule', 'model'], '两种抽取方式')
    assert.equal(Object.isFrozen(TYPES), true, 'TYPES 应冻结')
    assert.equal(Object.isFrozen(WAYS), true, 'WAYS 应冻结')
  })

  it('按行抽四类前缀，允许破折号开头', () => {
    const text = [
      '事实：档案是唯一源',
      '- 决定：按阶段推进',
      '  - 待办：跑测试',
      '- 偏好：中文注释',
      '普通正文不该收',
    ].join('\n')

    assert.deepEqual(
      extractRules(text),
      [
        { type: '事实', content: '档案是唯一源' },
        { type: '决定', content: '按阶段推进' },
        { type: '待办', content: '跑测试' },
        { type: '偏好', content: '中文注释' },
      ],
      '四类都应抽出且保持行序',
    )
  })

  it('内容去空白，空内容与无前缀行不收', () => {
    const text = ['- 事实：   前后有空白   ', '- 决定：', '   ', '事实在句中：不成立'].join('\n')

    assert.deepEqual(extractRules(text), [{ type: '事实', content: '前后有空白' }], '只收有内容的行')
  })

  it('半角冒号也认', () => {
    assert.deepEqual(extractRules('事实:半角冒号'), [{ type: '事实', content: '半角冒号' }], '半角冒号应生效')
  })

  it('同 type 同 content 时 model 覆盖 rule', () => {
    const merged = mergeEntries(
      [{ type: '事实', content: '档案是唯一源', sourceId: 'C001' }],
      [{ type: '事实', content: '档案是唯一源', sourceId: 'C002' }],
    )

    assert.deepEqual(
      merged,
      [{ type: '事实', content: '档案是唯一源', sourceId: 'C002', way: 'model' }],
      'model 的字段应覆盖 rule',
    )
  })

  it('model 新增排在 rule 之后', () => {
    const merged = mergeEntries(
      [{ type: '事实', content: '甲', sourceId: 'C001' }],
      [
        { type: '事实', content: '甲', sourceId: 'C002' },
        { type: '决定', content: '乙', sourceId: 'C002' },
      ],
    )

    assert.equal(merged.length, 2, '覆盖后只留两行')
    assert.equal(merged[0].content, '甲', 'rule 行在前')
    assert.equal(merged[1].content, '乙', 'model 新增在后')
    assert.equal(merged[0].way, 'model', '甲被 model 覆盖')
    assert.equal(merged[1].way, 'model', '新增行方式为 model')
  })

  it('type 不同即使 content 相同也不合并', () => {
    const merged = mergeEntries(
      [{ type: '事实', content: '甲' }],
      [{ type: '决定', content: '甲' }],
    )

    assert.equal(merged.length, 2, '不同类型应各留一行')
  })

  it('坏行一律跳过，不抛异常', () => {
    assert.deepEqual(mergeEntries(null, undefined), [], '非数组回空')
    assert.deepEqual(
      mergeEntries(
        [null, 42, { type: '其它', content: '甲' }, { type: '事实', content: '   ' }],
        [{ type: '事实', content: '乙', way: 'unknown' }],
      ),
      [{ type: '事实', content: '乙', way: 'model' }],
      '坏行跳过，way 非法回落到 model',
    )
  })
})

describe('renderEntries 五列表', () => {
  it('按五列逐字渲染', () => {
    const text = renderEntries([
      { type: '事实', content: '档案是唯一源', sourceId: 'C001', way: 'rule' },
      { type: '待办', content: '跑测试', sourceId: 'C002', way: 'model' },
    ])
    const expected = [
      '| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |',
      '|---|---|---|---|---|',
      '| 1 | 事实 | 档案是唯一源 | C001 | rule |',
      '| 2 | 待办 | 跑测试 | C002 | model |',
      '',
    ].join('\n')

    assert.equal(text, expected, '五列表应与口径逐字一致')
  })

  it('空数组也出表头与分隔行', () => {
    const text = renderEntries([])
    const expected = ['| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |', '|---|---|---|---|---|', ''].join('\n')

    assert.equal(text, expected, '空表也要表头')
  })

  it('内容里的竖线转义，换行压成空格', () => {
    const text = renderEntries([{ type: '事实', content: 'a|b\nc', sourceId: 'C001', way: 'rule' }])

    assert.ok(text.includes('| 1 | 事实 | a\\|b c | C001 | rule |'), '竖线应转义、换行应压平')
  })

  it('坏行跳过，合法行重新连续编号', () => {
    const text = renderEntries([
      null,
      { type: '其它', content: '不收' },
      { type: '事实', content: '   ' },
      { type: '决定', content: '有效', sourceId: 'C003', way: 'model' },
      'bad',
    ])

    assert.ok(text.includes('| 1 | 决定 | 有效 | C003 | model |'), '只有合法行成表')
    assert.equal(text.split('\n').filter((line) => line.startsWith('| 1 |')).length, 1, '编号应从 1 起')
  })

  it('来源编号缺省时留空，抽取方式非法回 rule', () => {
    const text = renderEntries([{ type: '偏好', content: '中文注释' }])

    assert.ok(text.includes('| 1 | 偏好 | 中文注释 |  | rule |'), '缺 sourceId 应留空、way 回 rule')
  })
})

// 模型那一路存在卡片正文里（`- 条目：` 下面几行），所以要有稳的编解码。
describe('条目编解码（卡片里那几行）', () => {
  it('一条一行，「类型：内容」，都标 model', () => {
    const lines = encodeEntries([
      { type: '待办', content: '把批次号接上' },
      { type: '事实', content: '卡片是唯一源' },
    ])

    assert.deepEqual(lines, ['待办：把批次号接上', '事实：卡片是唯一源'])
    assert.deepEqual(decodeEntries(lines), [
      { type: '待办', content: '把批次号接上', way: 'model' },
      { type: '事实', content: '卡片是唯一源', way: 'model' },
    ])
  })

  it('坏行跳过，不因为一行脏字就整张读不出来', () => {
    assert.deepEqual(decodeEntries(['待办：留着', '这是瞎写的', '事实：', '偏好：也留着', '', null]), [
      { type: '待办', content: '留着', way: 'model' },
      { type: '偏好', content: '也留着', way: 'model' },
    ])
    assert.deepEqual(decodeEntries(undefined), [])
  })

  it('带项目符号、全角半角冒号都认；类型不对就不出', () => {
    assert.deepEqual(
      decodeEntries(['- 待办：甲', '* 事实:乙']).map((one) => `${one.type}|${one.content}`),
      ['待办|甲', '事实|乙'],
    )
    assert.deepEqual(encodeEntries([{ type: '杂项', content: '甲' }, { type: '事实', content: '  ' }]), [])
    assert.deepEqual(encodeEntries(undefined), [])
  })

  it('内容里的标点原样留着（只不许换行）', () => {
    const one = { type: '决定', content: '用 /whale ctx entries C007 补，别写成 /status.ctx' }

    assert.deepEqual(decodeEntries(encodeEntries([one])), [{ ...one, way: 'model' }])
  })
})
