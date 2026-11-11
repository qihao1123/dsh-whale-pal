/**
 * 落盘层：路径、原子写、进程内串行锁、快照与审计。
 *
 * 为什么自己写而不是用宿主存储：人格状态需要人类能直接打开看、能导出、能
 * 在插件坏掉时手工修。纯 JSON + JSONL 是最不容易失联的格式。
 *
 * 写入一律「临时文件 + rename」，避免半截文件把下次启动带进死循环。
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const SNAPSHOT_KEEP = 20

/**
 * 认出当前 profile 名。
 *
 * 宿主进程本身没有 DSH_PROFILE（那是给工具子进程注入的），所以按可信度排队：
 * 显式配置 → DSH_PROFILE → DSH_PROFILE_DIR → argv 或 cwd 里的 .../profiles/<name>
 * → 最后才退回 'default'（单 profile 环境下无害，但多 profile 会共用一份状态）。
 */
export function detectProfile(deps = {}) {
  const env = deps.env ?? process.env
  const direct = env.DSH_PROFILE
  if (direct) return String(direct)
  const fromDir = env.DSH_PROFILE_DIR
  if (fromDir) {
    const base = basename(String(fromDir))
    if (base) return base
  }
  const argv = deps.argv ?? process.argv
  const cwd = deps.cwd ?? process.cwd()
  const candidates = [cwd, ...(Array.isArray(argv) ? argv : [])]
  for (const value of candidates) {
    const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]?$/.exec(String(value ?? ''))
    if (match && match[1]) return match[1]
  }
  return 'default'
}

/**
 * 依赖两个环境事实，都可被插件 config 覆盖：
 *   home    —— 配置根（DSH_HOME，桌面版是 ~/.dsh）
 *   profile —— 当前 profile 名（桌面版是 desktop）
 * 每个 profile 一份人格状态：跨工作区连续，但不同 profile 互不污染。
 */
export function resolvePaths(pluginConfig = {}) {
  const home = pluginConfig.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = pluginConfig.profile || detectProfile()
  const root = pluginConfig.personaDir || join(home, 'persona-framework', profile)
  return {
    home,
    profile,
    root,
    config: join(root, 'config.json'),
    state: join(root, 'state.json'),
    audit: join(root, 'audit.jsonl'),
    snapshots: join(root, 'snapshots'),
    exports: join(root, 'exports'),
  }
}

export function ensureLayout(paths) {
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.snapshots, { recursive: true })
  mkdirSync(paths.exports, { recursive: true })
}

export function readJsonFile(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function appendJsonLine(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

export function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 审计日志超过阈值就轮转一次，只留最近一份旧档。 */
export function rotateIfNeeded(file, maxBytes = 4 * 1024 * 1024) {
  try {
    if (fileSize(file) < maxBytes) return false
    const backup = `${file}.1`
    if (existsSync(backup)) unlinkSync(backup)
    copyFileSync(file, backup)
    writeFileSync(file, '', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 写入前留一个状态快照。快照是「回滚点」：设置页可以退回到任意一页。
 */
export function saveSnapshot(paths, state, { keep = SNAPSHOT_KEEP } = {}) {
  try {
    ensureLayout(paths)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(paths.snapshots, `${stamp}.json`)
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
    const files = readdirSync(paths.snapshots)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      try {
        unlinkSync(join(paths.snapshots, name))
      } catch {
        /* 单个删不掉不影响主流程 */
      }
    }
    return file
  } catch {
    return null
  }
}

export function listSnapshots(paths) {
  try {
    return readdirSync(paths.snapshots)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export function readSnapshot(paths, name) {
  // 只接受我们自己生成的文件名，防止路径穿越。
  if (typeof name !== 'string' || !/^[0-9A-Za-z._-]+\.json$/.test(name)) return null
  return readJsonFile(join(paths.snapshots, name), null)
}

/**
 * 进程内串行锁：同一 key 的任务排队执行。
 * 不是跨进程锁——桌面版单一宿主进程足够；跨进程写同一文件本来就是配置错误。
 */
const queues = new Map()

export function withLock(key, task) {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}
