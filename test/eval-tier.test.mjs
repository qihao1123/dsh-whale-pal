// 失忆率两级（2026-11-09 人类签字拆分判据 4）：只测纯计算，不碰盘。
//
// 这条量尺的历史包袱要留住：拆之前是 `1 − R@3`，8.3% 报「过」，
// 而 EVID 0/12（要原话时只拿得到转述）根本没进这个数。
// 拆之后级二对 evidence 用例单列一条要求：取回文本里得真含档案捞回的原话——
// 先是 16.7% 不过（原话链路还没接），链路补齐后 12/12。数不是靠改判法变好的。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TIER_LIMIT, catalogIdsOf, judgeTier, tierRates } from './eval/tier.mjs';

describe('目录行的编号：只认 `目录：` 那一行', () => {
  it('解析出「编号 · 主题」里的编号，顺序照写', () => {
    const summary = [
      '记得：用户的编辑器是 neovim',
      '目录：M-001 · 编辑器是 neovim；M-011 · Node 24；M-003 · 台账没清',
    ].join('\n')
    assert.deepEqual(catalogIdsOf(summary), ['M-001', 'M-011', 'M-003'])
  });

  it('别的行里出现 `M-002 · ` 不算目录（那是正文，不是指针）', () => {
    const summary = ['记得：M-002 · 项目在 D:\\AI 项目 下', '目录：M-009 · 先放着的三件事'].join('\n')
    assert.deepEqual(catalogIdsOf(summary), ['M-009'])
  });

  it('没有目录行、空串、非字符串都回空数组', () => {
    assert.deepEqual(catalogIdsOf(''), [])
    assert.deepEqual(catalogIdsOf(null), [])
    assert.deepEqual(catalogIdsOf(undefined), [])
    assert.deepEqual(catalogIdsOf('记得：只有正文'), [])
  });

  it('M-001 与 M-011 是两个号，不因为前缀相同就串', () => {
    const ids = catalogIdsOf('目录：M-011 · Node 24')
    assert.equal(ids.includes('M-001'), false)
    assert.equal(ids.includes('M-011'), true)
  });
});

describe('判一条用例的两级：级一看得见、级二拿得回', () => {
  const ids = ['M-003', 'M-007'];

  it('正文进了召回行 = 级一命中（正文），不需要再给指针', () => {
    const r = judgeTier({ shown: true, id: 'M-003', catalogIds: [], fetched: 'M-003\n用户在 Windows 上用 Node 24', expect: 'Node 24' })
    assert.equal(r.dir, true)
    assert.equal(r.dirVia, '正文')
    assert.equal(r.fetch, true)
  });

  it('正文没进、目录里有编号 = 级一命中（目录），这时取回才是真必经之路', () => {
    const r = judgeTier({ shown: false, id: 'M-007', catalogIds: ids, fetched: 'M-007\n昨天跑通了全量测试 899 条', expect: '899' })
    assert.equal(r.dir, true)
    assert.equal(r.dirVia, '目录')
    assert.equal(r.fetch, true)
  });

  it('正文没进、目录也没有 = 级一没命中；级二跟着没命中，并说清是「连编号都没拿到」', () => {
    const r = judgeTier({ shown: false, id: 'M-009', catalogIds: ids, fetched: 'M-009\n随便什么', expect: '先放着的三件事' })
    assert.equal(r.dir, false)
    assert.equal(r.dirVia, '没看见')
    assert.equal(r.fetch, false)
    assert.match(r.fetchWhy, /连编号都没拿到/)
  });

  it('取回的文本里没有答案 = 级二没命中（不是「没找到」，是「找到了但内容不对」）', () => {
    const r = judgeTier({ shown: true, id: 'M-003', fetched: 'M-003\n别的事', expect: 'Node 24' })
    assert.equal(r.dir, true)
    assert.equal(r.fetch, false)
    assert.match(r.fetchWhy, /没有答案/)
  });

  it('没有编号 = 级二是「没有编号」：编号是取回的钥匙，缺了连试都不用试', () => {
    const r = judgeTier({ shown: true, id: '', fetched: '', expect: 'Node 24' })
    assert.equal(r.dir, true)
    assert.equal(r.fetch, false)
    assert.match(r.fetchWhy, /没有编号/)
  });

  it('evidence 要原话：取回文本里只有转述 = 没命中；原话真的出来了 = 命中', () => {
    const noOriginal = judgeTier({ shown: true, id: 'M-003', fetched: 'M-003\n用户的编辑器是 neovim', expect: '编辑器是 neovim', needsOriginal: true, originalText: '' })
    assert.equal(noOriginal.fetch, false)
    assert.match(noOriginal.fetchWhy, /追不到原话/)

    // 档案里有原话，但取回文本装不下 / 没接进去 —— 也不能算命中。
    const notCarried = judgeTier({ shown: true, id: 'M-003', fetched: 'M-003\n用户的编辑器是 neovim', expect: '编辑器是 neovim', needsOriginal: true, originalText: '我的编辑器一直是 neovim，别给我换。' })
    assert.equal(notCarried.fetch, false)
    assert.match(notCarried.fetchWhy, /原话没进取回的文本/)

    const carried = judgeTier({
      shown: true,
      id: 'M-003',
      fetched: 'M-003\n用户的编辑器是 neovim\n原话：我的编辑器一直是 neovim，别给我换。',
      expect: '编辑器是 neovim',
      needsOriginal: true,
      originalText: '我的编辑器一直是 neovim，别给我换。',
    })
    assert.equal(carried.fetch, true)
  });

  it('recall 不要原话：同样的输出在 recall 上算命中', () => {
    const r = judgeTier({ shown: true, id: 'M-003', fetched: 'M-003\n用户的编辑器是 neovim', expect: '编辑器是 neovim' })
    assert.equal(r.fetch, true)
  });
});

describe('两级合率：分母同一批，上限各 10%', () => {
  const row = (over) => ({ dir: true, fetch: true, ...over });

  it('12 条掉一条 = 8.3%，过（一格 8.3%，再掉一条就过线）', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i === 0 ? { dir: false, fetch: false } : {}))
    const s = tierRates(rows)
    assert.equal(s.total, 12)
    assert.equal(s.dirHits, 11)
    assert.equal(s.dirMiss.toFixed(4), '0.0833')
    assert.equal(s.dirPass, true)
    assert.equal(s.fetchPass, true)
    assert.equal(TIER_LIMIT, 0.1)
    assert.equal(s.cell.toFixed(1), '8.3')
  });

  it('12 条掉两条 = 16.7%，不过（这就是现在级二的真读数）', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i < 2 ? { dir: true, fetch: false } : {}))
    const s = tierRates(rows)
    assert.equal(s.fetchHits, 10)
    assert.equal(s.fetchMiss.toFixed(4), '0.1667')
    assert.equal(s.dirPass, true)
    assert.equal(s.fetchPass, false)
  });

  it('两级的命中互不牵连：级一全中、级二全失，是两个不同的读数', () => {
    const rows = Array.from({ length: 12 }, () => row({ dir: true, fetch: false }))
    const s = tierRates(rows)
    assert.equal(s.dirMiss, 0)
    assert.equal(s.fetchMiss, 1)
  });

  it('分母 0 = 未实测，不报 0%（空集上的 0.0% 是假的好数）', () => {
    const s = tierRates([])
    assert.equal(s.dirMiss, null)
    assert.equal(s.fetchMiss, null)
    assert.equal(s.dirPass, false)
    assert.equal(s.fetchPass, false)
    assert.equal(s.cell, null)
  });
});
