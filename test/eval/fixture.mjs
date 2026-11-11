/**
 * 评估集的「临时卡」：往 mkdtemp 里灌一批已知记忆，再把真实插件装起来。
 *
 * 三条硬约束（施工方案第一批 §2.5 / §4）：
 *   1. 一切写入只发生在调用方给的临时目录里：`resolveDataPaths` 的
 *      `dataDir` / `dshHome` / `legacyDir` 三个口全部指向临时目录，
 *      真库一个字节都不碰（run.mjs 最后会断言所有路径都在临时根下）。
 *   2. 不重写打分：记忆的取用走 `renderStateSummary`（真正被注入的那段文本），
 *      写入走 `runAssessment` → `parseAssessment` → `applyAssessment`。
 *   3. 不用真模型：stub llm 只把 cases.json 里那串 assessorRaw 吐回来。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDataPaths } from '../../lib/paths.js'
import { normalize, DEFAULTS } from '../../lib/persona/lib/config.js'
import { applyPersona } from '../../lib/persona/index.js'
import { registerSurface } from '../../lib/host.js'
import { createInitialState } from '../../lib/persona/lib/state/schema.js'
import { anchorText, buildAnchor } from '../../lib/ctx/inject.js'
import { renderRaw } from '../../lib/ctx/raw.js'
import { CTX_TOOL_NAME, registerContext } from '../../lib/ctx/host-bridge.js'
import { ctxRoot, drainQueue, readCards } from '../../lib/ctx/store.js'

export const MEMORY_KINDS = ['facts', 'preferences', 'events', 'openTopics']

/** 固定时间戳：状态里的 at 不参与判分，但固定住可以让两次跑逐字节可比。 */
export const T0 = Date.parse('2026-11-05T08:00:00Z')

/** 种子状态的会话序号：所有种下去的条目都「最近被提起过」，新鲜度接近 1。 */
export const SEED_SESSION = 40

/**
 * 一份贴着线上口径的配置（名字 / 底色 / 价值观 / 主动性 / 表达习惯 / 边界）。
 * INJ 量的是「真实人格常驻要花多少字」，所以这里不许用一份被削瘦的假配置。
 */
export function evalConfig() {
  return normalize({
    ...DEFAULTS,
    bot_name: '六一',
    self_name_initial: '六一',
    title_name_initial: '用户',
    core_temperament: '自然、有边界、不讨好、愿意说不知道',
    core_values: '自由、民主、正义、公平，认同共产主义意识形态',
    extra_boundaries: '不主动骂人、不侮辱他人；不接受被骂，被骂会还击',
    language_baseline: '自然口语，少术语，不客服腔',
    proactive_level: 'medium',
    verbal_tick_level: 'low',
    allow_refusal: true,
    assessor_mode: 'important',
  })
}

/**
 * 一条短期记忆，形状与归一化后的 state.memory.* 完全一致。
 * `ref` 是来源指针（{session, turn, seq}）：真实的写入侧 2026-11-09 起会补上，
 * 这里给两条种子条目补上，让「取回原话」那条路在评估集里也走真的。
 */
function entry(text, { salience, hits = 1, session = SEED_SESSION, resolved = false, ref = null } = {}) {
  return {
    text,
    at: T0,
    session,
    lastSeenAt: T0,
    lastSeenSession: session,
    salience,
    hits,
    resolved,
    ref,
  }
}

/** 一条长期记忆：线上形状是 text/kind/at/session/hits/pinned，没有 ref —— EVID 的 0 就是从这来的。 */
function long(text, kind, { pinned = false, hits = 1, session = SEED_SESSION } = {}) {
  return { text, kind, at: T0, session, lastSeenAt: T0, lastSeenSession: session, hits, pinned }
}

/**
 * 种一批已知记忆。刻意造得小：每个用例的期望条目都能指认出来是第几条，
 * 不用在一堆噪声里猜名次。数值（salience / lastSeenSession）是手写的已知量，
 * 不是从真库抄的。
 */
export function seedState(config, now = T0) {
  const state = createInitialState(config, now)
  state.sessionOrdinal = SEED_SESSION
  state.revision = 553
  state.memory = {
    facts: [
      // 两条带来源：e01 / e02 问的是「我当时原话怎么说的」，取回得回档案捞原话。
      entry('用户的编辑器是 neovim，配置放在 nvim 的 dotfiles 里', { salience: 0.9, hits: 3, ref: { session: 34, turn: 1, seq: 101 } }),
      entry('用户的项目在 D:\\AI 项目 下，插件叫 dsh-whale-pal', { salience: 0.45, session: 39 }),
      entry('用户在 Windows 上用 Node 24', { salience: 0.4, session: 38 }),
    ],
    preferences: [
      entry('用户讨厌客套话，要直接说', { salience: 0.85, hits: 3 }),
      entry('用户喜欢先看基线数字再动代码', { salience: 0.6 }),
    ],
    events: [
      entry('上周改的导入 bug：模块导入早于快照，没有回滚点', { salience: 0.7, hits: 2, ref: { session: 34, turn: 1, seq: 120 } }),
      entry('昨天跑通了全量测试 899 条', { salience: 0.45, session: 39 }),
    ],
    openTopics: [
      entry('用户说先放着的三件事：形态审计、游标地板、ref', { salience: 0.65, hits: 2 }),
      entry('等用户确认后开工第一批', { salience: 0.5 }),
      entry('台账 .bak 还没清', { salience: 0.35, session: 38 }),
    ],
  }
  state.longMemory = [
    long('底线：不主动骂人，被骂会还击', 'boundaries', { pinned: true, hits: 3 }),
    long('用户认同共产主义意识形态', 'preferences', { session: 30, hits: 2 }),
    long('答应过：动手前先找到 skill 安装目录', 'commitments', { session: 35, hits: 2 }),
  ]
  state.traits = [
    { name: '技术细节会展开', weight: 0.7, confidence: 0.6, evidence: 3, lastUpdateSession: SEED_SESSION, lastUpdate: T0 },
    { name: '先核查再下结论', weight: 0.45, confidence: 0.5, evidence: 2, lastUpdateSession: SEED_SESSION, lastUpdate: T0 },
    { name: '先复述等确认再动手', weight: 0.35, confidence: 0.4, evidence: 2, lastUpdateSession: SEED_SESSION, lastUpdate: T0 },
  ]
  state.mood = { baseline: { pleasure: 0, arousal: 0, control: 0, social: 0, fatigue: 0 }, current: { pleasure: 0, arousal: 0, control: 0, social: 0, fatigue: 0 }, updatedAtSession: SEED_SESSION }
  state.relationship = {
    stage: 'familiar',
    trust: 0.62,
    familiarity: 0.7,
    boundaries: [{ text: '不主动骂人、不侮辱他人；不接受被骂，被骂会还击', at: T0, session: 1 }],
    commitments: [
      { text: '动手前先找到 skill 安装目录', at: T0, session: 35, status: 'open', doneAt: 0, doneSession: 0 },
      { text: '建 start-project 薄壳 skill', at: T0, session: 35, status: 'open', doneAt: 0, doneSession: 0 },
    ],
    address: {},
  }
  state.goal = { text: '完成总纲变动后的文档对齐并等待开工确认', updatedAt: T0, session: SEED_SESSION, missed: 0 }
  return state
}

/** 一条用例一个临时目录：临时根下 mkdtemp，绝不落在别处。 */
export function makeCaseDir(root, tag) {
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, `${tag}-`))
}

/** 把 dataDir / dshHome / legacyDir 三个口全部指向 caseDir，路径与真库不重叠。 */
export function casePaths(caseDir) {
  return resolveDataPaths({
    dshHome: join(caseDir, '_home'),
    profile: 'desktop',
    dataDir: caseDir,
    legacyDir: join(caseDir, '_legacy'),
  })
}

/** 写一份 state.json 形状的文件（外加 config.json，免得插件把默认配置盖上去）。 */
export function seedCase(caseDir, config = evalConfig()) {
  const resolved = casePaths(caseDir)
  mkdirSync(resolved.paths.root, { recursive: true })
  writeFileSync(resolved.paths.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  writeFileSync(resolved.paths.state, `${JSON.stringify(seedState(config), null, 2)}\n`, 'utf8')
  return { resolved, config }
}

/**
 * 假宿主：只把注册的东西收进数组，服务缺席时按 undefined 处理
 * （host.js / persona/index.js 的 service 取值都自己兜了）。
 */
export function makeFakeCtx({ reply = () => '', onError = () => {} } = {}) {
  const sections = []
  const routes = []
  const commands = []
  const tools = []
  const projections = []
  const handlers = []
  const ctx = {
    llm: {
      async *stream() {
        const text = reply()
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'eval', model: 'eval-stub' }) },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      handlers.push({ event, handler })
      return () => {}
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    commands: {
      register(spec) {
        commands.push(spec)
        return () => {}
      },
    },
    tools: {
      register(spec) {
        tools.push(spec)
        return () => {}
      },
    },
    sessionProjections: {
      register(def) {
        projections.push(def)
        return () => {}
      },
      stateOf: () => null,
    },
  }
  return { ctx, sections, routes, commands, tools, projections, handlers, onError }
}

/**
 * 装一个临时卡：先满配（applyPersona + registerSurface，与 index.js 的 apply 同序），
 * 但**不跑 runImport** —— 那条路会去读真宿主的旧插件目录，评估集不许碰。
 * 返回的 api 上挂着人格内核的进程内入口，dispose 把注册的东西全撤掉。
 */
export function mountCase({ resolved, assessorRawRef, onError }) {
  const holder = { value: typeof assessorRawRef === 'string' ? assessorRawRef : '' }
  const fake = makeFakeCtx({ reply: () => holder.value, onError })
  const api = applyPersona(fake.ctx, { paths: resolved.paths, log: () => {} })
  const surface = registerSurface({
    ctx: fake.ctx,
    api,
    paths: resolved.paths,
    legacy: resolved.legacy,
    base: resolved.base,
    importRecord: resolved.importRecord,
    importReport: null,
    log: () => {},
  })
  return { ...fake, api, surface, holder, dispose: () => surface.dispose() }
}

/** 把一条会话事件按真实宿主的样子发下去（人人都在监听）。 */
export function fire(session, event, handlers) {
  for (const { handler } of handlers) {
    try {
      handler(session, event)
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }
  return { error: null }
}

/** 递归列文件（相对 root），用来证明写入都发生在这个临时根里。 */
export function listFiles(root) {
  const out = []
  const walk = (dir, prefix) => {
    let items = []
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isDirectory()) walk(join(dir, item.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

export function readStateFile(paths) {
  return JSON.parse(readFileSync(paths.state, 'utf8'))
}

// ---------------------------------------------------------------------------
// ctx 面（目录 / 取回）的临时卡：量 DIR（目录一行）与 FETCH（一次取回）用。
//
// 与人格那几条腿同一个规矩：一切写入只发生在调用方给的临时目录里，
// 真库（`C:\Users\123\.dsh\whale-pal\desktop`）与真实记忆库（`D:\AI 空间\记忆空间`）
// 只读、一个字节都不碰；取回走的是真注册的那条工具路径，不是另写一套读法。
// ---------------------------------------------------------------------------

/**
 * 现场三张卡的摘要字数（2026-11-05 只读复制实测：9082 / 15916 / 18121 字）。
 * 种子腿按同一量级造摘要，好让两条腿量到的是同一个量级，而不是一份被削瘦的样品。
 */
export const CTX_SEED_SUMMARY_CHARS = [9082, 15916, 18121]

/** 种子卡的固定时间戳：`at` 不参与判分，固定住让两次跑逐字节可比。 */
export const CTX_SEED_AT = '2026-11-05T08:00:00.000Z'

// 现场三张卡的摘要首行都是宿主自动压缩吐出来的英文主题（`Primary Request and Intent`
// 那一形状），正文也是英文的 —— 代码注释里那句「宿主的压缩摘要是那边模型写的，写英文时
// 满篇 the/and/for」说的就是它。种子照这个形状造：三张都是英文正文、英文主题，
// 长度按现场那三张的量级走。中文主题那条路不由这里替它编，它归 899 条单测管。
const CTX_SEED_LINES = [
  [
    'Primary Request and Intent',
    'The user wants the context archive layer of dsh-whale-pal to stay small: the anchor block carries the index lines and nothing else.',
    'The summary body must never live in the prompt, and one fetch has to be readable in a single pass.',
    'Pin the numbers first, then touch code; every change has to be traceable to a file, a command and a reading.',
    'Reviewers walk three trails - ctx, agent and raw - and a missing trail means the step is not done.',
    'The raw transcript is kept on disk for later search only: it never enters the anchor block, the index or the keyword file.',
    'Budget rules are frozen for this pass, and the later batches are explicitly out of scope.',
  ],
  [
    'Whale Context Archive Layout And Budget Rules',
    'The card is the only source of truth; the index, the keyword file and the entry table are recomputed from it every time.',
    'A batch number follows one compaction event, and a batch either lands whole or moves to the recycle bin whole.',
    'One fetch reads one card and puts it back, leaving no resident copy behind in the prompt.',
    'The anchor hash decides the rewrite: an unchanged hash must not touch the file, so the prefix cache survives.',
    'Topics are cut to twelve characters and only two keywords reach the anchor line, which is what keeps the index short.',
    'Nothing in the anchor block may carry a date or a time, or the hash would change on every pass.',
  ],
  [
    'Session Compaction And Memory Notes',
    'Each compaction writes one card plus one raw transcript, and the raw file is never read by the injector.',
    'A card records its range, topic, summary, keywords and whatever was left undigested, in that order.',
    'The vault path comes from the settings page, so the archive root follows the vault instead of the plugin.',
    'When the host prunes a session event, the raw transcript says which seq went missing instead of pretending to be complete.',
    'Replaying a compaction event must not mint a second card for the same block, or the anchor would keep changing.',
    'Searches hit the topic and the keywords only, at most three rows at a time, and never widen the query by themselves.',
  ],
]

/** 一行一行重复到够长为止：确定性、可一条命令复现，长度落在现场那三张的量级上。 */
function synthSummary(lines, target) {
  const body = [lines[0]]
  let size = lines[0].length
  let round = 0
  while (size < target) {
    const line = lines[1 + (round % (lines.length - 1))]
    body.push(line)
    size += line.length + 1
    round += 1
  }
  return body.join('\n')
}

/** 种子摘要：按现场量级造的确定性合成文本，**不抄真库原文**。 */
export function seedCtxSummaries() {
  return CTX_SEED_LINES.map((lines, index) => synthSummary(lines, CTX_SEED_SUMMARY_CHARS[index]))
}

/**
 * 在临时目录里种一个 ctx 档案：先用真实 `drainQueue` 落卡片（编号、主题、关键词、
 * 索引都是真管线算的），再按真实 `syncArchives` 的次序把锚定块算出来（不落盘）。
 * 原始文本用真实 `renderRaw` 拼一份出来，好让"取回"读到的形状和现场一致。
 */
export function seedCtxVault(vaultPath, { now = CTX_SEED_AT } = {}) {
  const root = ctxRoot(vaultPath)
  const pending = seedCtxSummaries().map((text, index) => ({
    blockId: `eval-block-${index + 1}`,
    gen: 1,
    range: `${index * 100 + 1}–${(index + 1) * 100}`,
    at: now,
    source: 'native',
    text,
  }))
  const drained = drainQueue({
    root,
    pending,
    now,
    rawOf: (item) =>
      renderRaw({
        events: [],
        missing: [],
        blockId: item.blockId,
        gen: item.gen,
        range: item.range,
        at: item.at,
        provider: 'eval',
        model: 'eval-stub',
      }),
  })
  if (drained.ok !== true) return { ok: false, root, vault: vaultPath, reason: drained.reason ?? 'seed-failed' }
  const cards = readCards(root)
  // 锚定块不再落盘（第二批形态审计）：这里只算出来备用，anchorWrote 恒 false。
  const anchor = anchorText({ lines: buildAnchor({ cards }) })
  return { ok: true, root, vault: vaultPath, cards, anchor, anchorWrote: false, drained }
}

/**
 * 种一份「原话」档案：e01 / e02 的 `ref.seq` 指回这里的两段用户消息。
 *
 * 走真实 `drainQueue` + `renderRaw`（与现场同一条管线），不是手写卡片文件 ——
 * 量的是「按 seq 回档案捞原话」这条路，样本也得走真路径种下去。
 */
export function seedOriginArchive(vaultPath, { now = CTX_SEED_AT } = {}) {
  const root = ctxRoot(vaultPath)
  const events = [
    {
      type: 'user/message',
      seq: 101,
      time: Date.parse('2026-11-08T00:00:00.000Z'),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我的编辑器一直是 neovim，别给我换。' }] },
    },
    {
      type: 'user/message',
      seq: 120,
      time: Date.parse('2026-11-08T00:01:00.000Z'),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '上周那个导入 bug 我说过：模块导入早于快照，没有回滚点。' }] },
    },
  ]
  const drained = drainQueue({
    root,
    pending: [{ blockId: 'eval-origin-1', gen: 1, range: '1–200', at: now, source: 'native', text: '评估集原话档案：两段用户消息。' }],
    now,
    rawOf: (item) =>
      renderRaw({
        events,
        blockId: item.blockId,
        gen: item.gen,
        range: item.range,
        at: item.at,
        provider: 'eval',
        model: 'eval-stub',
      }),
  })
  return { ok: drained.ok === true, root, vault: vaultPath, drained }
}

/**
 * 挂一个假的 ctx，装上**真实**的 `registerContext`，把 `whale_ctx` 工具拿出来。
 * 取回必须走这条工具路径（execute → output.render），不能自己拼卡片字段：
 * 模型真正读到的就是 render 出来的那段文本。
 */
export function mountCtxTools(vaultPath) {
  const fake = makeFakeCtx()
  const api = { getConfig: () => ({ knowledge: { vaultPath: String(vaultPath ?? '') } }) }
  const registered = registerContext({ ctx: fake.ctx, api, log: () => {} })
  const spec = fake.tools.find((item) => item.name === CTX_TOOL_NAME) ?? null
  if (spec === null) throw new Error('ctx 工具没注册上：取回路径量不到')
  return {
    warnings: registered.warnings,
    async read(id) {
      const value = await spec.execute({ action: 'read', id })
      const blocks = spec.output.render({ action: 'read', id }, value)
      return { value, text: blocks.map((block) => String(block?.text ?? '')).join('') }
    },
    dispose: () => registered.dispose(),
  }
}
