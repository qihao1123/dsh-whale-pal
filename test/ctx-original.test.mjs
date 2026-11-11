// 按 seq 回原话（判据 4 级二，2026-11-09）：只测纯计算与只读解析，不碰真库。
//
// 这条是「我记得」到「我拿得出原话」的那一步。失败要能说清是哪一步：
// 没指针 / 没卡 / 没原文 / 原文里没这一段 —— 四种情况不能混成一句「取不到」。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { cardOf, ensureLayout, writeCard, writeRaw } from '../lib/ctx/store.js'
import { cardForSeq, originalAt, parseRange, sectionOfSeq } from '../lib/ctx/original.js'

const ROOT = mkdtempSync(join(tmpdir(), 'whale-original-'))
ensureLayout(ROOT)

function card(id, blockId, range, gen = 1) {
  return cardOf({ id, blockId, gen, at: '2026-11-08T00:00:00.000Z', item: { text: `卡 ${id} 的摘要`, range } })
}

const RAW = [
  '<!-- whale-context-raw block=b1 gen=1 range=19–3859 at=2026-11-08 events=3 kept=2 missing=0 -->',
  '# 原文留存 · b1',
  '',
  '---',
  '',
  '### [seq 100] 用户 · 2026-11-08T00:00:00.000Z',
  '',
  '我的编辑器一直是 neovim，别给我换。',
  '',
  '### [seq 120] 助手 · 2026-11-08T00:01:00.000Z',
  '',
  '好，不动你的 neovim。',
  '',
].join('\n')

after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('卡片范围：认得下各种写法，认不出就说认不出', () => {
  it('En dash / 连字符 / 波浪 / 中文「至」都算区间', () => {
    assert.deepEqual(parseRange('19–3859'), { start: 19, end: 3859 })
    assert.deepEqual(parseRange('19-3859'), { start: 19, end: 3859 })
    assert.deepEqual(parseRange('19~3859'), { start: 19, end: 3859 })
    assert.deepEqual(parseRange('19 至 3859'), { start: 19, end: 3859 })
  })

  it('单独一个数当作「只覆盖这一条」', () => {
    assert.deepEqual(parseRange('3859'), { start: 3859, end: 3859 })
  })

  it('反着写的区间、没标范围、空值一律 null', () => {
    assert.equal(parseRange('3859–19'), null)
    assert.equal(parseRange('未标'), null)
    assert.equal(parseRange(''), null)
    assert.equal(parseRange(null), null)
  })
})

describe('哪张卡覆盖这个 seq', () => {
  it('落在区间里就算，区间外不算', () => {
    const cards = [card('C001', 'b1', '19–3859'), card('C002', 'b2', '3868–6027')]
    assert.equal(cardForSeq(cards, 100)?.id, 'C001')
    assert.equal(cardForSeq(cards, 3860), null)
    assert.equal(cardForSeq(cards, 5000)?.id, 'C002')
  })

  it('区间重叠时取最窄的那张（再压一次留下的更细的卡）', () => {
    const cards = [card('C001', 'b1', '19–3859'), card('C003', 'b3', '90–130')]
    assert.equal(cardForSeq(cards, 100)?.id, 'C003')
  })

  it('seq 不合法（0 / 负数 / 非数）回 null', () => {
    const cards = [card('C001', 'b1', '19–3859')]
    assert.equal(cardForSeq(cards, 0), null)
    assert.equal(cardForSeq(cards, -5), null)
    assert.equal(cardForSeq(cards, Number.NaN), null)
  })
})

describe('从原文里取一节', () => {
  it('取到对应的那一节，停在下一节抬头之前', () => {
    const body = sectionOfSeq(RAW, 100)
    assert.equal(body, '我的编辑器一直是 neovim，别给我换。')
  })

  it('没有那一节就是 null，不拿相邻的节顶', () => {
    assert.equal(sectionOfSeq(RAW, 999), null)
  })

  it('正文里恰好出现这串字不算一节（只认行首）', () => {
    const text = ['引用：### [seq 7] 用户', '', '不是抬头', '### [seq 7] 用户', '', '真的那节'].join('\n')
    assert.equal(sectionOfSeq(text, 7), '真的那节')
  })
})

describe('originalAt：四步各说各的失败理由', () => {
  it('卡和原文都在 → 拿回原话', () => {
    writeCard(ROOT, card('C001', 'b1', '19–3859'))
    writeRaw(ROOT, { blockId: 'b1', text: RAW })
    const found = originalAt(ROOT, 100)
    assert.equal(found.ok, true)
    assert.match(found.text, /neovim/)
    assert.equal(found.cardId, 'C001')
  })

  it('没有覆盖这个位置的卡 → no-card', () => {
    assert.equal(originalAt(ROOT, 9999).reason, 'no-card')
  })

  it('卡在但原文没落盘 → no-raw', () => {
    writeCard(ROOT, card('C002', 'b2', '4000–4100'))
    assert.equal(originalAt(ROOT, 4050).reason, 'no-raw')
  })

  it('原文在但没有这一段 → no-section', () => {
    writeRaw(ROOT, { blockId: 'b1', text: RAW })
    assert.equal(originalAt(ROOT, 101).reason, 'no-section')
  })

  it('没有 seq → no-seq（0 是「没有来源」，不是「第 0 条」）', () => {
    assert.equal(originalAt(ROOT, 0).reason, 'no-seq')
  })
})
