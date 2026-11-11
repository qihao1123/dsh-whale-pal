/**
 * 旧状态的一次性导入。
 *
 * 规则只有三条，按顺序短路：
 *   1. 新根里已经有 state.json → 不导（说明导过了，或者已经住下来了）；
 *   2. 新根里已经有 import-record.json → 不导（导过但当时旧状态是空的，也算导过）；
 *   3. 旧根里没有 state.json → 不导（全新机器）。
 *
 * 导入的不是字节，是「读进内存 → 过一遍 normalizeState → 写盘」，
 * 顺便把导入前后的各项计数对一遍，不一致就落进 import-record.json。
 * 旧 state 里没有的东西（令牌、台账、审计流水）这次不搬，它们在别的阶段。
 */
import { existsSync, readFileSync } from 'node:fs'

import { normalize } from './persona/lib/config.js'
import { normalizeState } from './persona/lib/state/schema.js'
import { appendJsonLine, writeJsonAtomic } from './persona/lib/state/store.js'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 迁移要比对的计数：只列会被人眼核对的那几项。 */
export function countState(state) {
  const memory = state?.memory ?? {}
  const list = (value) => (Array.isArray(value) ? value.length : 0)
  return {
    revision: Number(state?.revision) || 0,
    facts: list(memory.facts),
    preferences: list(memory.preferences),
    events: list(memory.events),
    openTopics: list(memory.openTopics),
    longMemory: list(state?.longMemory),
    traits: list(state?.traits),
    traitsArchive: list(state?.traitsArchive),
    values: list(state?.values),
    titleCandidates: list(state?.titleCandidates),
    // v6：承诺迁到顶层；旧 state 还在 relationship 下，两处都认。
    commitments: list(state?.commitments ?? state?.relationship?.commitments),
  }
}

/**
 * @param {{paths: object, legacy: object, importRecord: string, log?: Function}} options
 * @returns {{imported: boolean, reason: string, counts?: object, diff?: string[]}}
 */
export function ensureStateImported({ paths, legacy, importRecord, log = () => {} }) {
  if (existsSync(paths.state)) return { imported: false, reason: 'state-exists' }
  if (existsSync(importRecord)) return { imported: false, reason: 'already-imported' }

  const legacyState = readJson(legacy.state)
  if (!legacyState) return { imported: false, reason: 'no-legacy-state' }

  // 配置优先用新根里已有的（也许人先手写了），没有再取旧的。
  const warnings = []
  const config = normalize(readJson(paths.config) ?? readJson(legacy.config) ?? {}, warnings)

  const state = normalizeState(legacyState, config)
  const before = countState(legacyState)
  const after = countState(state)
  const diff = Object.keys(before).filter((key) => key !== 'revision' && before[key] !== after[key])

  // 新根从第 1 条审计开始：旧流水留在旧目录，这里只留「我在哪一刻从哪搬来的」。
  state.audit = { lastSeq: 1 }

  writeJsonAtomic(paths.state, state)
  if (!existsSync(paths.config)) writeJsonAtomic(paths.config, config)
  appendJsonLine(paths.audit, {
    seq: 1,
    at: new Date().toISOString(),
    type: 'import',
    detail: { from: legacy.root, counts: after, diff },
  })
  writeJsonAtomic(importRecord, {
    at: new Date().toISOString(),
    from: legacy.root,
    revision: before.revision,
    counts: after,
    diff,
  })

  if (diff.length > 0) {
    log(`[dsh-whale-pal] 导入后计数有差异（${diff.join('、')}），已记进 import-record.json`)
  }
  return { imported: true, reason: 'imported', counts: after, diff }
}
