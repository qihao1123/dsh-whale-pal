// 锁的是 ctx 这一层唯一的碰盘文件：目录怎么建、卡片怎么写、队列消费后索引重建、
// 同一份文本不重复落盘、锚定块与条目表不落盘（按需现算）。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CTX_DIR_NAME,
  cardFileName,
  ctxRoot,
  drainQueue,
  ensureLayout,
  guessKeywords,
  pathsOf,
  rawCount,
  rawExists,
  rawFileOf,
  readCards,
  readTextFile,
  refreshCards,
  topicOf,
  writeCard,
  writeRaw,
  writeText,
  setCardEntries,
  trashBatch,
} from '../lib/ctx/store.js';
import { rawFileName } from '../lib/ctx/raw.js';
import { rebuildFromCards } from '../lib/ctx/rebuild.js';

// 条目表不再落盘，改由卡片现算（跟 host-bridge 的 entriesTableOf 同一口径）。
function entriesTableOf(root) {
  return rebuildFromCards(readCards(root)).entriesText;
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'whale-ctx-'));
  return { root: ctxRoot(root), vault: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const pendingOne = {
  blockId: 'c-1',
  gen: 1,
  at: '2026-11-04T05:00:00Z',
  range: '10–80',
  text: '投影每次加载都会重放一遍，写盘会把档案全重写。',
  tokens: 100,
};

function card(overrides = {}) {
  return {
    id: 'C001',
    blockId: 'c-1',
    gen: 1,
    batch: 'B001',
    source: 'native',
    at: '2026-11-04T05:00:00Z',
    fields: { range: '10–80', topic: '投影与落盘', summary: '摘要正文', keywords: ['投影', '落盘'], unfinished: '无' },
    ...overrides,
  };
}

describe('ctx 存盘：目录与路径', () => {
  it('根目录叫 _上下文，卡片放在 压缩档案 下', () => {
    const made = workspace();
    try {
      assert.equal(ctxRoot('D:/库'), join('D:/库', CTX_DIR_NAME));
      const layout = pathsOf(made.root);
      assert.equal(layout.cards, join(made.root, '压缩档案'));
      assert.equal(layout.index, join(made.root, '索引.md'));
    } finally {
      made.cleanup();
    }
  });

  it('ensureLayout 把 压缩档案 建出来，重复调用不报错', () => {
    const made = workspace();
    try {
      assert.equal(ensureLayout(made.root).ok, true);
      assert.equal(existsSync(pathsOf(made.root).cards), true);
      assert.equal(ensureLayout(made.root).ok, true);
    } finally {
      made.cleanup();
    }
  });
});

describe('ctx 存盘：卡片', () => {
  it('写一张卡再读回来，字段对得上', () => {
    const made = workspace();
    try {
      ensureLayout(made.root);
      const written = writeCard(made.root, card());
      assert.equal(written.ok, true);
      assert.equal(written.wrote, true);
      const cards = readCards(made.root);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].id, 'C001');
      assert.equal(cards[0].blockId, 'c-1');
      assert.equal(cards[0].fields.topic, '投影与落盘');
      assert.deepEqual(cards[0].fields.keywords, ['投影', '落盘']);
    } finally {
      made.cleanup();
    }
  });

  it('同一张卡再写一遍，一个字节都不动', () => {
    const made = workspace();
    try {
      ensureLayout(made.root);
      writeCard(made.root, card());
      const again = writeCard(made.root, card());
      assert.equal(again.ok, true);
      assert.equal(again.wrote, false);
    } finally {
      made.cleanup();
    }
  });

  it('文件名就是 blockId.md，编号不当文件名用', () => {
    const made = workspace();
    try {
      ensureLayout(made.root);
      writeCard(made.root, card());
      const file = join(pathsOf(made.root).cards, cardFileName('c-1'));
      assert.equal(existsSync(file), true);
      assert.equal(existsSync(join(pathsOf(made.root).cards, 'C001.md')), false);
    } finally {
      made.cleanup();
    }
  });
});

describe('ctx 存盘：同一块再压一次', () => {
  it('第二代另起文件名，上一版一个字节都不动', () => {
    const made = workspace();
    try {
      ensureLayout(made.root);
      const layout = pathsOf(made.root);
      writeCard(made.root, card());
      const firstText = readFileSync(join(layout.cards, cardFileName('c-1')), 'utf8');

      writeCard(made.root, card({ id: 'C002', gen: 2, fields: { ...card().fields, summary: '第二版摘要' } }));

      assert.equal(existsSync(join(layout.cards, cardFileName('c-1'))), true);
      assert.equal(existsSync(join(layout.cards, cardFileName('c-1', 2))), true);
      assert.equal(readFileSync(join(layout.cards, cardFileName('c-1')), 'utf8'), firstText);
      assert.equal(readCards(made.root).length, 2);
    } finally {
      made.cleanup();
    }
  })
})

describe('ctx 存盘：消费队列', () => {
  it('队列里两条按顺序变成 C001、C002，索引跟着重建，关键词与条目文件都不再生成', () => {
    const made = workspace();
    try {
      const result = drainQueue({ root: made.root, pending: [pendingOne, { ...pendingOne, blockId: 'c-2', text: '第二段摘要' }], now: '2026-11-04T06:00:00Z' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.ids, ['C001', 'C002']);
      const layout = pathsOf(made.root);
      assert.equal(existsSync(layout.index), true);
      assert.equal(existsSync(join(made.root, '关键词.md')), false);
      // 条目表改成按需现算，不再落盘（第二批形态审计）。
      assert.equal(existsSync(join(made.root, '条目.md')), false);
      const index = readFileSync(layout.index, 'utf8');
      assert.equal(index.includes('| 编号 | 时间 | 范围 | 主题 | 关键词 | 来源 | 状态 | 摘要文件 |'), true);
      assert.equal(index.includes('C001'), true);
      assert.equal(readCards(made.root).length, 2);
    } finally {
      made.cleanup();
    }
  });

  it('再消费一次接着往后排，不复用也不插空', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      const second = drainQueue({ root: made.root, pending: [{ ...pendingOne, blockId: 'c-9' }], now: '2026-11-04T07:00:00Z' });
      assert.deepEqual(second.ids, ['C002']);
    } finally {
      made.cleanup();
    }
  });

  it('没有待写的东西也能跑，索引照出', () => {
    const made = workspace();
    try {
      const result = drainQueue({ root: made.root, pending: [], now: '2026-11-04T06:00:00Z' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.ids, []);
      assert.equal(existsSync(pathsOf(made.root).index), true);
    } finally {
      made.cleanup();
    }
  });

  // 批次号原先没人发——三张卡全是默认 B001，验收⑩「按批次列全 + 整批回滚」就没法成立。
  it('每落一批就往后发一个号：第一次 B001，下一次 B002', () => {
    const made = workspace();
    try {
      const first = drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.deepEqual(first.batches, ['B001']);
      const second = drainQueue({ root: made.root, pending: [{ ...pendingOne, blockId: 'c-9' }], now: '2026-11-04T07:00:00Z' });
      assert.deepEqual(second.batches, ['B002']);
      assert.deepEqual(
        readCards(made.root).map((card) => [card.id, card.batch]),
        [['C001', 'B001'], ['C002', 'B002']],
      );
    } finally {
      made.cleanup();
    }
  });

  it('同一次压缩落的多张共用一个号', () => {
    const made = workspace();
    try {
      const result = drainQueue({
        root: made.root,
        pending: [pendingOne, { ...pendingOne, blockId: 'c-2', text: '第二段摘要' }],
        now: '2026-11-04T06:00:00Z',
      });
      assert.deepEqual(result.batches, ['B001', 'B001'], '同一条 at 算同一次事件');
      assert.deepEqual(readCards(made.root).map((card) => card.batch), ['B001', 'B001']);
    } finally {
      made.cleanup();
    }
  });

  it('重放的旧块不占号：跳过的那份不发批次号', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      // 同一条再排一遍（重放），再加一条新的：新的应当是 B002，不是 B003。
      const again = drainQueue({
        root: made.root,
        pending: [pendingOne, { ...pendingOne, blockId: 'c-9' }],
        now: '2026-11-04T07:00:00Z',
      });
      assert.deepEqual(again.skipped, [pendingOne.blockId]);
      assert.deepEqual(again.batches, ['B002']);
    } finally {
      made.cleanup();
    }
  });

  it('调用方显式给了批次号就整批都用它', () => {
    const made = workspace();
    try {
      const result = drainQueue({
        root: made.root,
        pending: [pendingOne, { ...pendingOne, blockId: 'c-2', text: '另一段' }],
        batch: 'B007',
        now: '2026-11-04T06:00:00Z',
      });
      assert.deepEqual(result.batches, ['B007', 'B007']);
      assert.deepEqual(readCards(made.root).map((card) => card.batch), ['B007', 'B007']);
    } finally {
      made.cleanup();
    }
  });
});

// 条目补录：存在卡片里（卡片是唯一源），所以重算冲不掉，重复写也不会变成两条。
describe('ctx 存盘：模型补的条目', () => {
  it('补进卡片正文，读回来还在，条目表跟着重算', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      const done = setCardEntries(made.root, { id: 'c001', rows: [{ type: '待办', content: '把批次号接上' }] });
      assert.equal(done.ok, true, '编号大小写不敏感');
      assert.equal(done.added, 1);
      assert.deepEqual(readCards(made.root)[0].fields.entries, [{ type: '待办', content: '把批次号接上', way: 'model' }]);
      // 条目表不落盘了：现算一遍，那一行照样得在。
      assert.ok(entriesTableOf(made.root).includes('| 1 | 待办 | 把批次号接上 | C001 | model |'));

      // 再补一条：两条都在，卡片正文里有那两行。
      setCardEntries(made.root, { id: 'C001', rows: [{ type: '事实', content: '卡片是唯一源' }] });
      const card = readCards(made.root)[0];
      assert.equal(card.fields.entries.length, 2);
      const text = readTextFile(join(pathsOf(made.root).cards, cardFileName(pendingOne.blockId, 1)));
      assert.ok(text.includes('- 条目：'), '卡片里应有条目那一格');
      assert.ok(text.includes('  - 待办：把批次号接上'));
      assert.ok(entriesTableOf(made.root).includes('| 2 | 事实 | 卡片是唯一源 | C001 | model |'));
    } finally {
      made.cleanup();
    }
  });

  it('同一「类型 + 内容」再写一遍不算新增（幂等）', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      setCardEntries(made.root, { id: 'C001', rows: [{ type: '偏好', content: '注释写中文' }] });
      const again = setCardEntries(made.root, { id: 'C001', rows: [{ type: '偏好', content: '注释写中文' }] });
      assert.equal(again.added, 0);
      assert.equal(again.wrote, false, '内容没变就不该重写卡片');
      assert.equal(readCards(made.root)[0].fields.entries.length, 1);
    } finally {
      made.cleanup();
    }
  });

  it('卡片不存在、编号空、脏行都不乱写', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.deepEqual(setCardEntries(made.root, { id: 'C099', rows: [{ type: '事实', content: '甲' }] }), { ok: false, reason: 'card-not-found' });
      assert.deepEqual(setCardEntries(made.root, { id: '  ', rows: [] }), { ok: false, reason: 'no-id' });
      const dirty = setCardEntries(made.root, { id: 'C001', rows: [{ type: '瞎写', content: '甲' }, { type: '事实', content: '  ' }] });
      assert.equal(dirty.added, 0);
      assert.deepEqual(readCards(made.root)[0].fields.entries, []);
    } finally {
      made.cleanup();
    }
  });
});

// 整批回滚：只挪不删，回收站里保持两层结构，索引按剩下的重算。
describe('ctx 存盘：整批撤进回收站', () => {
  it('只挪本批的卡片与原文，别批一个不动', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      writeRaw(made.root, { blockId: pendingOne.blockId, gen: 1, text: '# 原文\n- 一条\n' });
      drainQueue({ root: made.root, pending: [{ ...pendingOne, blockId: 'c-2', text: '第二段摘要' }], now: '2026-11-04T07:00:00Z' });

      const done = trashBatch(made.root, { batch: 'B001', at: '2026-11-04T08:00:00Z' });
      assert.equal(done.ok, true);
      assert.deepEqual(done.moved.map((one) => one.id), ['C001']);
      assert.equal(done.moved[0].raw, rawFileName(pendingOne.blockId, 1));
      // 回收站里按原来的两层放，搬回去就是还原。
      assert.equal(existsSync(join(done.folder, '压缩档案', cardFileName(pendingOne.blockId, 1))), true);
      assert.equal(existsSync(join(done.folder, '原文', rawFileName(pendingOne.blockId, 1))), true);
      // 卡片与原文都不在原处了；别批（B002）还在。
      assert.equal(existsSync(join(pathsOf(made.root).cards, cardFileName(pendingOne.blockId, 1))), false);
      assert.deepEqual(readCards(made.root).map((card) => card.id), ['C002']);
      assert.equal(readFileSync(pathsOf(made.root).index, 'utf8').includes('C001'), false, '索引要按剩下的重算');
      assert.deepEqual(readCards(made.root).map((card) => card.batch), ['B002']);
      assert.equal(done.cards, 1);
    } finally {
      made.cleanup();
    }
  });

  it('号对不上、或没给号，都明说，不动盘', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.deepEqual(trashBatch(made.root, { batch: 'B099' }), { ok: false, reason: 'batch-unknown' });
      assert.deepEqual(trashBatch(made.root, { batch: '  ' }), { ok: false, reason: 'no-batch' });
      assert.deepEqual(readCards(made.root).map((card) => card.id), ['C001']);
    } finally {
      made.cleanup();
    }
  });
});

describe('ctx 存盘：原文', () => {
  it('原文放在卡片目录下的子目录，路径按 blockId 推得出来', () => {
    const made = workspace();
    try {
      const layout = pathsOf(made.root);
      assert.equal(layout.raw, join(layout.cards, '原文'));
      assert.equal(rawFileOf(made.root, 'c-1', 1), join(layout.raw, 'c-1.md'));
      assert.equal(rawFileOf(made.root, 'c-1', 2), join(layout.raw, 'c-1-2.md'));
      ensureLayout(made.root);
      assert.equal(existsSync(layout.raw), true);
    } finally {
      made.cleanup();
    }
  });

  it('消费队列时按 seqs 留一份原文，卡片照写', () => {
    const made = workspace();
    try {
      const result = drainQueue({
        root: made.root,
        pending: [{ ...pendingOne, seqs: [10, 11] }],
        now: '2026-11-04T06:00:00Z',
        rawOf: (item) => `原文正文，seqs=${item.seqs.join(',')}`,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.ids, ['C001']);
      assert.deepEqual(result.rawWritten, ['c-1']);
      assert.deepEqual(result.rawMissing, []);
      assert.equal(rawExists(made.root, 'c-1', 1), true);
      assert.equal(rawCount(made.root), 1);
      assert.equal(readFileSync(rawFileOf(made.root, 'c-1', 1), 'utf8'), '原文正文，seqs=10,11');
      assert.equal(readCards(made.root).length, 1);
    } finally {
      made.cleanup();
    }
  });

  it('取不到原文不算失败：卡片照落，但要记下「这份没有原文」', () => {
    const made = workspace();
    try {
      const none = drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.equal(none.ok, true);
      assert.deepEqual(none.rawMissing, ['c-1']);
      assert.deepEqual(none.rawWritten, []);
      assert.equal(rawCount(made.root), 0);
      assert.equal(readCards(made.root).length, 1);

      const blank = drainQueue({ root: made.root, pending: [{ ...pendingOne, blockId: 'c-2' }], now: '2026-11-04T06:00:00Z', rawOf: () => null });
      assert.deepEqual(blank.rawMissing, ['c-2']);

      const boom = drainQueue({ root: made.root, pending: [{ ...pendingOne, blockId: 'c-3' }], now: '2026-11-04T06:00:00Z', rawOf: () => { throw new Error('会话没了'); } });
      assert.equal(boom.ok, true);
      assert.equal(boom.rawFailed.length, 1);
      assert.equal(boom.rawFailed[0].blockId, 'c-3');
      assert.equal(readCards(made.root).length, 3);
    } finally {
      made.cleanup();
    }
  });

  it('原文内容一样就不重写，mtime 不动', () => {
    const made = workspace();
    try {
      const first = writeRaw(made.root, { blockId: 'c-1', gen: 1, text: '同一条原文' });
      const second = writeRaw(made.root, { blockId: 'c-1', gen: 1, text: '同一条原文' });
      assert.equal(first.wrote, true);
      assert.equal(second.wrote, false);
    } finally {
      made.cleanup();
    }
  });

  it('卡片那层不把原文当卡片：原文目录放进 .md 也扫不出来', () => {
    const made = workspace();
    try {
      writeRaw(made.root, { blockId: 'c-1', gen: 1, text: '<!-- whale-context-raw block=c-1 -->\n原文' });
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.equal(rawCount(made.root), 1);
      assert.equal(readCards(made.root).length, 1);
      const index = readFileSync(pathsOf(made.root).index, 'utf8');
      assert.equal(index.includes('同一条原文'), false);
    } finally {
      made.cleanup();
    }
  });

  // 投影每次加载都会重放日志，同一份压缩会被重新排进队列。照写就会换编号（C001→C002），
  // 锚定块跟着换字、前缀缓存白废 —— 所以已经落过的块要跳过，编号必须钉住。
  it('同一块再排一次：跳过、不换编号、不重写卡片', () => {
    const made = workspace();
    try {
      const first = drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.deepEqual(first.ids, ['C001']);
      assert.deepEqual(first.skipped, []);
      const cardFile = join(pathsOf(made.root).cards, cardFileName('c-1', 1));
      const before = statSync(cardFile).mtimeMs;

      const again = drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T09:00:00Z' });
      assert.deepEqual(again.ids, []);
      assert.deepEqual(again.skipped, ['c-1']);
      assert.equal(readCards(made.root).length, 1);
      assert.equal(readCards(made.root)[0].id, 'C001');
      assert.equal(statSync(cardFile).mtimeMs, before);
      assert.equal(readFileSync(pathsOf(made.root).index, 'utf8').includes('C002'), false);
    } finally {
      made.cleanup();
    }
  });

  it('卡片落过了但原文没落下：卡片跳过，原文照样补', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.equal(rawCount(made.root), 0);
      const second = drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T09:00:00Z', rawOf: () => '补上的原文' });
      assert.deepEqual(second.skipped, ['c-1']);
      assert.deepEqual(second.ids, []);
      assert.deepEqual(second.rawWritten, ['c-1']);
      assert.deepEqual(second.rawMissing, []);
      assert.equal(readFileSync(rawFileOf(made.root, 'c-1', 1), 'utf8'), '补上的原文');
    } finally {
      made.cleanup();
    }
  });

  it('原文已经在盘上就不再报「没取到原文」', () => {
    const made = workspace();
    try {
      writeRaw(made.root, { blockId: 'c-1', gen: 1, text: '上次留下的原文' });
      const result = drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      assert.deepEqual(result.rawMissing, []);
      assert.deepEqual(result.rawWritten, []);
    } finally {
      made.cleanup();
    }
  });
});

// 主题与关键词是算出来的，口径错一次就会在索引与锚定块里挂很久（真机上第一版把
// `Primary Request and Intent` 切成 `Primary`、关键词出 `the、and、dsh`），所以这两格单独锁死。
describe('ctx 取词：主题与关键词', () => {
  it('主题断在预算内最后一个标点，不是第一个', () => {
    assert.equal(topicOf('## Primary Request and Intent'), 'Primary Request');
    assert.equal(topicOf('# 会话与插件'), '会话与插件');
    assert.equal(topicOf('第一行\n第二行'), '第一行');
    assert.equal(topicOf('\n\n   \n## 空行跳过'), '空行跳过');
    assert.equal(topicOf(''), '');
    assert.equal(topicOf(undefined), '');
  });

  it('长句断在最后一个标点；预算内没有标点就整段留下', () => {
    assert.equal(topicOf('上下文档案要落盘,原文只供检索,摘要才进上下文'), '上下文档案要落盘,原文只供检索');
    assert.equal(topicOf('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnop');
  });

  it('英文虚词不进关键词', () => {
    const words = guessKeywords('The user and the plugin are in the vault for the session');
    assert.equal(words.includes('the'), false);
    assert.equal(words.includes('and'), false);
    assert.equal(words.includes('for'), false);
    assert.equal(words.length > 0, true);
  });

  it('关键词照旧：2–6 字、按次数排、条目标签不算', () => {
    assert.deepEqual(guessKeywords('投影 投影 落盘 落盘 落盘 事实'), ['落盘', '投影']);
    assert.deepEqual(guessKeywords('一二三四五六七'), []);
    assert.deepEqual(guessKeywords('一二'), ['一二']);
    assert.equal(guessKeywords('投影', 1).length, 1);
  });

  // 拿真机那份 `compaction/summary` 走一遍：第一版就是在这份上出的 `Primary、the、and、dsh`。
  it('真机那条摘要：主题不再是 Primary，关键词不再有 the/and', () => {
    const raw = readFileSync(new URL('./fixtures/compaction-summary-2026-11-04.json', import.meta.url), 'utf8');
    const event = JSON.parse(raw);
    const summary = (event.data.summary ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    assert.equal(topicOf(summary), 'Primary Request');
    const words = guessKeywords(summary);
    assert.equal(words.includes('the'), false);
    assert.equal(words.includes('and'), false);
    assert.equal(words.includes('dsh'), true);
    assert.equal(words.length, 3);
  });

  it('refreshCards：只重算主题与关键词两格，摘要范围编号不动', () => {
    const made = workspace();
    try {
      writeCard(made.root, {
        id: 'C001',
        blockId: 'c-1',
        gen: 1,
        batch: 'B001',
        source: 'native',
        at: '2026-11-04T05:00:00Z',
        fields: {
          range: '10–80',
          topic: 'Primary',
          summary: '## Primary Request and Intent\n摘要正文，范围与编号都不该被动。',
          keywords: ['the', 'and'],
          unfinished: '无（自动压缩，原文没标）',
        },
      });
      const file = join(pathsOf(made.root).cards, cardFileName('c-1', 1));
      const before = readFileSync(file, 'utf8');

      const done = refreshCards(made.root);
      assert.equal(done.ok, true);
      assert.deepEqual(done.changed.map((one) => one.id), ['C001']);
      assert.deepEqual(done.failed, []);

      const after = readCards(made.root)[0];
      assert.equal(after.id, 'C001');
      assert.equal(after.fields.topic, 'Primary Request');
      assert.equal(after.fields.keywords.includes('the'), false);
      assert.equal(after.fields.range, '10–80');
      assert.equal(after.fields.summary.includes('摘要正文'), true);
      assert.notEqual(before, readFileSync(file, 'utf8'));
      const index = readFileSync(pathsOf(made.root).index, 'utf8');
      assert.equal(index.includes('Primary Request'), true);
      assert.equal(index.includes('C001'), true);
    } finally {
      made.cleanup();
    }
  });

  it('refreshCards：已经是当前口径的卡片不重写、不算改动', () => {
    const made = workspace();
    try {
      drainQueue({ root: made.root, pending: [pendingOne], now: '2026-11-04T06:00:00Z' });
      const file = join(pathsOf(made.root).cards, cardFileName('c-1', 1));
      const before = statSync(file).mtimeMs;
      const again = refreshCards(made.root);
      assert.deepEqual(again.changed, []);
      assert.equal(statSync(file).mtimeMs, before);
    } finally {
      made.cleanup();
    }
  });
});

describe('ctx 存盘：写文本', () => {
  it('内容一样就不落盘，返回 wrote false', () => {
    const made = workspace();
    try {
      ensureLayout(made.root);
      const file = join(made.root, '试一把.md');
      assert.equal(writeText(file, '甲').wrote, true);
      assert.equal(writeText(file, '甲').wrote, false);
      assert.equal(writeText(file, '乙').wrote, true);
      assert.equal(readFileSync(file, 'utf8'), '乙');
    } finally {
      made.cleanup();
    }
  });
});
