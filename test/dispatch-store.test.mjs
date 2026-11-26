/**
 * 派活账本：只测状态变换和读写。不碰宿主、不碰会话。
 *
 * 这一层最容易出的错是「丢件」——池里没了、历史里也没有，人查不到这单去哪了。
 * 所以每一条出池的路都单独测一遍（投出去 / 投不出去 / 会话没了）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DISPATCH_SENT_KEEP,
  DISPATCH_STATE_VERSION,
  clearProjectRecord,
  dropQueued,
  emptyDispatchState,
  enqueueTask,
  isQueued,
  markAttempt,
  normalizeDispatchState,
  projectRecordOf,
  queueLength,
  queuedForSession,
  readDispatchState,
  recordSent,
  saveDispatchState,
  setProjectRecord,
  settleSent,
} from '../lib/dispatch-store.js'

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `whale-store-${name}-`))
}

const item = (over = {}) => ({
  id: 'd1',
  project: 'p',
  task: 't',
  sessionId: 's-1',
  permission: 'danger-full-access',
  taskDir: 'D:\\p\\t',
  docPath: 'D:\\v\\t.md',
  at: '2026-11-27T00:00:00.000Z',
  attempts: 0,
  lastError: '',
  ...over,
})

describe('空账本与读坏', () => {
  it('没有文件就是空账本，不算坏', () => {
    const state = readDispatchState(join(tempDir('absent'), 'dispatch.json'))
    assert.deepEqual(state.queue, [])
    assert.deepEqual(state.projects, {})
    assert.equal(state.broken, false)
    assert.equal(state.version, DISPATCH_STATE_VERSION)
  })

  it('文件坏了要说 broken，不假装「一条都没派过」', () => {
    const file = join(tempDir('broken'), 'dispatch.json')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const state = readDispatchState(file)
    assert.equal(state.broken, true)
    assert.deepEqual(state.queue, [])
    assert.deepEqual(state.projects, {})
  })

  it('存了再读，内容一字不差', () => {
    const file = join(tempDir('roundtrip'), 'dispatch.json')
    const state = setProjectRecord(emptyDispatchState(), 'p', { sessionId: 's-1', permission: 'workspace-write' })
    assert.equal(saveDispatchState(file, state).ok, true)
    const again = readDispatchState(file)
    assert.equal(again.projects.p.sessionId, 's-1')
    assert.equal(again.projects.p.permission, 'workspace-write')
    assert.equal(again.broken, false)
    assert.match(readFileSync(file, 'utf8'), /"sessionId": "s-1"/)
  })

  it('形状不对的条目被丢掉，不把坏数据带进状态机', () => {
    const state = normalizeDispatchState({
      projects: { 好的: { sessionId: 's-1' }, 坏的: { permission: 'x' } },
      queue: [{ id: 'a', project: 'p', task: 't', sessionId: 's-1' }, { id: '' }, null, 5],
      sent: [],
    })
    assert.deepEqual(Object.keys(state.projects), ['好的'])
    assert.equal(state.queue.length, 1)
  })
})

describe('项目记录', () => {
  it('记下、读回、抹掉', () => {
    let state = emptyDispatchState()
    state = setProjectRecord(state, 'p', { sessionId: 's-1', permission: 'workspace-write', at: '2026-11-27T00:00:00.000Z' })
    assert.equal(projectRecordOf(state, 'p').sessionId, 's-1')
    assert.equal(projectRecordOf(state, '没有这个'), null)
    state = clearProjectRecord(state, 'p')
    assert.equal(projectRecordOf(state, 'p'), null)
  })

  it('空项目名、空会话编号不记账', () => {
    const state = emptyDispatchState()
    assert.equal(projectRecordOf(setProjectRecord(state, '', { sessionId: 's-1' }), ''), null)
    assert.equal(projectRecordOf(setProjectRecord(state, 'p', { sessionId: '' }), 'p'), null)
  })
})

describe('池子', () => {
  it('入池后有顺序，能按会话捞', () => {
    let state = emptyDispatchState()
    state = enqueueTask(state, item({ id: 'd1' }))
    state = enqueueTask(state, item({ id: 'd2', task: 't2' }))
    assert.equal(queueLength(state), 2)
    assert.deepEqual(queuedForSession(state, 's-1').map((one) => one.id), ['d1', 'd2'])
    assert.deepEqual(queuedForSession(state, '别人的'), [])
  })

  it('同项目同任务不重复入池：派两次只投一次', () => {
    let state = enqueueTask(emptyDispatchState(), item({ id: 'd1' }))
    state = enqueueTask(state, item({ id: 'd9' }))
    assert.equal(queueLength(state), 1)
    assert.equal(isQueued(state, { project: 'p', task: 't' }), true)
    assert.equal(isQueued(state, { project: 'p', task: '别的' }), false)
  })

  it('投成功：出池、进历史，历史留最近 50 条', () => {
    let state = emptyDispatchState()
    state = enqueueTask(state, item({ id: 'd1' }))
    state = settleSent(state, 'd1')
    assert.equal(queueLength(state), 0)
    assert.equal(state.sent.length, 1)

    for (let i = 0; i < DISPATCH_SENT_KEEP + 5; i += 1) {
      state = enqueueTask(state, item({ id: `x${i}` }))
      state = settleSent(state, `x${i}`)
    }
    assert.equal(state.sent.length, DISPATCH_SENT_KEEP, '历史不能无限长')
    assert.equal(state.sent.at(-1).id, `x${DISPATCH_SENT_KEEP + 4}`)
  })

  it('直接投的也记一笔：不进池不等于不记账', () => {
    const state = recordSent(emptyDispatchState(), item({ id: '直接投的' }))
    assert.equal(state.sent.length, 1)
    assert.equal(state.sent[0].id, '直接投的')
    assert.equal(queueLength(state), 0)
  })

  it('投失败：留在池里，次数和原因都记下', () => {
    let state = enqueueTask(emptyDispatchState(), item({ id: 'd1' }))
    state = markAttempt(state, 'd1', '宿主拒绝')
    assert.equal(queueLength(state), 1)
    assert.equal(state.queue[0].attempts, 1)
    assert.equal(state.queue[0].lastError, '宿主拒绝')
    state = markAttempt(state, 'd1', '又一次')
    assert.equal(state.queue[0].attempts, 2)
  })

  it('投不出去（会话没了）：出池，理由留在历史里，查得到', () => {
    let state = enqueueTask(emptyDispatchState(), item({ id: 'd1' }))
    state = dropQueued(state, 'd1', 'session-gone')
    assert.equal(queueLength(state), 0)
    assert.equal(state.sent.at(-1).id, 'd1')
    assert.equal(state.sent.at(-1).lastError, 'session-gone')
  })

  it('出池只认自己那一条：编号对不上时什么都不动', () => {
    const state = enqueueTask(emptyDispatchState(), item({ id: 'd1' }))
    assert.equal(settleSent(state, '没这条'), state)
    assert.equal(dropQueued(state, '没这条'), state)
    assert.equal(markAttempt(state, '没这条'), state)
  })
})
