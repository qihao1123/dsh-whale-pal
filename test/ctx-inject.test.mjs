// 锁的是锚定块：只放目录、不超过 300 字、哈希一样就不重写、里面绝不许出现日期时间。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  ANCHOR_LIMIT,
  ANCHOR_MAX,
  anchorHash,
  anchorText,
  buildAnchor,
} from '../lib/ctx/inject.js';

function card(id, topic, keywords = ['投影', '档案'], at = '2026-11-04T05:00:00Z') {
  return { id, blockId: `b-${id}`, gen: 1, batch: 'B001', source: 'native', at, fields: { range: '1–2', topic, summary: '摘要', keywords, unfinished: '无' } };
}

describe('锚定块：目录行', () => {
  it('一行是「编号 · 主题（前两个关键词）」，多的关键词不进来', () => {
    const lines = buildAnchor({ cards: [card('C001', '投影与落盘', ['投影', '落盘', '第三次'])] });
    assert.deepEqual(lines, ['C001 · 投影与落盘（投影、落盘）']);
  });

  it('主题超过 12 字就切', () => {
    const lines = buildAnchor({ cards: [card('C002', '一二三四五六七八九十十一十二十三')] });
    assert.equal(lines[0], 'C002 · 一二三四五六七八九十十一（投影、档案）');
  });

  // 缩的时候落在边界上，别切出半个词：`Primary Request` 该缩成 `Primary`，不是 `Primary Requ`。
  it('主题缩在词/标点边界上', () => {
    assert.equal(buildAnchor({ cards: [card('C003', 'Primary Request and Intent')] })[0], 'C003 · Primary（投影、档案）');
    assert.equal(buildAnchor({ cards: [card('C004', '上下文档案要落盘,原文只供检索')] })[0], 'C004 · 上下文档案要落盘（投影、档案）');
  });

  it('边界太靠前就宁可整段切', () => {
    assert.equal(buildAnchor({ cards: [card('C005', 'ab cdefghijklmnop')] })[0], 'C005 · ab cdefghijk（投影、档案）');
  });

  it('最多只放 12 条，最近的排前面', () => {
    const cards = [];
    for (let index = 1; index <= 15; index += 1) {
      const day = String(index).padStart(2, '0');
      cards.push(card(`C${String(index).padStart(3, '0')}`, `主题${index}`, ['投影'], `2026-11-${day}T00:00:00Z`));
    }
    const lines = buildAnchor({ cards });
    assert.equal(lines.length, ANCHOR_LIMIT);
    assert.equal(lines[0].startsWith('C015'), true);
    assert.equal(lines[ANCHOR_LIMIT - 1].startsWith('C004'), true);
  });

  it('没时间的排后面，缺编号的跳过', () => {
    const lines = buildAnchor({
      cards: [card('C001', '有时间的'), { id: '', fields: { topic: '没编号' } }, { id: 'C002', fields: { topic: '没时间的' } }],
    });
    assert.deepEqual(lines, ['C001 · 有时间的（投影、档案）', 'C002 · 没时间的']);
  });
});

describe('锚定块：文本', () => {
  it('不超过 300 字', () => {
    const lines = buildAnchor({ cards: [card('C001', '投影与落盘')] });
    const text = anchorText({ lines });
    assert.equal(text.length <= ANCHOR_MAX, true);
  });

  it('超长要截断并补省略号', () => {
    const many = [];
    for (let index = 1; index <= 12; index += 1) many.push(`C${String(index).padStart(3, '0')} · 主题${'很长'.repeat(6)}（投影、档案）`);
    const text = anchorText({ lines: many });
    assert.equal(text.length <= ANCHOR_MAX + 1, true);
    assert.equal(text.endsWith('…'), true);
  });

  it('日期时间一律滤掉', () => {
    const text = anchorText({ lines: ['C001 · 2026-11-04 的会（投影、档案）', 'C002 · 2026-11-04T05:00:00Z 又说了一次'] });
    assert.equal(text.includes('2026-11-04'), false);
  });

  it('空输入回空串，不报错', () => {
    assert.equal(anchorText({ lines: [] }), '');
    assert.equal(anchorText({}), '');
  });
});

describe('锚定块：哈希', () => {
  it('同一份文本哈希不变', () => {
    const text = anchorText({ lines: buildAnchor({ cards: [card('C001', '投影')] }) });
    assert.equal(anchorHash(text), anchorHash(text));
  });

  it('换一个字哈希就变', () => {
    assert.notEqual(anchorHash('甲'), anchorHash('乙'));
  });

  it('CRLF 与 LF、末尾多几个换行，算出来一样', () => {
    const expected = createHash('md5').update('甲\n乙\n', 'utf8').digest('hex');
    assert.equal(anchorHash('甲\n乙'), expected);
    assert.equal(anchorHash('甲\r\n乙\r\n'), expected);
    assert.equal(anchorHash('甲\n乙\n\n\n'), expected);
  });

  it('空文本也有哈希，不抛', () => {
    const expected = createHash('md5').update('\n', 'utf8').digest('hex');
    assert.equal(anchorHash(''), expected);
  });
});
