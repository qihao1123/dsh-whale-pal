/**
 * Obsidian 接入里唯一碰磁盘的一层。
 *
 * 分层理由：纯逻辑在 `lib/vault.js`，能拿假注入测「开关关着时一次都没读」；
 * 这里只负责把真 fs 套上去，审的时候只看这一个文件就知道会碰什么。
 *
 * 三条自律：
 *   1. 只 `readdir` + `stat`，不改任何文件；
 *   2. `.obsidian` / `.trash` / `.git` 一律不进（`EXCLUDED` 唯一出处）；
 *   3. 查进程只在「开着、且配置文件不在」时才做，别每次启动都去翻一遍。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { EXCLUDED, STATE, detectObsidian, hasExcludedSegment } from './vault.js'

/** Obsidian 的配置文件路径：`%APPDATA%\obsidian\obsidian.json`。 */
export function obsidianConfigPath(env = process.env) {
  const appData = env?.APPDATA ?? ''
  if (appData === '') return ''
  return join(appData, 'obsidian', 'obsidian.json')
}

/** 跑一次 tasklist 拿进程名；拿不到就回空数组，不抛、不重试。 */
function processNames() {
  try {
    // tasklist 是系统自带的，不引依赖。
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    })
    return out
      .split(/\r?\n/u)
      .map((line) => line.split(',')[0]?.replace(/^"|"$/gu, '') ?? '')
      .filter((name) => name !== '')
  } catch {
    return []
  }
}

/** 真机检测：把 `detectObsidian` 需要的三样接上真实现。 */
export function detectOnDisk({ enabled = false, env = process.env } = {}) {
  const configFile = obsidianConfigPath(env)
  return detectObsidian({
    enabled,
    configFile,
    fileExists: (path) => existsSync(path),
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    },
    // 只有开着、且配置不在时，detectObsidian 才会调它。
    processes: () => (enabled === true ? processNames() : []),
  })
}

/**
 * 列库里要管的笔记（vault 相对路径，正斜杠）。
 *
 * 不跟符号链接（避免绕出库外），不进排除目录，排序固定便于断言与比对。
 */
export function listVaultNotes(vaultPath, options = {}) {
  const root = typeof vaultPath === 'string' ? vaultPath.trim() : ''
  if (root === '') return { ok: false, error: 'vaultPath-required', notes: [] }
  if (existsSync(root) !== true) return { ok: false, error: 'vault-missing', notes: [] }

  // 数据目录原则上不放在库内；真放进去了，就不能把自己的 json 当笔记列出来。
  const excluded = new Set()
  const rawExcludes = Array.isArray(options?.excludePaths) ? options.excludePaths : []
  for (const item of rawExcludes) {
    const value = typeof item === 'string' ? item.trim() : ''
    if (value !== '') excluded.add(resolve(value))
  }
  const blocked = (dir) => excluded.has(resolve(dir))

  const notes = []
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (EXCLUDED.includes(entry.name)) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const child = join(dir, entry.name)
        if (blocked(child)) continue
        walk(child, rel)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) notes.push(rel)
    }
  }
  walk(root, '')
  notes.sort()
  return { ok: true, notes }
}

/**
 * 一棵树的「指纹」：相对路径 → `mtimeMs:size`。
 *
 * 只用来证明「没碰过」，不参与任何业务判断。
 */
export function treePrint(root) {
  const out = {}
  const walk = (dir, prefix) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel)
        continue
      }
      try {
        const stat = statSync(join(dir, entry.name))
        out[rel] = `${stat.mtimeMs}:${stat.size}`
      } catch {
        out[rel] = 'gone'
      }
    }
  }
  walk(root, '')
  return out
}

/**
 * 库就绪检查：`vaultPath` 有值、目录在、不是被排除的路径。
 *
 * 依赖库的功能（深链、扫描、写笔记）统一先过这一关；
 * 不过关就回一句人话，别让上层自己拼错误文案。
 */
export function vaultReady(config) {
  const path = typeof config?.knowledge?.vaultPath === 'string' ? config.knowledge.vaultPath.trim() : ''
  if (path === '') return { ok: false, error: 'vaultPath-required', message: '还没填笔记库路径，库相关的事都做不了' }
  if (hasExcludedSegment(path) === false && existsSync(path) !== true) {
    return { ok: false, error: 'vault-missing', message: '这个目录现在不在了，库相关的事都做不了' }
  }
  return { ok: true, path }
}

export { STATE }
