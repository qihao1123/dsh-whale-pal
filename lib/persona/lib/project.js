/**
 * 项目认定（记忆分层 P1）：会话目录属于哪个项目。
 *
 * 口径照方案 §2.2，四条：
 *   1. 默认一个工作目录就是一个项目，名字取目录名，可改；
 *   2. 子目录不算新项目：往上找最近的「这是个项目」的标记，找到就归那个项目；
 *   3. 手动合并：设置里把若干目录指定成同一个项目（`scenes.projects[].dirs`）；
 *   4. 备份和临时目录不单独建池，并到被备份的那个项目；认不出来就只在主人层留。
 *
 * 判定结果必须当场可见（P4 的界面），所以这里把 `via` 一起带出去：
 * manual / marker / cwd / backup / unresolved——「为什么归到这里」不该是黑箱。
 *
 * 纯逻辑 + 一个可注入的 `exists`：测试不用碰真盘，也不会因为本机目录结构不同而飘。
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'

import { projectScene } from './scene.js'

/** 往上找的「这是个项目」的标记。只看存在，不读内容。 */
export const PROJECT_MARKERS = Object.freeze([
  '.git',
  '.hg',
  '.svn',
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
])

/** 名字像这些的目录不当项目：备份、副本、归档、临时产物。 */
const BACKUP_PATTERN = /(^|[._\-\s])(bak|backup|backups|copy|tmp|temp|old|archive|trash)([._\-\s]|$)|备份|副本|归档|临时/u

/** 往上最多找几层。够深了，也防脏数据绕圈。 */
const MAX_DEPTH = 24

/** 项目清单的硬上限，和 scene.js 的 SCENES.projects 对齐。 */
const MAX_PROJECTS = 50

export function isBackupDir(name) {
  return BACKUP_PATTERN.test(String(name ?? '').trim())
}

/** 目录相等，或者 child 在 parent 底下。Windows 不分大小写，其余平台照原样比。 */
export function isWithin(parent, child, caseInsensitive = process.platform === 'win32') {
  const fold = (value) => {
    const text = normalize(String(value ?? '')).replace(/[\\/]+$/u, '')
    return caseInsensitive ? text.toLowerCase() : text
  }
  const p = fold(parent)
  const c = fold(child)
  if (p === '' || c === '') return false
  if (p === c) return true
  const sep = /[\\/]/u
  for (let i = 0; i < c.length; i += 1) {
    if (!sep.test(c[i])) continue
    if (c.slice(0, i) === p) return true
  }
  return false
}

/**
 * 判定 cwd 属于哪个项目。
 *
 * @param {string} cwd 会话目录
 * @param {object} options
 * @param {{projects?: Array}} [options.scenes] 场景树（手动映射靠它）
 * @param {(path: string) => boolean} [options.exists] 判断标记存在；测试可注入
 * @param {string[]} [options.markers]
 * @param {boolean} [options.caseInsensitive]
 * @param {number} [options.maxDepth]
 * @returns {{scene: string|null, name: string, dir: string, via: string}}
 *          scene 为 null 表示认不出来——调用方落主人层，不许默默建池。
 */
export function detectProjectScene(cwd, options = {}) {
  const {
    scenes = null,
    exists = existsSync,
    markers = PROJECT_MARKERS,
    caseInsensitive = process.platform === 'win32',
    maxDepth = MAX_DEPTH,
  } = options

  const start = normalize(String(cwd ?? '').trim())
  if (start === '' || start === '.') return { scene: null, name: '', dir: '', via: 'unresolved' }

  // 1. 手动合并：最长的那条映射赢（主力目录和子目录都写在一起时，挑更具体的）。
  const manual = manualProject(scenes, start, caseInsensitive)
  if (manual) {
    return { scene: manual.project.id, name: manual.project.name, dir: manual.dir, via: 'manual' }
  }

  // 2. 往上找标记。备份/临时目录跳过，记为「被备份的那个项目」的候选。
  let current = start
  let backupParent = ''
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const base = basename(current)
    if (isBackupDir(base)) {
      const up = dirname(current)
      if (up === current) break
      if (backupParent === '') backupParent = up
      current = up
      continue
    }
    if (hasMarker(current, exists, markers)) {
      const name = basename(current) || current
      return { scene: projectScene(name), name, dir: current, via: 'marker' }
    }
    const up = dirname(current)
    if (up === current) break
    current = up
  }

  // 3. 备份目录退回去：并到它被备份的那个项目，不新建池。
  if (backupParent !== '' && basename(backupParent) !== '') {
    const name = basename(backupParent)
    return { scene: projectScene(name), name, dir: backupParent, via: 'backup' }
  }

  // 4. 没有标记，也不是备份目录：当前目录自己就是一个项目。
  const name = basename(start)
  if (name === '') return { scene: null, name: '', dir: start, via: 'unresolved' }
  return { scene: projectScene(name), name, dir: start, via: 'cwd' }
}

function hasMarker(dir, exists, markers) {
  for (const marker of markers) {
    try {
      if (exists(join(dir, marker))) return true
    } catch {
      /* 读不了就当没有 */
    }
  }
  return false
}

/** 在手动映射里找包含 cwd 的最长目录。 */
function manualProject(scenes, cwd, caseInsensitive) {
  const projects = Array.isArray(scenes?.projects) ? scenes.projects : []
  let best = null
  for (const project of projects) {
    for (const dir of Array.isArray(project?.dirs) ? project.dirs : []) {
      if (!isWithin(dir, cwd, caseInsensitive)) continue
      if (!best || dir.length > best.dir.length) best = { project, dir }
    }
  }
  return best
}

/** 稳定短哈希：同名项目分在不同目录时，用它把 id 分开。 */
function shortHash(text) {
  let hash = 5381
  const value = String(text ?? '')
  for (let i = 0; i < value.length; i += 1) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0
  return hash.toString(36).slice(0, 4)
}

/**
 * 把认定的项目写进场景树：已经有的复用，没有的建一个。
 *
 * 返回项目节点；建不出来返回 null（清单满了、目录名空了），调用方落主人层。
 * 已存在的节点不因为这条路径「更浅」就被改写——项目根一旦定下，全靠手动改。
 */
export function ensureProjectScene(scenes, project, now = Date.now(), caseInsensitive = process.platform === 'win32') {
  if (!scenes || typeof scenes !== 'object') return null
  const dir = normalize(String(project?.dir ?? '').trim())
  const name = String(project?.name ?? '').trim() || basename(dir)
  if (dir === '' || name === '') return null
  const list = Array.isArray(scenes.projects) ? scenes.projects : (scenes.projects = [])
  for (const item of list) {
    for (const known of Array.isArray(item?.dirs) ? item.dirs : []) {
      if (isWithin(known, dir, caseInsensitive)) return item
    }
  }
  if (list.length >= MAX_PROJECTS) return null
  let id = projectScene(name)
  if (id === '') return null
  if (list.some((item) => item?.id === id)) id = `${id}-${shortHash(dir)}`
  const node = {
    id,
    name,
    dirs: [dir],
    // 「名字可改」：界面用的开关，改场景名不动 id。
    editable: true,
    createdAt: Number(now) || Date.now(),
    updatedAt: Number(now) || Date.now(),
  }
  list.push(node)
  return node
}
