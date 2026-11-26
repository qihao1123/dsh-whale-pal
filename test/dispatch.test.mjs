/**
 * 派活：只测这一层自己的判断——路径怎么拼、名字怎么收、什么情况拒、失败怎么兜底。
 *
 * 不碰真 DSH：工作区注册表和会话控制器都用假的，真盘子只用临时目录。
 * 这里最容易错的是「半成品」——目录建了、会话建了、但首条消息没递进去，
 * 侧栏就多一条点进去是空的。所以兜底那一条单独测。
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
  DISPATCH_PERMISSIONS,
  dispatchPrompt,
  ensureWorkspace,
  renderTaskDoc,
  runDispatch,
  safeName,
  taskDocPath,
  writeChiefInstruction,
} from '../lib/dispatch.js'

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `whale-dispatch-${name}-`))
}

function makeHost({
  promptFails = false,
  noRegistry = false,
  noController = false,
  noPermission = false,
  permissionFails = false,
  resolveError = false,
} = {}) {
  const workspaces = []
  let seq = 0
  const registry = {
    created: workspaces,
    archived: [],
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
    async create({ cwd }) {
      const id = `s-${(seq += 1)}`
      controller.created.push({ id, cwd })
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
  const services = {
    workspaceRegistry: noRegistry ? null : registry,
    sessionController: noController ? null : controller,
    permissionPresets: noPermission ? null : permissionPresets,
  }
  return {
    getService: (key) => services[key] ?? null,
    registry,
    controller,
    permissionPresets,
  }
}

function makeApi(workRoot, vaultPath) {
  return {
    getConfig: () => ({ knowledge: { workRoot, vaultPath } }),
  }
}

/**
 * 测试默认走「完全放开」这一档——绝大多数用例关心的不是权限。
 * 权限档本身的判断单独用 runDispatch 测，别让这个默认值把那条路盖住。
 */
function runFree(options) {
  return runDispatch({
    ...options,
    args: { permission: 'danger-full-access', ...(options?.args ?? {}) },
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

describe('runDispatch：权限档', () => {
  it('没给权限档：拒绝，磁盘上什么都不留', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runDispatch({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-required')
    assert.equal(result.message, COPY.dispatchPermissionRequired)
    assert.equal(existsSync(join(root, 'p')), false, '没定权限就不该建目录')
    assert.equal(host.registry.created.length, 0, '也不该注册工作区')
    assert.equal(host.controller.created.length, 0, '也不该开会话')
  })

  it('给了一个不存在的档：拒绝，不静默退默认', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runDispatch({
      api: makeApi(root, vault),
      getService: host.getService,
      args: { project: 'p', task: 't', permission: 'auto' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'permission-invalid')
    assert.equal(result.message, COPY.dispatchPermissionInvalid)
    assert.equal(host.controller.created.length, 0)
  })

  it('选「只能写工作区」：切的就是这一档，不偷换成完全放开', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runDispatch({
      api: makeApi(root, vault),
      getService: host.getService,
      args: { project: 'p', task: 't', permission: 'workspace-write' },
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
  it('工作区总路径空着：报错指向设置页，一个目录都不建', async () => {
    const host = makeHost()
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi('', vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'workRoot-missing')
    assert.equal(result.message, COPY.workRootRequired)
    assert.equal(host.controller.created.length, 0)
  })

  it('记忆空间没设：也说清楚，不猜', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const result = await runFree({ api: makeApi(root, ''), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'vault-missing')
    assert.equal(result.message, COPY.dispatchVaultMissing)
  })

  it('同名任务的产出目录已经在：拒绝，不合并', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const first = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(first.ok, true)
    const second = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(second.ok, false)
    assert.equal(second.error, 'task-exists')
    assert.equal(second.message, COPY.dispatchTaskExists)
  })

  it('任务文档已经在：默认不覆盖', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    const again = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't', overwrite: true } })
    // 产出目录还挡在前面，所以这里先看到的是 task-exists；换一个没建过产出目录的路径不会被挡。
    assert.equal(again.ok, false)
    assert.equal(again.error, 'task-exists')
  })

  it('宿主没给工作区注册表：不动盘就失败', async () => {
    const host = makeHost({ noRegistry: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-workspace-registry')
    assert.equal(result.message, COPY.dispatchNoRegistry)
    assert.equal(existsSync(join(root, 'p')), false, '服务不在就别留半个目录')
  })

  it('宿主没给会话控制器：不动盘就失败', async () => {
    const host = makeHost({ noController: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-session-controller')
    assert.equal(existsSync(join(root, 'p')), false)
  })

  it('外部任务文档路径不存在：拒绝，不建目录', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({
      api: makeApi(root, vault),
      getService: host.getService,
      args: { project: 'p', task: 't', doc: join(vault, '没有这份.md') },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'doc-missing')
    assert.equal(existsSync(join(root, 'p', 't')), false)
  })
})

describe('runDispatch：成功那一趟', () => {
  it('目录、工作区、会话、首条消息全都到位', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({
      api: makeApi(root, vault),
      getService: host.getService,
      args: { project: '插件dsh-whale-pal开发', task: '自动派活', brief: '做派活入口' },
    })

    assert.equal(result.ok, true)
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

    // 首条消息：指向任务文档，并写明产出目录
    assert.equal(host.controller.prompts.length, 1)
    const sent = host.controller.prompts[0]
    assert.equal(sent.sessionId, result.sessionId)
    assert.equal(sent.mode, 'queue')
    const text = sent.content[0].text
    assert.ok(text.includes(docPath), '首条消息要带任务文档的绝对路径')
    assert.ok(text.includes(taskDir), '首条消息要带产出目录')
    assert.ok(text.includes('【任务】自动派活'))

    // 权限档：派出去的会话要跑在用户选的那一档上
    assert.equal(result.permission, 'danger-full-access')
    assert.equal(host.controller.resolved[0].id, result.sessionId, '切的必须是刚建的那条会话')
    assert.equal(host.permissionPresets.applied.length, 1)
    assert.equal(host.permissionPresets.applied[0].session, host.controller.resolved[0].session)
    assert.equal(host.permissionPresets.applied[0].name, 'danger-full-access')
    assert.equal(result.note, '', '一路顺利就不该有多余的话')
  })

  it('权限档在首条消息之前切，别让它第一条命令就撞墙', async () => {
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
    await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.deepEqual(order, ['permission', 'prompt'])
  })

  it('宿主没给权限服务：照样派成，但要记一笔让它被盯着', async () => {
    const host = makeHost({ noPermission: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, true)
    assert.equal(result.permission, '')
    assert.equal(result.note, COPY.dispatchNoPermissionService)
  })

  it('权限档切不动：也照样派成，把原因带上', async () => {
    const host = makeHost({ permissionFails: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, true)
    assert.equal(result.permission, '')
    assert.ok(result.note.startsWith(COPY.dispatchPermissionFailed))
    assert.match(result.note, /没有这一档/)
  })

  it('宿主 resolveAgent 回 error：照样派成，把原因带上', async () => {
    const host = makeHost({ resolveError: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })
    assert.equal(result.ok, true)
    assert.equal(result.permission, '')
    assert.ok(result.note.startsWith(COPY.dispatchPermissionFailed))
    assert.match(result.note, /还没挂上/)
  })

  it('同项目第二个任务：复用工作区，只多开一条会话', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const api = makeApi(root, vault)
    const first = await runFree({ api, getService: host.getService, args: { project: 'p', task: '第一件' } })
    const second = await runFree({ api, getService: host.getService, args: { project: 'p', task: '第二件' } })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(host.registry.created.length, 1, '一个项目只该有一个工作区')
    assert.equal(host.controller.created.length, 2)
    assert.deepEqual(host.registry.created[0].sessionIds, [first.sessionId, second.sessionId])
  })

  it('外部给的任务文档：直接用，不再按模板新写', async () => {
    const host = makeHost()
    const root = tempDir('root')
    const vault = tempDir('vault')
    const given = join(vault, '现成的.md')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(given, '# 现成的\n', 'utf8')

    const result = await runFree({
      api: makeApi(root, vault),
      getService: host.getService,
      args: { project: 'p', task: 't', doc: given },
    })
    assert.equal(result.ok, true)
    assert.equal(result.docPath, given)
    assert.equal(result.docWritten, false)
    assert.equal(existsSync(taskDocPath(vault, 'p', 't')), false, '不该再写一份模板')
  })
})

describe('runDispatch：首条消息没递进去', () => {
  it('把空会话归档，并如实说是哪一步失败', async () => {
    const host = makeHost({ promptFails: true })
    const root = tempDir('root')
    const vault = tempDir('vault')
    const result = await runFree({ api: makeApi(root, vault), getService: host.getService, args: { project: 'p', task: 't' } })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'prompt-failed')
    assert.equal(result.message, COPY.dispatchPromptFailed)
    assert.equal(result.archived, true)
    assert.deepEqual(host.registry.archived, [result.sessionId], '空会话不能留在侧栏')
    assert.match(result.detail, /宿主拒绝/)
  })
})

describe('dispatchPrompt', () => {
  it('第一行就是任务名，并说清不是用户手工开的', () => {
    const text = dispatchPrompt({ task: '自动派活', docPath: 'D:\\a.md', taskDir: 'D:\\t' })
    assert.ok(text.startsWith('【任务】自动派活'))
    assert.ok(text.includes('不是用户手工开的会话'))
    assert.ok(text.includes('D:\\a.md'))
  })

  it('写盘那句留了口子：任务文档说不写就不写，冲突时以文档为准', () => {
    const text = dispatchPrompt({ task: 't', docPath: 'D:\\a.md', taskDir: 'D:\\t' })
    assert.ok(text.includes('如果要写盘'), '不能硬说「产出写到这个目录」')
    assert.ok(text.includes('以任务文档为准'))
  })
})
