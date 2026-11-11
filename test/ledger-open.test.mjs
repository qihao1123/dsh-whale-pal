/**
 * 未完结三类（第四批 §3c）：开始了没做完 / 他说回头再说 / 我提了他没回。
 *
 * 为什么值得单独测：这三类的下次动作完全不同（继续做 / 别再提 / 可以再问一句），
 * 判错一类就会做错动作 —— 把「他按了暂停」当成「继续做」是催人，
 * 把「悬着的事」当成「暂停」是漏掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OPEN_KIND,
  OPEN_KIND_NEXT,
  classifyOpen,
  openHandoffCells,
  openKey,
} from '../lib/ledger/lapse.js'

test('分类：开始了没做完', () => {
  assert.equal(classifyOpen('形态审计还没做完'), OPEN_KIND.STARTED_NOT_DONE)
  assert.equal(classifyOpen('台账 .bak 还没清'), OPEN_KIND.STARTED_NOT_DONE)
  assert.equal(classifyOpen({ text: '第四批还剩分档' }), OPEN_KIND.STARTED_NOT_DONE)
})

test('分类：他按了暂停（回头再说）', () => {
  assert.equal(classifyOpen('游标地板先放放'), OPEN_KIND.DEFERRED)
  assert.equal(classifyOpen('那件事回头再说'), OPEN_KIND.DEFERRED)
  assert.equal(classifyOpen('改天弄'), OPEN_KIND.DEFERRED)
})

test('分类：我提了他没回', () => {
  assert.equal(classifyOpen('我问了他 ref 那件事，还没回'), OPEN_KIND.UNANSWERED)
  assert.equal(classifyOpen('等用户回复'), OPEN_KIND.UNANSWERED)
  assert.equal(classifyOpen('发出了但没答复'), OPEN_KIND.UNANSWERED)
})

test('分类：「等确认」是我的活没干完，不是他欠我回复', () => {
  // 2026-11-07 实测踩过：把「等确认后开工」判成「我提了他没回」。
  // 「他等的是我」和「我等的是他」是两件事，动作也不同。
  assert.equal(classifyOpen('形态审计还没做完，等确认后开工'), OPEN_KIND.STARTED_NOT_DONE)
  assert.equal(classifyOpen('等用户确认后开工第一批'), OPEN_KIND.STARTED_NOT_DONE)
})

test('分类：暂停优先于悬着（人明确按了暂停，就该别再提）', () => {
  assert.equal(classifyOpen('先放放，回头再说，等你回复也没用'), OPEN_KIND.DEFERRED)
})

test('分类：拿不准就归到「开始了没做完」，那类最少冒犯', () => {
  assert.equal(classifyOpen('一件事'), OPEN_KIND.STARTED_NOT_DONE)
  assert.equal(classifyOpen(''), OPEN_KIND.STARTED_NOT_DONE)
})

test('三类各自写着下一次该做什么，不许空着', () => {
  for (const kind of Object.values(OPEN_KIND)) {
    assert.equal(typeof OPEN_KIND_NEXT[kind], 'string')
    assert.ok(OPEN_KIND_NEXT[kind].length > 0, `${kind} 得写清下次干什么`)
  }
})

test('待交接的行：键里带类别，所以同一句话换类会另起一行', () => {
  const text = '游标地板那件事'
  const a = openKey(OPEN_KIND.STARTED_NOT_DONE, text)
  const b = openKey(OPEN_KIND.DEFERRED, text)
  assert.notEqual(a, b, '类别变了就是真变了，不该被判成重复写')
  // 同类别同文本必须给出同一个键，重扫才不会写第二行。
  assert.equal(openKey(OPEN_KIND.DEFERRED, text), b)
})

test('待交接的行带类别前缀，人一眼看出是哪一类', () => {
  const cells = openHandoffCells({
    item: { text: '游标地板先放放', at: Date.parse('2026-11-07T00:00:00Z') },
    at: '2026-11-07T00:00:00Z',
  })
  assert.ok(cells, '要能落成一行')
  // 列顺序：时间 | 键 | 答应过的事 | 状态
  assert.equal(cells[0], '2026-11-07T00:00:00Z')
  assert.match(cells[1], /^open:/)
  assert.match(cells[2], /［他说回头再说］/)
  assert.equal(cells.length, 4)
})

test('空文本不落行，不往账上写空壳', () => {
  assert.equal(openHandoffCells({ item: { text: '  ' } }), null)
  assert.equal(openHandoffCells({ item: '' }), null)
  assert.equal(openHandoffCells({}), null)
})
