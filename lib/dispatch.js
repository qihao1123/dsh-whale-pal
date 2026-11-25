/**
 * 派活：一个项目、一个任务名、一段说明 —— 目录、工作区、会话、任务文档一次到位。
 *
 * 定下来的口径（方案文档 `项目文档\插件dsh-whale-pal开发\自动派活与工作区-方案.md`）：
 *   - 工作区按**项目**分，不按任务分：一个项目一个工作区，任务在它里面各开一条会话。
 *   - 工作区路径 `工作区总路径\<项目名>\`，产出写 `.\<任务名>\`。
 *   - 任务文档 `记忆空间\项目文档\<项目名>\<任务名>.md`。
 *   - 总路径空着就报错指向设置页，不猜默认值。
 *   - 名字撞了就不开工：产出目录或任务文档已经在，说明这个任务派过。
 *
 * 为什么先查服务再动盘：服务拿不到就别建出一个「有目录、没会话」的半成品，
 * 那种半成品人看不出来，下次派同一个任务还会撞上自己。
 *
 * 工具层的 guard、文案出口都在 host.js；这里只管动作和返回形状。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { COPY } from './copy.js'
import { promptSignal } from './ctx/switch.js'

/** 任务文档在记忆空间里的固定目录名。不做成设置项：多一个配置项只是多一个出错的地方。 */
export const DISPATCH_DOC_DIR = '项目文档'

/** 名字上限：够写清楚一个任务，又不至于撞上 Windows 长路径。 */
export const DISPATCH_NAME_MAX = 60

/**
 * 派出去的会话能选哪几档权限。
 *
 * 宿主预设表里就这两档；第三档是编出来的，不认。派活时由人当场选一档，
 * 代码不给默认值——这个选择决定一条没人看着的窗口能对你的磁盘做什么，
 * 不该由代码替人拍板。没选就不派（`permission-required`），别悄悄退回去。
 *
 * 两档的代价不一样，问的时候要一起说：
 *   - danger-full-access：完全放开、不问审批。沙箱那道墙根本不存在，活能干完。
 *   - workspace-write：只能写工作区。Windows 上新目录补不上写权限时，
 *     第一条命令就卡在那道墙上干等——更安全，但派出去的窗口可能等不到人。
 */
export const DISPATCH_PERMISSIONS = ['danger-full-access', 'workspace-write']

/**
 * 指挥部：总路径底下固定一个工作区，名字写死。
 *
 * 它跟项目工作区是同一套动作（`工作区总路径\<名字>\`），只有名字不用每次传。
 * 位置固定下来，侧栏里就能一直按自己的顺序摆；指挥部会话也就不用挤在主工作区里，
 * 上下文各自算各自的。
 */
export const CHIEF_WORKSPACE_NAME = '指挥部'

/**
 * 确保某个目录在宿主的工区清单里有一个工作区：有就复用，没有才建。
 *
 * 调用方负责先把目录造出来 —— `create` 认的是已存在的真实目录。
 * 出错照抛，不在这里吞：派活和设置页对「没建成」的处理不一样。
 */
export async function ensureWorkspace(registry, dir, title) {
  let workspace = null
  try {
    workspace = await registry.resolveByPath(dir)
  } catch {
    // 目录刚建出来、realpath 还不稳之类：落到下面 create 再试一次。
  }
  if (workspace) return workspace
  return registry.create(dir, title)
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

function bad(error, message, extra = {}) {
  return { ok: false, error, message, ...extra }
}

/**
 * 把项目名/任务名收成能当文件夹名的样子。
 *
 * 特殊字符**不静默替换成另一个名字**——那样人按名字去侧栏找会对不上。
 * 但也不原样放行：`\ / : * ? " < > |` 在 Windows 上根本建不出目录。
 * 折中：去掉它们之后如果跟原文不一样，照实说「名字里的特殊字符去掉了」，
 * 把最后用的名字一起返回，下一句要用就以返回的为准。
 *
 * @returns {{ok:boolean, name:string, note:string}}
 */
export function safeName(value) {
  const raw = oneLine(value)
  if (raw === '') return { ok: false, name: '', note: '' }
  if (raw === '.' || raw === '..') return { ok: false, name: '', note: '' }
  const cleaned = raw.replace(/[\\/:*?"<>|]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return { ok: false, name: '', note: '' }
  // 不截断：截断后的名字是另一个名字，比报错危险。
  if (cleaned.length > DISPATCH_NAME_MAX) return { ok: false, name: '', note: '' }
  return {
    ok: true,
    name: cleaned,
    note: cleaned === raw ? '' : `名字里的特殊字符去掉了，实际用的是「${cleaned}」`,
  }
}

/** 任务文档的落点。给测试和 host 共用这一处算法，别在两边各拼一遍。 */
export function taskDocPath(vaultPath, project, task) {
  return join(String(vaultPath ?? ''), DISPATCH_DOC_DIR, safeName(project).name, `${safeName(task).name}.md`)
}

/**
 * 任务文档的骨架：四件套。
 *
 * 给执行会话读的，它不在主会话的历史里，所以「现象 / 照哪做 / 怎么验 / 回一句」
 * 四段必须自带全部上下文，不能写「按上次说的办」。
 */
export function renderTaskDoc({ project = '', task = '', brief = '', at = '', projectDir = '', taskDir = '' } = {}) {
  const stamp = oneLine(at) || new Date().toISOString()
  const body = String(brief ?? '').trim()
  const lines = [
    `# ${task}`,
    '',
    `> 项目：${project}`,
    `> 建于：${stamp}`,
    `> 工作目录：${projectDir}`,
    `> 产出写到：${taskDir}`,
    '',
    '## 一、现象',
    '',
    '（现在是什么样。只写能看见的，不写形容词。）',
    '',
    '## 二、照哪做',
    '',
    '（唯一出处：方案、规则、文档的绝对路径。别让对方再猜。）',
    '',
    '## 三、怎么验',
    '',
    '（跑哪个检查、看到什么算通过。不写「见代码」这种空承诺。）',
    '',
    '## 四、回一句',
    '',
    '干完在这条会话里回：结论 + 证据 + 写盘路径。只在自己窗口说「我做完了」不算交付。',
    '',
    '## 五、派活时给的说明',
    '',
    body === '' ? '（派活时没写说明。先问人，别自己猜着开工。）' : body,
    '',
  ]
  return lines.join('\n')
}

/** 递进新会话的第一条消息：不是用户说的，写清楚来源和去处。 */
export function dispatchPrompt({ task = '', docPath = '', taskDir = '' } = {}) {
  return [
    `【任务】${task}`,
    '这条不是用户手工开的会话，是主会话派出来的活。',
    '',
    '先读这份任务文档，按它做（读完先回一句「读到了」，再动手）：',
    docPath,
    '',
    '产出如果要写盘，写在这个目录：',
    taskDir,
    '',
    '干完在这条会话里回：结论 + 证据 + 写盘路径。',
    '这条消息和任务文档对不上时，以任务文档为准。',
  ].join('\n')
}

/**
 * 派活主流程。
 *
 * @param {object} options
 * @param {object} options.api 人格内核 api（读配置）
 * @param {(key:string)=>any} options.getService 取宿主服务
 * @param {object} options.args 工具入参：project / task / brief / doc / overwrite / permission
 * @returns {Promise<object>} 成功时把每个落点都带出来，失败时 error + message
 */
export async function runDispatch({ api, getService, args = {} }) {
  // 权限档是第一道闸，放在最前面：没定这个就不该往下走一步，连目录都不建。
  const chosenPermission = oneLine(args.permission)
  if (chosenPermission === '') return bad('permission-required', COPY.dispatchPermissionRequired)
  if (!DISPATCH_PERMISSIONS.includes(chosenPermission)) {
    return bad('permission-invalid', COPY.dispatchPermissionInvalid)
  }

  const project = safeName(args.project)
  if (!project.ok) return bad('project-invalid', COPY.dispatchBadName)
  const task = safeName(args.task)
  if (!task.ok) return bad('task-invalid', COPY.dispatchBadName)

  const config = api?.getConfig?.() ?? {}
  const workRoot = oneLine(config.knowledge?.workRoot)
  if (workRoot === '') return bad('workRoot-missing', COPY.workRootRequired)
  if (!isAbsolute(workRoot)) return bad('workRoot-not-absolute', COPY.workRootNotAbsolute)
  if (!existsSync(workRoot)) return bad('workRoot-not-a-directory', COPY.workRootMissing)

  const vaultPath = oneLine(config.knowledge?.vaultPath)
  if (vaultPath === '') return bad('vault-missing', COPY.dispatchVaultMissing)

  const projectDir = join(workRoot, project.name)
  const taskDir = join(projectDir, task.name)
  const docPath = taskDocPath(vaultPath, project.name, task.name)
  const docDir = join(vaultPath, DISPATCH_DOC_DIR, project.name)

  // 名字撞了就不开工：产出目录或任务文档已经在，说明这个任务派过。
  if (existsSync(taskDir)) return bad('task-exists', COPY.dispatchTaskExists)
  if (existsSync(docPath) && args.overwrite !== true) return bad('doc-exists', COPY.dispatchDocExists)

  // 先查服务再动盘：拿不到服务就别留「有目录、没会话」的半成品。
  const registry = getService('workspaceRegistry')
  if (!registry || typeof registry.create !== 'function') {
    return bad('no-workspace-registry', COPY.dispatchNoRegistry)
  }
  const controller = getService('sessionController')
  if (!controller || typeof controller.create !== 'function') {
    return bad('no-session-controller', COPY.dispatchNoController)
  }

  // 外部给的任务文档：直接用，不搬家、不改写。
  const givenDoc = oneLine(args.doc)
  let docFinal = docPath
  if (givenDoc !== '') {
    if (!isAbsolute(givenDoc)) return bad('doc-not-absolute', COPY.dispatchGivenDocNotAbsolute)
    if (!existsSync(givenDoc)) return bad('doc-missing', COPY.dispatchGivenDocMissing)
    docFinal = givenDoc
  }

  try {
    mkdirSync(taskDir, { recursive: true })
    mkdirSync(docDir, { recursive: true })
  } catch (error) {
    return bad('mkdir-failed', COPY.dispatchMkdirFailed, { detail: String(error?.message ?? error) })
  }

  let docWritten = false
  if (givenDoc === '') {
    try {
      writeFileSync(
        docPath,
        renderTaskDoc({
          project: project.name,
          task: task.name,
          brief: args.brief,
          at: new Date().toISOString(),
          projectDir,
          taskDir,
        }),
        'utf8',
      )
      docWritten = true
    } catch (error) {
      return bad('doc-write-failed', COPY.dispatchDocWriteFailed, { detail: String(error?.message ?? error) })
    }
  }

  // ---- 工作区：已注册就复用，没有才建。同一个目录重复调用不改标题。
  let workspace = null
  try {
    workspace = await ensureWorkspace(registry, projectDir, project.name)
  } catch (error) {
    return bad('workspace-failed', COPY.dispatchWorkspaceFailed, { detail: String(error?.message ?? error) })
  }

  // ---- 会话：只传 cwd 建出来的是无主会话，要手动挂进工作区。
  let created = null
  try {
    created = await controller.create({ cwd: projectDir })
  } catch (error) {
    return bad('create-failed', COPY.dispatchCreateFailed, { detail: String(error?.message ?? error) })
  }
  const sessionId = oneLine(created?.sessionId)
  if (sessionId === '') return bad('create-failed', COPY.dispatchCreateFailed)

  let grouped = false
  try {
    if (workspace && typeof workspace.attachSession === 'function') {
      await workspace.attachSession(sessionId)
      grouped = true
    }
  } catch {
    // 挂不上不算没派成：会话已经在了，只是没归组，返回里如实说。
  }

  // ---- 权限档：趁首条消息还没递进去先切，让它第一条命令就跑在选定的档上。
  // 切不动不算没派成——这条会话还是能干活，只是可能被沙箱挡住，所以如实记一笔。
  //
  // 宿主的 resolveAgent 回的是 `{ agent }` 或 `{ error }` 包装，不是 agent 本身
  // （2026-11-25 踩过：照着「它就是 agent」去读 `.session`，读出来是空，
  // 权限一次都没切成，派出去的会话还是撞沙箱那道墙）。
  let permission = ''
  let permissionNote = ''
  const presets = getService('permissionPresets')
  if (!presets || typeof presets.set !== 'function' || typeof controller.resolveAgent !== 'function') {
    permissionNote = COPY.dispatchNoPermissionService
  } else {
    try {
      const found = await controller.resolveAgent(sessionId)
      if (found && typeof found === 'object' && 'error' in found) throw found.error
      const session = found?.agent?.session ?? found?.session ?? null
      if (session) {
        presets.set(session, chosenPermission)
        permission = chosenPermission
      } else {
        permissionNote = COPY.dispatchNoPermissionSession
      }
    } catch (error) {
      permissionNote = `${COPY.dispatchPermissionFailed}：${String(error?.message ?? error)}`
    }
  }

  // ---- 首条消息：失败就把刚建的空会话归档，别在侧栏留一条点进去是空的。
  let seeded = false
  let promptFailure = ''
  if (typeof controller.prompt === 'function') {
    try {
      await controller.prompt(
        {
          requestId: `whale-pal-dispatch-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: dispatchPrompt({ task: task.name, docPath: docFinal, taskDir }) }],
        },
        promptSignal(),
      )
      seeded = true
    } catch (error) {
      promptFailure = String(error?.message ?? error)
    }
  } else {
    promptFailure = '宿主没有 prompt 接口'
  }

  if (!seeded) {
    let archived = false
    try {
      if (typeof registry.archiveSession === 'function') {
        await registry.archiveSession(sessionId, { stopActivity: true })
        archived = true
      }
    } catch {
      // 归档也失败：只能把未归档这件事说出来，别假装收干净了。
    }
    return bad('prompt-failed', COPY.dispatchPromptFailed, {
      project: project.name,
      task: task.name,
      projectDir,
      taskDir,
      docPath: docFinal,
      sessionId,
      archived,
      detail: promptFailure,
    })
  }

  return {
    ok: true,
    project: project.name,
    task: task.name,
    projectDir,
    taskDir,
    docPath: docFinal,
    docWritten,
    workspaceId: oneLine(workspace?.id ?? workspace?.workspaceId),
    workspaceTitle: oneLine(workspace?.title) || project.name,
    sessionId,
    grouped,
    seeded,
    permission,
    note: [project.note, task.note, permissionNote].filter((item) => item !== '').join('；'),
  }
}
