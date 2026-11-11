import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  abandon,
  allStagesDone,
  begin,
  confirm,
  createProgress,
  defer,
  finish,
  formatMarker,
  jumpBack,
  land,
  nextStageNumber,
  progressText,
  readProgress,
  restart,
  rework,
  saveProgress,
} from '../lib/progress.js'

// 七形态的写法是照施工前总结 §5 抄的，改一个字都要先问人。
const SEVEN = [
  'Stage 1·拆解·已完成',
  'Stage 2·未确认',
  'Stage 3·返工中',
  'Stage 4·已放弃',
  '六阶段已完成·待落地',
  '六阶段已完成·已落地',
  'Stage 4·延迟待补',
]

function opened(stage = 1) {
  let progress = createProgress()
  for (let i = 1; i < stage; i += 1) {
    progress = begin(progress).progress
    progress = confirm(progress, `确定stage ${i} 阶段`).progress
  }
  return begin(progress).progress
}

test('七种进度点写法一字不差', () => {
  assert.equal(formatMarker({ stage: 1, mark: 'done' }), SEVEN[0])
  assert.equal(formatMarker({ stage: 2, mark: 'unconfirmed' }), SEVEN[1])
  assert.equal(formatMarker({ stage: 3, mark: 'rework' }), SEVEN[2])
  assert.equal(formatMarker({ stage: 4, mark: 'abandoned' }), SEVEN[3])
  assert.equal(formatMarker({ stage: 6, mark: 'allPending' }), SEVEN[4])
  assert.equal(formatMarker({ stage: 6, mark: 'allLanded' }), SEVEN[5])
  assert.equal(formatMarker({ stage: 4, mark: 'deferred' }), SEVEN[6])
})

test('没开工不渲染进度点，也不渲染空段', () => {
  const progress = createProgress()
  assert.equal(formatMarker(progress), '')
  assert.equal(progressText(progress), '')
})

test('开工后等确认，口令不对一律不前进', () => {
  let progress = begin(createProgress()).progress
  assert.equal(formatMarker(progress), 'Stage 1·未确认')
  for (const raw of ['对', '好', '嗯', 'OK', '继续', '', '确定stage 2 阶段']) {
    const result = confirm(progress, raw)
    assert.equal(result.ok, false, `「${raw}」不该推进`)
    assert.equal(result.ask, '要确认这一步，回我一句「确定stage 阶段号 阶段」，阶段号得是现在待确认的那个。')
    assert.equal(progress.stage, 1)
    assert.equal(progress.mark, 'unconfirmed')
  }
  const done = confirm(progress, '确定stage 1 阶段')
  assert.equal(done.ok, true)
  assert.equal(formatMarker(done.progress), SEVEN[0])
  assert.equal(done.progress.pending, 0)
})

test('六阶段走完是待落地，落地是另一格状态', () => {
  let progress = opened(1)
  for (let n = 1; n <= 6; n += 1) {
    progress = confirm(progress, `确定stage ${n} 阶段`).progress
    if (n < 6) progress = begin(progress).progress
  }
  assert.equal(allStagesDone(progress), true)
  assert.equal(nextStageNumber(progress), 0)
  const pending = finish(progress)
  assert.equal(pending.ok, true)
  assert.equal(formatMarker(pending.progress), '六阶段已完成·待落地')
  const landed = land(pending.progress)
  assert.equal(landed.ok, true)
  assert.equal(formatMarker(landed.progress), '六阶段已完成·已落地')
  assert.equal(land(landed.progress).ok, false)
})

test('六个阶段没走完不许说待落地', () => {
  const progress = opened(2)
  const result = finish(progress)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not-all-done')
})

test('返工与放弃都留痕，放弃的不会被自己捡回来', () => {
  const done = confirm(opened(2), '确定stage 2 阶段').progress
  const back = rework(done)
  assert.equal(back.ok, true)
  assert.equal(formatMarker(back.progress), 'Stage 2·返工中')
  assert.equal(back.progress.pending, 2)

  const quit = abandon(back.progress)
  assert.equal(quit.ok, true)
  assert.equal(formatMarker(quit.progress), 'Stage 2·已放弃')
  assert.equal(quit.progress.pending, 0)
  assert.match(progressText(quit.progress), /放弃了，别自己捡回来/u)
})

test('只有第 4 阶段能延迟待补', () => {
  assert.equal(defer(opened(3)).error, 'not-deferrable')
  const deferred = defer(opened(4))
  assert.equal(deferred.ok, true)
  assert.equal(formatMarker(deferred.progress), SEVEN[6])
  assert.match(progressText(deferred.progress), /别当成做完了/u)
})

test('定向回跳：从任意位置退回某一阶段重做', () => {
  const progress = opened(5)
  const jumped = jumpBack(progress, 2)
  assert.equal(jumped.ok, true)
  assert.equal(jumped.progress.stage, 2)
  assert.equal(jumped.progress.mark, 'rework')
  assert.equal(jumpBack(progress, 9).error, 'bad-stage')
  assert.equal(jumpBack(progress, 0).error, 'bad-stage')
})

test('任意断点都能续跑：落盘再读回来，状态与待确认号都不丢', () => {
  const home = mkdtempSync(join(tmpdir(), 'whale-pal-progress-'))
  const file = join(home, 'progress.json')
  try {
    const progress = opened(3)
    saveProgress(file, progress)

    const restored = readProgress(file)
    assert.deepEqual(
      { stage: restored.stage, mark: restored.mark, pending: restored.pending },
      { stage: 3, mark: 'unconfirmed', pending: 3 },
    )

    // 续跑：拿回同一个待确认号，口令照旧能过。
    const done = confirm(restored, '确定stage 3 阶段')
    assert.equal(done.ok, true)
    assert.equal(done.progress.stage, 3)
    assert.equal(done.progress.mark, 'done')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('文件不存在等于没开工，坏文件也不炸', () => {
  const home = mkdtempSync(join(tmpdir(), 'whale-pal-progress-'))
  try {
    const fresh = readProgress(join(home, 'nope.json'))
    assert.equal(fresh.mark, 'idle')
    assert.equal(fresh.stage, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('历史只追加，动作与前后状态都记下', () => {
  let progress = begin(createProgress()).progress
  progress = confirm(progress, '确定stage 1 阶段').progress
  assert.deepEqual(progress.history.map((item) => item.action), ['begin', 'confirm'])
  assert.equal(progress.history[0].to, '1/unconfirmed')
  assert.equal(progress.history[1].to, '1/done')
})

test('落地之后能开新一轮：旧账留在历史里，新的一轮从第 1 阶段起', () => {
  let progress = createProgress(1000)
  progress = begin(progress, 1001).progress
  progress = confirm(progress, '确定stage 1 阶段', 1002).progress
  // 一路走到落地
  for (const n of [2, 3, 4, 5, 6]) {
    progress = begin(progress, 1003 + n).progress
    progress = confirm(progress, `确定stage ${n} 阶段`, 1004 + n).progress
  }
  progress = finish(progress, 1010).progress
  assert.equal(progress.mark, 'allPending')
  // 还没落地时不许重开：那等于把欠着的交付抹掉
  assert.equal(restart(progress, 1011).error, 'not-landed')
  progress = land(progress, 1012).progress
  assert.equal(progress.mark, 'allLanded')

  const fresh = restart(progress, 1013)
  assert.equal(fresh.ok, true)
  assert.equal(fresh.progress.stage, 0)
  assert.equal(fresh.progress.mark, 'idle')
  assert.equal(fresh.progress.pending, 0)
  assert.equal(fresh.progress.history.at(-1).action, 'restart')
  // 新一轮能正常开工
  const opened = begin(fresh.progress, 1014)
  assert.equal(opened.ok, true)
  assert.equal(opened.progress.pending, 1)
})

test('没走完的阶段不许重开', () => {
  const progress = createProgress(2000)
  assert.equal(restart(progress, 2001).error, 'not-finished')
  const opened = begin(progress, 2002).progress
  assert.equal(restart(opened, 2003).error, 'not-finished')
})
