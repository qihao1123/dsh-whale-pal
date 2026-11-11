#!/usr/bin/env node
/**
 * 第一批评估集：一条命令跑完，出六个数 + 两条补充量尺。
 *
 *   node test/eval/run.mjs --data-dir <临时目录>
 *   node test/eval/run.mjs --data-dir <临时目录> --cases cases.json     # 只跑最早那 10 条
 *   node test/eval/run.mjs --data-dir <临时目录> --vault <记忆库目录>    # 换现场库（默认见 CTX_REAL_VAULT）
 *   node test/eval/run.mjs --data-dir <临时目录> --ledger <库目录>       # 把失败用例的归因写进 台账/偏离.md
 *
 * 六个数（口径见施工方案 §2.3）：
 *   R@1 / R@3   该想起的那条，在它该出现的那一行里排第 1 / 前 3
 *   EVID        命中的条目里，有几个带 ref 能追回原话（现在必然 0，ref 是第四批的事）
 *   FLAG        攻击被拦下的条数（被写进去 = 0）
 *   FALSE       普通句子被误记的条数（正常跳过 = 0）
 *   INJ（成本）  一次注入多少字、几段。判据 1 拆三段报（2026-11-07）：
 *               1a 骨架 ≤300（硬）· 1b 人类填写只记账（超 400 提醒）· 1c 规则文本软上限 800。
 *               三段按行分类求和，读的是 renderKernel 同一份行表；换行符单列。
 *
 * 另两条成本量尺（判据四数里的后两条，口径与 INJ 同一套 `.length`）：
 *   DIR         目录一行的字数（最长 / 均值），判据 ≤20 字。两条腿都量：
 *               种子腿 = mkdtemp 里用真 `drainQueue` 种卡 + 真 `buildAnchor` 拼行；
 *               现场腿 = 只读复制真实 `_上下文` 再量（只读，绝不写真库）。
 *   FETCH       一次取回的字数（最长 / 均值），判据 ≤2000 字。走真取回路径：
 *               `registerContext` 装上真 `whale_ctx` 工具 → `execute(read)` → `output.render`，
 *               量的就是模型真收到的那段文本；卡片摘要字数一并打出来对照。
 *   失忆率      两级（2026-11-09 人类签字拆分判据 4），分母都是带 expect 的召回类用例（recall + evidence）：
 *               级一 目录召回 = 这条记忆在注入里能不能被看见（正文进了召回行，或目录行有它的编号+主题）；
 *               级二 取回命中 = 按编号真取回（readEntry + renderRead，≤2000 字）后，文本里有没有答案；
 *                             要原话的用例（evidence）还要求能追回原文（ref），只有转述不算。
 *               两级各 ≤10%。旧口径 `1 − R@3` 降为对照数，不再作判据。
 *
 * 三条「不糊过去」的做法：
 *   1. 检索不重写：R@* 名次直接读 `renderStateSummary` 出来那段真实注入文本
 *      （`记得：`/`一直记着：`/`未完成：` 三行）里的次序，不用另一套打分函数算。
 *   2. 注入不重写：INJ 来自真装配（applyPersona + registerSurface）注册的
 *      systemPrompt section，逐个 text() 取真实文本。
 *   3. 写入不重写：FLAG / FALSE 走真实的 runAssessment → parseAssessment →
 *      applyAssessment，llm 是桩，只把 cases.json 里那条 assessorRaw 吐回来。
 *
 * 名次口径（两种读数都打出来，主数用前者）：
 *   主数 = 「在它自己那一行里的名次」：事实/偏好/事件落在 `记得：`（一行四格），
 *          未结落在 `未完成：`（一行两格），长期层落在 `一直记着：`。
 *          理由：未结那一类按注入顺序天生排在 `记得` 之后，用全局次序量它等于
 *          把「放在专门那一行里」判成失忆。
 *   变体 = 「在整个注入块里的阅读次序」（记得 → 一直记着 → 未完成）里的名次，
 *          一眼能看出哪一类被排到了后面。
 *
 * 用例文件：默认 `cases.json`（最早 10 条，原样保留）+ `cases-extra.json`
 * （补的 6 条 recall，把失忆率的分母从 6 抬到 12）。`--cases cases.json` 就是老那次跑。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildAnchor } from '../../lib/ctx/inject.js'
import { appendDeviation } from '../../lib/ledger/host-bridge.js'
import { allMemoryEntries } from '../../lib/persona/lib/memory.js'
import { attributeMistake, MISTAKE } from '../../lib/persona/lib/recall.js'
import { CATALOG_LIMIT, catalogOf, readEntry, renderRead } from '../../lib/persona/lib/retrieve.js'
import { originalAt } from '../../lib/ctx/original.js'
import { catalogIdsOf, judgeTier, tierRates } from './tier.mjs'
import { kernelBudget } from '../../lib/persona/lib/prompt/render.js'
import { ctxRoot, readCards, CTX_DIR_NAME } from '../../lib/ctx/store.js'
import {
  MEMORY_KINDS,
  evalConfig,
  fire,
  listFiles,
  makeCaseDir,
  mountCase,
  mountCtxTools,
  readStateFile,
  seedCase,
  seedCtxVault,
  seedOriginArchive,
} from './fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SECTION_OF_KIND = { facts: '记得', preferences: '记得', events: '记得', openTopics: '未完成' }
const RECALL_SECTIONS = ['记得', '一直记着', '未完成']
/** 默认用例文件：老那份（10 条）在前，补的 6 条 recall 在后。 */
const DEFAULT_CASE_FILES = ['cases.json', 'cases-extra.json']
/** 现场记忆库：只读复制，不写。`--vault` 可换。 */
const CTX_REAL_VAULT = 'D:/AI 空间/记忆空间'

function parseArgs(argv) {
  const out = { dataDir: '', clean: false, cases: '', vault: '', ledger: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--data-dir') out.dataDir = argv[i + 1] ?? ''
    else if (arg.startsWith('--data-dir=')) out.dataDir = arg.slice('--data-dir='.length)
    else if (arg === '--cases') out.cases = argv[i + 1] ?? ''
    else if (arg.startsWith('--cases=')) out.cases = arg.slice('--cases='.length)
    else if (arg === '--vault') out.vault = argv[i + 1] ?? ''
    else if (arg.startsWith('--vault=')) out.vault = arg.slice('--vault='.length)
    else if (arg === '--ledger') out.ledger = argv[i + 1] ?? ''
    else if (arg.startsWith('--ledger=')) out.ledger = arg.slice('--ledger='.length)
    else if (arg === '--clean') out.clean = true
  }
  return out
}

/** 字数统计：与 INJ 用同一套 `String.length`（不另开一套口径）。入参是一串已量好的字数。 */
const charStats = (sizes) => {
  const list = sizes.map((item) => Number(item))
  if (list.length === 0) return { count: 0, max: 0, mean: 0 }
  return { count: list.length, max: Math.max(...list), mean: list.reduce((sum, item) => sum + item, 0) / list.length }
}

const oneFixed = (value) => (Math.round(value * 10) / 10).toFixed(1)

/** 一串文本的字数（与 INJ 同一套 `String.length`）。 */
const charLens = (list) => list.map((item) => String(item).length)

/** 锚定块文本 → 逐行（去掉末尾换行，空行不计）。 */
const anchorLinesOf = (text) =>
  String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .filter((line) => line !== '')

/** 老库里可能还留着 `锚定块.md`（重启前）；有就读它，没有回空串。锚定块已改成按需现算。 */
const anchorFileOf = (root) => {
  const file = join(root, '锚定块.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** 把注入文本切成「哪一行、行内第几条」。不做打分，只认分隔符。 */
/**
 * 喂一条用户消息，然后取「这一轮会注入的摘要」。
 *
 * 为什么要这么测（2026-11-07 第四批）：
 *   召回层的输入是「这句话在问什么」。挂载后直接 getSummary() 拿到的是冷启摘要，
 *   里面没有查询、召回层退回纯排序 —— 那样测出来的失忆率测不到召回层。
 *   真实宿主里 user/message 一到就 refreshSummary()，注入是惰性的，所以这里照着做。
 */
function summaryForInput(mount, input) {
  const handlers = (mount.handlers ?? []).filter((item) => item.event === 'session/event')
  const list = handlers.length > 0 ? handlers : (mount.handlers ?? [])
  fire({ id: 'eval' }, { type: 'user/message', seq: Date.now(), data: { source: { kind: 'user' }, text: input } }, list)
  return mount.api.getSummary()
}

function readRecallBlock(summary) {
  const sections = {}
  for (const line of String(summary ?? '').split('\n')) {
    const index = line.indexOf('：')
    if (index < 0) continue
    const key = line.slice(0, index)
    if (!RECALL_SECTIONS.includes(key)) continue
    sections[key] = line
      .slice(index + 1)
      .split('；')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  const flat = []
  for (const key of RECALL_SECTIONS) {
    for (const text of sections[key] ?? []) flat.push({ section: key, text })
  }
  return { sections, flat }
}

/** 一条命中文本落在哪一行、行内第几、整块第几。 */
function locate(block, expect) {
  const needle = String(expect)
  const inSection = block.flat.filter((item) => item.text.includes(needle))
  if (inSection.length === 0) return null
  const first = inSection[0]
  const rankInSection = (block.sections[first.section] ?? []).findIndex((text) => text.includes(needle)) + 1
  const globalPosition = block.flat.findIndex((item) => item.section === first.section && item.text.includes(needle)) + 1
  return { section: first.section, rankInSection, globalPosition, text: first.text }
}

/** 状态里所有「可能被记住」的文本，带出处；ref 检查就在这上面做。 */
function textsOf(state) {
  const out = []
  for (const kind of MEMORY_KINDS) {
    for (const entry of state.memory?.[kind] ?? []) out.push({ where: `memory.${kind}`, text: String(entry?.text ?? ''), entry })
  }
  for (const entry of state.longMemory ?? []) out.push({ where: 'longMemory', text: String(entry?.text ?? ''), entry })
  for (const item of state.relationship?.boundaries ?? []) {
    out.push({ where: 'relationship.boundaries', text: typeof item === 'string' ? item : String(item?.text ?? ''), entry: null })
  }
  for (const item of state.relationship?.commitments ?? []) out.push({ where: 'relationship.commitments', text: String(item?.text ?? ''), entry: item })
  if (state.goal?.text) out.push({ where: 'goal', text: String(state.goal.text), entry: null })
  return out
}

// 来源指针的两种合法形状：字符串（老样子）或 `{session, turn, seq}`（2026-11-09 起的写入侧）。
const hasRef = (entry) => {
  const ref = entry?.ref
  if (typeof ref === 'string') return ref.trim() !== ''
  return ref !== null && typeof ref === 'object' && Object.keys(ref).length > 0
}

async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((done) => setTimeout(done, 5))
  }
}

function fireTurn(mount, session, input, reply) {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: input }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', data: { turn: 1 } },
  ]
  for (const event of events) {
    const result = fire(session, event, mount.handlers)
    if (result.error) return result
  }
  return { error: null }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.dataDir ? resolve(args.dataDir) : mkdtempSync(join(tmpdir(), 'whale-eval-'))
  mkdirSync(root, { recursive: true })

  const caseFiles = (args.cases === '' ? DEFAULT_CASE_FILES : args.cases.split(','))
    .map((name) => name.trim())
    .filter((name) => name !== '')
  const specs = caseFiles.map((name) => {
    const file = isAbsolute(name) ? name : join(HERE, name)
    return { name, spec: JSON.parse(readFileSync(file, 'utf8')) }
  })
  const cases = specs.flatMap((item) => item.spec.cases)
  const config = evalConfig()

  console.log('# dsh-whale-pal 第一批评估集')
  console.log(`临时根：${root}`)
  console.log(`用例文件：${specs.map((item) => `${item.name}（${item.spec.cases.length} 条）`).join(' · ')}`)
  console.log(`用例数：${cases.length}（recall ${cases.filter((c) => c.kind === 'recall').length} · evidence ${cases.filter((c) => c.kind === 'evidence').length} · attack ${cases.filter((c) => c.kind === 'attack').length} · normal ${cases.filter((c) => c.kind === 'normal').length}）`)
  console.log(`现场记忆库（只读复制）：${args.vault === '' ? CTX_REAL_VAULT : resolve(args.vault)}`)
  console.log('')

  // ---------------------------------------------------------------- 第一段：召回 + 证据 + 注入
  const baseDir = makeCaseDir(root, 'base')
  const base = seedCase(baseDir, config)
  const baseMount = mountCase({ resolved: base.resolved })
  const summary = baseMount.api.getSummary()
  const seeded = readStateFile(base.resolved.paths)
  const block = readRecallBlock(summary)

  // 原话档案（判据 4 级二）：e01 / e02 的 `ref.seq` 指回这里那两段用户消息。
  // 走真 `drainQueue` + `renderRaw` 种，不手写卡片文件；量的是「按 seq 回档案捞原话」这条路。
  const originVault = makeCaseDir(root, '_origin-vault')
  const origin = seedOriginArchive(originVault)
  if (origin.ok !== true) console.log(`⚠️ 原话档案没种成：${origin.drained?.reason ?? 'unknown'}`)

  // INJ：真装配注册的那几段，逐段取真实文本
  const injSections = [...baseMount.sections]
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
    .map((section) => {
      let text = ''
      try {
        text = String(section.text?.() ?? '')
      } catch (error) {
        text = `<<取文本失败：${error?.message ?? error}>>`
      }
      return { name: section.name, order: section.order, interpolate: section.interpolate, chars: text.length, empty: text.trim() === '' }
    })
  const injChars = injSections.reduce((sum, item) => sum + item.chars, 0)
  const injSegments = injSections.filter((item) => !item.empty).length

  console.log('## 注入拼装（真装配：applyPersona + registerSurface）')
  for (const item of injSections) {
    console.log(`- ${String(item.order).padStart(3, ' ')}  ${item.name.padEnd(22, ' ')} ${String(item.chars).padStart(5, ' ')} 字${item.empty ? '（空段）' : ''}`)
  }
  console.log(`  合计 ${injChars} 字 / ${injSegments} 段（注册 ${injSections.length} 段，空段不计）`)

  // 判据 1 拆三段（2026-11-07）：常驻注入不再拿总数当顶。
  //   1a 骨架 = 我们写的结构，硬顶 300；
  //   1b 人类填写 = 名字/底色/价值观/额外边界，只记账，超 400 提醒；
  //   1c 规则文本 = 行为要求，软上限 800，只提醒不硬卡。
  // 三段按行分类求和，与 renderKernel 读同一份行表；换行符单列，好让 1a+1b+1c+换行 = 总数。
  const kernel = kernelBudget(config)
  console.log('')
  console.log('### 判据 1（常驻注入拆三段，不再拿总数当顶）')
  for (const row of kernel.rows) {
    const verdict = row.over ? (row.hard ? '超硬顶 ✗' : '超软上限（只提醒）') : '过'
    console.log(`- ${row.label.padEnd(12, ' ')} ${String(row.chars).padStart(4, ' ')} / ${row.limit} 字  ${verdict}`)
  }
  console.log(`- 换行符 ${kernel.separators} 字（不归三段，但真付出去了）`)
  const kernelSection = injSections.find((item) => item.name === 'whale-pal/kernel') ?? null
  const others = kernelSection === null ? [] : injSections.filter((item) => item !== kernelSection && !item.empty)
  console.log(`- 三段合计 ${kernel.skeleton + kernel.human + kernel.rules} + 换行 ${kernel.separators} = ${kernel.total} 字`)
  console.log(
    `- 与真装配逐段读数对照：kernel 段 ${kernelSection?.chars ?? '未注册'} 字（本表 ${kernel.total} 字，差 ${kernelSection ? kernelSection.chars - kernel.total : '—'} 字）· 其余 ${others.length} 段合计 ${others.reduce((sum, item) => sum + item.chars, 0)} 字（${others.map((item) => item.name).join(' / ') || '无'}）`,
  )
  console.log('')
  console.log('## 状态摘要（真实注入文本，末两行是召回区）')
  for (const line of summary.split('\n')) console.log(`  ${line}`)
  console.log('')

  // 召回 + 证据
  const recallCases = cases.filter((item) => item.kind === 'recall' || item.kind === 'evidence')
  const rows = []
  let r1 = 0
  let r3 = 0
  let gr1 = 0
  let gr3 = 0
  let hits = 0
  let refs = 0
  // 两级失忆率要拿「编号 → 原文」那条真路径来量，所以状态取自装好的那一份（编号在加载时补发）。
  const stateWithIds = baseMount.api.getState()
  const storeEntries = allMemoryEntries(stateWithIds)
  for (const item of recallCases) {
    // 每条用例按它自己的 input 取一次摘要：这才对得上真实宿主里「这句话会带出什么」。
    // 而且每条**独立 mount** —— 共用一个 mount 时 buffer.entries 会累积，
    // 前一条用例的句子会干扰后一条的召回（实测 r07 单独跑能进、混跑进不去）。
    let blockForCase = block
    let summaryText = summary
    if (item.input) {
      const caseDir = makeCaseDir(root, `recall-${item.id}`)
      const seededCase = seedCase(caseDir, config)
      const caseMount = mountCase({ resolved: seededCase.resolved })
      try {
        summaryText = summaryForInput(caseMount, item.input)
        blockForCase = readRecallBlock(summaryText)
      } finally {
        caseMount.dispose()
      }
    }
    const found = locate(blockForCase, item.expect)
    const pool = textsOf(seeded).filter((entry) => entry.text.includes(item.expect))
    const refed = pool.find((entry) => hasRef(entry.entry)) ?? null
    // 两级：级一按这一轮的注入文本判，级二按编号真取回一次判（与级一是否露正文无关）。
    const storeEntry = storeEntries.find((entryItem) => String(entryItem.entry.text ?? '').includes(item.expect)) ?? null
    const memId = storeEntry === null ? '' : String(storeEntry.entry.id ?? '')
    // 级二：按条目的 ref.seq 回档案捞原话，再把它接进取回文本 —— 与工具那条路同形。
    const refSeq = Math.floor(Number(storeEntry?.entry?.ref?.seq) || 0)
    const source = refSeq > 0 ? originalAt(origin.root, refSeq) : { ok: false, reason: 'no-seq' }
    const originalText = source.ok === true ? source.text : ''
    const fetchedValue = memId === '' ? null : readEntry(stateWithIds, memId)
    const fetchedText =
      fetchedValue === null ? '' : renderRead(originalText === '' ? fetchedValue : { ...fetchedValue, original: originalText })
    const tier = judgeTier({
      shown: found !== null,
      id: memId,
      catalogIds: catalogIdsOf(summaryText),
      fetched: fetchedText,
      expect: item.expect,
      // evidence 用例问的是「我当时原话怎么说的」：取回文本里得含档案捞回的原话，只有转述不算。
      needsOriginal: item.kind === 'evidence',
      originalText,
    })
    if (found) {
      hits += 1
      if (found.rankInSection === 1) r1 += 1
      if (found.rankInSection <= 3) r3 += 1
      if (found.globalPosition === 1) gr1 += 1
      if (found.globalPosition <= 3) gr3 += 1
      // EVID 数的是「能打开的原话」：ref 在、并且按 seq 真捞得到原话，才算。
      if (refed && source.ok === true) refs += 1
    }
    rows.push({
      id: item.id,
      kind: item.kind,
      expect: item.expect,
      section: found?.section ?? '—',
      rank: found ? found.rankInSection : null,
      global: found ? found.globalPosition : null,
      text: found?.text ?? '（没出现在注入里）',
      ref: refed ? (source.ok === true ? '有（能开）' : '有（开不了）') : '无',
      // 归因要用到的事实：在不在库、在不在注入、排第几。只记事实，不记判断。
      inStore: pool.length > 0,
      inInjection: Boolean(found),
      input: item.input ?? '',
      // 两级失忆率的逐条事实（判据 4，见 test/eval/tier.mjs）。
      memId,
      dir: tier.dir,
      dirVia: tier.dirVia,
      fetch: tier.fetch,
      fetchWhy: tier.fetchWhy,
      fetchChars: fetchedText.length,
      fetchHead: fetchedText.split('\n')[0] ?? '',
    })
  }

  console.log('## 召回 / 证据（逐条）')
  for (const row of rows) {
    console.log(`- ${row.id} [${row.kind}] ${row.section} 行内第 ${row.rank ?? '—'} / 整块第 ${row.global ?? '—'} · ref ${row.ref} · ${row.text}`)
  }

  // ---------------------------------------------------------------- 判据 4：失忆率两级（2026-11-09 人类签字拆分）
  // 旧口径 1 − R@3 把「没被看见」和「排第四」混成一个数；这两件事的代价差很远，各算各的。
  const tierSummary = tierRates(rows)
  const rateOf = (miss) => (miss === null ? '未实测' : `${(miss * 100).toFixed(1)}%`)
  console.log('')
  console.log('## 失忆率（两级，判据 4）')
  console.log('口径（实现与注释见 `test/eval/tier.mjs`）：')
  console.log('- 级一 目录召回：这一轮的注入里能看见这条 —— 正文进了「记得 / 未完成 / 一直记着」，或目录行里有它的「编号 · 主题」。')
  console.log('- 级二 取回命中：拿它的编号真取回（`readEntry` + `renderRead`，≤2000 字），取回的文本里有这条的答案；要原话的用例（evidence）还要求能追回原文（ref），只有转述不算。')
  console.log(`- 分母同一批：带 expect 的召回用例 ${tierSummary.total} 条（recall + evidence），一格 ${tierSummary.cell === null ? '—' : `${tierSummary.cell.toFixed(1)}%`}。`)
  console.log('- 级二不看级一：正文露出来了也照样按编号取一次 —— 量的是路径，不是这一轮的运气。')
  for (const row of rows) {
    const dirText = row.dir ? `命中（${row.dirVia}${row.dirVia === '目录' && row.memId !== '' ? `，${row.memId}` : ''}）` : '没命中'
    const fetchText = row.fetch ? `命中（${row.fetchChars} 字）` : `没命中（${row.fetchWhy}）`
    console.log(`- ${row.id} [${row.kind}] 级一 ${dirText} · 级二 ${fetchText}`)
    if (!row.fetch && row.fetchChars > 0) console.log(`    取回开头：${row.fetchHead}`)
  }
  console.log(`→ 目录召回 ${tierSummary.dirHits}/${tierSummary.total}（失忆率 ${rateOf(tierSummary.dirMiss)}）≤10% ${tierSummary.dirPass ? '过' : '不过'}`)
  console.log(`→ 取回命中 ${tierSummary.fetchHits}/${tierSummary.total}（失忆率 ${rateOf(tierSummary.fetchMiss)}）≤10% ${tierSummary.fetchPass ? '过' : '不过'}`)
  if (tierSummary.dirMiss === 0 && tierSummary.fetchMiss === 0) {
    console.log('  两条都是 0.0%，但这个量尺只在条目数超过目录容量（现在 5 行）时才真咬人，见下面的全库可达。')
  }

  // 全库口径的诊断（不算判据）：库里所有条目，有几条既不在召回行、也不在目录行 ——
  // 那些才是「连编号都拿不到」的真失忆。量的是库里全部条目，不是那 12 条用例。
  const catalogIdsNow = catalogIdsOf(summary)
  const unreachable = storeEntries.filter((entryItem) => {
    const text = String(entryItem.entry.text ?? '')
    const memId = String(entryItem.entry.id ?? '')
    if (memId === '') return true
    if (catalogIdsNow.includes(memId)) return false
    return !(text !== '' && summary.includes(text.slice(0, 12)))
  })
  console.log(`- 全库可达（诊断，不算判据）：${storeEntries.length} 条里能看见 ${storeEntries.length - unreachable.length} 条（正文或目录编号），看不见 ${unreachable.length} 条`)
  for (const entryItem of unreachable) {
    console.log(`    ${String(entryItem.entry.id ?? '无编号')} · ${String(entryItem.entry.text ?? '').slice(0, 24)}`)
  }

  // 失误三分类（方案 §2.4）：失败用例逐条归因，附一句「检索方式要不要改」。
  // 只对没进前 3 的用例生成，命中的不硬凑一条。
  const misses = rows.filter((row) => !row.inInjection || (Number(row.rank) || 0) > 3)
  const attributions = misses.map((row) => {
    const verdict = attributeMistake({
      inStore: row.inStore,
      inInjection: row.inInjection,
      rank: row.rank,
      expectRank: 3,
    })
    return { row, ...verdict }
  })
  if (attributions.length > 0) {
    console.log('')
    console.log('## 失误归因（每条都写「检索方式要不要改」，写不出就写「无新增」）')
    for (const item of attributions) {
      const label = item.type ?? '不算检索失误'
      console.log(`- ${item.row.id} · ${label} · ${item.row.expect}`)
      console.log(`    为什么：${item.why}`)
      console.log(`    要不要改检索：${item.fix}`)
    }
    console.log(`  → ${attributions.length} 条待入账（${attributions.filter((item) => item.type === MISTAKE.RECALL_MISS).length} 召回漏 · ${attributions.filter((item) => item.type === MISTAKE.RECALL_NOISE).length} 召回噪 · ${attributions.filter((item) => item.type === MISTAKE.ROUTE_WRONG).length} 路由错 · ${attributions.filter((item) => item.type === null).length} 不算检索失误）`)

    // 真入账：写进 `台账/偏离.md`（现有五本账之一，不新开表）。
    // 只在给了 `--ledger <库目录>` 时写，默认不写 —— 评估集跑在临时目录里，
    // 不该顺手往真库落行；要落就显式指库，而且仍然走 appendToBook 的幂等键。
    if (args.ledger !== '') {
      const written = []
      for (const item of attributions) {
        const result = appendDeviation({
          api: { getConfig: () => ({ knowledge: { vaultPath: resolve(args.ledger) } }) },
          scene: `评估集 ${item.row.id}：问「${item.row.input || '（无输入）'}」，期望「${item.row.expect}」`,
          deviation: `${item.type ?? '不算检索失误'}：${item.why}`,
          // 原因只写可观测的那条事实，不猜动机：没进注入 / 进了但排太后 / 压根不在库。
          reason: !item.row.inStore
            ? '条目不在库：写入侧没记下来'
            : !item.row.inInjection
              ? '条目在库但没进注入：召回层没捞上来'
              : `条目进了注入但排在行内第 ${item.row.rank}：排序或槽位不够`,
          fix: item.fix,
        })
        written.push({ id: item.row.id, ok: result.ok === true, wrote: result.wrote === true, skipped: result.skipped === true, reason: result.reason ?? '' })
      }
      console.log(`  入账（台账/偏离.md）：${written.filter((item) => item.wrote).length} 条新写入 · ${written.filter((item) => item.skipped).length} 条已存在跳过`)
      for (const item of written) {
        if (item.ok !== true) console.log(`    没写进去：${item.id}（${item.reason}）`)
      }
    } else {
      console.log('  未入账：没给 --ledger <库目录>。要写进 `台账/偏离.md` 就加上它（幂等键会防重复）。')
    }
  }
  console.log('')

  // ---------------------------------------------------------------- 第二段：攻击 / 普通句
  const writeRows = []
  for (const item of cases.filter((entryCase) => entryCase.kind === 'attack' || entryCase.kind === 'normal')) {
    const caseDir = makeCaseDir(root, item.id)
    const seededCase = seedCase(caseDir, config)
    const before = readStateFile(seededCase.resolved.paths)
    const beforeTexts = textsOf(before)
    const mount = mountCase({ resolved: seededCase.resolved, assessorRawRef: item.assessorRaw })
    const sessionId = `eval-${item.id}`
    const session = { id: sessionId, header: { origin: 'user' } }
    const beforeCount = mount.api.getDiag().assessments
    const fired = fireTurn(mount, session, item.input, item.reply)
    let outcome = fired.error ? `事件处理报错：${fired.error}` : ''
    if (!fired.error) {
      const scheduled = await waitFor(() => {
        const diag = mount.api.getDiag()
        return diag.assessments > beforeCount || diag.lastSkip === 'no-substance' || diag.lastSkip === 'mode-off'
      })
      const diag = mount.api.getDiag()
      if (!scheduled) outcome = '评估没在超时内落地'
      else if (diag.assessments <= beforeCount) outcome = `闸门拦下（${diag.lastSkip}）`
      else outcome = '评估已落地'
    }
    const after = readStateFile(seededCase.resolved.paths)
    const afterTexts = textsOf(after)
    const markers = item.kind === 'attack' ? item.forbid ?? [] : item.trivia ?? []
    const hasMarker = (text) => markers.some((marker) => String(text).includes(marker))
    const newHits = afterTexts.filter(
      (entry) => hasMarker(entry.text) && !beforeTexts.some((old) => hasMarker(old.text)),
    )
    const selfNameChanged = after.selfName?.current !== before.selfName?.current
    const written = newHits.length > 0 || (item.forbidSelfNameChange === true && selfNameChanged)
    writeRows.push({
      id: item.id,
      kind: item.kind,
      outcome,
      written,
      detail: newHits.map((entry) => `${entry.where}: ${entry.text}`).join(' | '),
      selfNameChanged,
      selfName: `${before.selfName?.current ?? '?'} → ${after.selfName?.current ?? '?'}`,
      summaryChars: String(mount.api.getSummary() ?? '').length,
      revision: `${before.revision} → ${after.revision}`,
    })
    mount.dispose()
  }

  console.log('## 攻击 / 普通句（走真实 hasSubstance → runAssessment → applyAssessment）')
  for (const row of writeRows) {
    const verdict = row.kind === 'attack' ? (row.written ? '被写进去了' : '被拦下') : row.written ? '误记' : '正常跳过'
    console.log(`- ${row.id} [${row.kind}] ${row.outcome} → ${verdict}（自称 ${row.selfName} · revision ${row.revision} · 摘要 ${row.summaryChars} 字）`)
    if (row.detail) console.log(`    落点：${row.detail}`)
  }
  console.log('')

  const attacks = writeRows.filter((item) => item.kind === 'attack')
  const normals = writeRows.filter((item) => item.kind === 'normal')
  const flagBlocked = attacks.filter((item) => !item.written).length
  const falseRecorded = normals.filter((item) => item.written).length

  // ---------------------------------------------------------------- 第三段：目录 / 取回（DIR / FETCH）
  // 两条腿都量：种子腿在 mkdtemp 里用真管线种卡，现场腿只读复制真实 `_上下文`。
  // 字数一律走 `String.length`，与 INJ 同一套口径，不另开一套。
  const seedVaultDir = makeCaseDir(root, '_ctx-seed')
  const seededCtx = seedCtxVault(seedVaultDir)
  // 写后读回：卡片与锚定块都从盘上读一遍再量，不拿内存里的对象充数。
  const seedCards = readCards(ctxRoot(seededCtx.vault))
  const seedBuiltLines = buildAnchor({ cards: seedCards })
  const seedReader = mountCtxTools(seededCtx.vault)
  const seedFetches = []
  for (const card of seedCards) {
    const fetched = await seedReader.read(card.id)
    seedFetches.push({
      id: card.id,
      summaryChars: String(card.fields?.summary ?? '').length,
      fetchChars: fetched.text.length,
      hasRaw: fetched.value?.hasRaw === true,
    })
  }
  seedReader.dispose()

  const realVault = args.vault === '' ? CTX_REAL_VAULT : resolve(args.vault)
  const realCtxSrc = ctxRoot(realVault)
  const realRoot = makeCaseDir(root, '_ctx-real')
  let fieldLeg = null
  if (existsSync(realCtxSrc)) {
    // 只读复制：真库一个字节都不碰，量的是复制体。
    cpSync(realCtxSrc, join(realRoot, CTX_DIR_NAME), { recursive: true })
    const copyRoot = join(realRoot)
    const fieldCards = readCards(ctxRoot(copyRoot))
    const fieldBuiltLines = buildAnchor({ cards: fieldCards })
    const fieldFileText = anchorFileOf(ctxRoot(copyRoot))
    // 锚定块不再落盘：老库里还有这份文件时照旧比一次（比的是「盘上那份 == 现算」），
    // 重启后清掉了就退回现算本身，不再假装盘上有东西。
    const fieldFileLines = fieldFileText === '' ? fieldBuiltLines : anchorLinesOf(fieldFileText)
    const fieldReader = mountCtxTools(copyRoot)
    const fieldFetches = []
    for (const card of fieldCards) {
      const fetched = await fieldReader.read(card.id)
      fieldFetches.push({
        id: card.id,
        summaryChars: String(card.fields?.summary ?? '').length,
        fetchChars: fetched.text.length,
        hasRaw: fetched.value?.hasRaw === true,
      })
    }
    fieldReader.dispose()
    fieldLeg = {
      vault: realVault,
      copy: ctxRoot(copyRoot),
      cards: fieldCards,
      fileLines: fieldFileLines,
      builtLines: fieldBuiltLines,
      matched: JSON.stringify(fieldFileLines) === JSON.stringify(fieldBuiltLines),
      fromFile: fieldFileText !== '',
      fetches: fieldFetches,
    }
  }

  const seedDirStats = charStats(charLens(seedBuiltLines))
  const seedFetchStats = charStats(seedFetches.map((item) => item.fetchChars))
  const seedSummaryStats = charStats(seedFetches.map((item) => item.summaryChars))
  const fieldDirStats = fieldLeg ? charStats(charLens(fieldLeg.fileLines)) : null
  const fieldFetchStats = fieldLeg ? charStats(fieldLeg.fetches.map((item) => item.fetchChars)) : null
  const fieldSummaryStats = fieldLeg ? charStats(fieldLeg.fetches.map((item) => item.summaryChars)) : null

  console.log('## 目录 / 取回（DIR / FETCH）')
  console.log(`口径与 INJ 同一套：\`String.length\`（UTF-16 码元），不另开一套。`)
  console.log('')
  console.log('### 种子腿（mkdtemp 里用真 drainQueue 种卡 + 真 buildAnchor 拼行）')
  console.log(`- 种子 vault：${ctxRoot(seededCtx.vault)}（卡片 ${seedCards.length} 张 · 写后读回 ${seedCards.length === (seededCtx.cards ?? []).length ? '一致' : '不一致'} · 锚定块入库 ${seededCtx.anchorWrote === true ? '是' : '否'}）`)
  console.log(`- 目录一行（真 buildAnchor）逐行：`)
  for (const line of seedBuiltLines) console.log(`    ${String(line.length).padStart(3)} 字  ${line}`)
  console.log(`  → 最长 ${seedDirStats.max} 字 · 均值 ${oneFixed(seedDirStats.mean)} 字（${seedDirStats.count} 行）`)
  console.log(`- 一次取回（真 whale_ctx 工具 execute(read) → output.render）逐卡：`)
  for (const item of seedFetches) console.log(`    ${item.id} 取回 ${item.fetchChars} 字（卡片摘要 ${item.summaryChars} 字 · 原文 ${item.hasRaw ? '有' : '无'}）`)
  console.log(`  → 最长 ${seedFetchStats.max} 字 · 均值 ${oneFixed(seedFetchStats.mean)} 字（摘要最长 ${seedSummaryStats.max} · 均值 ${oneFixed(seedSummaryStats.mean)}）`)
  console.log('')
  if (fieldLeg) {
    console.log(`### 现场基线（只读复制真实 \`_上下文\`，真库零写入）`)
    console.log(`- 现场库：${fieldLeg.vault} → 复制到 ${fieldLeg.copy}`)
    console.log(`- 现场目录行来源：${fieldLeg.fromFile ? '盘上 锚定块.md（老库还留着）与真 buildAnchor 重算' : '按卡片现算（锚定块不再落盘）'}，一致：${fieldLeg.matched ? '是' : '否'}`)
    console.log(`- 目录一行（现场锚定块.md 逐行）逐行：`)
    for (const line of fieldLeg.fileLines) console.log(`    ${String(line.length).padStart(3)} 字  ${line}`)
    console.log(`  → 最长 ${fieldDirStats.max} 字 · 均值 ${oneFixed(fieldDirStats.mean)} 字（${fieldDirStats.count} 行）`)
    console.log(`- 一次取回（同一套真取回路径）逐卡：`)
    for (const item of fieldLeg.fetches) console.log(`    ${item.id} 取回 ${item.fetchChars} 字（卡片摘要 ${item.summaryChars} 字 · 原文 ${item.hasRaw ? '有' : '无'}）`)
    console.log(`  → 最长 ${fieldFetchStats.max} 字 · 均值 ${oneFixed(fieldFetchStats.mean)} 字（摘要最长 ${fieldSummaryStats.max} · 均值 ${oneFixed(fieldSummaryStats.mean)}）`)
  } else {
    console.log(`### 现场基线：未实测（库不在 ${realCtxSrc}）`)
  }
  console.log('')
  console.log(`判据对照：目录一行 ≤20 字 → ${fieldDirStats ? (fieldDirStats.max <= 20 ? '现场过' : '现场不过') : '现场未实测'} · 种子 ${seedDirStats.max <= 20 ? '过' : '不过'}；一次取回 ≤2000 字 → ${fieldFetchStats ? (fieldFetchStats.max <= 2000 ? '现场过' : '现场不过') : '现场未实测'} · 种子 ${seedFetchStats.max <= 2000 ? '过' : '不过'}`)
  console.log('')

  // ---------------------------------------------------------------- 第三段之二：记忆目录 / 记忆取回（第四批 §2.3）
  // 上面那两条腿量的是**会话档案**（whale_ctx 卡片）：卡片摘要本来就是长文，
  // 所以 FETCH 量出 1.8 万字是真实的，但那是另一个问题。
  // 判据 2、3 现在有第二个对象了：记忆条目的目录与取回。两条腿都量。
  const memReader = baseMount.api
  const memState = memReader.getState()
  const memEntries = allMemoryEntries(memState)
  const memCatalog = catalogOf(memState, { limit: CATALOG_LIMIT })
  const memCatalogStats = charStats(charLens(memCatalog))
  // 逐条真取回：走 `readEntry`（工具用的同一个函数），再按 `renderRead` 成形，
  // 量的就是模型真收到的那段。
  const memFetches = memEntries
    .filter((item) => String(item.entry.id ?? '') !== '')
    .map((item) => {
      const result = readEntry(memState, item.entry.id)
      const rendered = renderRead(result)
      return {
        id: item.entry.id,
        bodyChars: String(item.entry.text ?? '').length,
        fetchChars: rendered.length,
        truncated: result.truncated === true,
      }
    })
  const memFetchStats = charStats(memFetches.map((item) => item.fetchChars))

  console.log('### 记忆目录 / 记忆取回（第四批新增，判据 2、3 的第二个对象）')
  console.log(`- 条目 ${memEntries.length} 条（编号 ${memEntries.filter((item) => String(item.entry.id ?? '') !== '').length} 个 · 发号器 memorySeq=${memState.memorySeq}）`)
  console.log(`- 目录（进注入的那 5 行，` + `真 catalogOf）逐行：`)
  for (const line of memCatalog) console.log(`    ${String(line.length).padStart(3)} 字  ${line}`)
  console.log(`  → 最长 ${memCatalogStats.max} 字 · 均值 ${oneFixed(memCatalogStats.mean)} 字（${memCatalogStats.count} 行）  判据 ≤20 字 → ${memCatalogStats.max <= 20 ? '过' : '不过'}`)
  console.log(`- 一次取回（真 readEntry + renderRead）逐条：`)
  for (const item of memFetches) {
    console.log(`    ${item.id} 取回 ${item.fetchChars} 字（正文 ${item.bodyChars} 字${item.truncated ? ' · 已截断' : ''}）`)
  }
  console.log(`  → 最长 ${memFetchStats.max} 字 · 均值 ${oneFixed(memFetchStats.mean)} 字（${memFetchStats.count} 条）  判据 ≤2000 字 → ${memFetchStats.max <= 2000 ? '过' : '不过'}`)
  const truncatedCount = memFetches.filter((item) => item.truncated).length
  console.log(`  → 截断 ${truncatedCount} 条（截断的都带「已截断，原文 N 字」，不静默少给）`)
  console.log('')

  // ---------------------------------------------------------------- 第四段：只碰临时目录的证据
  const pathValues = []
  const collect = (label, value) => {
    if (typeof value === 'string' && value !== '') pathValues.push({ label, value })
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collect(`${label}.${key}`, item)
  }
  collect('paths', base.resolved.paths)
  collect('api.paths', baseMount.api.paths)
  pathValues.push({ label: 'importRecord', value: base.resolved.importRecord })
  pathValues.push({ label: 'progress', value: base.resolved.progress })
  // ctx 那两条腿的临时目录一起断言：目录 / 取回的读写都落在同一个临时根下。
  pathValues.push({ label: 'ctxSeedDir', value: seedVaultDir })
  if (fieldLeg) pathValues.push({ label: 'ctxRealCopyDir', value: realRoot })
  // 只把绝对路径当路径判：paths.profile 之类的标签（值就是 'desktop'）不是路径。
  const pathLike = pathValues.filter((item) => isAbsolute(item.value))
  const labels = pathValues.filter((item) => !isAbsolute(item.value))
  const outside = pathLike.filter((item) => item.value !== root && !item.value.startsWith(root + sep))
  const files = listFiles(root)

  console.log('## 写入范围证据（代码级）')
  console.log(`- 评估集用到的绝对路径必须全部落在临时根下：${pathLike.length} 个路径，越界 ${outside.length} 个`)
  for (const item of outside) console.log(`    越界：${item.label} = ${item.value}`)
  console.log(`- 非路径字段（不参与越界判定）：${labels.map((item) => `${item.label}=${item.value}`).join(' · ') || '无'}`)
  console.log(`- 临时根下实际产生的文件 ${files.length} 个：`)
  for (const file of files) console.log(`    ${file}`)
  const baseAuditRaw = existsSync(base.resolved.paths.audit) ? readFileSync(base.resolved.paths.audit, 'utf8').trim() : ''
  const baseAuditLines = baseAuditRaw === '' ? 0 : baseAuditRaw.split('\n').length
  const ctxFiles = files.filter((file) => file.startsWith('_ctx-seed') || file.startsWith('_ctx-real'))
  console.log(`- 其中 ctx 两条腿的文件 ${ctxFiles.length} 个（_ctx-seed 是种子腿、_ctx-real 是只读复制来的现场库；都在这个临时根下）`)
  console.log(`- 临时根里的 audit.jsonl 行数：${baseAuditLines}（base 卡没触发评估就不生成 audit.jsonl，这也算零写入；真库的审计写在真库那边，见基线文档的 sha256 前后）`)
  console.log('')

  baseMount.dispose()

  // ---------------------------------------------------------------- 六个数
  const fmt = (hit, total) => `${hit}/${total} (${total === 0 ? '0.00' : (hit / total).toFixed(2)})`
  console.log('## 六个数')
  console.log(`R@1   = ${fmt(r1, recallCases.length)}   行内名次 = 1 的召回用例`)
  console.log(`R@3   = ${fmt(r3, recallCases.length)}   行内名次 ≤ 3`)
  console.log(`EVID  = ${fmt(refs, hits)}   命中条目里带能打开原话的 ref 的条数（ref + 按 seq 真捞到原话，两级都要）`)
  console.log(`FLAG  = ${fmt(flagBlocked, attacks.length)}   攻击被拦下的条数（被写进去 = 0）`)
  console.log(`FALSE = ${fmt(falseRecorded, normals.length)}   普通句子被误记的条数（正常跳过 = 0）`)
  console.log(`INJ   = ${injChars} 字 / ${injSegments} 段（拆三段：1a 骨架 ${kernel.skeleton} 字 · 1b 人类填写 ${kernel.human} 字 · 1c 规则文本 ${kernel.rules} 字 · 换行 ${kernel.separators} 字）`)
  const dirOf = (stats, unit) => (stats ? `最长 ${stats.max} 字 / 均值 ${oneFixed(stats.mean)} 字（${stats.count} ${unit}）` : '未实测')
  console.log(`DIR   = 记忆目录 ${dirOf(memCatalogStats, '行')} → 判据 ≤20 字 ${memCatalogStats.max <= 20 ? '过' : '不过'}`)
  console.log(`        会话档案（第二对象）现场 ${dirOf(fieldDirStats, '行')} · 种子 ${dirOf(seedDirStats, '行')} → 判据 ≤20 字 ${fieldDirStats ? (fieldDirStats.max <= 20 ? '过' : '不过') : '现场未实测'}`)
  console.log(`FETCH = 记忆取回 ${dirOf(memFetchStats, '条')} → 判据 ≤2000 字 ${memFetchStats.max <= 2000 ? '过' : '不过'}`)
  console.log(`        会话档案（第二对象）现场 ${dirOf(fieldFetchStats, '张卡')} · 种子 ${dirOf(seedFetchStats, '张卡')} → 判据 ≤2000 字 ${fieldFetchStats ? (fieldFetchStats.max <= 2000 ? '过' : '不过') : '现场未实测'}（摘要部分：现场 ${fieldSummaryStats ? `最长 ${fieldSummaryStats.max} / 均值 ${oneFixed(fieldSummaryStats.mean)} 字` : '未实测'} · 种子 最长 ${seedSummaryStats.max} / 均值 ${oneFixed(seedSummaryStats.mean)} 字）`)
  const missRate = recallCases.length === 0 ? null : 1 - r3 / recallCases.length
  console.log(
    `失忆率 = 目录召回 ${rateOf(tierSummary.dirMiss)}（${tierSummary.dirHits}/${tierSummary.total}）+ 取回命中 ${rateOf(tierSummary.fetchMiss)}（${tierSummary.fetchHits}/${tierSummary.total}）→ 两级各 ≤10%：${tierSummary.dirPass && tierSummary.fetchPass ? '过' : '不过'}`,
  )
  console.log(
    `        旧口径对照（2026-11-09 起不作判据）：1 − R@3 = ${missRate === null ? '未实测' : `${(missRate * 100).toFixed(1)}%`}（${r3}/${recallCases.length}，分母 = recall ${cases.filter((c) => c.kind === 'recall').length} + evidence ${cases.filter((c) => c.kind === 'evidence').length}）`,
  )
  console.log('')
  console.log(`变体读数（按整块阅读次序排）：R@1 = ${fmt(gr1, recallCases.length)} · R@3 = ${fmt(gr3, recallCases.length)}`)
  console.log(`临时根：${root}${args.clean ? '（--clean：已删除）' : '（保留作证据；要删就加 --clean）'}`)

  if (args.clean) rmSync(root, { recursive: true, force: true })
  return outside.length === 0 ? 0 : 2
}

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((error) => {
    console.error(error?.stack ?? error)
    process.exit(1)
  })
