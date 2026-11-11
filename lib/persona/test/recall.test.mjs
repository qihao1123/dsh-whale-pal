import assert from 'node:assert/strict'
import { test } from 'node:test'

import { attributeMistake, MISTAKE, markTier, recallScore, recallThenRank, splitByTier, TIER, tierOf, tokenize } from '../lib/recall.js'
import { selectMemory } from '../lib/memory.js'

test('切词：中文按词切，去掉停用词与单字', () => {
  const words = tokenize('我这台机器上的 Node 版本是哪个？以前跟你提过的。')
  assert.ok(words.includes('node'), `应该切出 node：${words.join(',')}`)
  assert.ok(words.includes('版本'), `应该切出 版本：${words.join(',')}`)
  assert.ok(words.includes('机器'), `应该切出 机器：${words.join(',')}`)
  // 停用词与单字不进
  for (const bad of ['的', '我', '是', '哪个', '这']) assert.equal(words.includes(bad), false, `不该有 ${bad}`)
})

test('切词：空输入与纯停用词都回空数组', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize('的了是我'), [])
})

test('切词：英文与中英混排', () => {
  const words = tokenize('The dotfiles 配置在 neovim 里')
  assert.ok(words.includes('dotfiles'))
  assert.ok(words.includes('neovim'))
  assert.equal(words.includes('the'), false)
})

test('召回分：命中比例算得对', () => {
  const words = ['node', '版本']
  assert.equal(recallScore('用户在 Windows 上用 Node 24', words).hit, 0.5)
  assert.equal(recallScore('这台机器的 Node 版本是 24', words).hit, 1)
  assert.equal(recallScore('用户讨厌客套话', words).hit, 0)
  assert.deepEqual(recallScore('用 Node 24', words).matched, ['node'])
})

test('召回分：空查询与空文本都不崩', () => {
  assert.equal(recallScore('任意文本', []).hit, 0)
  assert.equal(recallScore('', ['node']).hit, 0)
  assert.equal(recallScore(null, ['node']).hit, 0)
})

function entries() {
  return [
    { kind: 'facts', text: '用户的编辑器是 neovim，配置放在 nvim 的 dotfiles 里', score: 0.9 },
    { kind: 'facts', text: '用户在 Windows 上用 Node 24', score: 0.396 },
    { kind: 'facts', text: '用户的项目在 D:\\AI 项目 下，插件叫 dsh-whale-pal', score: 0.4477 },
    { kind: 'preferences', text: '用户讨厌客套话，要直接说', score: 0.85 },
    { kind: 'events', text: '昨天跑通了全量测试 899 条', score: 0.4477 },
    { kind: 'events', text: '上周改的导入 bug：模块导入早于快照，没有回滚点', score: 0.7 },
  ]
}

test('两段式：问 Node 版本时，那条低分事实被召回上来（这是本批的核心）', () => {
  const { picked, recall } = recallThenRank(entries(), { query: '我这台机器上的 Node 是哪个版本？', limit: 4 })
  assert.ok(recall.words.includes('node'))
  const texts = picked.map((item) => item.text)
  // 改之前：这条 score 0.396 排在 neovim 0.9 之后、挤不进前 4。
  // 改之后：它命中了查询词，进了候选池，而且池内按存量分排时它只在命中集合里比——
  // 所以它排第 1，neovim（没命中）退到补位。
  assert.ok(texts.some((t) => t.includes('Node 24')), `Node 那条该进注入：${texts.join(' | ')}`)
  assert.equal(picked[0].text.includes('Node 24'), true, '命中的那条该排第一')
  assert.equal(picked[0].recallHit > 0, true)
  // 没命中的高分条目靠补位进来，仍排在命中条目之后。
  assert.equal(picked[1].recallHit, 0)
  assert.match(picked[1].text, /neovim/)
})

test('两段式：召回不足时用存量分补位，不因为召回不上就一条不给', () => {
  const { picked, recall } = recallThenRank(entries(), { query: '完全无关的一句话 哈哈', limit: 4 })
  assert.equal(recall.usedFallback, true)
  assert.equal(picked.length, 4)
  // 补位来的按存量分从高到低
  assert.match(picked[0].text, /neovim/)
})

test('两段式：没有查询词时退回纯排序', () => {
  const { picked, recall } = recallThenRank(entries(), { limit: 3 })
  assert.equal(recall.words.length, 0)
  assert.equal(recall.usedFallback, true)
  assert.equal(picked.length, 3)
  assert.match(picked[0].text, /neovim/)
})

test('两段式：limit 为 0 与空候选都不崩', () => {
  assert.deepEqual(recallThenRank(entries(), { query: 'node', limit: 0 }).picked, [])
  assert.deepEqual(recallThenRank([], { query: 'node', limit: 4 }).picked, [])
  assert.deepEqual(recallThenRank(null, { query: 'node', limit: 4 }).picked, [])
})

test('两段式：召回命中多条时，池内仍按存量分排而不是按命中率', () => {
  const list = [
    { kind: 'facts', text: 'Node 版本 20', score: 0.2 },
    { kind: 'facts', text: 'Node 版本 24 与 机器', score: 0.8 },
  ]
  const { picked } = recallThenRank(list, { query: 'Node 版本 机器', limit: 2 })
  // 两条都命中，score 高的在前（0.8 > 0.2），不是按命中率
  assert.equal(picked[0].score, 0.8)
})

// ---------------------------------------------------------------- 分档（第四批 §2.2）

test('分档：高档是「本来就重要」或「这句就在问它」', () => {
  assert.equal(tierOf({ score: 0.8, recallHit: 0 }, {}), TIER.HIGH)
  // 存量分不高，但这句正好在问它 → 也是高档
  assert.equal(tierOf({ score: 0.4, recallHit: 0.6 }, {}), TIER.HIGH)
  assert.equal(tierOf({ score: 0.5, recallHit: 0.2 }, {}), TIER.MID)
})

test('分档：低档 = 存量分低但有召回命中（要用先确认）', () => {
  assert.equal(tierOf({ score: 0.2, recallHit: 0.25 }, {}), TIER.LOW)
  // 存量分低、也没命中 → 不是低档，是「无关紧要」，走中档
  assert.equal(tierOf({ score: 0.2, recallHit: 0 }, {}), TIER.MID)
})

test('分档：很久没提起且这句没问到 → 无权重，不进注入', () => {
  const stale = { score: 0.5, recallHit: 0, lastSeenSession: 1 }
  assert.equal(tierOf(stale, { session: 300 }), TIER.NONE)
  // 同样陈旧，但这句正好问到 → 有命中就不该被判无权重
  assert.equal(tierOf({ ...stale, recallHit: 0.4 }, { session: 300 }), TIER.MID)
  // 刚提过 → 正常中档
  assert.equal(tierOf({ ...stale, lastSeenSession: 299 }, { session: 300 }), TIER.MID)
})

test('无权重档在分档这一步就被剔掉，不留给渲染层判断', () => {
  const entries = [
    { kind: 'facts', text: '很久没提的事', score: 0.5, recallHit: 0, lastSeenSession: 1 },
    { kind: 'facts', text: '刚提过的事', score: 0.5, recallHit: 0, lastSeenSession: 300 },
  ]
  const { kept, dropped } = splitByTier(entries, { session: 300 })
  assert.equal(kept.length, 1)
  assert.equal(kept[0].text, '刚提过的事')
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].tier, TIER.NONE)
})

test('档位标记：高档行首加 !，低档行尾附注，中档原样', () => {
  assert.equal(markTier('用户讨厌客套话', TIER.HIGH), '!用户讨厌客套话')
  assert.equal(markTier('用户讨厌客套话', TIER.LOW), '用户讨厌客套话（低权重，确认再用）')
  assert.equal(markTier('用户讨厌客套话', TIER.MID), '用户讨厌客套话')
  // 不改正文：改了就不是同一句话，取回时会对不上。
  assert.equal(markTier('用户讨厌客套话', TIER.HIGH).includes('用户讨厌客套话'), true)
  assert.equal(markTier('', TIER.HIGH), '')
})

test('分档不改变检索出来的条目内容，只加档位', () => {
  const memory = {
    facts: [{ text: '用户的编辑器是 neovim', salience: 0.9, hits: 2, lastSeenSession: 5, at: 1, session: 5 }],
  }
  const picked = selectMemory(memory, { session: 5, limit: 4, query: '' })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].text, '用户的编辑器是 neovim')
  assert.equal(picked[0].tier, TIER.HIGH)
})

// ---------------------------------------------------------------- 失误归因（第四批 §2.4）

test('归因：库里没有这条 → 不是检索的错，不硬塞类型', () => {
  const result = attributeMistake({ inStore: false, inInjection: false })
  assert.equal(result.type, null, '没记下来就别怪召回层')
  assert.match(result.why, /不在库里/)
  assert.match(result.fix, /写入侧/)
})

test('归因：在库但没进注入 → 召回漏', () => {
  const result = attributeMistake({ inStore: true, inInjection: false })
  assert.equal(result.type, MISTAKE.RECALL_MISS)
  assert.match(result.why, /没进注入/)
  assert.match(result.fix, /召回层/)
})

test('归因：进了注入但排太后 → 也是召回漏，但改法指向排序', () => {
  const result = attributeMistake({ inStore: true, inInjection: true, rank: 4, expectRank: 3 })
  assert.equal(result.type, MISTAKE.RECALL_MISS)
  assert.match(result.why, /第 4/)
  assert.match(result.fix, /排序/)
})

test('归因：已经排进前 3 → 不算失误，教训写「无新增」而不是空着', () => {
  const result = attributeMistake({ inStore: true, inInjection: true, rank: 2, expectRank: 3 })
  assert.equal(result.type, null)
  assert.equal(result.fix, '无新增')
})
