/**
 * 两种模式（融合计划 §14；2026-11-10 改成按会话目录定）。
 *
 * 模式不是语体开关，是**主次排序**：人格表达和任务准确性，谁给谁让路。
 *   助手模式：任务准确性在前，人格表达让路 —— 可以收着性子，不能不准。
 *   鲸鲸模式：人格表达在前，任务准确性让路 —— 让的是形式和效率，不是事实。
 *
 * 两件事**任何模式都不参与排序、都不让路**：
 *   1. 门禁与确认口令按字面判 —— 「对 / 好 / 嗯」在鲸鲸模式下也不算通过；
 *   2. 事实、校验、安全 —— 个性化只作用于形式，不作用于判断。
 *
 * 模式从哪来：两条来路，都不存在「全局开关」。
 *   1. 新会话起手在模式选择里挑了「鲸鲸」预设 —— 那是明示，优先；
 *   2. 否则只看会话 cwd：列在 `config.whaleWorkspaces` 里的目录走鲸鲸。
 * 全局默认与会话级覆盖这两层已经删掉 —— 它们正是
 * 「在 A 会话切一下、B 会话跟着变」的来源。
 */
import { COPY } from './copy.js'
import { DEFAULT_MODE, MODES, normalizeExtras, workspaceKey } from './settings.js'

/** 鲸鲸工作区在工作区名前面挂的标；解绑时剥掉。 */
export const WHALE_TAG = '【鲸鲸】'

/** 这个 cwd 是不是鲸鲸工作区。空 cwd（还读不到会话目录）一律不是。 */
export function isWhaleWorkspace(config, cwd) {
  const key = workspaceKey(cwd)
  if (key === '') return false
  const list = normalizeExtras(config).whaleWorkspaces
  return list.some((item) => workspaceKey(item) === key)
}

/** 模式选择区里那个预设的 id：新会话起手挑它，就是鲸鲸。 */
export const WHALE_PRESET = 'whale'

/**
 * 一个会话该走哪个模式。
 *
 * 两条来路：
 *   1. 新会话起手选了鲸鲸预设 —— 这是明示，优先；
 *   2. 否则看目录在不在鲸鲸名单里。
 * 预设不要求目录也在名单里：在项目目录里挑鲸鲸，就是这一回要聊天。
 * 反过来，没挑预设的会话仍旧只看目录，行为和以前一样。
 */
export function resolveMode({ config, cwd, preset } = {}) {
  if (String(preset ?? '').trim() === WHALE_PRESET) return 'whale'
  return isWhaleWorkspace(config, cwd) ? 'whale' : DEFAULT_MODE
}

/** 把 cwd 加进/移出鲸鲸名单，返回新名单（不改入参）。 */
export function setWhaleWorkspace(list, cwd, whale) {
  const key = workspaceKey(cwd)
  const path = String(cwd ?? '').trim()
  const rest = (Array.isArray(list) ? list : []).filter((item) => workspaceKey(item) !== key)
  if (whale !== true) return rest
  if (key === '') return rest
  return [...rest, path]
}

/** 工作区名加/剥标记。先剥再加，人手动改过的名字也不会越叠越长。 */
export function taggedTitle(title, whale) {
  const bare = String(title ?? '').replace(/^【鲸鲸】\s*/u, '').trim()
  return whale === true ? `${WHALE_TAG}${bare}` : bare
}

export function modeLabel(mode) {
  return mode === 'whale' ? COPY.modeWhale : COPY.modeAssistant
}

/**
 * 系统提示里那一段：当前模式 + 这一模式的主次排序 + 两条不参与排序的规矩。
 * 这里只定主次，不定语气 —— 怎么说话属于人格卡，插件没权替它决定。
 * 这段话是给模型的指令，不是给用户看的文案。
 */
export function modeText({ mode } = {}) {
  const current = MODES.includes(mode) ? mode : DEFAULT_MODE
  // 常驻预算≤500字：只留主次和硬规矩，不复述命令说明，不写语气。
  const lines = [`【模式】${modeLabel(current)}`]
  if (current === 'whale') {
    lines.push(
      '- 主次：人格表达在前，任务准确性在后。两者冲突时形式让路——宁可多说一句、多问一句，也不为了效率换成客服腔把活干完。',
    )
  } else {
    lines.push(
      '- 主次：任务准确性在前，人格表达在后。要准的是事实、结论和取舍；语气、态度、称呼、情绪不归这条管，照旧。',
      '- 这两样不冲突：话讲清楚了，照样按你自己的说法说；讲不清楚才算让路，说话变客气不算。',
    )
  }
  lines.push(
    '- 门禁与确认口令按字面判：「对 / 好 / 嗯」这类不构成确认。',
    '- 事实、校验、安全不在这条排序里，任何模式都不让路。',
  )
  return lines.join('\n')
}

/**
 * `/whale mode` 这些写法都认：
 *   `/whale mode`            看当前目录是什么模式
 *   `/whale mode whale`      把这个目录设成鲸鲸（= `/whale bind`）
 *   `/whale mode assistant`  设回助手（= `/whale unbind`）
 * 旧写法 `/whale whale` 也保留，语义一样 —— 都是改这个目录，不是临时开关。
 */
export function parseModeCommand(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (!text) return { action: 'show' }
  const parts = text.split(/\s+/)
  const head = (parts[0] ?? '').toLowerCase()
  if (head === 'bind') return { action: 'set', whale: true }
  if (head === 'unbind') return { action: 'set', whale: false }
  if (MODES.includes(head)) return { action: 'set', whale: head === 'whale' }
  if (head !== 'mode') return { action: 'unknown', head }
  const value = (parts[1] ?? '').toLowerCase()
  if (!value) return { action: 'show' }
  if (!MODES.includes(value)) return { action: 'invalid', value }
  return { action: 'set', whale: value === 'whale' }
}

/**
 * `/whale mode ...` 的处理。改的是**这个目录的绑定**，不是会话现状。
 * 顺带把工作区名改成带标记的，人一眼看得出这是鲸鲸那间。
 */
export function handleModeCommand({ api, cwd, rawInput, workspaceController, log } = {}) {
  const parsed = parseModeCommand(rawInput)
  if (parsed.action === 'unknown') {
    return { kind: 'error', text: COPY.modeCommandHint }
  }
  if (parsed.action === 'invalid') return { kind: 'error', text: COPY.modeUnknown }

  const config = api.getConfig() ?? {}

  if (parsed.action === 'show') {
    if (!cwd) return { kind: 'error', text: COPY.workspaceUnknown }
    const mode = resolveMode({ config, cwd })
    const bound = isWhaleWorkspace(config, cwd)
    return {
      kind: 'success',
      text: `${COPY.modeNow(modeLabel(mode))}；${bound ? COPY.workspaceIsWhale : COPY.workspaceIsAssistant}`,
    }
  }

  if (!cwd) return { kind: 'error', text: COPY.workspaceUnknown }

  const list = normalizeExtras(config).whaleWorkspaces
  const next = setWhaleWorkspace(list, cwd, parsed.whale)
  const nextConfig = { ...config, whaleWorkspaces: next }
  // 旧的全局模式字段顺手清掉：留着它只会让人以为还有一层兜底。
  delete nextConfig.mode
  const written = api.setConfig(nextConfig, 'whale-bind')
  if (!written || written.ok !== true) {
    return { kind: 'error', text: COPY.settingsWriteFailed }
  }

  // 改名是增强：拿不到工作区服务、或这个目录还没注册成工作区，就只改绑定。
  // 不 await —— 绑定已经落盘了，改名慢一点不该让命令卡住。
  void syncWorkspaceTitle({ workspaceController, cwd, whale: parsed.whale }).then((said) => {
    if (said.ok !== true && typeof log === 'function') {
      log(`[dsh-whale-pal] 工作区改名跳过：${said.reason}`)
    }
  })

  return {
    kind: 'success',
    text: parsed.whale ? COPY.workspaceBoundWhale : COPY.workspaceBoundAssistant,
  }
}

/**
 * 把 cwd 对应的工作区改名成带/不带标记的样子。
 * 每一步失败都返回原因而不是抛错：这条路是增强，不能连累绑定本身。
 */
export async function syncWorkspaceTitle({ workspaceController, cwd, whale } = {}) {
  const wc = workspaceController
  if (!wc || typeof wc.rename !== 'function' || typeof wc.follow !== 'function') {
    return { ok: false, reason: 'no-service' }
  }
  const found = await findWorkspace(wc, cwd)
  if (found.ok !== true) return found
  const workspace = found.workspace
  if (!workspace) return { ok: false, reason: 'not-registered' }

  const want = taggedTitle(workspace.title, whale)
  if (want === workspace.title) return { ok: true, changed: false, title: want }
  if (want === '') return { ok: false, reason: 'empty-title' }
  try {
    await wc.rename({ workspaceId: workspace.workspaceId, title: want })
    return { ok: true, changed: true, title: want }
  } catch (error) {
    return { ok: false, reason: 'rename-failed', message: error?.message ?? String(error) }
  }
}

/** 从工作区投影里按目录找那一间。只读第一帧 baseline，读完就断开。 */
export async function findWorkspace(workspaceController, cwd) {
  const key = workspaceKey(cwd)
  if (key === '') return { ok: true, workspace: null }
  if (typeof workspaceController?.follow !== 'function') return { ok: false, reason: 'no-service' }
  const controller = new AbortController()
  try {
    for await (const frame of workspaceController.follow(controller.signal)) {
      if (frame?.type !== 'baseline') continue
      const items = Array.isArray(frame?.value?.items) ? frame.value.items : []
      return { ok: true, workspace: items.find((item) => workspaceKey(item?.path) === key) ?? null }
    }
    return { ok: true, workspace: null }
  } catch (error) {
    return { ok: false, reason: 'read-failed', message: error?.message ?? String(error) }
  } finally {
    controller.abort()
  }
}

/**
 * 设置页改了名单之后，把所有工作区的名字对齐一遍：
 * 名单里的加标记，不在名单里的剥掉。只改需要改的那几个。
 *
 * 一条改名失败不该拦住其余的（比如两个工作区撞名），所以逐条 try。
 */
export async function syncAllWorkspaceTitles({ workspaceController, list } = {}) {
  const wc = workspaceController
  if (!wc || typeof wc.rename !== 'function' || typeof wc.follow !== 'function') {
    return { ok: false, reason: 'no-service' }
  }
  const all = await listWorkspaces(wc)
  const keys = new Set((Array.isArray(list) ? list : []).map(workspaceKey))
  const changed = []
  for (const workspace of all) {
    const whale = keys.has(workspaceKey(workspace.path))
    const want = taggedTitle(workspace.title, whale)
    if (want === workspace.title || want === '') continue
    try {
      await wc.rename({ workspaceId: workspace.id, title: want })
      changed.push({ path: workspace.path, title: want })
    } catch {
      // 单条失败留给下一次对齐，不连累其余工作区。
    }
  }
  return { ok: true, changed }
}

/**
 * 列出宿主认识的所有工作区，给设置页当勾选清单。
 * 读不到就回空数组 —— 设置页还有「手动填路径」这条兜底。
 */
export async function listWorkspaces(workspaceController) {
  if (typeof workspaceController?.follow !== 'function') return []
  const controller = new AbortController()
  try {
    for await (const frame of workspaceController.follow(controller.signal)) {
      if (frame?.type !== 'baseline') continue
      const items = Array.isArray(frame?.value?.items) ? frame.value.items : []
      return items
        .filter((item) => typeof item?.path === 'string' && item.path !== '')
        .map((item) => ({
          id: String(item.workspaceId ?? ''),
          path: item.path,
          title: String(item.title ?? ''),
        }))
    }
    return []
  } catch {
    return []
  } finally {
    controller.abort()
  }
}
