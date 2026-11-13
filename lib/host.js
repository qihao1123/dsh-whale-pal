/**
 * 宿主这一侧的接线：把设置层和模式挂到 DSH 上。
 *
 * 挂三样东西：
 *   1. `/api/whale-pal/*` 路由 —— 客户端设置页唯一的通道（GUI 带 <base href="./">，
 *      所以客户端用文档相对路径 `api/whale-pal/status` 来打）；
 *   2. `/whale` 命令 —— 切换模式；
 *   3. 一段系统提示 —— 当前模式。
 *
 * 另外挂一个 `whale_pal_identity` 工具：设置页填过就只读，之后要改只能在对话里说，
 * 模型用这个工具带理由写回去（模型没有别的写通道）。
 *
 * 写权仍然只有一处：所有落盘都经 `api.setConfig` / `api.setState`，
 * 这两个是人格内核返回的进程内入口，不额外开写者。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { listBackups, restoreLatest } from './atomic.js'
import { COPY } from './copy.js'
import { listEntries, readEntry, renderRead, searchEntries } from './persona/lib/retrieve.js'
import { handleModeCommand, listWorkspaces, resolveMode, modeText, syncAllWorkspaceTitles } from './mode.js'
import { ctxAnchor, ctxInfo, registerContext } from './ctx/host-bridge.js'
import { makeServiceOf, switchSession } from './ctx/switch.js'
import { messageFor } from './inbox.js'
import { originalAt } from './ctx/original.js'
import { ctxRoot } from './ctx/store.js'
import {
  abandon,
  begin,
  confirm,
  createProgress,
  defer,
  finish,
  formatMarker,
  jumpBack,
  land,
  progressText,
  readProgress,
  restart,
  rework,
  saveProgress,
} from './progress.js'
import { CARD_RAW_MAX, applyIdentityChange, applySettings, describeStatus, normalizeExtras, readConfigFile } from './settings.js'
import { withFailureReceipt } from './receipt.js'
import { parsePersonaCard } from './persona-card.js'
import { importCommand } from './import/command.js'
import { registerLedger } from './ledger/host-bridge.js'
import { LEVEL, loadReport, markCleanExit, markRunStart } from './load.js'
import { STATE, describeState } from './vault.js'
import { detectOnDisk } from './vault-io.js'
// 升级那一套（lib/upgrade/）第二批整目录删了：它是照抄「人手动维护的文档库」的仪式。
// 现在只留一件事：从台账里读最后一条「版本：」行，回答「这库升到哪一版了」。

export const SETTINGS_ROUTE = '/api/whale-pal'
export const MODE_SECTION = 'whale-pal/mode'
export const MODE_ORDER = 92
export const PROGRESS_SECTION = 'whale-pal/progress'
export const PROGRESS_ORDER = 93
// 锚定块紧跟在两段之后：前面那四段（内核、状态、模式、进度）才是「稳定前缀」，
// 这一段是它后面的热索引，只在有新档案时才变。顺序写死，不跟别的段抢位置。
export const ANCHOR_SECTION = 'whale-pal/anchor'
export const ANCHOR_ORDER = 94
/**
 * 请求体上限。人格卡原文最长 10000 字（中文 UTF-8 三字节一个，加上 JSON
 * 转义约 35 KB），64 KB 已经很紧，给到 128 KB 留足余量。
 */
const MAX_BODY = 128 * 1024

/** 允许回滚的两个根：插件数据目录、设置页填的笔记库。 */
function rollbackRoots(paths) {
  const roots = []
  if (paths?.root) roots.push(resolve(paths.root))
  try {
    const config = readConfigFile(paths) ?? {}
    const vault = config?.knowledge?.vaultPath
    if (typeof vault === 'string' && vault !== '') roots.push(resolve(vault))
  } catch {
    // 配置读不出来就只认数据目录，不猜。
  }
  return roots
}

function insideAny(target, roots) {
  const abs = resolve(target)
  return roots.some((root) => {
    const base = root.endsWith(sep) ? root : root + sep
    return abs === root || abs.startsWith(base)
  })
}

/**
 * 一键回滚：把某个文件退回最近一份 `.bak`。
 *
 * 三个拒绝要能说清：路径不在范围内、没有备份、文件根本不存在。
 * 退回之后要说退到哪一份，不然「退回去了」是句废话。
 */
function runRollback(paths, { path: target } = {}) {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (raw === '' || isAbsolute(raw) === false) {
    return { ok: false, error: 'path-required', message: COPY.rollbackOutside }
  }
  const roots = rollbackRoots(paths)
  if (roots.length === 0 || insideAny(raw, roots) === false) {
    return { ok: false, error: 'path-not-allowed', message: COPY.rollbackOutside }
  }
  const backups = listBackups(raw)
  if (backups.length === 0) {
    const missing = existsSync(raw) === false
    return {
      ok: false,
      error: missing ? 'no-such-file' : 'no-backup',
      message: missing ? COPY.rollbackMissing : COPY.rollbackNoBackup,
    }
  }
  const result = restoreLatest(raw)
  if (result.ok !== true) {
    return { ok: false, error: result.error, message: COPY.rollbackNoBackup }
  }
  return { ok: true, path: raw, backup: result.backup, message: COPY.rollbackDone }
}

/** 进度点文件；调用方没给这个格子时，跟着 config.json 放同一个目录，别落到工作目录里。 */
function progressFile(paths) {
  if (paths?.progress) return paths.progress
  return join(dirname(paths?.config ?? join(process.cwd(), 'config.json')), 'progress.json')
}

/**
 * 记忆取回：正文 + 原话（2026-11-09，判据 4 级二）。
 *
 * 原话按条目的 `ref.seq` 回档案捞。捞不到就填 `originalMissing`，取回文本里会写清是哪一步没成
 * ——「没有来源」「档案没落盘」「原文里没这一段」是三种不同的情况，不能混成一句「取不到」。
 * 原话也吃 2000 字额度：装不下就截断并注明，不静默少给；连截的余量都没有就如实说装不下。
 */
function readMemoryWithSource(state, id, paths) {
  const value = readEntry(state, id)
  if (!value || value.ok !== true) return value
  const seq = Math.floor(Number(value?.ref?.seq) || 0)
  if (seq <= 0) return value
  let vault = ''
  try {
    const config = readConfigFile(paths) ?? {}
    vault = typeof config?.knowledge?.vaultPath === 'string' ? config.knowledge.vaultPath.trim() : ''
  } catch {
    vault = ''
  }
  if (vault === '') return { ...value, originalMissing: 'no-vault' }
  const found = originalAt(ctxRoot(vault), seq)
  if (found.ok !== true) return { ...value, originalMissing: found.reason ?? 'unknown' }
  const room = Math.max(0, 2000 - renderRead({ ...value, original: '', originalMissing: '' }).length - 4)
  if (room <= 0) return { ...value, originalMissing: 'no-room' }
  const original = String(found.text)
  const text = original.length > room ? `${original.slice(0, room)}…（原话已截断，全文 ${original.length} 字）` : original
  return { ...value, original: text }
}

/**
 * 走一步状态机。纯函数在 lib/progress.js，这里只负责读盘、落盘、把结果说清。
 * 所有拒绝都带原因码；要用户重说时一并给那句回问，不自己另编一句。
 */
function runProgress(paths, { action = 'show', token = '', stage } = {}) {
  const file = progressFile(paths)
  const progress = readProgress(file) ?? createProgress()
  if (action === 'show') {
    return { ok: true, progress, marker: formatMarker(progress) }
  }

  const steps = { begin, restart, rework, abandon, defer, finish, land }
  let result = null
  if (action === 'confirm') result = confirm(progress, token)
  else if (action === 'jump') result = jumpBack(progress, Number(stage))
  else if (steps[action]) result = steps[action](progress)
  else return { ok: false, error: 'unknown-action' }

  if (!result.ok) return { ok: false, error: result.error, ask: result.ask }
  saveProgress(file, result.progress)
  return { ok: true, progress: result.progress, marker: formatMarker(result.progress) }
}
/** 选目录等到用户点完为止，上限给足；纯防泄漏，不催用户。 */
const PICK_TIMEOUT_MS = 10 * 60 * 1000

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('bad-json')
  }
}

/**
 * 取这个 scope 的工作目录。
 *
 * 优先读 `workingDirectory` 服务的投影：那才是会话里 `cd` 过之后**当前**的目录
 * （`@deepseek-ai/dsh-working-directory` 把目录放进 session 投影，`get(session)` 只读、不碰文件系统）。
 * 拿不到服务或投影时退回 `header.cwd` —— 它是会话创建时的原始目录，
 * 会话里没 cd 过时与投影同值；两者都读不到才算空。
 */
function cwdOf(scope, workingDirectory = null) {
  const session = scope?.agent?.session ?? scope?.session ?? null
  if (workingDirectory && session) {
    try {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current !== '') return current
    } catch {
      // 投影读不出来就退会话头：模式宁可读到老目录，也不能整段断掉。
    }
  }
  const cwd =
    scope?.agent?.session?.header?.cwd ??
    scope?.session?.header?.cwd ??
    scope?.cwd ??
    ''
  return typeof cwd === 'string' ? cwd : ''
}

/**
 * Obsidian 现在的样子，给设置页显示用。
 *
 * 开关关着时只 stat 一下配置文件回答「装过没装」（`:342` 的轻判断），
 * 不解析内容、不探 `.obsidian/`、不查进程（`:273`）。
 * 检测本身不许让设置页崩，出任何错都退成 `absent`。
 */
function obsidianStatus(api) {
  let config = {}
  try {
    config = api.getConfig() ?? {}
  } catch {
    config = {}
  }
  const extras = normalizeExtras(config)
  const enabled = extras.obsidian.enabled === true
  let info = { state: STATE.ABSENT }
  try {
    info = detectOnDisk({ enabled })
  } catch {
    info = { state: STATE.ABSENT }
  }
  return {
    enabled,
    state: info.state,
    label: describeState(info.state),
    vaultName: extras.knowledge.vaultName,
    hasVault: extras.knowledge.vaultPath !== '',
    prompted: extras.obsidian.prompted === true,
  }
}

/** 设置页与调试共用的一条只读视图。 */
function statusPayload({ api, importRecord, projection = 'unknown' }) {
  const payload = describeStatus({ api, importRecord })
  try {
    payload.view = api.buildView()
  } catch {
    payload.view = null
  }
  // 库相关的状态：装没装、接没接、库名、有没有路径。
  payload.obsidian = obsidianStatus(api)
  // 升级：只读最近一次完成标记，没有就说没升过（设置页只显示一行）。
  payload.upgrade = upgradeInfo(api)
  // 上下文档案：有多少份、库在哪；没选库就照实说没地方放。projection 是投影到底挂上没有。
  payload.ctx = ctxInfo({ api, projection })
  return payload
}

function createHandler({ api, paths, importRecord, log, pickerStatus, pickFolder, health, guard, projectionStatus, workspaceController = null }) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = (url.pathname.slice(SETTINGS_ROUTE.length) || '/').replace(/\/+$/, '') || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (rest === '/status' && method === 'GET') {
        const payload = statusPayload({ api, importRecord, projection: typeof projectionStatus === 'function' ? projectionStatus() : 'unknown' })
        // 页面靠这一格决定「选目录」按钮能不能点，别让用户点一个必然失败的按钮。
        payload.picker = pickerStatus ? pickerStatus() : { ok: true, available: false, kind: null }
        // 健康状态也带上，设置页只显示一行小字。
        if (typeof health === 'function') payload.health = health()
        return json(res, 200, payload)
      }
      if (rest === '/workspaces' && method === 'GET') {
        // 设置页那份勾选清单。读不到就回空数组，页面还有「手动填路径」这条兜底。
        const workspaces = await listWorkspaces(workspaceController)
        return json(res, 200, { ok: true, workspaces })
      }
      if (rest === '/health' && method === 'GET') {
        const report =
          typeof health === 'function' ? health() : { ok: false, state: 'disabled', notes: ['健康检查没接上'] }
        return json(res, report.ok ? 200 : 503, report)
      }
      if (rest === '/settings' && method === 'POST') {
        // 降级态先拦一道：不靠调用方自觉，写不进去就明说为什么。
        const blocked = typeof guard === 'function' ? guard() : null
        if (blocked) return json(res, blocked.status, blocked)
        const body = await readBody(req)
        const result = applySettings(api, paths, body)
        if (result.ok) {
          // 名单改了就把工作区名跟着对齐：名单里的加标记，移出的剥掉。
          // 不 await —— 存盘已经成了，改名慢一点或撞名都不该让保存失败。
          if (Array.isArray(result.applied) && result.applied.includes('whaleWorkspaces')) {
            void syncAllWorkspaceTitles({
              workspaceController,
              list: api.getConfig()?.whaleWorkspaces,
            })
          }
          return json(res, 200, result)
        }
        // code 给页面做判断，message 直接给人看；两边都不猜对方的词。
        return json(res, result.status ?? 400, {
          ok: false,
          error: result.error,
          message: result.message,
          keys: result.keys,
        })
      }
      // 规则拆分：免费、即时、可预测，是主路。不写盘，只回结果。
      if (rest === '/card/parse' && method === 'POST') {
        const body = await readBody(req)
        const raw = typeof body?.raw === 'string' ? body.raw : ''
        if (raw.length > CARD_RAW_MAX) {
          return json(res, 400, {
            ok: false,
            error: 'personaCard-too-long',
            message: COPY.cardTooLong,
          })
        }
        return json(res, 200, { ok: true, ...parsePersonaCard(raw) })
      }
      // 模型拆分：兜底路，只有人点了按钮才跑，花的是真钱，所以不自动触发。
      if (rest === '/card/split' && method === 'POST') {
        const body = await readBody(req)
        const raw = typeof body?.raw === 'string' ? body.raw : ''
        if (raw.trim() === '') {
          return json(res, 400, { ok: false, error: 'card-empty', message: COPY.cardEmptyRaw })
        }
        if (raw.length > CARD_RAW_MAX) {
          return json(res, 400, {
            ok: false,
            error: 'personaCard-too-long',
            message: COPY.cardTooLong,
          })
        }
        if (typeof api.splitCard !== 'function') {
          return json(res, 503, { ok: false, error: 'split-unavailable', message: COPY.cardSplitFailed })
        }
        const result = await api.splitCard(raw)
        if (!result || result.ok !== true) {
          // 「读不懂」那句话本身没信息量：不知道是没模型、超时、还是回了半截。
          // 知道原因的就把原因接上，认不出的原样带上短串，别把真话吞掉。
          const code = typeof result?.error === 'string' && result.error !== '' ? result.error : 'split-failed'
          const known = Object.prototype.hasOwnProperty.call(COPY.cardSplitReasons, code)
            ? COPY.cardSplitReasons[code]
            : String(code).slice(0, 120)
          return json(res, 503, {
            ok: false,
            error: code,
            finish: result?.finish ?? null,
            chars: typeof result?.chars === 'number' ? result.chars : null,
            message: COPY.cardSplitReason(known),
          })
        }
        // 模型那条只认十项；页面上的「没进内核」段落也得摆出来，
        // 所以规则拆的那一份原样带回去——同一份 raw、同一份来源，不另算一遍。
        // ruleFields 一起回：模型跳过的项，页面可以拿规则拆到的补上，
        // 并且能说清是哪几项补的（规则只按标题认标签，认出来的就是原文自己的结构）。
        const parsed = parsePersonaCard(raw)
        return json(res, 200, {
          ok: true,
          fields: result.fields,
          hits: result.hits,
          total: result.total,
          // 模型自己交代的账：哪一段搬进了哪一项、哪一段没搬进去。
          // 老 api 不带这两样时给空数组，页面照旧能用。
          moves: Array.isArray(result.moves) ? result.moves : [],
          unused: Array.isArray(result.unused) ? result.unused : [],
          ruleFields: parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {},
          sections: parsed.sections,
          rest: parsed.rest,
        })
      }
      if (rest === '/picker' && method === 'GET') {
        const info = pickerStatus ? pickerStatus() : { ok: true, available: false, kind: null }
        return json(res, 200, info)
      }
      if (rest === '/pick' && method === 'POST') {
        const result = pickFolder
          ? await pickFolder()
          : { ok: false, status: 503, error: 'picker-unavailable', message: COPY.pickerUnavailable }
        if (result.ok) return json(res, 200, { ok: true, path: result.path ?? null })
        return json(res, result.status ?? 500, {
          ok: false,
          error: result.error,
          message: result.message,
        })
      }
      if (rest === '/ping' && method === 'GET') {
        return json(res, 200, { ok: true, name: 'dsh-whale-pal', paths })
      }
      return json(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      const tooLarge = error?.message === 'body-too-large'
      const code = tooLarge ? 'body-too-large' : 'body-not-json'
      log(`[dsh-whale-pal] 设置路由出错：${code}`)
      return json(res, 400, {
        ok: false,
        error: code,
        message: tooLarge ? COPY.bodyTooLarge : COPY.bodyNotJson,
      })
    }
  }
}

/**
 * 给服务套一层计数：注册了几个，自检那一步就拿这个数对账。
 *
 * 用 Proxy 而不是在各处手写 `+= 1`：手写的迟早会漏一个，
 * 漏了之后「挂载确认」就是在骗自己。
 */
function counting(svc, key, registered, method = 'register') {
  if (!svc || typeof svc[method] !== 'function') return svc
  return new Proxy(svc, {
    get(target, prop) {
      if (prop === method) {
        // 只数这个服务真正用的那个挂载方法：systemPrompt 用 section 不是 register，
        // 一律拦 register 会让「挂载确认」把 4 段提示数成 0。
        return (...args) => {
          const dispose = target[method](...args)
          registered[key] += 1
          return dispose
        }
      }
      return Reflect.get(target, prop, target)
    },
  })
}

/**
 * 取一个服务。
 *
 * 先直接取，没注入时 Cordis 的 Proxy 会抛错 —— 吞掉，再走 `ctx.get(key)`
 * 这条正规的可选访问口。2026-11-11：只留直接取这一条时，插件没 inject 的
 * 服务（workingDirectory 就是）永远取不到，模式段只能退回会话头，
 * 会话里 `cd` 过去也不会换模式。
 */
function service(ctx, key) {
  try {
    const direct = ctx?.[key]
    if (direct) return direct
  } catch {
    /* 未注入的服务按缺席处理，下面走 ctx.get */
  }
  try {
    const found = typeof ctx?.get === 'function' ? ctx.get(key) : null
    return found ?? null
  } catch {
    return null
  }
}

/** 只吃字符串：`args` 从工具调用进来，什么都可能是。 */
function argText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `/whale ledger ...` 的回话：读数、该说什么、确认交接、还欠着什么。
 *
 * 台账模块自己挂定时器与会话钩子，但它按约定不注册命令（见 `lib/ledger/host-bridge.js` 头注），
 * 所以人这一面在这儿接：只读为主，唯一会改盘的是 `settle`（把人确认过的那条标结）与 `fallback`
 * （没人在跑时落一行待提醒）。两样都不碰人格内核。
 */
function ledgerCommand({ ledger, argument = '', at = '' } = {}) {
  if (!ledger || typeof ledger.info !== 'function') return { ok: false, text: COPY.ledgerOff }
  const said = argText(argument)
  if (said === '' || said === 'status') return { ok: true, text: ledgerText({ ledger }) }

  if (/^preview\b/iu.test(said)) {
    const seen = ledger.preview()
    if (seen.ok !== true) return { ok: false, text: COPY.ledgerNoVault }
    const lines = [
      ...seen.report.map((one) => `补报：${one.text}`),
      ...seen.fire.map((one) => `这次该说：${one.text}`),
    ]
    return { ok: true, text: lines.length === 0 ? COPY.ledgerQuiet : lines.join('\n') }
  }

  if (/^handoffs?\b/iu.test(said)) {
    const seen = ledger.handoffs()
    if (seen.ok !== true) return { ok: false, text: COPY.ledgerNoVault }
    if (seen.rows.length === 0) return { ok: true, text: `还欠着的交接：0 条（这本账一共 ${seen.total} 行）` }
    return {
      ok: true,
      text: [
        `还欠着的交接：${seen.rows.length} 条（这本账一共 ${seen.total} 行）`,
        ...seen.rows.map((one) => `  #${one.index} ${one.key}｜${one.what}｜${one.at}｜${one.status}`),
        '',
        '人确认了就 `/whale ledger settle <行号>`；不想管的写 `/whale ledger settle <行号> ignore`',
      ].join('\n'),
    }
  }

  if (/^fills?\b/iu.test(said)) {
    const seen = ledger.pendingFills()
    if (seen.ok !== true) return { ok: false, text: COPY.ledgerNoVault }
    if (seen.rows.length === 0) return { ok: true, text: '该补判断与教训的行：0 条（隔了一天还没定的才列）' }
    return {
      ok: true,
      text: [
        `该补判断与教训的行：${seen.rows.length} 条`,
        ...seen.rows.map((one) => `  #${one.index} ${one.what ?? ''}｜待补：${(one.missing ?? []).join('、')}`),
        '',
        '补的时候用工具 whale_pal_ledger（action: fill）——这几个字抄当时原话，别美化',
      ].join('\n'),
    }
  }

  const settle = /^settle\s+(\d+)\s*(\S*)$/iu.exec(said)
  if (settle) {
    const action = /^ignore$/iu.test(settle[2] ?? '') ? 'ignore' : 'settle'
    const done = ledger.settleHandoff({ key: settle[1], action })
    if (done.ok !== true) return { ok: false, text: `那条没标上（${done.reason ?? '未知'}）` }
    return { ok: true, text: `第 ${settle[1]} 条标成${action === 'ignore' ? '忽略' : '结清'}了（只动台账那一格，不碰人格内核）` }
  }

  const fallback = /^fallback\s+(日|周|月)\s*(\S+)$/u.exec(said)
  if (fallback) {
    const done = ledger.fallback({ kind: fallback[1], value: fallback[2], at })
    if (done.ok !== true) return { ok: false, text: `这一行没落成（${done.reason ?? '未知'}）` }
    return { ok: true, text: `往「待提醒」落了一行：${fallback[1]} ${fallback[2]}（同一个周期键只落一行，下次启动补报一次）` }
  }

  return { ok: false, text: COPY.ledgerUnknown }
}

/** 台账读数的人话。没有库的时候它自己会回 ready:false，照实说。 */
function ledgerText({ ledger } = {}) {
  const seen = ledger.info()
  if (seen.ok !== true) return COPY.ledgerOff
  if (seen.ready !== true) return COPY.ledgerNoVault
  const books = seen.books ?? {}
  return [
    `台账：一共 ${seen.rows} 行`,
    `  事件 ${books['事件'] ?? 0}｜偏离 ${books['偏离'] ?? 0}｜异议 ${books['异议'] ?? 0}｜待交接 ${books['待交接'] ?? 0}｜待提醒 ${books['待提醒'] ?? 0}`,
    `  还欠着的交接 ${seen.handoffs} 条｜该补判断与教训 ${seen.fills} 条`,
    `  待提醒：还挂着 ${seen.reminders?.pending ?? 0} 行，已经报过 ${seen.reminders?.reported ?? 0} 行`,
    `  节律：今天该说的是 ${(seen.due ?? []).map((one) => one.kind ?? one).join('、') || '暂无'}`,
    `  上次真报出去：${seen.rhythm?.lastReport || '还没报过'}`,
    '',
    '看现在该说什么用 `/whale ledger preview`；欠着的交接 `/whale ledger handoffs`；该补的行 `/whale ledger fills`',
  ].join('\n')
}

/**
 * 最近一次升级的读数：找库里最新的完成标记，读回 ④ 与 ②。
 *
 * 没有标记就说「还没升过版」——不猜、不按目录名推断。
 */
function upgradeInfo(api) {
  let config = {}
  try {
    config = api.getConfig() ?? {}
  } catch {
    config = {}
  }
  const vaultPath = typeof config?.knowledge?.vaultPath === 'string' ? config.knowledge.vaultPath : ''
  if (vaultPath === '') return { ok: true, never: true, message: COPY.upgradeNever }

  // 版本号只认台账里最后一条 `版本：` 行（第二批 §6 的落点）。
  // 不再去找 `*_升级完成-*.md` 那种六字段标记文件——那是别人的仪式。
  const book = join(vaultPath, '台账', '事件.md')
  let body = ''
  try {
    body = readFileSync(book, 'utf8')
  } catch {
    body = ''
  }
  const hits = [...body.matchAll(/版本：\s*([^\s|·]+)/gu)]
  if (hits.length === 0) return { ok: true, never: true, message: COPY.upgradeNever }
  const last = hits[hits.length - 1]
  return {
    ok: true,
    never: false,
    file: join('台账', '事件.md'),
    vaultVersion: last[1],
  }
}

/**
 * 把四样东西挂上去。任何一样挂了都只记日志，不影响人格内核本身。
 *
 * @param {{ctx: object, api: object, paths: object, legacy?: object, base?: object, importRecord?: string, importReport?: object|null, log: (m: string) => void}} options
 */
export function registerSurface({ ctx, api, paths, legacy = null, base = null, importRecord, importReport = null, log }) {
  const disposers = []

  // 启动这一笔在这儿写：registerSurface 就是「这个插件真的起来了」的那道门。
  // 只写退出那笔的话，被杀之后标记还停在上一次的 clean，自检会把「崩过」读成「正常退出」。
  markRunStart(paths, log)

  // 实际挂上多少东西：自检那一步拿这个数对账，不写死数字。
  const registered = { routes: 0, commands: 0, tools: 0, sections: 0 }

  /** 拿内存里那份状态；拿不到就回 null——健康报告少一格，比报个假数好。 */
  const readStateSafe = () => {
    try {
      return typeof api?.getState === 'function' ? (api.getState() ?? null) : null
    } catch {
      return null
    }
  }

  /**
   * 现在的健康状态。每次现算，不缓存——状态会变，缓存就成了谎。
   * 带 runtime：装载六步回答不了「评估器最近挂了百分之多少」「记忆顶满没有」，
   * 那两个数字以前只有翻 audit.jsonl 才看得到。
   */
  const health = () =>
    loadReport({ paths, registered, log, runtime: true, state: readStateSafe() })

  /**
   * 写操作统一过的闸门。
   *
   * 只拦我们自己这三个写入口；人格内核自己的 setState/setConfig 拦不住，
   * 所以「停写保读」是插件与内核各管一半——交付里写明，不假装全拦住。
   */
  const guard = () => {
    const report = health()
    if (report.state === LEVEL.NORMAL) return null
    const reason = report.notes.length > 0 ? report.notes.join('；') : '装载没过关'
    if (report.state === LEVEL.DISABLED) {
      return { ok: false, status: 503, error: 'disabled', message: `${COPY.healthDisabled}：${reason}` }
    }
    return { ok: false, status: 403, error: 'readonly-degraded', message: `${COPY.healthReadonly}：${reason}` }
  }

  // ---- 0. 目录选择：宿主 compose 了 native 的 picker 才有这个能力
  // 不写进 export const inject：缺席时整个插件不该被拖下水，所以用可选注入自查。
  let picker = null
  const pickerCapability = () => {
    if (!picker) return null
    try {
      const capability = typeof picker.capability === 'function' ? picker.capability() : null
      if (!capability || typeof capability.pick !== 'function') return null
      if (capability.kind !== 'native') return null
      return capability
    } catch {
      return null
    }
  }
  const pickerStatus = () => {
    const capability = pickerCapability()
    return { ok: true, available: Boolean(capability), kind: capability ? 'native' : null }
  }
  const pickFolder = async () => {
    const capability = pickerCapability()
    if (!capability) {
      return { ok: false, status: 503, error: 'picker-unavailable', message: COPY.pickerUnavailable }
    }
    // 必须带 signal：native 后端 win32 的第一行就读 signal.aborted，不给会直接 TypeError（秒失败）。
    // 上限时间到就 abort，别把对话框 worker 挂着。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PICK_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const chosen = await capability.pick(controller.signal)
      if (typeof chosen !== 'string' || chosen.length === 0) return { ok: true, path: null }
      return { ok: true, path: chosen }
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 300)
      // 原始报错只进日志，不进响应：页面和 curl 都不该看到宿主的内部栈。
      log(`[dsh-whale-pal] 选目录失败：${detail}`)
      return { ok: false, status: 500, error: 'picker-failed', message: COPY.pickerFailed }
    } finally {
      clearTimeout(timer)
    }
  }
  const inject = service(ctx, 'inject')
  if (typeof inject === 'function') {
    try {
      inject.call(ctx, ['directoryPicker'], (pickerCtx) => {
        try {
          picker = pickerCtx?.directoryPicker ?? null
        } catch {
          picker = null
        }
      })
    } catch (error) {
      log(`[dsh-whale-pal] 目录选择器缺席：${error?.message ?? error}`)
    }
  }

  // 只造一个 handler：注册进 webServer 的和返回给调用方的必须是同一个，
  // 不然测试摸的是返回的那个，线上跑的是注册的那个，两边能悄悄分叉。
  const handler = createHandler({
    api,
    paths,
    importRecord,
    log,
    pickerStatus,
    pickFolder,
    health,
    guard,
    // 工作区服务是可选的：宿主没这服务时只影响设置页的勾选清单与改名，不拖垮插件。
    workspaceController: service(ctx, 'workspaceController'),
    // context 在这段之后才赋值，所以给的是取值函数而不是快照。
    projectionStatus: () => (typeof context?.projectionStatus === 'function' ? context.projectionStatus() : 'unknown'),
  })

  // ---- 0.5 上下文档案：投影只折叠、落盘只走工具与命令
  // 投影与工具都不写进 export const inject：宿主没这服务时这不该拖垮插件。
  // 真正的注册放到「工具」那一段之后：先过计数包装，挂载数量才对得上。
  let context = null

  // ---- 1. 路由
  const webServer = counting(service(ctx, 'webServer'), 'routes', registered)
  if (webServer && typeof webServer.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            webServer.register({
              kind: 'prefix',
              path: SETTINGS_ROUTE,
              handler,
            }),
          'dsh-whale-pal: settings route',
        ),
      )
    } catch (error) {
      // 只打日志等于悄悄死掉：设置页整条路由不在了，health 那边还显示正常。
      // 宿主对重复注册是直接抛的（webserver: duplicate prefix route），这一条必须露出来。
      const detail = String(error?.message ?? error).slice(0, 200)
      log(`[dsh-whale-pal] 设置路由注册失败：${detail}`)
      registered.warnings = (registered.warnings ?? []).concat(`设置路由没挂上：${detail}`)
    }
  }

  // `/whale` 这一条命令的路由：ctx / import / ledger 各自一路，剩下的还给模式切换。
  // 返回值原样交给宿主；失败时再由 withFailureReceipt 往会话里补一句（成功不吭声）。
  const runWhaleCommand = (invocation) => {
    const rawInput = invocation?.rawInput ?? ''
    // ctx 那几个子命令走档案这一路，`import` 走旧状态导入那一路，剩下的还给模式切换。
    if (context && /^ctx\b/iu.test(String(rawInput).trim())) {
      const result = context.command(rawInput, {
        pending: context.pendingOf(invocation?.agent),
        session: context.sessionOf(invocation?.agent),
        // 只在真问到 status 时才算这一格（要读库、读宿主投影）。
        statusOf: () => context.statusOf(invocation?.agent),
      })
      return { kind: result.ok === true ? 'success' : 'error', text: result.text }
    }
    if (/^import\b/iu.test(String(rawInput).trim())) {
      const said = importCommand({
        resolved: { paths, legacy, base, importRecord },
        argument: String(rawInput).trim().replace(/^import\b/iu, ''),
        at: new Date().toISOString(),
        log,
      })
      return { kind: said.ok === true ? 'success' : 'error', text: said.text }
    }
    if (/^ledger\b/iu.test(String(rawInput).trim())) {
      const said = ledgerCommand({
        ledger,
        argument: String(rawInput).trim().replace(/^ledger\b/iu, ''),
        at: new Date().toISOString(),
      })
      return { kind: said.ok === true ? 'success' : 'error', text: said.text }
    }
    // 手动开新会话：跟自动那条走同一个函数，只是理由写成「你让开的」。
    // 命令结果里不留字：返回的 text 会一直挂在命令行上（第一版写「正在开新会话」，看着像卡住），
    // 进度和结果都走 inject，写完就完。
    if (/^new\b/iu.test(String(rawInput).trim())) {
      const agent = invocation?.agent ?? null
      const session = context && typeof context.sessionOf === 'function'
        ? context.sessionOf(agent)
        : agent?.session ?? null
      let catalog = ''
      try {
        catalog = ctxAnchor({ api })
      } catch {
        catalog = ''
      }
      try {
        agent?.inject?.(messageFor(COPY.switchStarting))
      } catch (error) {
        log(`[dsh-whale-pal] 开新会话这句没塞回会话：${error?.message ?? error}`)
      }
      switchSession({
        getService: makeServiceOf(ctx),
        api,
        session,
        reason: '用户手动 /whale new 开的',
        catalog,
      })
        .then((done) => {
          const line = done.ok !== true
            ? `开新会话没成：${done.reason}${done.detail ? `（${done.detail}）` : ''}`
            : done.mode === 'whale'
              ? COPY.switchDoneWhale(done.sessionId, done.groupDetail)
              : COPY.switchManual(done.sessionId, done.seeded, done.detail, done.groupDetail)
          try {
            agent?.inject?.(messageFor(line))
          } catch (error) {
            log(`[dsh-whale-pal] 手动开新会话的结果没塞回会话：${error?.message ?? error}`)
          }
        })
        .catch((error) => {
          log(`[dsh-whale-pal] 手动开新会话抛了：${error?.message ?? error}`)
        })
      return { kind: 'success' }
    }
    return handleModeCommand({
      api,
      cwd: cwdOf(invocation?.agent ?? invocation, service(ctx, 'workingDirectory')),
      rawInput,
      workspaceController: service(ctx, 'workspaceController'),
      log,
    })
  }

  // ---- 2. 命令
  const commands = counting(service(ctx, 'commands'), 'commands', registered)
  if (commands && typeof commands.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            commands.register({
              name: 'whale',
              description: '鲸鲸：绑工作区模式、开新会话、查上下文档案、看/回滚旧状态导入（/whale mode [whale|assistant]、/whale bind、/whale unbind、/whale new、/whale ctx search <词>、/whale import）',
              input: { hint: 'mode|bind|unbind|new · ctx search|read|files|batch|entries|sync|rollback · import rollback|undo' },
              handler: (invocation) =>
                withFailureReceipt({
                  agent: invocation?.agent,
                  result: runWhaleCommand(invocation),
                  rawInput: invocation?.rawInput,
                  log,
                }),
            }),
          'dsh-whale-pal: whale command',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] /whale 命令注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 3. 工具：设置页填过就只读，之后要改只能在对话里说
  const tools = counting(service(ctx, 'tools'), 'tools', registered)
  // 上下文档案的工具与投影在这里挂：工具要过计数包装，命令那段的闭包也这时才有值。
  context = registerContext({ ctx, api, log, tools })
  if (typeof context.dispose === 'function') disposers.push(context.dispose)
  // 挂载时哪一项没挂上，写进 mounted 那一行，别让它在控制台里烂掉。
  if (Array.isArray(context.warnings) && context.warnings.length > 0) {
    registered.warnings = (registered.warnings ?? []).concat(context.warnings)
  }

  // ---- 4.5 台账与节律（P4）：模块自己挂定时器与会话钩子，这里只给根目录、收 warnings。
  // 它**不注册命令也不注册工具**（那两样在这儿接），返回的 handle 就是写入口与读数口。
  // 挂不上只记一笔，不拦启动——台账没起来不该把人拦在门外。
  let ledger = null
  try {
    ledger = registerLedger({ ctx, api, log, dataDir: paths.root })
    if (typeof ledger.dispose === 'function') disposers.push(ledger.dispose)
    if (Array.isArray(ledger.warnings) && ledger.warnings.length > 0) {
      registered.warnings = (registered.warnings ?? []).concat(ledger.warnings)
    }
    // 旧状态导入那件事要留一条台账（可回查），但导入发生在 applyPersona 之前，
    // 那会儿还没有库的 api；所以把报告传进来，在这儿补一行。
    // 判断/结果/教训三格故意留空：当场不下定论，隔天补（口径 §11.6）。
    if (ledger && importReport && importReport.imported === true) {
      const { counts } = importReport
      const written = ledger.appendEvent({
        at: importReport.at,
        type: '任务',
        what: `从旧插件目录导入状态：revision ${counts?.revision ?? '?'}、短记忆 ${(counts?.facts ?? 0) + (counts?.preferences ?? 0) + (counts?.events ?? 0) + (counts?.openTopics ?? 0)} 条、长记忆 ${counts?.longMemory ?? 0} 条、traits ${counts?.traits ?? 0} 条、承诺 ${counts?.commitments ?? 0} 条`,
      })
      if (written?.ok !== true) log(`[dsh-whale-pal] 导入那一条台账没写上：${written?.reason ?? '未知'}`)
    }
  } catch (error) {
    log(`[dsh-whale-pal] 台账没挂上：${error?.message ?? error}`)
  }
  if (tools && typeof tools.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            tools.register({
              name: COPY.toolName,
              description:
                'Change one identity field after the user asked for it in conversation (name, selfName, title, or their meanings). Ask why first, then pass the reason. An empty value clears the field (the kernel then falls back to its built-in default), and it still needs a reason.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: {
                    type: 'string',
                    enum: ['name', 'nameMeaning', 'selfName', 'selfNameMeaning', 'title', 'titleMeaning'],
                    description: '要改哪一项',
                  },
                  value: { type: 'string', description: '新的值' },
                  reason: { type: 'string', description: '用户为什么要改，照他的话记' },
                },
                required: ['key', 'value', 'reason'],
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
              },
              timeoutMs: 15000,
              async execute(args) {
                const blocked = guard()
                if (blocked) return { ok: false, error: blocked.error, message: blocked.message }
                const result = applyIdentityChange(api, paths, args ?? {})
                if (result.ok) return { ok: true, applied: result.applied }
                return { ok: false, error: result.error, message: result.message }
              },
            }),
          'dsh-whale-pal: identity tool',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] whale_pal_identity 工具注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 3.6 工具：台账与节律（P4）。模型写那几本账，人那一面走 `/whale ledger`。
  // 只追加：写进去的行不改不删，例外只有「待补」那几格、以及人确认后那一条的状态格。
  if (tools && typeof tools.register === 'function' && ledger) {
    try {
      disposers.push(
        ctx.effect(
          () =>
            tools.register({
              name: 'whale_pal_ledger',
              description:
                '只追加的台账：事件（六列：时间/类型/发生了什么/当时的判断/结果/教训）、偏离、异议，外加人确认后的交接标结。action=status 看各本账多少行与还欠着什么；event 当场只写发生了什么，判断与结果/教训当时不下定论，隔天用 fill 补（fill 只换那几格，其余字节不动）。类型只有 任务/纠正/偏好/观察 四种。判断那一列抄当时原话，不美化；教训写不出具体动作就留空，系统记「无新增」。',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  action: {
                    type: 'string',
                    enum: ['status', 'preview', 'event', 'fill', 'deviation', 'dissent', 'settle'],
                    description: '要做什么',
                  },
                  type: { type: 'string', enum: ['任务', '纠正', '偏好', '观察'], description: '事件类型，只有这四种' },
                  what: { type: 'string', description: '发生了什么：一句话，写事实不写评价' },
                  judgment: { type: 'string', description: '当时的判断：抄当时原话，不美化；没定就留空，隔天用 fill 补' },
                  result: { type: 'string', description: '结果：做到了 / 没做到 / 还没定；没定就留空' },
                  lesson: { type: 'string', description: '教训：写得出下次具体改哪一步就写；写不出留空，会记「无新增」' },
                  key: { type: 'string', description: '行号，fill 与 settle 用；行号看 /whale ledger handoffs 或 fills' },
                  patch: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'fill 要换哪几格：列名照账上写，只认 当时的判断 / 结果 / 教训，例 {"教训":"先看版本再动手"}',
                  },
                  scene: { type: 'string', description: '偏离：在什么场景下' },
                  deviation: { type: 'string', description: '偏离：实际怎么偏的' },
                  reason: { type: 'string', description: '偏离：为什么偏（当时真实的理由，不是事后找的）' },
                  fix: { type: 'string', description: '偏离：下次怎么改' },
                  topic: { type: 'string', description: '异议：争的是什么' },
                  mine: { type: 'string', description: '异议：我的看法' },
                  yours: { type: 'string', description: '异议：你的看法' },
                  handling: { type: 'string', description: '异议：最后怎么处理的' },
                  settleAction: { type: 'string', enum: ['settle', 'ignore'], description: 'settle 时：标结 / 手动忽略' },
                },
                required: ['action'],
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
              },
              timeoutMs: 15000,
              async execute(args) {
                const said = args ?? {}
                const action = argText(said.action)
                if (action === 'status') return { ok: true, info: ledger.info() }
                if (action === 'preview') return { ok: true, preview: ledger.preview() }
                if (action === 'event') {
                  const done = ledger.appendEvent({
                    at: new Date().toISOString(),
                    type: argText(said.type),
                    what: argText(said.what),
                    judgment: argText(said.judgment),
                    result: argText(said.result),
                    lesson: argText(said.lesson),
                  })
                  return done.ok === true ? { ok: true, wrote: 'event' } : { ok: false, error: done.reason }
                }
                if (action === 'fill') {
                  const done = ledger.fillEvent({ key: argText(said.key), patch: said.patch ?? {} })
                  return done.ok === true ? { ok: true, filled: argText(said.key) } : { ok: false, error: done.reason }
                }
                if (action === 'deviation') {
                  const done = ledger.appendDeviation({
                    scene: argText(said.scene),
                    deviation: argText(said.deviation),
                    reason: argText(said.reason),
                    fix: argText(said.fix),
                  })
                  return done.ok === true ? { ok: true, wrote: 'deviation' } : { ok: false, error: done.reason }
                }
                if (action === 'dissent') {
                  const done = ledger.appendDissent({
                    at: new Date().toISOString(),
                    topic: argText(said.topic),
                    mine: argText(said.mine),
                    yours: argText(said.yours),
                    handling: argText(said.handling),
                  })
                  return done.ok === true ? { ok: true, wrote: 'dissent' } : { ok: false, error: done.reason }
                }
                if (action === 'settle') {
                  const done = ledger.settleHandoff({
                    key: argText(said.key),
                    action: argText(said.settleAction) === 'ignore' ? 'ignore' : 'settle',
                  })
                  return done.ok === true ? { ok: true, settled: argText(said.key) } : { ok: false, error: done.reason }
                }
                return { ok: false, error: 'bad-action' }
              },
            }),
          'dsh-whale-pal: ledger tool',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] whale_pal_ledger 工具注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 3.5 工具：六阶段处理流程的进度点
  // 状态机自己落盘，模型只能通过这个工具推它；确认那一步还要过口令，
  // 所以「对 / 好 / 嗯」这类回话在代码里就过不去，不靠提示词自觉。
  if (tools && typeof tools.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            tools.register({
              name: COPY.progressToolName,
              description:
                'Six-stage processing flow progress marker. begin opens the next stage; confirm ONLY when the user literally replied "确定stage N 阶段" matching the pending stage number (对/好/嗯/OK do not count and must be asked again); rework, abandon, defer (stage 4 only), jump back to an earlier stage, finish when all six are confirmed, land when the work actually shipped; restart opens a fresh run after the previous one landed (refused while it is still 待落地). show just reads.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  action: {
                    type: 'string',
                    enum: ['show', 'begin', 'restart', 'confirm', 'rework', 'abandon', 'defer', 'jump', 'finish', 'land'],
                    description: '要做什么',
                  },
                  token: { type: 'string', description: '用户原话，confirm 时必须原样传进来' },
                  stage: { type: 'integer', description: 'jump 回跳到第几阶段（1-6）' },
                },
                required: ['action'],
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
              },
              timeoutMs: 15000,
              async execute(args) {
                // show 只读，降级态也让人看；其余动作先过闸门。
                if ((args ?? {}).action !== 'show') {
                  const blocked = guard()
                  if (blocked) return { ok: false, error: blocked.error, message: blocked.message }
                }
                const result = runProgress(paths, args ?? {})
                return result.ok
                  ? { ok: true, marker: result.marker, stage: result.progress.stage, pending: result.progress.pending }
                  : { ok: false, error: result.error, ...(result.ask ? { ask: result.ask } : {}) }
              },
            }),
          'dsh-whale-pal: progress tool',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] whale_pal_progress 工具注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 3.6 工具：一键回滚
  // 对照阶段补出来的缺口（`融合计划-v2.md:189` 判据里的「可一键回滚」）。
  // 只认两个地方的文件：插件自己的数据目录、以及设置页填的笔记库。
  // 别的一律不碰——回滚是个能删人东西的动作，宁可拒。
  if (tools && typeof tools.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            tools.register({
              name: COPY.rollbackToolName,
              description:
                'Roll one data file back to its newest .bak backup. Use only when the user asks to undo a bad write. path must be a file under the plugin data directory or the configured note vault; anything else is refused.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', description: '要退回的文件绝对路径' },
                },
                required: ['path'],
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
              },
              timeoutMs: 15000,
              async execute(args) {
                const blocked = guard()
                if (blocked) return { ok: false, error: blocked.error, message: blocked.message }
                return runRollback(paths, args ?? {})
              },
            }),
          'dsh-whale-pal: rollback tool',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] whale_pal_rollback 工具注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 3.7 工具：健康检查
  // 和设置页那条 `/health` 读同一份报告，不各算一遍。
  if (tools && typeof tools.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            tools.register({
              name: COPY.healthToolName,
              description:
                'Report the load-and-health state: six load steps, the failure level (normal / readonly / disabled), the color (green / yellow / red), the notes behind it, and a runtime line (assessor success rate over the recent samples, memory occupancy, recent evictions). Read-only.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {},
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
              },
              timeoutMs: 15000,
              async execute() {
                return health()
              },
            }),
          'dsh-whale-pal: health tool',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] 健康检查工具注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 3.8 工具：记忆取回（第四批 §2.3）
  // 常驻只放目录（编号 + 一句主题），正文靠这个工具按需取回。
  // 为什么和 `whale_ctx` 分开：会话档案和记忆条目是两种东西，
  // 混在一个工具里，模型要读原文时得先猜「这条属于哪一种」。
  if (tools && typeof tools.register === 'function') {
    try {
      disposers.push(
        ctx.effect(
          () =>
            tools.register({
              name: COPY.memoryToolName,
              description:
                'Recall stored memories by number. The injected state only carries a short catalog (M-001 · topic); this tool is how the full text comes back. action=list lists every number with its topic (no body); action=read returns one entry in full (at most 2000 characters, truncated with a note when longer) and, when the entry records where it came from, the original sentence from the archive; action=search does a word-level search and returns matching numbers with topics (no body). Numbers are never invented: an unknown id reports not-found instead of returning the nearest match.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  action: { type: 'string', enum: ['list', 'read', 'search'], description: 'list 列编号与主题 / read 读一条正文 / search 按词找编号' },
                  id: { type: 'string', description: 'read 用的编号，形如 M-003' },
                  query: { type: 'string', description: 'search 用的词，两个字起' },
                },
                required: ['action'],
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                // read 用可读文本回（一串 JSON 里夹着转义，读起来比原文更费钱）；
                // list / search 回结构，调用方自己排版。
                render: (args, value) => {
                  if (String(args?.action ?? '') === 'read') return [{ type: 'text', text: renderRead(value) }]
                  return [{ type: 'text', text: JSON.stringify(value) }]
                },
              },
              timeoutMs: 15000,
              async execute(args = {}) {
                const action = String(args.action ?? '').trim()
                const state = api.getState()
                if (action === 'list') return listEntries(state)
                if (action === 'read') return readMemoryWithSource(state, args.id, paths)
                if (action === 'search') return searchEntries(state, args.query)
                return { ok: false, reason: 'unknown-action', message: '只有 list / read / search 三种。' }
              },
            }),
          'dsh-whale-pal: memory tool',
        ),
      )
    } catch (error) {
      log(`[dsh-whale-pal] whale_pal_memory 工具注册失败：${error?.message ?? error}`)
    }
  }

  // ---- 4. 系统提示：当前模式
  const systemPrompt = counting(service(ctx, 'systemPrompt'), 'sections', registered, 'section')
  try {
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      throw new Error('systemPrompt.section 不可用')
    }
    disposers.push(
      ctx.effect(
        () =>
          systemPrompt.section({
            name: MODE_SECTION,
            order: MODE_ORDER,
            interpolate: false,
            text: (context) => {
              // 服务每次渲染时现取：装配可能是上一轮就缓存好的，拿老引用没意义。
              const workingDirectory = service(ctx, 'workingDirectory')
              let cwd = cwdOf(context, workingDirectory)
              if (cwd === '') {
                // 装配上下文里没带会话时，退回宿主正在跑的那个 agent：
                // 投影是按 session 存的，拿到会话就读得到「现在」的目录。
                try {
                  const agents = service(ctx, 'agents')
                  const agent =
                    typeof agents?.currentInitiator === 'function' ? agents.currentInitiator() : null
                  cwd = cwdOf(agent, workingDirectory)
                } catch {
                  cwd = ''
                }
              }
              const mode = resolveMode({ config: api.getConfig(), cwd })
              return modeText({ mode })
            },
          }),
        'dsh-whale-pal: mode section',
      ),
    )
  } catch (error) {
    log(`[dsh-whale-pal] 模式段注册失败：${error?.message ?? error}`)
  }

  // ---- 5. 系统提示：进度点（没开工就不渲染，不占一行空话）
  try {
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      throw new Error('systemPrompt.section 不可用')
    }
    disposers.push(
      ctx.effect(
        () =>
          systemPrompt.section({
            name: PROGRESS_SECTION,
            order: PROGRESS_ORDER,
            interpolate: false,
            text: () => progressText(readProgress(progressFile(paths))),
          }),
        'dsh-whale-pal: progress section',
      ),
    )
  } catch (error) {
    log(`[dsh-whale-pal] 进度点段注册失败：${error?.message ?? error}`)
  }

  // ---- 6. 系统提示：锚定块
  // 档案总要有条路进上下文，不然摘要、索引、原文全躺在库里，模型一个字也看不见。
  // 这一段只放目录（≤300 字、无时间戳），改用 systemPrompt.section 而不是每步注入，
  // 所以「整个会话的 pre-step 注入次数」仍然是 0。
  try {
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      throw new Error('systemPrompt.section 不可用')
    }
    disposers.push(
      ctx.effect(
        () =>
          systemPrompt.section({
            name: ANCHOR_SECTION,
            order: ANCHOR_ORDER,
            interpolate: false,
            text: () => ctxAnchor({ api, head: COPY.ctxAnchorHead }),
          }),
        'dsh-whale-pal: anchor section',
      ),
    )
  } catch (error) {
    log(`[dsh-whale-pal] 锚定块段注册失败：${error?.message ?? error}`)
  }

  // 卸载要有人接。以前这一段只放进返回值，调用方没接，退出标记和下面这些 dispose
  // 一次都没跑过；接在 ctx.effect 上，宿主卸插件时会自己调到。
  let closed = false
  const shutdown = () => {
    if (closed) return
    closed = true
    // 正常卸载时留一笔 clean，下次启动才分得清「干净退出」和「被杀」。
    try {
      markCleanExit(paths, log)
    } catch {
      /* 退出标记写不了也不该拦住卸载 */
    }
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载失败不影响其它段 */
      }
    }
  }
  try {
    ctx.effect(() => shutdown, 'dsh-whale-pal: teardown')
  } catch (error) {
    log(`[dsh-whale-pal] 卸载钩子没挂上：${error?.message ?? error}`)
  }

  return {
    api,
    registered,
    health,
    guard,
    statusPayload: () => ({
      ...statusPayload({
        api,
        importRecord,
        projection: typeof context?.projectionStatus === 'function' ? context.projectionStatus() : 'unknown',
      }),
      picker: pickerStatus(),
      health: health(),
    }),
    handler,
    dispose: shutdown,
  }
}
