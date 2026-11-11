// 锁原文留存这一层：怎么把事件拼成 md、截断留痕、不碰盘不看时钟，
// 以及最要紧的一条——这份东西只供检索，绝不进上下文。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { MAX_BLOCK_CHARS, NON_TEXT_BLOCK, RAW_DIR_NAME, RAW_MARK, cut, rawFileName, renderRaw, sectionOf } from '../lib/ctx/raw.js';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (name) => readFileSync(join(here, '..', 'lib', 'ctx', name), 'utf8');
const source = readSource('raw.js');

const userEvent = (seq, text) => ({ type: 'user/message', seq, time: 1793754352000 + seq, data: { content: [{ type: 'text', text }] } });
const assistantEvent = (seq, blocks) => ({ type: 'assistant/message', seq, time: 1793754352000 + seq, data: { message: { role: 'assistant', content: blocks } } });
const resultEvent = (seq, text) => ({ type: 'tool/result', seq, time: 1793754352000 + seq, data: { message: { role: 'tool', content: [{ type: 'text', text }] } } });

describe('原文：截断', () => {
  it('够短就原样，够长就砍并留痕', () => {
    assert.equal(cut('短句'), '短句');
    const long = '词'.repeat(MAX_BLOCK_CHARS + 10);
    const out = cut(long);
    assert.equal(out.startsWith('词'.repeat(10)), true);
    assert.equal(out.includes(`…（截断，原文 ${long.length} 字）`), true);
  });

  it('不传就按上限算，空值当空串', () => {
    assert.equal(cut(null), '');
    assert.equal(cut(undefined), '');
  });
});

describe('原文：文件名', () => {
  it('第一代不带代号，第二代起带代号——绝不覆盖上一版', () => {
    assert.equal(rawFileName('c-1'), 'c-1.md');
    assert.equal(rawFileName('c-1', 1), 'c-1.md');
    assert.equal(rawFileName('c-1', 2), 'c-1-2.md');
    assert.equal(rawFileName(undefined), '.md');
  });
});

describe('原文：只拼字', () => {
  it('这一层不碰盘、不看时钟', () => {
    assert.equal(source.includes('node:fs'), false);
    assert.equal(source.includes('Date.now'), false);
  });

  it('不是对话的事件直接跳过', () => {
    assert.equal(sectionOf({ type: 'step/start', seq: 1 }), null);
    assert.equal(sectionOf({ type: 'compaction/prune', seq: 2 }), null);
    assert.equal(sectionOf(null), null);
  });
});

describe('原文：拼一份', () => {
  const events = [
    { type: 'request/header', seq: 14, time: 1793754350000 },
    userEvent(15, '先放着，继续 P3.5'),
    assistantEvent(16, [{ type: 'text', text: '好，接着核。' }, { type: 'reasoning', text: '内部推理不该进原文' }, { type: 'tool-call', name: 'ops_bash', arguments: '{"command":"ls"}' }]),
    resultEvent(17, '目录是空的'),
  ];

  it('头部把块、代数、范围、来源、条数都写清楚', () => {
    const text = renderRaw({ events, blockId: 'c-1', gen: 2, range: '15–824', at: '2026-11-04T05:00:00.000Z', provider: 'guiji', model: 'flash' });
    assert.equal(text.startsWith(`<!-- ${RAW_MARK} block=c-1 gen=2 range=15–824 at=2026-11-04T05:00:00.000Z events=4 kept=3 missing=0 -->`), true);
    assert.equal(text.includes('# 原文留存 · c-1'), true);
    assert.equal(text.includes('- 来源：guiji/flash'), true);
    assert.equal(text.includes('- 原始事件：4 条，收进 3 条'), true);
    assert.equal(text.includes('不参与上下文注入——上下文只放摘要'), true);
    assert.equal(text.includes('request/header 1'), true);
    assert.equal(text.includes('> 缺 '), false);
  });

  it('用户、助手、工具结果各成一小节，工具调用带名字与参数', () => {
    const text = renderRaw({ events, blockId: 'c-1', gen: 1, range: '15–824', at: '2026-11-04T05:00:00.000Z' });
    assert.equal(text.includes('### [seq 15] 用户 · '), true);
    assert.equal(text.includes('先放着，继续 P3.5'), true);
    assert.equal(text.includes('### [seq 16] 助手 · '), true);
    assert.equal(text.includes('**调用工具**：`ops_bash`'), true);
    assert.equal(text.includes('{"command":"ls"}'), true);
    assert.equal(text.includes('### [seq 17] 工具结果 · '), true);
    assert.equal(text.includes('目录是空的'), true);
  });

  it('推理块不进原文，非文本块记占位', () => {
    const text = renderRaw({ events: [assistantEvent(16, [{ type: 'reasoning', text: '内部推理不该进原文' }, { type: 'image' }])], blockId: 'c-1' });
    assert.equal(text.includes('内部推理不该进原文'), false);
    assert.equal(text.includes(NON_TEXT_BLOCK), true);
  });

  it('没有任何事件也给一份合法的头，kept 是 0', () => {
    const text = renderRaw({ events: [], blockId: 'c-9' });
    assert.equal(text.includes(`<!-- ${RAW_MARK} block=c-9 gen=1 range= at= events=0 kept=0 missing=0 -->`), true);
    assert.equal(text.includes('- 范围：未标'), true);
  });

  // 宿主会单点 prune（一次删掉一条 seq，不是整批）。被删的那些 `eventAt` 取不到，
  // 原文里必须写明缺哪几条 —— 不许装作整份都齐。
  it('缺了几条照样出原文，但把缺的 seq 写在最前面', () => {
    const text = renderRaw({ events: [userEvent(15, '在'), resultEvent(17, '还在')], missing: [16], blockId: 'c-1', gen: 1, range: '15–17', at: '2026-11-04T05:00:00.000Z' });
    assert.equal(text.includes('events=2 kept=2 missing=1'), true);
    assert.equal(text.includes('- 原始事件：3 条，收进 2 条'), true);
    assert.equal(text.includes('> 缺 1 条：seq 16（宿主已 prune，内容取不回来了）'), true);
    assert.equal(text.includes('在'), true);
    assert.equal(text.includes('还在'), true);
  });

  it('缺的编号不是数就忽略，只算真的数字', () => {
    const text = renderRaw({ events: [userEvent(15, '甲')], missing: [null, 'x', NaN, 16], blockId: 'c-1' });
    assert.equal(text.includes('missing=1'), true);
    assert.equal(text.includes('> 缺 1 条：seq 16'), true);
  });

  it('长工具结果被砍，也留下砍了多少', () => {
    const text = renderRaw({ events: [resultEvent(20, 'x'.repeat(MAX_BLOCK_CHARS + 5))], blockId: 'c-1' });
    assert.equal(text.includes('…（截断，原文 '), true);
  });

  it('头一行不会被当成卡片头读走', () => {
    const text = renderRaw({ events: [userEvent(15, '甲')], blockId: 'c-1', gen: 1, range: '15–15', at: '2026-11-04T05:00:00.000Z' });
    assert.equal(/^<!-- whale-context block=/.test(text), false);
    assert.equal(text.startsWith(`<!-- ${RAW_MARK}`), true);
  });
});

describe('原文：不进上下文', () => {
  it('目录名跟卡片目录分开，卡片那层按 .md 平铺扫描时扫不到它', () => {
    assert.equal(RAW_DIR_NAME, '原文');
    assert.equal(RAW_DIR_NAME.includes('.'), false);
  });

  it('注入、重建、检索这三层都不认识原文', () => {
    for (const name of ['inject.js', 'rebuild.js', 'search.js']) {
      const body = readSource(name);
      assert.equal(body.includes('raw.js'), false, `${name} 不该引原文`);
      assert.equal(body.includes(RAW_DIR_NAME), false, `${name} 不该碰原文目录`);
    }
  });
});
