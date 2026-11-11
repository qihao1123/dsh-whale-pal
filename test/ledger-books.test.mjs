/**
 * 台账纯逻辑：六列 / 四类型 / 待补与补齐 / 幂等键 / 转义往返 / 另外三本账。
 * 口径出处：`融合计划-v2.md` §11.6（一行一条、类型只四种、教训宁缺不凑、不当场定论）、
 * §7 第 5 条（只追加，不修改历史行）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOKS,
  EVENT_TYPES,
  HANDOFF_IGNORED,
  HANDOFF_OPEN,
  REMINDER_PENDING,
  appendRow,
  bookOf,
  findByKey,
  fillRow,
  keyOfRow,
  rowsOf,
  setStatus,
  skeleton,
  statusOf,
} from '../lib/ledger/books.js';
import { dayGap, eventCells, isEventType, pendingFills } from '../lib/ledger/event.js';
import { PLACEHOLDER, parseRows, renderRow } from '../lib/ledger/table.js';

function added(cells, text = '') {
  const done = appendRow({ book: '事件', text, cells });
  assert.equal(done.ok, true, done.reason);
  return done;
}

describe('台账 · 五本账的口径', () => {
  it('五本账齐、文件名与人可读的列都在', () => {
    assert.deepEqual(
      BOOKS.map((book) => book.name),
      ['事件', '偏离', '异议', '待交接', '待提醒'],
    );
    assert.deepEqual(bookOf('事件').columns, ['时间', '类型', '发生了什么', '当时的判断', '结果', '教训']);
    assert.deepEqual(bookOf('待提醒').columns, ['时间', '键', '提醒什么', '状态']);
    assert.equal(bookOf('事件.md').name, '事件');
    assert.equal(bookOf('没有这本'), null);
  });

  it('骨架是一张空表加说明行，说明不参与数据行', () => {
    const text = skeleton('事件');
    assert.match(text, /^# 事件台账/mu);
    assert.match(text, /^\| 时间 \| 类型 \|/mu);
    assert.deepEqual(rowsOf('事件', text), []);
    assert.deepEqual(parseRows(text), []);
  });

  it('事件类型只有四种，第五种不收', () => {
    assert.deepEqual([...EVENT_TYPES], ['任务', '纠正', '偏好', '观察']);
    assert.equal(isEventType('纠正'), true);
    assert.equal(isEventType('感想'), false);
    const done = appendRow({ book: '事件', text: '', cells: eventCells({ at: '2026-11-05T03:20', type: '感想', what: 'x' }) });
    assert.equal(done.ok, false);
    assert.equal(done.reason, 'bad-type');
  });

  it('必填列空着不收，报哪一列', () => {
    const done = appendRow({ book: '事件', text: '', cells: eventCells({ at: '2026-11-05T03:20', type: '任务' }) });
    assert.equal(done.ok, false);
    assert.equal(done.reason, 'missing:发生了什么');
    assert.equal(appendRow({ book: '待交接', text: '', cells: { 时间: '2026-11-05', 答应过的事: '答应的事' } }).reason, 'missing:键');
  });
});

describe('台账 · 不当场定论', () => {
  it('当场那一行只写三格，判断/结果/教训落成待补', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '把 3 份笔记按域归档' });
    assert.deepEqual(cells, ['2026-11-05T03:20', '任务', '把 3 份笔记按域归档', PLACEHOLDER, PLACEHOLDER, PLACEHOLDER]);
  });

  it('补齐只替换「待补」那一格，其余字节不动', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '归档' });
    const first = added(cells);
    const key = keyOfRow('事件', cells);
    const filled = fillRow({ book: '事件', text: first.text, key, patch: { 教训: '归属不明时先问一句' } });
    assert.equal(filled.ok, true);
    assert.deepEqual(filled.filled, ['教训']);
    assert.deepEqual(filled.skipped, []);

    const before = rowsOf('事件', first.text)[0].cells;
    const after = rowsOf('事件', filled.text)[0].cells;
    assert.deepEqual(after[5], '归属不明时先问一句');
    for (const i of [0, 1, 2, 3, 4]) assert.equal(after[i], before[i], `第 ${i} 格不该动`);
  });

  it('已定稿的格不再改：第二次补同一格，或者改已有内容，一律拒', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '归档' });
    const first = added(cells);
    const key = keyOfRow('事件', cells);
    const filled = fillRow({ book: '事件', text: first.text, key, patch: { 教训: '先问一句' } });
    const again = fillRow({ book: '事件', text: filled.text, key, patch: { 教训: '换个说法' } });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'no-placeholder');
    assert.deepEqual(again.skipped, ['教训']);
  });

  it('空值不算补齐，一格都没换成就整条拒绝（「无新增」要人自己写）', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '归档' });
    const first = added(cells);
    const key = keyOfRow('事件', cells);
    const done = fillRow({ book: '事件', text: first.text, key, patch: { 教训: '   ' } });
    assert.equal(done.ok, false);
    assert.equal(done.reason, 'no-placeholder');
  });

  it('隔一天才列出来补：当天写的不催，第二天（或更晚）才出现', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '归档' });
    const first = added(cells);
    assert.deepEqual(pendingFills({ text: first.text, today: '2026-11-05' }), []);
    const next = pendingFills({ text: first.text, today: '2026-11-06' });
    assert.equal(next.length, 1);
    assert.deepEqual(next[0].missing, ['当时的判断', '结果', '教训']);
    assert.equal(next[0].ageDays, 1);
    assert.equal(next[0].key, keyOfRow('事件', cells));

    const half = fillRow({ book: '事件', text: first.text, key: next[0].key, patch: { 结果: '你改到了 C 域' } });
    const left = pendingFills({ text: half.text, today: '2026-11-07' });
    assert.deepEqual(left[0].missing, ['当时的判断', '教训']);
    assert.equal(left[0].ageDays, 2);
  });

  it('日期差不看时钟只看参数；读不出的日期宁可不提示', () => {
    assert.equal(dayGap('2026-11-05', '2026-11-06'), 1);
    assert.equal(dayGap('2026-11-05', '2026-12-05'), 30);
    assert.equal(dayGap('', '2026-11-06'), null);
    assert.equal(dayGap('2026-11-05', '乱七八糟'), null);
    const odd = renderRow(['没写时间', '任务', 'x', PLACEHOLDER, PLACEHOLDER, PLACEHOLDER]);
    const text = `${skeleton('事件')}${odd}\n`;
    assert.deepEqual(pendingFills({ text, today: '2026-11-06' }), []);
  });
});

describe('台账 · 一行一条与幂等', () => {
  it('同一条账再写一次：跳过，正文一个字节不变', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '归档' });
    const first = added(cells);
    const again = appendRow({ book: '事件', text: first.text, cells });
    assert.equal(again.ok, true);
    assert.equal(again.wrote, false);
    assert.equal(again.skipped, true);
    assert.equal(again.text, undefined, '跳过时不该给出新正文（调用方据此不写盘）');
    assert.equal(rowsOf('事件', first.text).length, 1);
  });

  it('追加只接在末尾，别的行原样', () => {
    const first = added(eventCells({ at: '2026-11-05T03:20', type: '任务', what: '第一条' }));
    const second = appendRow({ book: '事件', text: first.text, cells: eventCells({ at: '2026-11-05T04:00', type: '观察', what: '第二条' }) });
    assert.equal(second.text.startsWith(first.text), true);
    assert.deepEqual(
      rowsOf('事件', second.text).map((row) => row.cells[2]),
      ['第一条', '第二条'],
    );
  });

  it('竖线转义：文件里是 \\|，读回来是原样的 |，键也照样对得上', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: 'A | B' });
    const first = added(cells);
    assert.match(first.text, /A \\\| B/u);
    assert.deepEqual(rowsOf('事件', first.text)[0].cells[2], 'A | B');
    const key = keyOfRow('事件', cells);
    assert.equal(key, '2026-11-05T03:20|任务|A | B');
    assert.notEqual(findByKey('事件', first.text, key), null);
  });

  it('换行进不了格子：压成一行，不留半条账', () => {
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '第一行\n第二行' });
    const first = added(cells);
    assert.equal(rowsOf('事件', first.text).length, 1);
    assert.equal(rowsOf('事件', first.text)[0].cells[2], '第一行 第二行');
  });
});

describe('台账 · 另外三本账', () => {
  it('待交接：键去重、状态默认待处理、只能从待处理往前推', () => {
    const cells = ['2026-11-04T04:40:59.078Z', 'lapse:241#9', '记着 guiji 1M 窗口未结', HANDOFF_OPEN];
    const first = appendRow({ book: '待交接', text: '', cells });
    assert.equal(first.ok, true);
    assert.equal(first.wrote, true);
    const again = appendRow({ book: '待交接', text: first.text, cells });
    assert.equal(again.skipped, true);

    const settled = setStatus({ book: '待交接', text: first.text, key: 'lapse:241#9', status: '已结' });
    assert.equal(settled.ok, true);
    assert.equal(settled.changed, true);
    assert.equal(statusOf('待交接', rowsOf('待交接', settled.text)[0].cells), '已结');
    // 已经结过的行不许再标：标成「已忽略」也拒，避免处理记录被改写。
    const flip = setStatus({ book: '待交接', text: settled.text, key: 'lapse:241#9', status: HANDOFF_IGNORED });
    assert.equal(flip.ok, false);
    assert.equal(flip.reason, 'not-open');
    // 重复标同一个状态是幂等的。
    const same = setStatus({ book: '待交接', text: settled.text, key: 'lapse:241#9', status: '已结' });
    assert.equal(same.ok, true);
    assert.equal(same.changed, false);
  });

  it('待交接：行里自带键列，人的话看不出来也不影响', () => {
    const first = appendRow({ book: '待交接', text: '', cells: { 时间: '2026-11-04', 键: 'lapse:1#0', 答应过的事: '把文档里那条错命令改掉' } });
    assert.deepEqual(rowsOf('待交接', first.text)[0].cells, ['2026-11-04', 'lapse:1#0', '把文档里那条错命令改掉', HANDOFF_OPEN]);
  });

  it('待提醒：同一个周期键只一行，默认待报', () => {
    const cells = { 时间: '2026-11-05T09:00', 键: 'day:2026-11-05', 提醒什么: '今天 2026-11-05：没有欠着的事' };
    const first = appendRow({ book: '待提醒', text: '', cells });
    assert.deepEqual(rowsOf('待提醒', first.text)[0].cells[3], REMINDER_PENDING);
    assert.equal(appendRow({ book: '待提醒', text: first.text, cells }).skipped, true);
  });

  it('偏离与异议：四列/五列，缺的格先落待补', () => {
    const dev = appendRow({ book: '偏离', text: '', cells: { 场景: '归档', 偏离: '按标签猜了' } });
    assert.deepEqual(rowsOf('偏离', dev.text)[0].cells, ['归档', '按标签猜了', PLACEHOLDER, PLACEHOLDER]);
    const dis = appendRow({ book: '异议', text: '', cells: { 时间: '2026-11-05', 议题: '要不要自动压缩', 我的看法: '不自动', 你的看法: '看情况' } });
    assert.deepEqual(rowsOf('异议', dis.text)[0].cells, ['2026-11-05', '要不要自动压缩', '不自动', '看情况', PLACEHOLDER]);
  });
});
