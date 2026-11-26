/**
 * 派活：一个项目、一个任务名、一段说明 —— 目录、工作区、任务文档一次到位，
 * 任务交给这个项目**已有的执行会话**；没空就排队，等它空下来再投。
 *
 * 定下来的口径（方案文档 `项目文档\插件dsh-whale-pal开发\自动派活与工作区-方案.md` 第八节）：
 *   - 一项目一条执行会话：有就复用，删了/归档了才新建。
 *   - 一任务一份文档、一个产出目录，重名照旧拒——复用的是会话，不是产出。
 *   - 目标会话在跑就入池（`dispatch.json` 的 `queue`），`agent/status` 变 idle 再投。
 *   - 完全放开必须先问人：用宿主的**问题服务**，不用审批服务——`danger-full-access`
 *     这个预设恰好把审批策略写成 `never`，用审批等于自己把门焊死。
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
import {
  dropQueued,
  enqueueTask,
  markAttempt,
  projectRecordOf,
  queueLength,
  readDispatchState,
  recordSent,
  saveDispatchState,
  setProjectRecord,
  settleSent,
} from './dispatch-store.js'

/** 任务文档在记忆空间里的固定目录名。不做成设置项：多一个配置项只是多一个出错的地方。 */
export const DISPATCH_DOC_DIR = '项目文档'

/** 名字上限：够写清楚一个任务，又不至于撞上 Windows 长路径。 */
export const DISPATCH_NAME_MAX = 60

/**
 * 派出去的会话能选哪几档权限。
 *
 * 宿主预设表里就这两档；第三档是编出来的，不认。派活时由人当场选一档，
 * 代码不给默认值——这个选择决定一条没人看着的窗口能对你的磁盘做什么，
 * 不该由代码替人拍板。没选就不派。
 *
 * 两档的代价不一样，问的时候要一起说：
 *   - danger-full-access：完全放开、不问审批。沙箱那道墙根本不存在，活能干完。
 *   - workspace-write：只能写工作区。Windows 上新目录补不上写权限时，
 *     第一条命令就卡在那道墙上干等——更安全，但派出去的窗口可能等不到人。
 */
export const DISPATCH_PERMISSIONS = ['danger-full-access', 'workspace-write']

/** 问人时那三个选项的标签。问题与答案按标签对，不用序号。 */
export const DISPATCH_OPTIONS = Object.freeze({
  full: COPY.dispatchPermissionFull,
  workspace: COPY.dispatchPermissionWorkspace,
  cancel: COPY.dispatchPermissionCancel,
})

/**
 * 指挥部：总路径底下固定一个工作区，名字写死。
 *
 * 它跟项目工作区是同一套动作（`工作区总路径\<名字>\`），只有名字不用每次传。
 * 位置固定下来，侧栏里就能一直按自己的顺序摆；指挥部会话也就不用挤在主工作区里，
 * 上下文各自算各自的。
 */
export const CHIEF_WORKSPACE_NAME = '指挥部'

/**
 * 指挥部目录里那份职责说明的文件名。
 *
 * 用 DSH 的工作区指令惯例：会话第一次请求就会从项目根一路读到当前目录，
 * 读到这个文件。写在这里，是因为「它自己知道自己干什么」不该靠人每次开口交代。
 */
export const CHIEF_INSTRUCTION_FILE = 'AGENTS.md'

/**
 * 职责说明正文。
 *
 * 短。它每次开会话都进提示，占的是字节预算；说清三件事就够——
 * 只判断和派活、派之前问权限、派完不接管。
 */
export const CHIEF_INSTRUCTION = `# 指挥部

这个目录里开的会话是指挥部：只判断、只派活，不自己下场干活。

- 收到一件事，先判断要不要做、拆成几件、每件交给谁；判断完用 whale_pal_dispatch 派出去。
- 派之前问人这次给哪一档权限（完全放开 / 只能写工作区）。人不选就不派。
- 派完只留一句：派出去了、在哪个工作区。别在指挥部里替它做事；要看进度去看，不要接管。
- 收尾时只核结果，不改它的产出。

这份说明由插件在创建指挥部工作区时写进去；已经存在就不会被覆盖，想改直接改这里。
`

/**
 * 把职责说明写进指挥部目录：没有才写，已经有就一个字不动。
 *
 * 为什么「有就不碰」：人能自己改这份说明（比如加自己的规矩），
 * 插件每次存设置都覆盖一遍，等于把人写的东西冲掉。
 *
 * 写不进去不算失败：工作区该建还得建，只是少了自动交代，
 * 调用方把 `failed` 如实回去就行。
 *
 * @returns {'written'|'kept'|'failed'}
 */
export function writeChiefInstruction(dir) {
  try {
    const file = join(dir, CHIEF_INSTRUCTION_FILE)
    if (existsSync(file)) return 'kept'
    writeFileSync(file, CHIEF_INSTRUCTION, 'utf8')
    return 'written'
  } catch {
    return 'failed'
  }
}

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

/** 递进执行会话的任务消息：不是用户说的，写清楚来源和去处。 */
export function dispatchPrompt({ task = '', docPath = '', taskDir = '' } = {}) {
  return [
    `【任务】${task}`,
    '这条不是用户手工写的，是主会话派出来的活。干完就停，别自己找下一件。',
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

/** 两条路径是不是同一个目录：Windows 不分大小写，末尾斜杠不算区别。 */
export function sameDir(left, right) {
  const norm = (value) => oneLine(value).replace(/[\\/]+$/u, '').replace(/\//gu, '\\').toLowerCase()
  const a = norm(left)
  return a !== '' && a === norm(right)
}

/** 宿主的归档会话名单；拿不到就当没有——归档那条判据只是加分项，不能卡住派活。 */
export function archivedIdsOf(registry) {
  try {
    const list = registry?.archivedSessionIds
    return Array.isArray(list) ? list.map((id) => String(id)) : []
  } catch {
    return []
  }
}

/**
 * 在这个项目的已有会话里挑一条能接活的。
 *
 * 判据只认落点，不认标题（标题人随时改）：
 *   - `cwd` 就是项目目录（同一目录才算同一个项目）；
 *   - 不是子代理产物、不是分支出来的子会话（它们有自己的父亲）；
 *   - 不在宿主的归档名单里（归档的会话被拦在 `agent/pre-step`，投进去会静默不跑）；
 *   - 跑过至少一轮（`blank` 是没说过话的空会话，接活等于接在一个没人用过的壳上）。
 *
 * 有记录就优先记录里那条——项目归哪条会话是**记下来的**，不是每次现猜；
 * 记录那条不在了才退回「最近动过的那条」。
 *
 * @returns {object|null} 宿主 `SessionSummary`，没有就 null
 */
export function pickReusableSession({ sessions = [], archived = [], projectDir = '', record = null } = {}) {
  const usable = (session) =>
    session !== null &&
    typeof session === 'object' &&
    session.origin !== 'subagent' &&
    session.parentSessionId === undefined &&
    !archived.includes(session.sessionId) &&
    sameDir(session.cwd, projectDir)

  const candidates = sessions.filter(usable)
  const remembered = record === null ? undefined : candidates.find((s) => s.sessionId === record.sessionId)
  if (remembered !== undefined) return remembered

  const spoken = candidates
    .filter((session) => session.blank !== true)
    .sort((left, right) => (Number(left.updatedAt) || 0) - (Number(right.updatedAt) || 0))
  return spoken.length === 0 ? null : spoken[spoken.length - 1]
}

/**
 * 问人：这次这条执行会话给哪一档。
 *
 * 用问题服务而不是审批服务，理由写在方案第八节：`danger-full-access` 预设把
 * 审批策略设成 `never`，审批服务在这个档下只会回 `rejected`，问不出人来。
 *
 * 任何问不出来的情况都按「不派」处理（fail closed）：没服务、调用报错、
 * 人选了取消、答案不是这两个标签之一。
 *
 * @returns {Promise<{ok:true, permission:string}|{ok:false, error:string, message:string}>}
 */
export async function askDispatchPermission({ getService, agent, project = '', task = '' } = {}) {
  const questions = typeof getService === 'function' ? getService('userQuestions') : null
  if (!questions || typeof questions.ask !== 'function') {
    return { ok: false, error: 'permission-unavailable', message: COPY.dispatchPermissionUnavailable }
  }
  if (!agent) {
    return { ok: false, error: 'permission-unavailable', message: COPY.dispatchPermissionNoAgent }
  }
  let answer = null
  try {
    answer = await questions.ask({
      agent,
      questions: [
        {
          id: 'dispatch-permission',
          header: COPY.dispatchPermissionHeader,
          question: COPY.dispatchPermissionQuestion(project, task),
          detail: COPY.dispatchPermissionDetail,
          options: [
            { label: DISPATCH_OPTIONS.full, description: COPY.dispatchPermissionFullHint },
            { label: DISPATCH_OPTIONS.workspace, description: COPY.dispatchPermissionWorkspaceHint },
            { label: DISPATCH_OPTIONS.cancel, description: COPY.dispatchPermissionCancelHint },
          ],
        },
      ],
    })
  } catch (error) {
    return {
      ok: false,
      error: 'permission-unavailable',
      message: `${COPY.dispatchPermissionUnavailable}：${oneLine(error?.message ?? error).slice(0, 160)}`,
    }
  }
  const picked = oneLine(answer?.answers?.find((item) => item?.id === 'dispatch-permission')?.selected?.[0])
  if (picked === DISPATCH_OPTIONS.full) return { ok: true, permission: 'danger-full-access' }
  if (picked === DISPATCH_OPTIONS.workspace) return { ok: true, permission: 'workspace-write' }
  return { ok: false, error: 'permission-rejected', message: COPY.dispatchPermissionRejected }
}

/** 一条池任务的编号：时间在前好排序，尾巴三位随机防同一毫秒撞车。 */
export function newDispatchId(now = Date.now()) {
  return `d${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

/**
 * 把一条任务投进执行会话。
 *
 * `requestId` 用池项自己的编号：宿主按它去重（`hasPromptRequest`），
 * 所以崩在投递中间重启再投一次，不会同一条任务投两遍。
 */
export async function deliverTask(controller, item) {
  await controller.prompt(
    {
      requestId: `whale-pal-dispatch-${item.id}`,
      sessionId: item.sessionId,
      mode: 'queue',
      content: [
        { type: 'text', text: dispatchPrompt({ task: item.task, docPath: item.docPath, taskDir: item.taskDir }) },
      ],
    },
    promptSignal(),
  )
}

/** 现在能不能读会话清单：读不到就别假装知道项目有没有执行会话。 */
function canList(controller) {
  return Boolean(controller) && typeof controller.list === 'function'
}

async function listSessions(controller) {
  const value = await controller.list({}, promptSignal())
  const items = Array.isArray(value?.items) ? value.items : []
  return items
}

/**
 * 派活主流程。
 *
 * @param {object} options
 * @param {object} options.api 人格内核 api（读配置）
 * @param {(key:string)=>any} options.getService 取宿主服务
 * @param {object} options.args 工具入参：project / task / brief / doc / overwrite
 * @param {object|null} options.agent 调用方会话的 agent（问人要用它）
 * @param {string} options.dispatchFile 账本路径
 * @returns {Promise<object>} 成功时把每个落点都带出来，失败时 error + message
 */
export async function runDispatch({
  api,
  getService,
  args = {},
  agent = null,
  dispatchFile = '',
  log = () => {},
}) {
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

  // 权限是第一道闸：人没点头就不该往下走一步，连目录都不建。
  const asked = await askDispatchPermission({ getService, agent, project: project.name, task: task.name })
  if (!asked.ok) return bad(asked.error, asked.message)

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
  if (!canList(controller)) return bad('no-session-list', COPY.dispatchNoList)

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

  // ---- 先看这个项目有没有执行会话：有就复用，不新建。
  const state = readDispatchState(dispatchFile)
  const record = projectRecordOf(state, project.name)
  let sessions = []
  try {
    sessions = await listSessions(controller)
  } catch (error) {
    return bad('session-list-failed', COPY.dispatchListFailed, { detail: String(error?.message ?? error) })
  }
  const archived = archivedIdsOf(registry)
  let session = pickReusableSession({ sessions, archived, projectDir, record })
  const reused = session !== null

  // 复用时也把工作区查出来：返回里要带 id，人按它去侧栏对。
  // 查不到不算错——会话在就行，只是这次没法报 id。
  let workspace = null
  if (reused) {
    try {
      workspace = await registry.resolveByPath(projectDir)
    } catch {
      workspace = null
    }
  }

  // ---- 没有就开一条：只传 cwd 建出来的是无主会话，要手动挂进工作区。
  if (!reused) {
    try {
      workspace = await ensureWorkspace(registry, projectDir, project.name)
    } catch (error) {
      return bad('workspace-failed', COPY.dispatchWorkspaceFailed, { detail: String(error?.message ?? error) })
    }
    let created = null
    try {
      created = await controller.create({ cwd: projectDir })
    } catch (error) {
      return bad('create-failed', COPY.dispatchCreateFailed, { detail: String(error?.message ?? error) })
    }
    const sessionId = oneLine(created?.sessionId)
    if (sessionId === '') return bad('create-failed', COPY.dispatchCreateFailed)
    session = { sessionId, running: false, cwd: projectDir, blank: true }
    if (workspace && typeof workspace.attachSession === 'function') {
      try {
        await workspace.attachSession(sessionId)
      } catch {
        // 挂不上不算没派成：会话已经在了，只是没归组，返回里如实说。
      }
    }
  }

  const sessionId = oneLine(session?.sessionId)
  if (sessionId === '') return bad('create-failed', COPY.dispatchCreateFailed)

  // ---- 权限档：DSH 的权限是会话级的，没有「只给这一条消息」的口子，
  // 所以这里改的是整条会话，返回里要说明。切不动不算没派成——如实记一笔。
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
      const live = found?.agent?.session ?? found?.session ?? null
      if (live) {
        presets.set(live, asked.permission)
        permission = asked.permission
      } else {
        permissionNote = COPY.dispatchNoPermissionSession
      }
    } catch (error) {
      permissionNote = `${COPY.dispatchPermissionFailed}：${String(error?.message ?? error)}`
    }
  }

  // ---- 记下「这个项目用这条会话」，连这次选的档：下次派活直接接上。
  let next = setProjectRecord(state, project.name, {
    sessionId,
    permission,
    at: new Date().toISOString(),
  })
  const item = {
    id: newDispatchId(),
    project: project.name,
    task: task.name,
    sessionId,
    permission,
    taskDir,
    docPath: docFinal,
    at: new Date().toISOString(),
    attempts: 0,
    lastError: '',
  }

  const base = {
    ok: true,
    project: project.name,
    task: task.name,
    projectDir,
    taskDir,
    docPath: docFinal,
    docWritten,
    workspaceId: oneLine(session?.workspaceId ?? workspace?.id ?? workspace?.workspaceId),
    workspaceTitle: oneLine(workspace?.title) || project.name,
    sessionId,
    grouped: true,
    permission,
    reused,
    note: [project.note, task.note, permissionNote].filter((text) => text !== '').join('；'),
  }

  // ---- 目标会话正在跑：不打断，进池等它空下来。
  if (session.running === true) {
    next = enqueueTask(next, item)
    const saved = saveDispatchState(dispatchFile, next)
    if (saved.ok !== true) {
      return bad('queue-save-failed', COPY.dispatchQueueSaveFailed, { ...base, ok: false, detail: saved.error })
    }
    return { ...base, queued: true, queueLength: queueLength(next) }
  }

  // ---- 空着就直接投。投不进去不是丢件：从池子这条路走，等它空了再投一次。
  try {
    await deliverTask(controller, item)
  } catch (error) {
    const failure = String(error?.message ?? error)
    log(`[dsh-whale-pal] 任务「${task.name}」没投进执行会话：${failure}`)
    if (!reused) {
      let archivedSession = false
      try {
        if (typeof registry.archiveSession === 'function') {
          await registry.archiveSession(sessionId, { stopActivity: true })
          archivedSession = true
        }
      } catch {
        // 归档也失败：只能把未归档这件事说出来，别假装收干净了。
      }
      return bad('prompt-failed', COPY.dispatchPromptFailed, {
        ...base,
        ok: false,
        archived: archivedSession,
        detail: failure,
      })
    }
    next = markAttempt(enqueueTask(next, item), item.id, failure)
    const saved = saveDispatchState(dispatchFile, next)
    if (saved.ok !== true) {
      return bad('queue-save-failed', COPY.dispatchQueueSaveFailed, { ...base, ok: false, detail: saved.error })
    }
    return {
      ...base,
      queued: true,
      queueLength: queueLength(next),
      note: [base.note, COPY.dispatchQueuedAfterFailure].filter((text) => text !== '').join('；'),
    }
  }

  next = recordSent(next, item)
  const saved = saveDispatchState(dispatchFile, next)
  if (saved.ok !== true) log(`[dsh-whale-pal] 派活了，但账本没落盘：${saved.error}`)
  return { ...base, queued: false, queueLength: queueLength(next) }
}

/** 一次只跑一个冲刷：定时器、事件、加载三处可能同时触发，不排队会重复投。 */
let flushing = false

/**
 * 把池里能投的任务投出去。
 *
 * 什么时候算能投：目标会话查得到、没被归档、而且不在跑。
 * 会话被删/归档的池项不投——归档会话过了 `agent/pre-step` 那道闸就会被拦住静默不跑，
 * 投进去等于假装派出去了。这种项出池、记进历史，理由留 `lastError`。
 *
 * @returns {Promise<{sent:string[], dropped:string[], remaining:number}>}
 */
export async function flushQueuedTasks({ getService, dispatchFile = '', log = () => {} } = {}) {
  if (flushing) return { sent: [], dropped: [], remaining: 0, skipped: true }
  flushing = true
  try {
    const state = readDispatchState(dispatchFile)
    if (state.broken === true) {
      log('[dsh-whale-pal] 派活账本读不出来，这次不冲池（账本已备份，先查它）')
      return { sent: [], dropped: [], remaining: 0, broken: true }
    }
    if (queueLength(state) === 0) return { sent: [], dropped: [], remaining: 0 }

    const controller = getService('sessionController')
    if (!canList(controller) || typeof controller.prompt !== 'function') {
      return { sent: [], dropped: [], remaining: queueLength(state), unavailable: true }
    }
    let sessions = []
    try {
      sessions = await listSessions(controller)
    } catch (error) {
      log(`[dsh-whale-pal] 冲池时读不到会话清单：${String(error?.message ?? error)}`)
      return { sent: [], dropped: [], remaining: queueLength(state), unavailable: true }
    }
    const byId = new Map(sessions.map((session) => [session.sessionId, session]))
    const archived = archivedIdsOf(getService('workspaceRegistry'))

    let next = state
    const sent = []
    const dropped = []
    for (const item of [...state.queue]) {
      const live = byId.get(item.sessionId)
      if (!live || archived.includes(item.sessionId)) {
        next = dropQueued(next, item.id, live ? 'archived' : 'session-gone')
        dropped.push(item.id)
        continue
      }
      if (live.running === true) continue
      try {
        await deliverTask(controller, item)
        next = settleSent(next, item.id)
        sent.push(item.id)
      } catch (error) {
        next = markAttempt(next, item.id, String(error?.message ?? error))
        log(`[dsh-whale-pal] 池里的任务「${item.task}」又没投进去：${String(error?.message ?? error)}`)
        break
      }
    }
    if (next !== state) {
      const saved = saveDispatchState(dispatchFile, next)
      if (saved.ok !== true) log(`[dsh-whale-pal] 池子投出去了，但账本没落盘：${saved.error}`)
    }
    return { sent, dropped, remaining: queueLength(next) }
  } finally {
    flushing = false
  }
}
