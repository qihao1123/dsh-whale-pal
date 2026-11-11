import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FIELD_LABELS, nextId, parseSummary, readCard, renderCard } from '../lib/ctx/archive.js'

const SUMMARY_200 = '摘'.repeat(200)

function makeText(overrides = {}) {
  const values = {
    范围: '1–10',
    主题: '上下文档案',
    摘要: SUMMARY_200,
    关键词: '甲、乙、丙',
    没消化完的: '无',
    ...overrides,
  }

  return Object.entries(values)
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `- ${label}：${value}`)
    .join('\n')
}

function makeFields(overrides = {}) {
  return {
    range: '1–10',
    topic: '上下文档案',
    summary: SUMMARY_200,
    keywords: ['甲', '乙', '丙'],
    unfinished: '无',
    // 第六格是模型补的条目，可选：没补过读回来就是空数组。
    entries: [],
    ...overrides,
  }
}

describe('parseSummary 五格校验', () => {
  it('五格齐全且合规时解析成功', () => {
    const parsed = parseSummary(makeText())

    assert.equal(parsed.ok, true, '合规文本应通过')
    assert.deepEqual(parsed.errors, [], '不应有错误')
    assert.deepEqual(
      parsed.fields,
      { range: '1–10', topic: '上下文档案', summary: SUMMARY_200, keywords: ['甲', '乙', '丙'], unfinished: '无' },
      '五格应解回来',
    )
  })

  it('五格缺任何一格都不收，并给中文错误', () => {
    for (const label of FIELD_LABELS) {
      const parsed = parseSummary(makeText({ [label]: null }))
      assert.equal(parsed.ok, false, `缺 ${label} 应被拒`)
      assert.ok(parsed.errors.includes(`缺 ${label}`), `错误里应写缺 ${label}`)
    }
  })

  it('摘要字数边界：199 拒、200 收、2000 收、2001 拒', () => {
    const at199 = parseSummary(makeText({ 摘要: '摘'.repeat(199) }))
    const at200 = parseSummary(makeText({ 摘要: '摘'.repeat(200) }))
    const at2000 = parseSummary(makeText({ 摘要: '摘'.repeat(2000) }))
    const at2001 = parseSummary(makeText({ 摘要: '摘'.repeat(2001) }))

    assert.equal(at199.ok, false, '199 字应被拒')
    assert.ok(at199.errors[0].startsWith('摘要字数 199'), '应报 199 字')
    assert.equal(at200.ok, true, '200 字应收')
    assert.equal(at2000.ok, true, '2000 字应收')
    assert.equal(at2001.ok, false, '2001 字应被拒')
    assert.ok(at2001.errors[0].startsWith('摘要字数 2001'), '应报 2001 字')
  })

  it('摘要先去掉首尾空白再数字数', () => {
    const parsed = parseSummary(makeText({ 摘要: `  ${SUMMARY_200}  ` }))

    assert.equal(parsed.ok, true, '首尾空白不应计入')
    assert.equal(parsed.fields.summary, SUMMARY_200, '解析结果应去空白')
  })

  it('摘要字数按 Unicode 码点算，不按 UTF-16 长度', () => {
    const parsed = parseSummary(makeText({ 摘要: '😀'.repeat(200) }))

    assert.equal(parsed.ok, true, '200 个码点应收')
  })

  it('关键词边界：2 拒、3 收、5 收、6 拒', () => {
    assert.equal(parseSummary(makeText({ 关键词: '甲、乙' })).ok, false, '2 个应被拒')
    assert.equal(parseSummary(makeText({ 关键词: '甲、乙、丙' })).ok, true, '3 个应收')
    assert.equal(parseSummary(makeText({ 关键词: '甲、乙、丙、丁、戊' })).ok, true, '5 个应收')
    assert.equal(parseSummary(makeText({ 关键词: '甲、乙、丙、丁、戊、己' })).ok, false, '6 个应被拒')
  })

  it('关键词按顿号、全角逗号、半角逗号切开', () => {
    const parsed = parseSummary(makeText({ 关键词: '甲,乙，丙、丁' }))

    assert.deepEqual(parsed.fields.keywords, ['甲', '乙', '丙', '丁'], '三种分隔符都应生效')
    assert.equal(parsed.ok, true, '4 个关键词应收')
  })

  it('范围必须能匹配编号区间形状', () => {
    for (const range of ['1–10', 'C1-C9', 'A12~B20']) {
      assert.equal(parseSummary(makeText({ 范围: range })).ok, true, `范围 ${range} 应收`)
    }
    for (const range of ['1', 'abc', '1到9', 'C1']) {
      const parsed = parseSummary(makeText({ 范围: range }))
      assert.equal(parsed.ok, false, `范围 ${range} 应被拒`)
      assert.ok(parsed.errors.includes('范围格式不对'), '应报范围格式不对')
    }
  })

  it('没消化完的留空时归一成「无」', () => {
    const parsed = parseSummary(makeText({ 没消化完的: '' }))

    assert.equal(parsed.ok, true, '留空不算缺格')
    assert.equal(parsed.fields.unfinished, '无', '空值应归一成无')
  })

  it('非字符串入参不抛，按五格全缺处理', () => {
    for (const input of [null, undefined, 42, {}]) {
      assert.doesNotThrow(() => parseSummary(input), '坏入参不应抛')
      const parsed = parseSummary(input)
      assert.equal(parsed.ok, false, '坏入参应被拒')
      assert.equal(parsed.errors.length, 5, '应报五格全缺')
    }
  })
})

describe('nextId 编号只增不减', () => {
  it('空数组从 C001 起', () => {
    assert.equal(nextId([]), 'C001', '空数组应回 C001')
    assert.equal(nextId(null), 'C001', '非数组应回 C001')
  })

  it('按最后一个编号加一并补零三位', () => {
    assert.equal(nextId(['C001']), 'C002', 'C001 之后是 C002')
    assert.equal(nextId(['C001', 'C003']), 'C004', '应取最后一个 C003 加一')
    assert.equal(nextId(['C003', 'C001']), 'C002', '按最后一个算，不按最大算')
  })

  it('999 之后变四位 C1000', () => {
    assert.equal(nextId(['C999']), 'C1000', 'C999 之后应是 C1000')
    assert.equal(nextId(['C1000']), 'C1001', '四位后继续加一')
    assert.equal(nextId(['C1001']), 'C1002', '四位继续补到四位')
  })

  it('末项坏掉时用最大合法编号兜底', () => {
    assert.equal(nextId(['C002', 'bad']), 'C003', '坏末项应回最大加一')
    assert.equal(nextId(['bad']), 'C001', '全坏应回 C001')
  })
})

describe('renderCard 与 readCard 往返', () => {
  const input = {
    id: 'C007',
    blockId: 'B12',
    batch: 'b7',
    gen: 3,
    source: 'native',
    at: '2026-11-04T00:00:00.000Z',
    fields: makeFields(),
  }

  const expected = [
    '<!-- whale-context block=B12 id=C007 gen=3 batch=b7 source=native at=2026-11-04T00:00:00.000Z -->',
    '### C007 · 上下文档案',
    '- 范围：1–10',
    '- 主题：上下文档案',
    `- 摘要：${SUMMARY_200}`,
    '- 关键词：甲、乙、丙',
    '- 没消化完的：无',
    '',
  ].join('\n')

  it('renderCard 逐字产出注释行、标题与五条正文', () => {
    assert.equal(renderCard(input), expected, '卡片文本应与口径逐字一致')
  })

  it('renderCard 把空白的没消化完的写成「无」', () => {
    const text = renderCard({ ...input, fields: makeFields({ unfinished: '   ' }) })

    assert.ok(text.includes('- 没消化完的：无'), '空白值应写成无')
  })

  it('renderCard 参数不全或 fields 不合规时回 card-incomplete', () => {
    const badInputs = [
      null,
      { ...input, at: undefined },
      { ...input, at: 'has space' },
      { ...input, id: 'X007' },
      { ...input, gen: 0 },
      { ...input, gen: 1.5 },
      { ...input, blockId: '' },
      { ...input, fields: makeFields({ range: '1' }) },
      { ...input, fields: makeFields({ topic: '' }) },
    ]

    for (const item of badInputs) {
      assert.deepEqual(renderCard(item), { ok: false, reason: 'card-incomplete' }, '坏参数应回 card-incomplete')
    }
  })

  it('自动压缩给多长就存多长，多行摘要与少几个关键词都照实落', () => {
    // 200–2000 字与 3–5 个关键词是「按模板写摘要」那一路的校验（parseSummary），
    // 宿主自动压缩的摘要不受这条管：短的不补，长的不截，关键词算不出就不编。
    for (const summary of ['摘'.repeat(199), '摘'.repeat(2001)]) {
      const rendered = renderCard({ ...input, fields: makeFields({ summary }) })
      assert.equal(typeof rendered, 'string', '自动压缩的摘要不该因为长度被拒')
    }
    const few = renderCard({ ...input, fields: makeFields({ keywords: ['甲', '乙'] }) })
    assert.equal(typeof few, 'string', '关键词少于三个也照实写')
    const none = renderCard({ ...input, fields: makeFields({ keywords: [] }) })
    assert.equal(typeof none, 'string', '一个关键词都算不出来时留空行，不编')

    const multiline = renderCard({ ...input, fields: makeFields({ summary: '第一行\n第二行\n第三行' }) })
    const read = readCard(multiline)
    assert.equal(read.ok, true)
    assert.equal(read.fields.summary, '第一行\n第二行\n第三行', '多行摘要要原样读回来')
  })

  it('readCard 把 renderCard 的结果原样解回', () => {
    const read = readCard(renderCard(input))

    assert.deepEqual(
      read,
      {
        ok: true,
        id: 'C007',
        blockId: 'B12',
        gen: 3,
        batch: 'b7',
        source: 'native',
        at: '2026-11-04T00:00:00.000Z',
        fields: makeFields(),
      },
      '往返后字段应一致',
    )
  })

  it('readCard 认 CRLF 换行', () => {
    const read = readCard(renderCard(input).replace(/\n/g, '\r\n'))

    assert.equal(read.ok, true, 'CRLF 也应能读')
    assert.equal(read.id, 'C007', '编号应解回')
  })

  it('readCard 解析不出来时回 card-unreadable', () => {
    const badTexts = [
      '',
      'hello',
      '<!-- whale-context block=B12 id=C007 gen=3 batch=b7 source=native at=t -->',
      renderCard(input).replace('### C007', '### C008'),
      renderCard(input).replace('- 范围：1–10\n', ''),
      renderCard(input).replace('### C007 · 上下文档案\n', ''),
    ]

    for (const text of badTexts) {
      assert.deepEqual(readCard(text), { ok: false, reason: 'card-unreadable' }, '坏文本应回 card-unreadable')
    }
  })
})

// 第六格「条目」是可选的一格：没补过就不该多出一行（老卡片一个字节都不变）。
describe('卡片里的条目那一格', () => {
  // 这一块自己立一个卡片入参：上面那个 `input` 是本文件另一个 describe 的局部变量。
  const input = {
    blockId: 'B12',
    id: 'C007',
    gen: 3,
    batch: 'b7',
    source: 'native',
    at: '2026-11-04T00:00:00.000Z',
    fields: makeFields(),
  }

  it('没补过就不写这一行，读回来是空数组', () => {
    const text = renderCard(input)

    assert.equal(text.includes('- 条目：'), false, '没补过就别写这一格')
    assert.deepEqual(readCard(text).fields.entries, [])
  })

  it('补过就写成缩进两格的续行，读回来一条不差', () => {
    const rows = [
      { type: '待办', content: '把批次号接上' },
      { type: '事实', content: '卡片是唯一源（重算冲不掉）' },
    ]
    const text = renderCard({ ...input, fields: makeFields({ entries: rows }) })

    assert.ok(text.includes('- 条目：\n  - 待办：把批次号接上\n  - 事实：卡片是唯一源（重算冲不掉）'), '两格缩进的续行')
    assert.deepEqual(readCard(text).fields.entries, [
      { type: '待办', content: '把批次号接上', way: 'model' },
      { type: '事实', content: '卡片是唯一源（重算冲不掉）', way: 'model' },
    ])
  })

  it('条目行脏了只丢那一行，卡片照读', () => {
    const text = `${renderCard({ ...input, fields: makeFields({ entries: [{ type: '待办', content: '留着' }] }) })}\n  - 瞎写：丢掉\n`

    assert.deepEqual(readCard(text).fields.entries, [{ type: '待办', content: '留着', way: 'model' }])
  })
})
