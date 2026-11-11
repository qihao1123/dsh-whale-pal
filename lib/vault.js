/**
 * Obsidian 接入：只放纯逻辑，不碰磁盘。
 *
 * 口径来自 `融合计划-v2.md`：
 *   - `:273` 开关关着时不读 `obsidian.json`、不探 `.obsidian/`、不查进程；
 *   - `:342` 启动只做一次「是否装过」的轻判断（读一个注册表值或文件存在性即可），只提示一次；
 *   - `:327` 路径一律 vault 相对路径，深链里对库名与路径做 URL 编码；
 *   - `:332` `.obsidian/`、`.trash/`、`workspace.json` 一律黑盒。
 *
 * 「装没装」和「有哪些库」是两件事，分两个状态回答：
 *   - 关着：只 `stat` 配置在不在，回 `installed` / `absent`，不解析一个字；
 *   - 开着：解析 `vaults`，回 `ready` / `installed-no-vault` / `running-no-config` / `absent`。
 *
 * 注意 `obsidian.json` 的形状：`{vaults: {"<随机id>": {path, ts, open}}}`——
 * 是对象不是数组，按 `ts` 倒序才是「最近的库」。
 */

/** 永远不读、不写、不备份、不计数的目录（唯一出处，别处一律引用这里）。 */
export const EXCLUDED = Object.freeze(['.obsidian', '.trash', '.git'])

export const STATE = Object.freeze({
  /** 开关关着，但机器上确实装过 Obsidian。 */
  INSTALLED: 'installed',
  /** 开着，库列表拿到了。 */
  READY: 'ready',
  /** 开着，配置在但没有库。 */
  INSTALLED_NO_VAULT: 'installed-no-vault',
  /** 开着，配置不见了但进程活着——异常态，不是「装过三形态」之一。 */
  RUNNING_NO_CONFIG: 'running-no-config',
  /** 没装。 */
  ABSENT: 'absent',
})

/** 默认库名（`:271`：只用于显示与深链，改名字不动文件路径）。 */
export const DEFAULT_VAULT_NAME = '记忆空间'

/**
 * 解析 `obsidian.json` 的文本。
 *
 * 坏 JSON、缺字段、vaults 不是对象——一律当「没有库」，不抛。
 * 别人的配置文件，读不懂就是读不懂，不该让整个插件崩。
 */
export function parseObsidianConfig(text) {
  let data
  try {
    data = JSON.parse(String(text ?? ''))
  } catch {
    return { vaults: [] }
  }
  const raw = data && typeof data === 'object' ? data.vaults : null
  if (!raw || typeof raw !== 'object') return { vaults: [] }
  const vaults = []
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue
    const path = typeof value.path === 'string' ? value.path.trim() : ''
    if (path === '') continue
    vaults.push({
      id,
      path,
      ts: Number(value.ts) || 0,
      open: value.open === true,
    })
  }
  vaults.sort((a, b) => b.ts - a.ts)
  return { vaults }
}

/**
 * 判断装没装、库在哪。
 *
 * deps 全部注入，测试不碰真机：
 *   - `enabled` 开关现值；
 *   - `configFile` 配置文件路径（仅作参数，本函数不拼路径）；
 *   - `fileExists(path)` 只问在不在；
 *   - `readText(path)` 读文本（**只有开着时才会被调用**）；
 *   - `processes()` 回进程名列表（**只有开着且配置缺失时才调用**）。
 */
export function detectObsidian(deps = {}) {
  const {
    enabled = false,
    configFile = '',
    fileExists = () => false,
    readText = () => '',
    processes = () => [],
  } = deps

  const present = configFile !== '' && fileExists(configFile) === true

  if (enabled !== true) {
    // 关着：只回答「装过没装过」，一个字节都不解析。
    return { state: present ? STATE.INSTALLED : STATE.ABSENT, vaults: [], source: 'existence' }
  }

  if (present) {
    const { vaults } = parseObsidianConfig(readText(configFile))
    return {
      state: vaults.length > 0 ? STATE.READY : STATE.INSTALLED_NO_VAULT,
      vaults,
      source: 'config',
    }
  }

  const running = asList(processes()).some((name) => String(name).toLowerCase().includes('obsidian'))
  return { state: running ? STATE.RUNNING_NO_CONFIG : STATE.ABSENT, vaults: [], source: running ? 'process' : 'none' }
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

/** 设置页填的库路径可用吗。空就是不可用——依赖库的功能一律停在这里。 */
export function resolveVault(config) {
  const path = config && typeof config === 'object' ? config?.knowledge?.vaultPath : ''
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (trimmed === '') return { ok: false, error: 'vaultPath-required' }
  return { ok: true, path: trimmed }
}

/** 一个名字该不该跳过。 */
export function isExcluded(name) {
  return EXCLUDED.includes(String(name))
}

/** 这条相对路径里有没有被排除的段（`.obsidian/x/y.md` 这种）。 */
export function hasExcludedSegment(relPath) {
  return String(relPath ?? '')
    .split(/[\\/]+/u)
    .some((part) => isExcluded(part))
}

/**
 * 拼深链：`obsidian://open?vault=<库名>&file=<相对路径>`。
 *
 * `file` 用 vault 相对路径、不带 `.md`（Obsidian 自己认扩展名），
 * 两端都做 URL 编码（`:327`）。路径为空就回空串，让调用方去说「没库」。
 */
export function deepLink({ vaultName = '', relPath = '' } = {}) {
  const rel = String(relPath ?? '')
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+/u, '')
    .replace(/\.md$/iu, '')
  if (rel === '') return ''
  const vault = String(vaultName ?? '').trim() || DEFAULT_VAULT_NAME
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(rel)}`
}

/** 状态给人看的一句话。空态照实说，不美化。 */
export function describeState(state) {
  switch (state) {
    case STATE.READY:
      return '接上了'
    case STATE.INSTALLED:
      return '装过 Obsidian，还没打开开关'
    case STATE.INSTALLED_NO_VAULT:
      return '装了 Obsidian，里面还没有库'
    case STATE.RUNNING_NO_CONFIG:
      return 'Obsidian 在跑，但找不到它的配置文件'
    case STATE.ABSENT:
      return '这台机器上没找到 Obsidian'
    default:
      return '还没判过'
  }
}
