/**
 * dsh-whale-pal 人格内核装配。
 *
 * 这套代码整体搬自 dsh-persona-framework（`lib/persona/lib/*.js` 十三个模块，
 * `lib/persona/test/*.mjs` 168 条测试原样通过）。与旧宿主的差别只有三处：
 *   1. 不再自己声明插件名与注入项，`name`/`inject` 在同级 index.js 里；
 *   2. 数据根换成 `~/.dsh/whale-pal/<profile>`，路径由宿主算好传进来；
 *   3. 没有设置页、没有 HTTP 写路由，能力改成进程内 api 交给宿主
 *      （见 applyPersona 的返回值），HTTP 只留 /ping 与 /state 给排障用。
 *
 * 失败姿势不变：任何一步失败都只降级，不 throw。宿主装配抛错会把整个外壳
 * 挡在门外，而人格只是附加能力，不该有这种否决权。
 */
import { DEFAULTS, TEXT_LIMITS, needsSetup, normalize } from './lib/config.js'
import { describeFields } from './lib/validate.js'
import { kernelBudget, renderKernel, renderStateSummary } from './lib/prompt/render.js'
import { extractJson, runAssessment } from './lib/assessor.js'
import { clip } from './lib/sanitize.js'
import { SPLITTER_SYSTEM, validateSplit } from '../persona-card.js'
import { applyAssessment } from './lib/updater.js'
import { forgetLong, listMemory, MEMORY_KINDS, pinLong } from './lib/memory.js'
import { createTranscript, describeSubstance, hasSubstance, ingestEvent, renderTranscript } from './lib/transcript.js'
import { createInitialState, normalizeState, CAPS } from './lib/state/schema.js'
import {
  appendJsonLine,
  ensureLayout,
  listSnapshots,
  readJsonFile,
  readSnapshot,
  saveSnapshot,
  withLock,
  writeJsonAtomic,
} from './lib/state/store.js'
import { writerGate } from '../atomic.js'

export const PLUGIN_NAME = 'dsh-whale-pal'

const ROUTE_PREFIX = '/dsh-whale-pal-7a1f'
const KERNEL_ORDER = 90
const SUMMARY_ORDER = 91

// ------------------------------------------------------------------ 读写

function loadConfig(paths) {
  const raw = readJsonFile(paths.config, null)
  if (raw === null) {
    const config = normalize({ ...DEFAULTS })
    try {
      writeJsonAtomic(paths.config, config)
    } catch {
      /* 首次写盘失败不影响本次运行，下次再试 */
    }
    return { config, warnings: [] }
  }
  const warnings = []
  return { config: normalize(raw, warnings), warnings }
}

function loadState(paths, config) {
  const raw = readJsonFile(paths.state, null)
  if (raw === null) {
    const state = createInitialState(config)
    try {
      writeJsonAtomic(paths.state, state)
    } catch {
      /* 同上 */
    }
    return state
  }
  return normalizeState(raw, config)
}

function persistState(paths, state) {
  // 写者闸：盘上 revision 比内存基线大，说明有别人（脚本/手工/另一个进程）写过。
  // 这时整份覆盖会把人家的改动静默抹掉，所以不写，只把这件事报出来。
  const gate = writerGate({ file: paths.state, expectedRevision: state.revision })
  if (gate.ok !== true) {
    console.warn(
      '[dsh-whale-pal] 状态没落盘：盘上 revision ' + gate.diskRevision + ' 比内存里的 ' + state.revision + ' 新，可能是外部改过 state.json',
    )
    state.writeBlocked = { reason: gate.reason, diskRevision: gate.diskRevision, at: Date.now() }
    return state
  }
  state.revision = (Number(state.revision) || 0) + 1
  state.updatedAt = Date.now()
  writeJsonAtomic(paths.state, state)
  return state
}

function recordAudit(paths, state, type, detail) {
  state.audit = state.audit ?? { lastSeq: 0 }
  state.audit.lastSeq = (Number(state.audit.lastSeq) || 0) + 1
  const record = { seq: state.audit.lastSeq, at: new Date().toISOString(), type, detail }
  try {
    appendJsonLine(paths.audit, record)
  } catch {
    /* 审计写失败不能让状态更新失败，但要在控制台留痕 */
    console.warn('[dsh-whale-pal] 审计写入失败：', record.type)
  }
  return record
}

// ------------------------------------------------------------------ HTTP 工具

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

// ------------------------------------------------------------------ 状态视图

/** 给设置页看的摘要。v6 之后只剩记忆、承诺与身份。 */
function buildView(paths, config, warnings, state, summary) {
  return {
    ok: true,
    needsSetup: needsSetup(config),
    config,
    warnings,
    // 判据 1 的三段账：1a 骨架（硬顶 300）· 1b 人类填写（只记账）· 1c 规则文本（软上限 800）。
    kernel: kernelBudget(config),
    // 直接引用 config.js 的上限表，别在这里抄一份——抄了就会悄悄过期。
    limits: { ...TEXT_LIMITS },
    // 校验规则也走同一份声明：客户端据此标红、禁用保存、生成 ⁇ 提示文案。
    fields: describeFields(),
    state: {
      revision: state.revision,
      sessionOrdinal: state.sessionOrdinal,
      updatedAt: state.updatedAt,
      selfName: state.selfName,
      commitments: (state.commitments ?? []).map((item) => ({
        text: item.text,
        status: item.status,
        at: item.at,
        session: item.session,
      })),
      memory: Object.fromEntries(
        MEMORY_KINDS.map((kind) => [
          kind,
          listMemory(state.memory, kind, state.sessionOrdinal ?? 0),
        ]),
      ),
      // 长期层单独给：设置页要显示「哪些被判定为不该忘」，以及有没有被人钉住。
      longMemory: (state.longMemory ?? []).map((item) => ({
        text: item.text,
        kind: item.kind,
        pinned: item.pinned === true,
        hits: item.hits,
        lastSeenSession: item.lastSeenSession,
      })),
    },
    summary,
    paths: { profile: paths.profile, home: paths.home, root: paths.root, config: paths.config, state: paths.state, audit: paths.audit },
    snapshots: listSnapshots(paths).slice(0, 20),
  }
}

// ------------------------------------------------------------------ 入口

export function applyPersona(ctx, options = {}) {
  const paths = options.paths
  const log = options.log ?? ((message) => console.warn(message))
  if (!paths) {
    log('[dsh-whale-pal] 没拿到数据路径，人格内核未激活')
    return null
  }
  try {
    ensureLayout(paths)
  } catch (error) {
    log(`[dsh-whale-pal] 数据目录建不出来，人格内核未激活：${error?.message ?? error}`)
    return null
  }

  let { config, warnings } = loadConfig(paths)
  let state = loadState(paths, config)
  let kernelText = renderKernel(config)
  // 这一轮用户的原话：召回层要拿它判断「这句话在问什么」。
  // 只取 ingestEvent 过滤过的 user 条目（source.kind === 'user'），所以不会有时间戳这类假消息。
  let lastUserText = ''
  let summaryText = renderStateSummary(state, config)

  function refreshKernel() {
    kernelText = renderKernel(config)
  }

  function refreshSummary() {
    // 每轮重算一次：记忆分档与召回会随你这句话变。
    summaryText = renderStateSummary(state, config, { query: lastUserText })
  }

  refreshSummary()

  function setConfig(next, source) {
    const collected = []
    config = normalize(next, collected)
    warnings = collected
    // 底层文本改了，状态里跟着它的部分要立刻对齐：
    // 价值观条目以底层为准（权重跟着同名条目走），名字没填时回落到默认。
    try {
      state = normalizeState(state, config)
    } catch {
      /* 状态对齐失败不影响配置本身生效 */
    }
    refreshKernel()
    // 配置变了，摘要里的名字/自称可能也要跟着变（状态里已记录的自称优先）。
    refreshSummary()
    try {
      writeJsonAtomic(paths.config, config)
    } catch (error) {
      return { ok: false, error: `配置写入失败：${error?.message ?? error}` }
    }
    recordAudit(paths, state, 'config', { source, fields: collected.length > 0 ? collected : 'all' })
    try {
      writeJsonAtomic(paths.state, state)
    } catch {
      /* 审计序号没落盘不影响配置生效 */
    }
    return { ok: true, config, warnings }
  }

  function setState(next, type, detail, options = {}) {
    if (options.snapshot !== false) saveSnapshot(paths, state)
    state = normalizeState(next, config)
    persistState(paths, state)
    recordAudit(paths, state, type, detail)
    writeJsonAtomic(paths.state, state)
    refreshSummary()
    return state
  }

  /**
   * 人类删除一条记忆。
   *
   * 允许的理由：记忆是模型的判断，判断错了（记岔了、把玩笑当真）要能立刻撤掉，
   * 而不是等它自己淡忘。反过来，人类也不能往里写——写记忆仍然只有更新器一条路。
   */
  // 人类可以替「答应过的事」结账（做到了 / 记错了），但不能往里加——
  // 加只有一条路：模型在对话里真的答应了。
  function settleCommitment(text, done) {
    const target = String(text ?? '').trim()
    if (!target) return { ok: false, error: 'empty-text' }
    const list = state.commitments ?? []
    const match = list.find((item) => item.text === target)
    if (!match) return { ok: false, error: 'not-found' }
    if (!done) {
      setState(
        { ...state, commitments: list.filter((item) => item.text !== target) },
        'commitment-remove',
        { text: target },
      )
      return { ok: true, removed: target }
    }
    if (match.status === 'done') return { ok: true, already: true }
    const next = list.map((item) =>
      item.text === target ? { ...item, status: 'done', doneAt: Date.now(), doneSession: state.sessionOrdinal ?? 0 } : item,
    )
    setState({ ...state, commitments: next }, 'commitment-done', { text: target })
    return { ok: true, done: target }
  }

  function removeMemory(kind, text) {
    if (!MEMORY_KINDS.includes(kind)) return { ok: false, error: 'bad-kind' }
    const target = String(text ?? '').trim()
    if (!target) return { ok: false, error: 'empty-text' }
    const list = state.memory?.[kind]
    if (!Array.isArray(list)) return { ok: false, error: 'bad-kind' }
    const kept = list.filter((entry) => entry.text !== target)
    if (kept.length === list.length) return { ok: false, error: 'not-found' }
    setState({ ...state, memory: { ...state.memory, [kind]: kept } }, 'memory-remove', { kind, text: target, left: kept.length })
    return { ok: true, removed: target, left: kept.length }
  }

  // 钉住 / 取消钉住一条长期记忆。这是人类唯一能「往里写」的通道，而且写的不是内容，
  // 是「这条别忘」这个判断——内容仍然只能来自对话。
  function pinMemory(text, pinned, kind) {
    const target = String(text ?? '').trim()
    if (!target) return { ok: false, error: 'empty-text' }
    const next = Array.isArray(state.longMemory) ? [...state.longMemory] : []
    const entry = pinLong(next, target, {
      pinned: pinned !== false,
      kind: MEMORY_KINDS.includes(kind) ? kind : 'facts',
      cap: CAPS.longMemory,
      session: state.sessionOrdinal ?? 0,
    })
    if (!entry) return { ok: false, error: 'not-found' }
    setState({ ...state, longMemory: next }, pinned === false ? 'memory-unpin' : 'memory-pin', { text: target })
    return { ok: true, text: entry.text, pinned: entry.pinned === true }
  }

  function forgetLongMemory(text) {
    const target = String(text ?? '').trim()
    if (!target) return { ok: false, error: 'empty-text' }
    const next = Array.isArray(state.longMemory) ? [...state.longMemory] : []
    const removed = forgetLong(next, target)
    if (removed === null) return { ok: false, error: 'not-found' }
    setState({ ...state, longMemory: next }, 'memory-long-remove', { text: removed })
    return { ok: true, removed }
  }

  // ---- 评估器与更新器
  // 每轮结束后用一次独立小调用判断「这轮值不值得改」，再按规则限幅落盘。
  // 整条链路都是旁路：模型调用失败、解析失败、宿主服务缺失，都只是这轮不更新。
  const buffers = new Map()
  const ASSESS_TIMEOUT_MS = 30000
  let assessChain = Promise.resolve()
  let disposed = false
  const diag = { llm: false, registered: false, events: 0, turns: 0, assessments: 0, lastEventType: null, lastError: null, lastSkip: null, lastTurn: null, types: {}, lastPayload: null }

  function serviceOf(key) {
    try {
      const direct = ctx[key]
      if (direct) return direct
    } catch {
      /* 未注入的服务按 undefined 处理 */
    }
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : undefined
    } catch {
      return undefined
    }
  }

  function defaultTarget() {
    const service = serviceOf('agentDefaultModel')
    let current = null
    try {
      current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
    } catch {
      current = null
    }
    const provider = (current && (current.provider ?? current.providerId)) || null
    const model = (current && (current.model ?? current.modelId)) || null
    if (provider && model) return { provider, model, source: 'default' }
    return null
  }

  function resolveModel() {
    // 配置里写死的优先：它能绕开「当前默认模型不支持流式/不接受这些参数」的情况，
    // 而 agentDefaultModel 只是没人指定时的顺带选择。
    const raw = String(config.assessor_model ?? '').trim()
    if (raw.includes('/')) {
      const index = raw.indexOf('/')
      const left = raw.slice(0, index)
      const right = raw.slice(index + 1)
      if (left && right) return { provider: left, model: right, source: 'config' }
    }
    return defaultTarget()
  }

  /** 「让模型帮我拆」给的时间：比评估宽，因为要吐十项、人也在等结果。 */
  const SPLIT_TIMEOUT_MS = 60000

  /**
   * 人主动点的模型拆分。
   *
   * 与评估器的区别：这不是每轮都跑的旁路，而是人按一次跑一次，所以失败要
   * 能回话给界面，不能像评估那样悄悄沉默。花的是真钱，所以只有按钮能触发。
   */
  async function runCardSplit(raw) {
    const llm = serviceOf('llm')
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm-unavailable' }
    const target = resolveModel()
    if (!target) return { ok: false, error: 'no-model' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SPLIT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()

    let text = ''
    try {
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        system: SPLITTER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: ['<card>', clip(raw, 12000), '</card>', '', '按结构输出 JSON。'].join('\n'),
              },
            ],
          },
        ],
        temperature: 0,
        // 十项都撑到 1000 字也装得下；这是上限，不是每次都会付。
        maxTokens: 4000,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          return { ok: false, error: 'stream-error' }
        }
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error).slice(0, 200) }
    } finally {
      clearTimeout(timer)
    }

    const json = extractJson(text)
    if (!json) return { ok: false, error: 'unparseable' }
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch {
      return { ok: false, error: 'bad-json' }
    }
    const result = validateSplit(parsed)
    if (!result) return { ok: false, error: 'empty' }
    return { ok: true, ...result }
  }

  /**
   * 配置里写死的模型会过期：供应商改名、模型下架都会让 llm.stream 直接报错。
   * 那种时候不该让评估一路失败到沉默——退回当前默认模型再跑一次，
   * 并在审计里记下「原本配的是谁」，免得人以为记忆一直在更新。
   */
  async function runAssess(llm, target, transcript) {
    const attempt = (which) =>
      runAssessment({
        llm,
        provider: which.provider,
        model: which.model,
        transcript,
        timeoutMs: ASSESS_TIMEOUT_MS,
      })

    const first = await attempt(target)
    if (first.ok || target.source !== 'config') return { target, result: first, retried: false }

    const fallback = defaultTarget()
    if (!fallback) return { target, result: first, retried: false }
    if (fallback.provider === target.provider && fallback.model === target.model) {
      return { target, result: first, retried: false }
    }
    const second = await attempt(fallback)
    return { target: fallback, result: second, retried: true, first }
  }

  function flushState() {
    try {
      writeJsonAtomic(paths.state, state)
    } catch (error) {
      console.warn('[dsh-whale-pal] 状态落盘失败：', error?.message ?? error)
    }
  }

  async function assessTurn(sessionId, turn) {
    if (disposed) return
    const buffer = buffers.get(sessionId)
    if (!buffer) return
    const llm = serviceOf('llm')
    if (!llm || typeof llm.stream !== 'function') {
      diag.lastError = 'llm-unavailable'
      recordAudit(paths, state, 'assess', { turn, ok: false, error: 'llm-unavailable' })
      flushState()
      return
    }

    const target = resolveModel()
    if (!target) {
      recordAudit(paths, state, 'assess', { turn, ok: false, error: 'no-model' })
      flushState()
      return
    }

    // 只发自上次评估以来的增量，多带两条给点上下文。
    const from = Math.max(0, (buffer.assessed ?? 0) - 2)
    const entries = buffer.entries.slice(from)
    const text = renderTranscript({ entries })
    if (!text) return

    const run = await runAssess(llm, target, text)
    const result = run.result

    // 配的模型挂了、退回默认模型跑成功时，两条都记：先记挂掉的那次，再记真正用上的那次。
    if (run.retried) {
      recordAudit(paths, state, 'assess', {
        turn,
        ok: false,
        model: target.provider + '/' + target.model,
        source: target.source,
        error: run.first?.error ?? 'unknown',
        salience: null,
        raw: null,
      })
    }

    recordAudit(paths, state, 'assess', {
      turn,
      ok: result.ok,
      model: run.target.provider + '/' + run.target.model,
      source: run.target.source,
      error: result.error ?? null,
      salience: result.ok ? (result.assessment.salience ?? 0) : null,
      raw: result.raw ?? null,
      ...(run.retried ? { fellBackFrom: target.provider + '/' + target.model } : {}),
    })

    diag.assessments += 1
    diag.lastError = result.ok ? null : (result.error ?? 'unknown')
    if (!result.ok) {
      flushState()
      return
    }

    buffer.assessed = buffer.entries.length
    // 称呼候选必须能在原文里找到出处，防模型把一句讽刺当昵称。
    // 记忆的 ref 落在这一轮那句用户原话的 seq 上：取回时回档案捞的就是它。
    const sourceUser = [...entries].reverse().find((entry) => entry.role === 'user') ?? null
    const applied = applyAssessment(state, result.assessment, {
      turn,
      seq: Number(sourceUser?.seq) || 0,
    })
    if (applied.changes.length === 0) {
      flushState()
      return
    }
    setState(
      applied.state,
      'update',
      { turn, salience: applied.salience, changes: applied.changes },
      { snapshot: applied.changes.length >= 4 },
    )
  }

  async function debugAssess() {
    const llm = serviceOf('llm')
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm-unavailable' }
    const target = resolveModel()
    if (!target) return { ok: false, error: 'no-model' }

    let buffer = null
    for (const candidate of buffers.values()) buffer = candidate
    let text = buffer ? renderTranscript(buffer) : ''
    const fromBuffer = Boolean(text)
    if (!text) {
      text =
        '用户：我最近在改一个库存同步的活，写到一半发现重试没做幂等，重复扣了两次，有点烦。\n' +
        '你：先别急着补测试，把写入那一步改成按（订单号 + 版本）去重的 upsert，重试就是安全的，然后再补一条重复投递的用例。\n' +
        '用户：行，那我先把写入层改了再说。'
    }

    const started = Date.now()
    const run = await runAssess(llm, target, text)
    const result = run.result
    return {
      ok: result.ok,
      ms: Date.now() - started,
      fromBuffer,
      model: run.target.provider + '/' + run.target.model,
      source: run.target.source ?? null,
      fellBackFrom: run.retried ? target.provider + '/' + target.model : null,
      transcriptChars: text.length,
      error: result.error ?? null,
      finish: result.finish ?? null,
      chars: result.chars ?? null,
      reasoningChars: result.reasoningChars ?? null,
      assessment: result.ok ? result.assessment : null,
      raw: result.raw ?? null,
    }
  }

  function scheduleAssessment(sessionId, turn) {
    assessChain = assessChain
      .then(() => assessTurn(sessionId, turn))
      .catch((error) => {
        console.warn('[dsh-whale-pal] 评估失败：', error?.message ?? error)
      })
  }

  function handleSessionEvent(session, event) {
      if (disposed) return
      if (event === undefined || event === null) {
        event = session
        session = (event && (event.session ?? (event.sessionId ? { id: event.sessionId } : null))) || null
      }
      if (event && typeof event.type === 'string') {
        diag.events += 1
        diag.lastEventType = event.type
        diag.types[event.type] = (diag.types[event.type] ?? 0) + 1
        if (event.type === 'user/message' || event.type === 'assistant/message') {
          diag.lastPayload = {
            type: event.type,
            dataKeys: Object.keys(event.data ?? {}),
            sample: JSON.stringify(event.data ?? {}).slice(0, 300),
          }
        }
      }
      if (!session || typeof session !== 'object') return
      const header = session.header
      if (header && header.origin === 'subagent') return // 子代理不参与人格状态
      const id = session.id
      if (!id || typeof id !== 'string') return
      if (!event || typeof event.type !== 'string') return

      let buffer = buffers.get(id)
      if (!buffer) {
        buffer = { ...createTranscript(), assessed: 0, lastSeq: -1 }
        if (buffers.size >= 32) {
          const oldest = buffers.keys().next()
          if (!oldest.done) buffers.delete(oldest.value)
        }
        buffers.set(id, buffer)
      }

      // 事件带 seq，重复投递时跳过
      if (typeof event.seq === 'number') {
        if (event.seq <= buffer.lastSeq) return
        buffer.lastSeq = event.seq
      }

      ingestEvent(buffer, event)
      if (event.type === 'user/message') {
        // ingestEvent 已经把非人类消息（时间戳、环境、技能目录、审批）过滤掉了，
        // 所以这里取最后一条 user 条目就是人真的说的那句话。
        const lastUser = [...buffer.entries].reverse().find((item) => item.role === 'user')
        const changedText = lastUser !== undefined && lastUser.text !== lastUserText
        if (lastUser) lastUserText = lastUser.text
        if (changedText) refreshSummary()
      }
      if (event.type !== 'turn/end') return
      diag.turns += 1

    try {
      const mode = config.assessor_mode ?? 'important'
      const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : buffer.turn
      const sub = describeSubstance(buffer)
      diag.lastTurn = { sessionId: id, turn, mode, ...sub }
      if (mode === 'off') {
        diag.lastSkip = 'mode-off'
        return
      }
      if (mode === 'important' && !hasSubstance(buffer)) {
        diag.lastSkip = 'no-substance'
        return
      }
      diag.lastSkip = null
      scheduleAssessment(id, turn)
    } catch (error) {
      console.warn('[dsh-whale-pal] 会话事件处理失败：', error?.message ?? error)
    }
  }

  try {
    const llm = serviceOf('llm')
    diag.llm = Boolean(llm && typeof llm.stream === 'function')
    if (!diag.llm) console.warn('[dsh-whale-pal] llm 服务不可用，评估会失败但事件照常记录')
    ctx.effect(() => {
      const off = ctx.on('session/event', handleSessionEvent)
      diag.registered = true
      return () => {
        disposed = true
        diag.registered = false
        buffers.clear()
        if (typeof off === 'function') off()
      }
    }, 'dsh-whale-pal: assessor')
  } catch (error) {
    console.warn('[dsh-whale-pal] 评估器注册失败：', error?.message ?? error)
  }

  // ---- 提示词注入
  try {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'whale-pal/kernel',
          order: KERNEL_ORDER,
          interpolate: false,
          text: () => kernelText,
        }),
      'dsh-whale-pal: kernel section',
    )
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'whale-pal/state',
          order: SUMMARY_ORDER,
          interpolate: false,
          text: () => summaryText,
        }),
      'dsh-whale-pal: state summary section',
    )
  } catch (error) {
    console.warn('[dsh-whale-pal] 系统提示注入失败：', error?.message ?? error)
  }

  // ---- 进程内入口
  // P1.5 的设置页、/whale 命令、工具都从这里调，不再绕 HTTP。
  // 旧版这些能力只挂在写路由上，撤掉路由就会变成死代码；收进返回值才留得住。
  const api = {
    name: PLUGIN_NAME,
    paths,
    getConfig: () => config,
    getWarnings: () => warnings,
    getState: () => state,
    getSummary: () => summaryText,
    getDiag: () => ({ ...diag, mode: config.assessor_mode, buffers: buffers.size }),
    buildView: () => buildView(paths, config, warnings, state, summaryText),
    setConfig,
    setState,
    removeMemory,
    pinMemory,
    forgetLongMemory,
    settleCommitment,
    runSelfTest: debugAssess,
    // 设置页那个「让模型帮我拆」按钮：只在人点了之后跑一次。
    splitCard: runCardSplit,
  }

  // ---- 调试路由（只读）
  // 迁移期用来对比新旧状态；写入口一个都不留。
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    try {
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: createDebugHandler(api),
          }),
        'dsh-whale-pal: debug route',
      )
    } catch (error) {
      log(`[dsh-whale-pal] 调试路由注册失败：${error?.message ?? error}`)
    }
  } else {
    log('[dsh-whale-pal] webServer 不可用，调试路由未注册')
  }

  return api
}


// ------------------------------------------------------------------ 调试路由

//   GET <ROUTE_PREFIX>/ping    活着没有、数据根在哪
//   GET <ROUTE_PREFIX>/state   与旧 /state 同形的只读快照
function createDebugHandler(api) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    const guard = async (fn) => {
      try {
        return await fn()
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }

    if (route === '/ping' && method === 'GET') {
      return guard(() => sendJson(res, 200, { ok: true, name: PLUGIN_NAME, paths: api.paths }))
    }

    if (route === '/state' && method === 'GET') {
      return guard(() => sendJson(res, 200, api.buildView()))
    }

    return guard(() => sendJson(res, 404, { ok: false, error: 'not found' }))
  }
}
