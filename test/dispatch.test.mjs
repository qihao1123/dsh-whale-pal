/**
 * 派活：只测这一层自己的判断——路径怎么拼、名字怎么收、什么情况拒、失败怎么兜底，
 * 以及「一项目一条执行会话 + 待派池」这条主线。
 *
 * 不碰真 DSH：工作区注册表、会话控制器、问题服务都用假的，真盘子只用临时目录。
 * 这里最容易错的是「半成品」——目录建了、会话建了、但任务没递进去，
 * 侧栏就多一条点进去是空的。所以兜底那条单独测。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { COPY } from '../lib/copy.js'
import {
  CHIEF_INSTRUCTION,
  CHIEF_INSTRUCTION_FILE,
  CHIEF_WORKSPACE_NAME,
  DISPATCH_DOC_DIR,
  DISPATCH_OPTIONS,
  DISPATCH_PERMISSIONS,
  dispatchPrompt,
  ensureWorkspace,
  flushQueuedTasks,
  newDispatchId,
  pickReusableSession,
  renderTaskDoc,
  runDispatch,
  safeName,
  sameDir,
  taskDocPath,
  writeChiefInstruction,
} from '../lib/dispatch.js'
import { readDispatchState } from '../lib/dispatch-store.js'

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `whale-dispatch-${name}-`))
}

/** 调用方的会话：问人要它，这里给个够用的壳。 */
const CALLER = { session: { id: 'caller' } }

function makeHost({
  promptFails = false,
  noRegistry = false,
  noController = false,
  noPermission = false,
  permissionFails = false,
  noList = false,
  listFails = false,
  resolveError = false,
  noQuestions = false,
  askFails = false,
  answer = COPY.dispatchPermissionFull,
  archivedIds = [],
  sessions = [],
} = {}) {
  const workspaces = []
  let seq = 0
  const registry = {
    created: workspaces,
    archived: [],
    archivedSessionIds: archivedIds,
    async resolveByPath(path) {
      return workspaces.find((item) => item.path === path)
    },
    async create(path, title) {
      const workspace = {
        id: `ws-${(seq += 1)}`,
        path,
        title,
        sessionIds: [],
        async attachSession(id) {
          workspace.sessionIds.push(id)
        },
      }
      workspaces.push(workspace)
      return workspace
    },
    async archiveSession(id) {
      registry.archived.push(id)
    },
  }
  const controller = {
    created: [],
    prompts: [],
    resolved: [],
    sessions,
    listFails,
    noList,
    async list() {
      if (listFails) throw new Error('读不到会话')
      return { items: controller.sessions }
    },
    async create({ cwd }) {
      const id = `s-${(seq += 1)}`
      controller.created.push({ id, cwd })
      const session = { sessionId: id, cwd, running: false, blank: true, updatedAt: Date.now() }
      controller.sessions.push(session)
      return { sessionId: id }
    },
    resolveAgent(id) {
      const session = { id }
      controller.resolved.push({ id, session })
      // 宿主回的是 `{ agent }` 或 `{ error }`，不是 agent 本身——照真机形状来，
      // 不然这里回 `{ session }` 测试就绿、线上还是切不成。
      if (resolveError) return { error: new Error('会话还没挂上') }
      return { agent: { session } }
    },
    async prompt(request) {
      if (promptFails) throw new Error('宿主拒绝')
      controller.prompts.push(request)
    },
  }
  const permissionPresets = {
    applied: [],
    set(session, name) {
      if (permissionFails) throw new Error('没有这一档')
      permissionPresets.applied.push({ session, name })
    },
  }
  const userQuestions = {
    asked: [],
    async ask(request) {
      userQuestions.asked.push(request)
      if (askFails) throw new Error('问不到人')
      const value = typeof userQuestions.answer === 'function' ? userQuestions.answer(request) : userQuestions.answer
      return {
        answers: [{ id: request.questions[0].id, selected: value === null ? [] : [value] }],
      }
    },
    answer,
  }
  const services = {
    workspaceRegistry: noRegistry ? null : registry,
    sessionController: noController ? null : controller,
    permissionPresets: noPermission ? null : permissionPresets,
    userQuestions: noQuestions ? null : userQuestions,
  }
  // 「宿主没这个接口」要真的没有：只是设个标志位，`typeof list === 'function'` 照样是函数。
  if (noList) delete controller.list
  return {
    getService: (key) => services[key] ?? null,
    registry,
    controller,
    permissionPresets,
    userQuestions,
    services,
  }
}

function makeApi(workRoot, vaultPath) {
  return {
    getConfig: () => ({ knowledge: { workRoot, vaultPath } }),
  }
}

/**
 * 测试默认走「完全放开」那一档——绝大多数用例关心的不是权限。
 * 权限档本身的判断单独测，别让这个默认值把那条路盖住。
 */
function runAs(host, options) {
  return runDispatch({
    agent: CALLER,
    dispatchFile: options.dispatchFile,
    ...options,
    getService: host.getService,
  })
}

describe('ensureWorkspace', () => {
  it('已有工作区就复用，标题不动', async () => {
    const host = makeHost()
    const first = await ensureWorkspace(host.registry, 'D:\\项目', '项目')
    const again = await ensureWorkspace(host.registry, 'D:\\项目', '别的名字')
    assert.equal(again.id, first.id)
    assert.equal(again.title, '项目', '已有的工作区不该被改名')
    assert.equal(host.registry.created.length, 1)
  })

  it('没有才建：目录和标题原样交给注册表', async () => {
    const host = makeHost()
    const workspace = await ensureWorkspace(host.registry, 'D:\\项目', CHIEF_WORKSPACE_NAME)
    assert.equal(workspace.title, CHIEF_WORKSPACE_NAME)
    assert.equal(host.registry.created.length, 1)
  })

  it('注册表抛错照抛，不吞成「没建成」', async () => {
    const host = makeHost()
    host.registry.create = async () => {
      throw new Error('撞名')
    }
    await assert.rejects(() => ensureWorkspace(host.registry, 'D:\\项目', '项目'), /撞名/)
  })
})

describe('writeChiefInstruction', () => {
  it('目录里没有就写一份，内容说清「只判断和派活」', () => {
    const dir = tempDir('chief-write')
    assert.equal(writeChiefInstruction(dir), 'written')
    const text = readFileSync(join(dir, CHIEF_INSTRUCTION_FILE), 'utf8')
    assert.equal(text, CHIEF_INSTRUCTION)
    assert.match(text, /只判断、只派活/)
    assert.match(text, /whale_pal_dispatch/)
  })

  it('已经有一份就一个字不动——人可能改过', () => {
    const dir = tempDir('chief-keep')
    const file = join(dir, CHIEF_INSTRUCTION_FILE)
    writeFileSync(file, '# 我自己写的\n', 'utf8')
    assert.equal(writeChiefInstruction(dir), 'kept')
    assert.equal(readFileSync(file, 'utf8'), '# 我自己写的\n')
  })

  it('写不进去返回 failed，不抛', () => {
    const dir = join(tempDir('chief-fail'), '不存在的一层')
    assert.equal(writeChiefInstruction(dir), 'failed')
  })

  it('文件名是 DSH 认的那个', () => {
    assert.equal(CHIEF_INSTRUCTION_FILE, 'AGENTS.md')
  })
})

describe('safeName', () => {
  it('普通名字原样用', () => {
    const result = safeName('自动派活')
    assert.equal(result.ok, true)
    assert.equal(result.name, '自动派活')
    assert.equal(result.note, '')
  })

  it('空名字、点、点点都不收', () => {
    for (const value of ['', '   ', '.', '..']) {
      assert.equal(safeName(value).ok, false, `「${value}」不该放行`)
    }
  })

  it('Windows 建不出目录的字符去掉，并说清实际用了哪个名字', () => {
    const result = safeName('a/b:c*d')
    assert.equal(result.ok, true)
    assert.equal(result.name, 'a b c d')
    assert.match(result.note, /特殊字符去掉了/)
  })

  it('太长不截断，直接不收（截断后的名字是另一个名字）', () => {
    assert.equal(safeName('长'.repeat(61)).ok, false)
    assert.equal(safeName('长'.repeat(60)).ok, true)
  })
})

describe('任务文档骨架', () => {
  it('四件套按顺序都在，说明放在最后', () => {
    const text = renderTaskDoc({
      project: '插件dsh-whale-pal开发',
      task: '自动派活',
      brief: '把派活做成一条命令',
      at: '2026-11-24T12:00:00.000Z',
      projectDir: 'D:\\AI 项目\\插件dsh-whale-pal开发',
      taskDir: 'D:\\AI 项目\\插件dsh-whale-pal开发\\自动派活',
    })
    assert.match(text, /^# 自动派活/)
    assert.ok(text.includes('## 一、现象'))
    assert.ok(text.includes('## 二、照哪做'))
    assert.ok(text.includes('## 三、怎么验'))
    assert.ok(text.includes('## 四、回一句'))
    assert.ok(text.includes('## 五、派活时给的说明'))
    assert.ok(text.includes('把派活做成一条命令'))
    assert.ok(text.indexOf('## 一、现象') < text.indexOf('## 二、照哪做'))
    assert.ok(text.indexOf('## 四、回一句') < text.indexOf('## 五、派活时给的说明'))
  })

  it('没写说明就明说没写，不让人猜着开工', () => {
    const text = renderTaskDoc({ project: 'p', task: 't' })
    assert.ok(text.includes('派活时没写说明'))
  })
})

describe('runDispatch：权限这一步（问人，不是问模型）', () => {
  it('问不到人：不派，磁盘上什么都不留', async () => {
    const host = makeHost({ noQuestions: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const result = await runAs(host, { api: makeApi(root, vault), args: { project: 'p', task: 't' }, dispatchFile })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-unavailable')
    assert.equal(result.message, COPY.dispatchPermissionUnavailable)
    assert.equal(existsSync(join(root, 'p')), false, '问不到人就什么都不该建')
    assert.equal(host.registry.created.length, 0, '也不该注册工作区')
    assert.equal(host.controller.created.length, 0, '也不该开会话')
    assert.equal(existsSync(dispatchFile), false, '账本也不该写')
  })

  it('没给调用方会话也问不到人：不派', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runDispatch({
      api: makeApi(root, vault),
      getService: host.getService,
      args: { project: 'p', task: 't' },
      agent: null,
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-unavailable')
    assert.equal(result.message, COPY.dispatchPermissionNoAgent)
  })

  it('问题服务自己抛错：按「问不到人」处理', async () => {
    const host = makeHost({ askFails: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-unavailable')
    assert.match(result.message, /问不到人/)
    assert.equal(host.controller.created.length, 0)
  })

  it('人点取消：不派，一个目录都不建', async () => {
    const host = makeHost({ answer: COPY.dispatchPermissionCancel })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-rejected')
    assert.equal(result.message, COPY.dispatchPermissionRejected)
    assert.equal(existsSync(join(root, 'p')), false)
    assert.equal(host.controller.created.length, 0)
  })

  it('答了别的话（自由文本）也按取消处理，不猜意图', async () => {
    const host = makeHost({ answer: '随便吧' })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-rejected')
  })

  it('问的时候把项目和任务写进问题里，人知道自己批的是哪一件', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    await runAs(host, {
      api: makeApi(root, vault),
      args: { project: '项目甲', task: '任务乙' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(host.userQuestions.asked.length, 1)
    const question = host.userQuestions.asked[0].questions[0]
    assert.match(question.question, /项目甲 \/ 任务乙/)
    assert.deepEqual(
      question.options.map((option) => option.label),
      [DISPATCH_OPTIONS.full, DISPATCH_OPTIONS.workspace, DISPATCH_OPTIONS.cancel],
    )
  })

  it('选「只能写工作区」：切的就是这一档，不偷换成完全放开', async () => {
    const host = makeHost({ answer: COPY.dispatchPermissionWorkspace })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.permission, 'workspace-write')
    assert.equal(host.permissionPresets.applied[0].name, 'workspace-write')
  })

  it('白名单就两档，别的名字一个都不认', () => {
    assert.deepEqual(DISPATCH_PERMISSIONS, ['danger-full-access', 'workspace-write'])
  })
})

describe('runDispatch：拒的情形', () => {
  it('工作区总路径空着：报错指向设置页，一个目录都不建，也不问人', async () => {
    const host = makeHost()
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi('', vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'workRoot-missing')
    assert.equal(result.message, COPY.workRootRequired)
    assert.equal(host.userQuestions.asked.length, 0, '名字/路径先不过关就不该打扰人')
    assert.equal(host.controller.created.length, 0)
  })

  it('记忆空间没设：也说清楚，不猜', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const result = await runAs(host, {
      api: makeApi(root, ''),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'vault-missing')
    assert.equal(result.message, COPY.dispatchVaultMissing)
  })

  it('同名任务的产出目录已经在：拒绝，不合并', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: 't' }, dispatchFile })
    assert.equal(first.ok, true)
    const second = await runAs(host, { api, args: { project: 'p', task: 't' }, dispatchFile })
    assert.equal(second.ok, false)
    assert.equal(second.error, 'task-exists')
    assert.equal(second.message, COPY.dispatchTaskExists)
    assert.equal(host.controller.created.length, 1, '拒的时候不该再开一条会话')
  })

  it('宿主没给工作区注册表：不动盘就失败', async () => {
    const host = makeHost({ noRegistry: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-workspace-registry')
    assert.equal(result.message, COPY.dispatchNoRegistry)
    assert.equal(existsSync(join(root, 'p')), false, '服务不在就别留半个目录')
  })

  it('宿主没给会话控制器：不动盘就失败', async () => {
    const host = makeHost({ noController: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-session-controller')
    assert.equal(existsSync(join(root, 'p')), false)
  })

  it('宿主读不了会话清单：失败，不硬开新会话', async () => {
    const host = makeHost({ noList: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-session-list')
    assert.equal(host.controller.created.length, 0)
  })

  it('会话清单读的时候抛错：失败，不硬开新会话', async () => {
    const host = makeHost({ listFails: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'session-list-failed')
  })

  it('外部任务文档路径不存在：拒绝，不建目录', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't', doc: join(vault, '没有这份.md') },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'doc-missing')
    assert.equal(existsSync(join(root, 'p', 't')), false)
  })
})

describe('runDispatch：成功那一趟', () => {
  it('目录、工作区、会话、任务消息全都到位', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: '插件dsh-whale-pal开发', task: '自动派活', brief: '做派活入口' },
      dispatchFile,
    })

    assert.equal(result.ok, true)
    assert.equal(result.reused, false, '第一次派活要新建会话')
    assert.equal(result.queued, false)
    const projectDir = join(root, '插件dsh-whale-pal开发')
    const taskDir = join(projectDir, '自动派活')
    const docPath = join(vault, DISPATCH_DOC_DIR, '插件dsh-whale-pal开发', '自动派活.md')

    assert.equal(result.projectDir, projectDir)
    assert.equal(result.taskDir, taskDir)
    assert.equal(result.docPath, docPath)
    assert.ok(existsSync(taskDir))
    assert.ok(existsSync(docPath))
    assert.match(readFileSync(docPath, 'utf8'), /做派活入口/)

    // 工作区：建了一个，标题用项目名
    assert.equal(host.registry.created.length, 1)
    assert.equal(host.registry.created[0].path, projectDir)
    assert.equal(host.registry.created[0].title, '插件dsh-whale-pal开发')

    // 会话：cwd 是项目目录，并且挂进了工作区
    assert.equal(host.controller.created.length, 1)
    assert.equal(host.controller.created[0].cwd, projectDir)
    assert.equal(result.sessionId, host.controller.created[0].id)
    assert.deepEqual(host.registry.created[0].sessionIds, [result.sessionId])
    assert.equal(result.grouped, true)

    // 任务消息：指向任务文档，并写明产出目录
    assert.equal(host.controller.prompts.length, 1)
    const sent = host.controller.prompts[0]
    assert.equal(sent.sessionId, result.sessionId)
    assert.equal(sent.mode, 'queue')
    assert.match(sent.requestId, /^whale-pal-dispatch-/)
    const text = sent.content[0].text
    assert.ok(text.includes(docPath), '任务消息要带任务文档的绝对路径')
    assert.ok(text.includes(taskDir), '任务消息要带产出目录')
    assert.ok(text.includes('【任务】自动派活'))

    // 权限档：派出去的会话要跑在用户选的那一档上
    assert.equal(result.permission, 'danger-full-access')
    assert.equal(host.controller.resolved[0].id, result.sessionId)
    assert.equal(host.permissionPresets.applied.length, 1)
    assert.equal(host.permissionPresets.applied[0].session, host.controller.resolved[0].session)
    assert.equal(host.permissionPresets.applied[0].name, 'danger-full-access')
    assert.equal(result.note, '', '一路顺利就不该有多余的话')

    // 账本：记下这个项目用哪条会话
    const state = readDispatchState(dispatchFile)
    assert.equal(state.projects['插件dsh-whale-pal开发'].sessionId, result.sessionId)
    assert.equal(state.projects['插件dsh-whale-pal开发'].permission, 'danger-full-access')
    assert.equal(state.queue.length, 0)
    assert.equal(state.sent.length, 1)
    assert.equal(state.sent[0].task, '自动派活')
  })

  it('权限档在任务消息之前切，别让它第一条命令就撞墙', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const order = []
    const originalSet = host.permissionPresets.set
    host.permissionPresets.set = (session, name) => {
      order.push('permission')
      originalSet(session, name)
    }
    const originalPrompt = host.controller.prompt
    host.controller.prompt = async (request) => {
      order.push('prompt')
      return originalPrompt(request)
    }
    await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.deepEqual(order, ['permission', 'prompt'])
  })

  it('宿主没给权限服务：照样派成，但要记一笔让它被盯着', async () => {
    const host = makeHost({ noPermission: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.permission, '')
    assert.equal(result.note, COPY.dispatchNoPermissionService)
  })

  it('权限档切不动：也照样派成，把原因带上', async () => {
    const host = makeHost({ permissionFails: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.permission, '')
    assert.ok(result.note.startsWith(COPY.dispatchPermissionFailed))
    assert.match(result.note, /没有这一档/)
  })

  it('宿主 resolveAgent 回 error：照样派成，把原因带上', async () => {
    const host = makeHost({ resolveError: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.permission, '')
    assert.ok(result.note.startsWith(COPY.dispatchPermissionFailed))
    assert.match(result.note, /还没挂上/)
  })

  it('外部给的任务文档：直接用，不再按模板新写', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const given = join(vault, '现成的.md')
    writeFileSync(given, '# 现成的\n', 'utf8')

    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't', doc: given },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })
    assert.equal(result.ok, true)
    assert.equal(result.docPath, given)
    assert.equal(result.docWritten, false)
    assert.equal(existsSync(taskDocPath(vault, 'p', 't')), false, '不该再写一份模板')
  })
})

describe('runDispatch：一项目一条执行会话', () => {
  it('同项目第二个任务：复用同一条会话，不再新建', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    const second = await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.reused, false)
    assert.equal(second.reused, true)
    assert.equal(second.sessionId, first.sessionId, '同项目只该有一条执行会话')
    assert.equal(host.registry.created.length, 1, '一个项目只该有一个工作区')
    assert.equal(host.controller.created.length, 1, '第二条任务不该再开会话')
    assert.equal(host.controller.prompts.length, 2)
    assert.equal(host.controller.prompts[1].sessionId, first.sessionId)
    assert.notEqual(host.controller.prompts[0].requestId, host.controller.prompts[1].requestId)
  })

  it('没有记录时按目录认已有会话：不新建', async () => {
    const projectDir = 'D:\\项目\\已有'
    const sessions = [
      { sessionId: 'old-1', cwd: 'd:\\项目\\已有\\', running: false, blank: false, updatedAt: 10 },
    ]
    const host = makeHost({ sessions })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    // 让项目目录解析到临时根下，会话的 cwd 跟着换。
    const realProjectDir = join(root, '已有')
    sessions[0].cwd = realProjectDir
    const result = await runAs(host, { api: makeApi(root, vault), args: { project: '已有', task: 't' }, dispatchFile })
    assert.equal(result.ok, true)
    assert.equal(result.reused, true)
    assert.equal(result.sessionId, 'old-1')
    assert.equal(host.controller.created.length, 0)
    assert.equal(host.controller.prompts[0].sessionId, 'old-1')
    assert.equal(projectDir === realProjectDir, false, '这条断言只是防止变量被误用')
  })

  it('记录里的会话被删了：新建一条并改记录，不报错', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    // 会话真的没了：清单里拿掉。
    host.controller.sessions.length = 0
    const second = await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })
    assert.equal(second.ok, true)
    assert.equal(second.reused, false)
    assert.notEqual(second.sessionId, first.sessionId)
    const state = readDispatchState(dispatchFile)
    assert.equal(state.projects.p.sessionId, second.sessionId)
  })

  it('记录里的会话被归档了：当没有，新建一条', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.registry.archivedSessionIds = [first.sessionId]
    const second = await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })
    assert.equal(second.ok, true)
    assert.equal(second.reused, false)
    assert.notEqual(second.sessionId, first.sessionId)
  })
})

describe('runDispatch：会话忙就排队', () => {
  it('在跑的会话不收新消息：任务进池，账本里留一条', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.sessions[0].running = true
    const second = await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })

    assert.equal(second.ok, true)
    assert.equal(second.queued, true)
    assert.equal(second.queueLength, 1)
    assert.equal(host.controller.prompts.length, 1, '忙的时候不该硬投')
    const state = readDispatchState(dispatchFile)
    assert.equal(state.queue.length, 1)
    assert.equal(state.queue[0].task, '第二件')
    assert.equal(state.queue[0].sessionId, first.sessionId)
  })

  it('会话空下来：池里的任务自动投，出池进历史', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.sessions[0].running = true
    await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })

    host.controller.sessions[0].running = false
    const flushed = await flushQueuedTasks({ getService: host.getService, dispatchFile })
    assert.equal(flushed.sent.length, 1)
    assert.equal(flushed.remaining, 0)
    assert.equal(host.controller.prompts.length, 2)
    assert.equal(host.controller.prompts[1].sessionId, first.sessionId)
    const state = readDispatchState(dispatchFile)
    assert.equal(state.queue.length, 0)
    assert.equal(state.sent.filter((item) => item.task === '第二件').length, 1)
  })

  it('投递的 requestId 跟着池项走：重投不会换号', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.sessions[0].running = true
    await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })
    const queued = readDispatchState(dispatchFile).queue[0]
    host.controller.sessions[0].running = false
    await flushQueuedTasks({ getService: host.getService, dispatchFile })
    assert.equal(host.controller.prompts[1].requestId, `whale-pal-dispatch-${queued.id}`)
  })

  it('没人管的时候池子还在：换一份宿主接着投（重启后恢复）', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.sessions[0].running = true
    await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })

    // 模拟重启：新的一批服务对象，会话清单还是同一条会话。
    const restarted = makeHost({
      sessions: [{ sessionId: first.sessionId, cwd: join(root, 'p'), running: false, blank: false, updatedAt: 1 }],
    })
    const flushed = await flushQueuedTasks({ getService: restarted.getService, dispatchFile })
    assert.equal(flushed.sent.length, 1)
    assert.equal(restarted.controller.prompts.length, 1)
    assert.equal(readDispatchState(dispatchFile).queue.length, 0)
  })

  it('执行会话被删了：池里的任务不投，出池并记下原因', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.sessions[0].running = true
    await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })
    host.controller.sessions.length = 0

    const flushed = await flushQueuedTasks({ getService: host.getService, dispatchFile })
    assert.deepEqual(flushed.dropped.length, 1)
    assert.equal(host.controller.prompts.length, 1, '会话没了就别投')
    const state = readDispatchState(dispatchFile)
    assert.equal(state.queue.length, 0)
    assert.equal(state.sent.at(-1).lastError, 'session-gone')
  })

  it('执行会话被归档了：池里的任务也不投', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.sessions[0].running = true
    await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })
    host.registry.archivedSessionIds = [first.sessionId]

    const flushed = await flushQueuedTasks({ getService: host.getService, dispatchFile })
    assert.deepEqual(flushed.dropped.length, 1)
    assert.equal(readDispatchState(dispatchFile).sent.at(-1).lastError, 'archived')
  })

  it('池是空的：冲池什么都不做', async () => {
    const host = makeHost()
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const flushed = await flushQueuedTasks({ getService: host.getService, dispatchFile })
    assert.deepEqual(flushed, { sent: [], dropped: [], remaining: 0 })
  })
})

describe('pickReusableSession', () => {
  const base = { sessionId: 'a', cwd: 'D:\\项目\\甲', running: false, blank: false, updatedAt: 5 }

  it('同一个目录才算同一个项目：末尾斜杠和大小写不算区别', () => {
    assert.equal(sameDir('D:\\项目\\甲', 'd:\\项目\\甲\\'), true)
    assert.equal(sameDir('D:\\项目\\甲', 'D:\\项目\\甲二'), false)
    assert.equal(sameDir('', ''), false)
  })

  it('子代理产物、分支子会话、归档会话、别的目录，全都不算', () => {
    const sessions = [
      { ...base, sessionId: 'sub', origin: 'subagent' },
      { ...base, sessionId: 'child', parentSessionId: 'a' },
      { ...base, sessionId: 'archived' },
      { ...base, sessionId: 'other', cwd: 'D:\\项目\\乙' },
      { ...base, sessionId: 'ok', updatedAt: 9 },
    ]
    const picked = pickReusableSession({
      sessions,
      archived: ['archived'],
      projectDir: 'D:\\项目\\甲',
      record: null,
    })
    assert.equal(picked.sessionId, 'ok')
  })

  it('记录里那条优先，哪怕有更近动过的', () => {
    const sessions = [
      { ...base, sessionId: 'remembered', updatedAt: 1 },
      { ...base, sessionId: 'newer', updatedAt: 99 },
    ]
    const picked = pickReusableSession({
      sessions,
      archived: [],
      projectDir: 'D:\\项目\\甲',
      record: { sessionId: 'remembered' },
    })
    assert.equal(picked.sessionId, 'remembered')
  })

  it('一句都没说过的空会话不认（接活等于接在没人用过的壳上）', () => {
    const picked = pickReusableSession({
      sessions: [{ ...base, blank: true }],
      archived: [],
      projectDir: 'D:\\项目\\甲',
      record: null,
    })
    assert.equal(picked, null)
  })
})

describe('runDispatch：任务没递进去', () => {
  it('新建的会话：把空会话归档，并如实说是哪一步失败', async () => {
    const host = makeHost({ promptFails: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runAs(host, {
      api: makeApi(root, vault),
      args: { project: 'p', task: 't' },
      dispatchFile: join(tempDir('data'), 'dispatch.json'),
    })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'prompt-failed')
    assert.equal(result.message, COPY.dispatchPromptFailed)
    assert.equal(result.archived, true)
    assert.deepEqual(host.registry.archived, [result.sessionId], '空会话不能留在侧栏')
    assert.match(result.detail, /宿主拒绝/)
  })

  it('复用的会话：不归档，任务进池等它空下来重投', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const dispatchFile = join(tempDir('data'), 'dispatch.json')
    const api = makeApi(root, vault)
    const first = await runAs(host, { api, args: { project: 'p', task: '第一件' }, dispatchFile })
    host.controller.prompt = async () => {
      throw new Error('宿主拒绝')
    }
    const second = await runAs(host, { api, args: { project: 'p', task: '第二件' }, dispatchFile })

    assert.equal(second.ok, true)
    assert.equal(second.queued, true)
    assert.match(second.note, /待派池/)
    assert.deepEqual(host.registry.archived, [], '复用的会话不能归档')
    const state = readDispatchState(dispatchFile)
    assert.equal(state.queue.length, 1)
    assert.match(state.queue[0].lastError, /宿主拒绝/)
    assert.equal(state.projects.p.sessionId, first.sessionId)
  })
})

describe('dispatchPrompt', () => {
  it('第一行就是任务名，并说清不是用户手工写的', () => {
    const text = dispatchPrompt({ task: '自动派活', docPath: 'D:\\a.md', taskDir: 'D:\\t' })
    assert.ok(text.startsWith('【任务】自动派活'))
    assert.ok(text.includes('不是用户手工写的'))
    assert.ok(text.includes('D:\\a.md'))
  })

  it('写盘那句留了口子：任务文档说不写就不写，冲突时以文档为准', () => {
    const text = dispatchPrompt({ task: 't', docPath: 'D:\\a.md', taskDir: 'D:\\t' })
    assert.ok(text.includes('如果要写盘'), '不能硬说「产出写到这个目录」')
    assert.ok(text.includes('以任务文档为准'))
  })
})

describe('newDispatchId', () => {
  it('时间在前、尾巴三位，够区分同一毫秒里的两条', () => {
    const a = newDispatchId(1700000000000)
    const b = newDispatchId(1700000000000)
    assert.match(a, /^d[0-9a-z]+$/)
    assert.equal(a.length, b.length)
    assert.ok(newDispatchId(1700000000001) > a, '时间大的排在后面')
  })
})
