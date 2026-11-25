/**
 * 更新器：把评估结果落成状态变化。
 *
 * v6（2026-11-10）：状态机拆掉后，这里只做两件事——
 *   1. 记忆：写入、去重、淡忘、晋升长期层；
 *   2. 承诺：答应过的事有状态（open / done / lapsed），不是一条会淡的记忆。
 *
 * 不再有 traits 衰减、mood 回归、关系数值、称呼意愿值、goal 结转。
 * 每一个变化仍产出一条可审计的记录，改了什么都说得清。
 */

import { CAPS } from './state/schema.js'
import { ensureProjectScene } from './project.js'
import { findConflictingRule } from './hardrules.js'
import { normalizeSceneId, parentScene, sceneOf, SCENE_OWNER } from './scene.js'
import {
  addMemory,
  entryText,
  fadeMemory,
  pinLong,
  planWriteScene,
  promoteMemory,
  reevaluateElevations,
  resolveMemory,
  similarity,
  MEMORY_KINDS,
  tombstonesOf,
} from './memory.js'

// 答应的东西：旧了还没做就是「说到没做到」。这不是骂人，是记账——记下来才谈得上补。
const COMMITMENT_LAPSE_TURNS = 12

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state))
}

/**
 * 主入口。返回 { state, changes, ordinal, salience }，不修改传入的 state。
 * options = { now, turn, seq }
 */
export function applyAssessment(inputState, assessment, options = {}) {
  const now = options.now ?? Date.now()
  // 来源指针（2026-11-09）：`{ session: 这一轮的序号, turn, seq }`。
  // seq 是那句用户原话在会话事件里的位置，取回时靠它回档案捞原话。
  // 拿不到 seq 就写 null —— 不拿 turn 凑一个「大概在哪」，那会让取回说假话。
  const sourceTurn = Number(options.turn) || 0
  const sourceSeq = Number(options.seq) || 0
  const changes = []
  if (!assessment) return { state: inputState, changes, ordinal: inputState?.sessionOrdinal ?? 0, salience: 0 }

  const state = cloneState(inputState)
  state.sessionOrdinal = (state.sessionOrdinal ?? 0) + 1
  // 淘汰留痕：这一轮顶掉的条目，编号/时间/原因要留下来，否则「查不到」说不清是哪一种。
  const tombstones = tombstonesOf(state)
  const ordinal = state.sessionOrdinal
  const ref = sourceSeq > 0 ? { session: ordinal, turn: sourceTurn, seq: sourceSeq } : null
  const salience = typeof assessment.salience === 'number' ? assessment.salience : 0
  // 当前场景（记忆分层 P0/P1）：写入时带上它，才知道这条该落在哪个池子。
  // 只有在真要写东西时才定场景——只是路过一个目录，不该平白多出一个项目池。
  let writeScene = null
  const sceneForWrite = () => {
    if (writeScene !== null) return writeScene
    writeScene = resolveSceneId(state, options, now)
    return writeScene
  }

  // ── 记忆：不论轻重都记，人类主动说的事实本来就该留下
  // 去重、重要度、淘汰都在 memory.js 里：同义合并成一条，被重复提到更重要，满了先丢最淡的。
  const memoryCaps = {
    facts: CAPS.facts,
    preferences: CAPS.preferences,
    events: CAPS.events,
    openTopics: CAPS.openTopics,
  }
  const touchedMemory = []
  // 写死的规则（P3 规则五）：人写的常驻指令跟学来的直接矛盾时，学来的那条当噪声丢掉。
  const hardRules = Array.isArray(options.rules) ? options.rules : []
  const requestSceneSlot = (target, text, id = '') => {
    const list = Array.isArray(state.sceneRequests) ? state.sceneRequests : (state.sceneRequests = [])
    if (list.some((item) => item.scene === target && similarity(item.text, text) >= 0.75)) return false
    list.push({ id: String(id ?? '').slice(0, 30), scene: target, text: String(text).slice(0, 300), at: now, session: ordinal })
    while (list.length > 20) list.shift()
    return true
  }
  if (assessment.memory) {
    const writingScene = sceneForWrite()
    for (const kind of MEMORY_KINDS) {
      const list = state.memory[kind]
      if (!Array.isArray(list)) continue
      for (const text of assessment.memory[kind] ?? []) {
        // 规则五：写死的赢。丢的那条要留一句为什么，否则人只看到她「记错了」。
        const conflict = findConflictingRule(text, hardRules)
        if (conflict) {
          changes.push({ kind: `memory:${kind}`, op: 'blocked', to: text, why: `跟写死的规则冲突：${conflict.rule}` })
          continue
        }
        // 规则二：按类别定层（偏好进主人层，点名了项目的留在项目层）。
        const target = planWriteScene(kind, writingScene, text, state.scenes)
        const result = addMemory(list, text, {
          kind,
          now,
          session: ordinal,
          cap: memoryCaps[kind],
          ref,
          tombstones,
          scene: target,
        })
        if (result.status === 'skipped') continue
        touchedMemory.push(text)
        if (result.elevation?.blocked) {
          // 规则四：项目通用层满 50，不许自己丢一条，提个请求等人决定。
          requestSceneSlot(result.elevation.scene, text, result.elevation.id)
          changes.push({ kind: `memory:${kind}`, op: 'requested', to: text, why: '项目通用层满了，等人决定谁走' })
          continue
        }
        if (result.elevation?.from) {
          changes.push({
            kind: `memory:${kind}`,
            op: 'elevated',
            to: text,
            why: `在别的场景也出现过，升到共同父节点（原属 ${result.elevation.from}）`,
          })
        }
        if (result.status === 'added') {
          changes.push({ kind: `memory:${kind}`, op: 'added', to: text })
        } else {
          changes.push({ kind: `memory:${kind}`, op: 'merged', to: text })
        }
        if (result.evicted) changes.push({ kind: `memory:${kind}`, op: 'forgot', to: result.evicted })
      }
    }
  }

  // ── 做完了的事：不是删掉，是「不必再提」。
  // 只在同一个池子里结：A 项目里说「这件事做完了」，不该把 B 项目的同名事结掉。
  for (const text of assessment.resolvedTopics ?? []) {
    const done = resolveMemory(state.memory.openTopics ?? [], text, { session: ordinal, scene: sceneForWrite() })
    if (!done) continue
    touchedMemory.push(done)
    changes.push({ kind: 'memory:openTopics', op: 'resolved', to: done })
  }

  // 淡忘：没被提到的记忆慢慢变淡，容量紧张时清掉已经很淡的。
  for (const kind of MEMORY_KINDS) {
    const list = state.memory[kind]
    if (!Array.isArray(list)) continue
    const forgotten = fadeMemory(list, { session: ordinal, cap: memoryCaps[kind], touched: touchedMemory, tombstones, kind })
    for (const text of forgotten) changes.push({ kind: `memory:${kind}`, op: 'faded', to: text })
  }

  // ── 分层：反复被提到的东西升进长期层，此后不再参与衰减。
  // 这一步放在淡忘之后：只有真的活过了好几轮的记忆，才有资格说「我一直记得」。
  const promoted = promoteMemory(state, { session: ordinal, now, cap: CAPS.longMemory })
  for (const text of promoted) changes.push({ kind: 'memory:long', op: 'promoted', to: text })

  // ── 对方明确说了「记住这个」：不先淡一轮，直接钉进长期层
  // 为什么另开一条路：hits ≥ 3 的晋升线在本机 337 条记忆里一次都没触发过（最高只有 2），
  // 也就是说「长期层」实际上没有入口。人亲自交代「记住」，是唯一不需要靠巧合的入口。
  //
  // 规则一（P3）：明确说过的升到**当前场景的上一层**，不是无脑进主人层——
  // 在项目里说「以后都按这个来」，进的是项目通用层，不是全场景通用。
  // 这类不衰减、只能人删（fade / 淘汰都会跳过它）。
  for (const text of assessment.rememberNow ?? []) {
    const value = String(text ?? '').trim()
    if (!value) continue
    const baseScene = sceneForWrite()
    const explicitScene = parentScene(baseScene) ?? baseScene
    const entry = pinLong(state.longMemory, value, {
      pinned: true,
      kind: 'facts',
      cap: CAPS.longMemory,
      session: ordinal,
      now,
      ref,
      scene: explicitScene,
      elevatedBy: 'explicit',
      originScene: baseScene,
    })
    if (!entry) continue
    changes.push({
      kind: 'memory:long',
      op: 'pinned',
      to: entry.text,
      why: explicitScene === baseScene ? '明确说过，只停在原层' : `明确说过，升到上一层（原属 ${baseScene}）`,
    })
    // 短层里那条跟着升上去，同一件事不留两份。只在同一个池子里找：
    // 别的项目里碰巧有句同文，不该被这次「记住」顺手拿走。
    for (const kind of MEMORY_KINDS) {
      const list = state.memory[kind]
      if (!Array.isArray(list)) continue
      const index = list.findIndex(
        (item) => sceneOf(item) === baseScene && similarity(entryText(item), entry.text) >= 0.75,
      )
      if (index >= 0) list.splice(index, 1)
    }
  }

  // ── 降级（P3）：靠计数升上去的，别的场景不再提起了，就降回出现最多的那个场景。
  // 降级不是删除：编号不变，正文不变，只是不再占通用层的位置。
  for (const item of reevaluateElevations(state, { session: ordinal, now })) {
    changes.push({
      kind: `memory:${item.kind}`,
      op: 'demoted',
      to: item.text,
      why: `别的场景不再提起，降回 ${item.to}`,
    })
  }

  // ── 约定：答应过的事有状态，不是一条会淡的记忆
  const commitments = state.commitments ?? (state.commitments = [])
  for (const text of assessment.commitments ?? []) {
    const value = String(text ?? '').trim().slice(0, 120)
    if (!value) continue
    if (commitments.some((item) => item.status === 'open' && similarity(item.text, value) >= 0.6)) continue
    commitments.push({ text: value, at: now, session: ordinal, status: 'open', doneAt: 0, doneSession: 0 })
    changes.push({ kind: 'commitment', op: 'added', to: value })
  }
  for (const text of assessment.commitmentsDone ?? []) {
    const value = String(text ?? '').trim()
    if (!value) continue
    const match = commitments.find((item) => item.status === 'open' && similarity(item.text, value) >= 0.5)
    if (!match) continue
    match.status = 'done'
    match.doneAt = now
    match.doneSession = ordinal
    changes.push({ kind: 'commitment', op: 'done', to: match.text })
  }
  // 欠着太久的，记成「说到没做到」，摘要里不再占位，但状态里留着。
  for (const item of commitments) {
    if (item.status !== 'open') continue
    if (ordinal - Number(item.session || 0) < COMMITMENT_LAPSE_TURNS) continue
    item.status = 'lapsed'
    changes.push({ kind: 'commitment', op: 'lapsed', to: item.text })
  }
  while (commitments.length > CAPS.commitments) {
    const closed = commitments.findIndex((item) => item.status !== 'open')
    commitments.splice(closed >= 0 ? closed : 0, 1)
  }

  state.revision = (state.revision ?? 0) + 1
  state.updatedAt = now
  return { state, changes, ordinal, salience }
}

/**
 * 这一轮该写进哪个池子。
 *
 * 优先级：显式给的场景 > 目录认定出来的项目 > 主人层。
 * 认不出项目时（`project` 为空、或项目清单满了建不出来）落主人层——
 * 不许默默建池：一个月后就是几十个空池，而且界面看不出是哪来的。
 */
function resolveSceneId(state, options, now) {
  if (typeof options.scene === 'string' && options.scene.trim() !== '') {
    return normalizeSceneId(options.scene)
  }
  const project = options.project
  if (project && typeof project === 'object') {
    const node = ensureProjectScene(state.scenes, { dir: project.dir, name: project.name }, Number(now) || Date.now())
    if (node) return node.id
  }
  return SCENE_OWNER
}
