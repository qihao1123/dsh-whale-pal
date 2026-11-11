/**
 * 装载与健康：六步读回、三级失败态、三色。
 *
 * 口径来自 `融合计划-v2.md` §19：
 *   - §19.2 装载六步，每步都要读回，不靠「应该没问题」；
 *   - §19.3 三级失败态，顺序是「能只读就不要停用，能不阻断就不要阻断」；
 *   - §19.4 三色，坏哪块禁哪块，别把小事放大成插件挂了；
 *   - 不变量 17：装载任一步失败不得阻断 DSH 启动。
 *
 * 与计划的三处偏差，写在这里而不是藏着：
 *   1. 没有 SQLite，第 4 步的 `PRAGMA integrity_check` 换成「JSON 能解析 + 版本认得」；
 *   2. 没有 `sessions/`，数据目录就是 config/state/progress + snapshots + 备份；
 *   3. 第 5 步的「日志有自有标记」在当前宿主上不可事后核对（宿主不落盘），只保证打一行。
 *
 * 本文件不 import 人格内核的任何写函数：它只读、只判断、只报告。
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeExtras } from './settings.js'

/** 我们认识的配置 schema 版本。读到更大的版本不猜，直接降级。 */
export const SCHEMA_VERSION = 1

/** 新装后的只读复核窗口：72 小时（§19.6 第 2 条）。 */
export const GRACE_MS = 72 * 60 * 60 * 1000

export const LEVEL = Object.freeze({
  NORMAL: 'normal',
  READONLY: 'readonly',
  DISABLED: 'disabled',
})

export const COLOR = Object.freeze({
  GREEN: 'green',
  YELLOW: 'yellow',
  RED: 'red',
})

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 插件自己的版本号：从 package.json 读，读不到就说读不到。 */
export function packageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 数据目录里最新的一个备份时间，用来当「什么时候装的」的近似值。 */
export function installedAt(paths) {
  const root = paths?.root
  if (!root) return null
  const stamps = []
  for (const name of safeList(root)) {
    const match = /\.bak-(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/u.exec(name)
    if (match) stamps.push(match[1])
  }
  for (const file of [paths.state, paths.config]) {
    if (!file || existsSync(file) !== true) continue
    try {
      stamps.push(new Date(statSync(file).mtimeMs).toISOString())
    } catch {
      // 读不到时间就不算，不编。
    }
  }
  if (stamps.length === 0) return null
  stamps.sort()
  return stamps[0]
}

function safeList(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 六步读回。
 *
 * `registered` 是 `registerSurface` 实际挂上的数量——不写死数字，
 * 免得以后加一个工具就挂一条测试。
 */
export function loadSteps({ paths, registered = null, log = () => {} } = {}) {
  const steps = []

  // 1. 包能解析、版本读得出
  const version = packageVersion()
  steps.push({
    id: 'package',
    ok: version !== '',
    detail: version === '' ? '读不出自己的版本号' : `v${version}`,
  })

  // 2. 配置能读能校验，schema 版本认识
  let config = {}
  let configOk = false
  let configDetail = ''
  if (!paths?.config) {
    configDetail = '没有配置路径'
  } else if (existsSync(paths.config) !== true) {
    // 配置文件不存在是「全新安装」，不是坏；按空配置继续。
    configOk = true
    configDetail = '还没有配置文件，按空配置启动'
  } else {
    const read = readJson(paths.config)
    if (!read.ok) {
      configDetail = `配置读不出来：${read.error}`
    } else if (!read.value || typeof read.value !== 'object') {
      configDetail = '配置不是对象'
    } else {
      config = read.value
      const declared = Number(config.schemaVersion)
      if (Number.isFinite(declared) && declared > SCHEMA_VERSION) {
        configDetail = `配置版本 ${declared} 比认识的 ${SCHEMA_VERSION} 新，不猜`
      } else {
        configOk = true
        configDetail = declared ? `v${declared}` : `v${SCHEMA_VERSION}（没写版本，按当前算）`
        try {
          normalizeExtras(config)
        } catch (error) {
          configOk = false
          configDetail = `配置字段校验失败：${String(error?.message ?? error)}`
        }
      }
    }
  }
  steps.push({ id: 'config', ok: configOk, detail: configDetail })

  // 3. 数据目录真能写：写一个探针、读回来、再删
  let dataOk = false
  let dataDetail = ''
  // 老调用方只给 config/state 两个路径：数据目录就是放它们的那一层。
  const root = paths?.root || (paths?.config ? dirname(paths.config) : '')
  if (!root) {
    dataDetail = '没有数据目录'
  } else {
    const probe = join(root, `.probe-${process.pid}`)
    try {
      // 数据目录本来就该由我们建：全新安装时它还不存在，不能因此判「写不了」。
      mkdirSync(dirname(probe), { recursive: true })
      writeFileSync(probe, 'ok', 'utf8')
      const back = readFileSync(probe, 'utf8')
      dataOk = back === 'ok'
      dataDetail = dataOk ? '写得进也读得回' : '写进去读回来不一样'
    } catch (error) {
      dataDetail = `数据目录写不了：${String(error?.message ?? error)}`
    } finally {
      // 探针必须清掉，不管前面成没成。
      try {
        if (existsSync(probe)) rmSync(probe, { force: true })
      } catch {
        dataDetail += '（探针没删掉）'
      }
    }
  }
  steps.push({ id: 'data', ok: dataOk, detail: dataDetail })

  // 3.5 笔记库所在的盘能不能写：不能写就该少做事，但整个插件不用停。
  // 只 stat/access，绝不往库里写东西——「.obsidian/ 零写入」这条比探针证据更要紧。
  let vaultOk = true
  let vaultDetail = ''
  const vaultPath = typeof config?.knowledge?.vaultPath === 'string' ? config.knowledge.vaultPath.trim() : ''
  if (vaultPath === '') {
    vaultDetail = '还没选笔记库，跳过'
  } else if (existsSync(vaultPath) !== true) {
    vaultOk = false
    vaultDetail = `笔记库目录不在了：${vaultPath}`
  } else {
    try {
      accessSync(vaultPath, constants.W_OK)
      vaultDetail = '笔记库目录写得进'
    } catch {
      vaultOk = false
      vaultDetail = `笔记库目录写不了：${vaultPath}`
    }
  }
  steps.push({ id: 'vault', ok: vaultOk, detail: vaultDetail })

  // 4. 状态能解析、版本认得（对应计划里的「库能开」）
  let stateOk = false
  let stateDetail = ''
  if (!paths?.state) {
    // 调用方没给状态路径：没有东西可解析，按空状态启动，不算故障。
    stateOk = true
    stateDetail = '没有状态路径，按空状态启动'
  } else if (existsSync(paths.state) !== true) {
    stateOk = true
    stateDetail = '还没有状态文件，按空状态启动'
  } else {
    const read = readJson(paths.state)
    if (!read.ok) {
      stateDetail = `状态读不出来：${read.error}`
    } else if (!read.value || typeof read.value !== 'object') {
      stateDetail = '状态不是对象'
    } else {
      const revision = read.value.revision
      const declared = Number(read.value.schemaVersion)
      if (revision !== undefined && !Number.isFinite(Number(revision))) {
        stateDetail = '状态的 revision 不是数字'
      } else if (Number.isFinite(declared) && declared > SCHEMA_VERSION) {
        stateDetail = `状态版本 ${declared} 比认识的 ${SCHEMA_VERSION} 新，不猜`
      } else {
        stateOk = true
        stateDetail = `revision ${Number(revision) || 0}`
      }
    }
  }
  steps.push({ id: 'state', ok: stateOk, detail: stateDetail })

  // 5. 挂载确认：自己数实际注册了多少，不写死
  const counts = registered ?? null
  const mountedOk = counts !== null
  steps.push({
    id: 'mounted',
    ok: mountedOk,
    detail: mountedOk
      ? `routes ${counts.routes} · commands ${counts.commands} · tools ${counts.tools} · sections ${counts.sections}` +
        (Array.isArray(counts.warnings) && counts.warnings.length > 0
          ? ` · 没挂上：${counts.warnings.join('；')}`
          : '')
      : '没拿到注册数量',
  })

  // 6. 自检：把上面五项与上次退出标记合成一行，不再重复检查
  const last = readRunState(paths)
  const exitDetail =
    last === null
      ? '首次启动，没有上次退出记录'
      : last.status === 'clean'
        ? `上次正常退出（${last.at}）`
        : `上次没干净退出（${last.at ?? '时间不明'}），能自愈，只记录`
  const allOk = steps.every((step) => step.ok)
  steps.push({
    id: 'selftest',
    ok: allOk,
    detail: `${allOk ? '五项都过' : '有项没过'} · ${exitDetail}`,
  })

  return steps
}

/** 读上次退出标记：文件不存在 = 首次；存在但状态不是 clean = 上次不干净。 */
export function readRunState(paths) {
  const file = paths?.runState
  if (!file || existsSync(file) !== true) return null
  const read = readJson(file)
  if (!read.ok || !read.value || typeof read.value !== 'object') return null
  return {
    status: typeof read.value.status === 'string' ? read.value.status : 'unknown',
    at: typeof read.value.at === 'string' ? read.value.at : null,
    pid: Number(read.value.pid) || null,
  }
}

/** 退出时写一笔 clean。启动时不写 running——启动只读，别每次开都落盘。 */
export function markCleanExit(paths, log = () => {}) {
  const file = paths?.runState
  if (!file) return false
  try {
    writeFileSync(file, JSON.stringify({ status: 'clean', at: new Date().toISOString(), pid: process.pid }), 'utf8')
    return true
  } catch (error) {
    log(`[dsh-whale-pal] 退出标记没写成功：${error?.message ?? error}`)
    return false
  }
}

/**
 * 72 小时只读复核窗口。
 *
 * 新装（数据目录里没有更早的东西）才开窗；窗口内不写知识库。
 * 现在还没有写知识库的功能，这里先把闸门立好，不谎报「已经生效在拦东西」。
 */
export function graceWindow(paths, now = Date.now()) {
  const since = installedAt(paths)
  if (since === null) return { active: false, installedAt: null, readOnlyUntil: null }
  const start = Date.parse(since)
  if (!Number.isFinite(start)) return { active: false, installedAt: null, readOnlyUntil: null }
  const until = start + GRACE_MS
  return {
    active: now < until,
    installedAt: new Date(start).toISOString(),
    readOnlyUntil: new Date(until).toISOString(),
  }
}

/**
 * 合成三级状态与三色。
 *
 * 红：配置/状态读不出来（停写保读）；只有连读都做不到才进停用。
 * 黄：数据目录写不了、配置版本不认识（禁相关功能，其余照常）。
 * 绿：上次退出不干净、探针残留（只记录）。
 */
export function classify(steps, { grace = null } = {}) {
  const by = Object.fromEntries(steps.map((step) => [step.id, step]))
  const notes = []

  const configBad = by.config?.ok === false
  const stateBad = by.state?.ok === false
  const dataBad = by.data?.ok === false
  const vaultBad = by.vault?.ok === false
  // 挂载对不上就是根本没挂上，这时候说「正常」是骗人。
  const mountedBad = by.mounted !== undefined && by.mounted.ok === false

  if (configBad || stateBad || mountedBad) {
    // 读都读不动，只读也没意义——但文件一个字节都不动，交给人处理。
    return {
      state: LEVEL.DISABLED,
      color: COLOR.RED,
      notes: [
        configBad ? by.config.detail : '',
        stateBad ? by.state.detail : '',
        mountedBad ? by.mounted.detail : '',
      ].filter(Boolean),
      grace,
    }
  }

  if (dataBad || vaultBad) {
    if (dataBad) notes.push(by.data.detail)
    // 库写不了只是「库相关的事做不了」，别把整个插件降级。
    if (vaultBad) notes.push(by.vault.detail)
    return { state: LEVEL.READONLY, color: COLOR.YELLOW, notes, grace }
  }

  const selftest = by.selftest?.detail ?? ''
  if (selftest.includes('上次没干净退出')) notes.push('上次没干净退出，能自愈')
  if (by.data?.detail?.includes('探针没删掉')) notes.push('探针残留')

  return { state: LEVEL.NORMAL, color: COLOR.GREEN, notes, grace }
}

/** 一次算完，给 `/health` 和工具共用同一份结果。 */
export function loadReport({ paths, registered = null, log = () => {}, now = Date.now() } = {}) {
  const steps = loadSteps({ paths, registered, log })
  const grace = graceWindow(paths, now)
  const verdict = classify(steps, { grace })
  const version = packageVersion()
  if (version !== '') log(`[whale-pal] mounted v${version}`)
  return {
    ok: verdict.state === LEVEL.NORMAL,
    state: verdict.state,
    color: verdict.color,
    notes: verdict.notes,
    steps,
    grace,
    version,
  }
}

/** 数据目录若落在笔记库里，列笔记时要排掉它。 */
export function dataDirInsideVault(paths, vaultPath) {
  if (!paths?.root || !vaultPath) return false
  const root = resolve(paths.root)
  const vault = resolve(vaultPath)
  return root === vault || root.startsWith(`${vault}\\`) || root.startsWith(`${vault}/`)
}
