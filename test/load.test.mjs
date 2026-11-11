/**
 * 装载与健康：六步、三级失败态、三色、退出标记、72 小时窗口。
 *
 * 这里只用临时目录，不碰真数据。判据是「哪一种坏法该落到哪一级」，
 * 而不是「代码跑了没」——降级顺序错了，用户看到的就是误导。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  COLOR,
  LEVEL,
  SCHEMA_VERSION,
  classify,
  dataDirInsideVault,
  graceWindow,
  installedAt,
  loadReport,
  loadSteps,
  markCleanExit,
  readRunState,
} from '../lib/load.js'

function tempDir(prefix = 'whale-load-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 一份干净的数据目录：config 与 state 都能解析。 */
function goodPaths() {
  const root = tempDir()
  const config = join(root, 'config.json')
  const state = join(root, 'state.json')
  writeFileSync(config, JSON.stringify({ bot_name: '六一' }), 'utf8')
  writeFileSync(state, JSON.stringify({ revision: 3 }), 'utf8')
  return { root, config, state, runState: join(root, 'run-state.json') }
}

const registered = { routes: 1, commands: 1, tools: 1, sections: 1 }

describe('装载六步', () => {
  it('步骤按顺序都有 id，一个不多一个不少', () => {
    const steps = loadSteps({ paths: goodPaths(), registered })
    assert.deepEqual(
      steps.map((step) => step.id),
      ['package', 'config', 'data', 'vault', 'state', 'mounted', 'selftest'],
    )
  })

  it('数据目录还不存在也算能写：全新安装不该被判成故障', () => {
    const root = tempDir()
    const steps = loadSteps({ paths: { root, config: join(root, 'config.json') }, registered })
    const data = steps.find((step) => step.id === 'data')
    assert.equal(data.ok, true)
    const config = steps.find((step) => step.id === 'config')
    assert.equal(config.ok, true)
  })

  it('探针写完就删：目录里不留 .probe 文件', () => {
    const paths = goodPaths()
    loadSteps({ paths, registered })
    const steps = loadSteps({ paths, registered })
    const data = steps.find((step) => step.id === 'data')
    assert.equal(data.detail.includes('探针没删掉'), false)
  })

  it('有一项没挂上时，mounted 那行把原因念出来', () => {
    const steps = loadSteps({
      paths: goodPaths(),
      registered: { ...registered, warnings: ['工具没挂上：shape rejected'] },
    })
    const mounted = steps.find((step) => step.id === 'mounted')
    assert.equal(mounted.ok, true)
    assert.match(mounted.detail, /tools 1/)
    assert.match(mounted.detail, /没挂上：工具没挂上：shape rejected/)
  })

  it('挂载数量从实测来，没拿到就判没挂上', () => {
    const steps = loadSteps({ paths: goodPaths(), registered: null })
    const mounted = steps.find((step) => step.id === 'mounted')
    assert.equal(mounted.ok, false)
    assert.equal(mounted.detail, '没拿到注册数量')
  })
})

describe('笔记库能不能写', () => {
  it('没选库就跳过，不算故障', () => {
    const steps = loadSteps({ paths: goodPaths(), registered })
    const vault = steps.find((step) => step.id === 'vault')
    assert.equal(vault.ok, true)
    assert.equal(vault.detail, '还没选笔记库，跳过')
  })

  it('库里目录不在了：只读，黄色', () => {
    const paths = goodPaths()
    writeFileSync(paths.config, JSON.stringify({ bot_name: '六一', knowledge: { vaultPath: join(paths.root, '没有这个库') } }), 'utf8')
    const report = loadReport({ paths, registered })
    assert.equal(report.state, LEVEL.READONLY)
    assert.equal(report.color, COLOR.YELLOW)
    assert.ok(report.notes.some((note) => note.includes('笔记库目录不在了')))
  })

  it('去库里只看不写：库内一个字节都不多出来', () => {
    const paths = goodPaths()
    const vault = join(paths.root, '库')
    mkdirSync(vault, { recursive: true })
    writeFileSync(join(vault, '笔记.md'), '# 一\n', 'utf8')
    writeFileSync(paths.config, JSON.stringify({ knowledge: { vaultPath: vault } }), 'utf8')
    const before = readdirSync(vault).join(',')
    loadSteps({ paths, registered })
    assert.equal(readdirSync(vault).join(','), before)
  })
})

describe('三级失败态与三色', () => {
  it('配置是坏 JSON：停用，红色，不去猜', () => {
    const root = tempDir()
    const config = join(root, 'config.json')
    writeFileSync(config, '{ 不是 JSON', 'utf8')
    const report = loadReport({ paths: { root, config }, registered })
    assert.equal(report.state, LEVEL.DISABLED)
    assert.equal(report.color, COLOR.RED)
    assert.equal(report.ok, false)
  })

  it('状态读不出来：停用，红色', () => {
    const root = tempDir()
    const state = join(root, 'state.json')
    writeFileSync(state, '{', 'utf8')
    const report = loadReport({ paths: { root, state }, registered })
    assert.equal(report.state, LEVEL.DISABLED)
  })

  it('状态版本比认识的更新：停用，不猜', () => {
    const root = tempDir()
    const state = join(root, 'state.json')
    writeFileSync(state, JSON.stringify({ revision: 1, schemaVersion: SCHEMA_VERSION + 1 }), 'utf8')
    const report = loadReport({ paths: { root, state }, registered })
    assert.equal(report.state, LEVEL.DISABLED)
  })

  it('数据目录写不了：只读，黄色（不是停用）', () => {
    const root = tempDir()
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    // 配置路径给全，只是它在「文件占了目录位置」那边，数据那一步才会单独坏。
    const report = loadReport({ paths: { root: blocker, config: join(blocker, 'config.json') }, registered })
    assert.equal(report.state, LEVEL.READONLY)
    assert.equal(report.color, COLOR.YELLOW)
    assert.equal(report.ok, false)
  })

  it('挂载对不上：停用——这时候说正常是骗人', () => {
    const report = loadReport({ paths: goodPaths(), registered: null })
    assert.equal(report.state, LEVEL.DISABLED)
  })

  it('一切正常：绿色，notes 为空', () => {
    const report = loadReport({ paths: goodPaths(), registered })
    assert.equal(report.state, LEVEL.NORMAL)
    assert.equal(report.color, COLOR.GREEN)
    assert.equal(report.ok, true)
    assert.deepEqual(report.notes, [])
  })

  it('上次没干净退出只记录，不改级别', () => {
    const paths = goodPaths()
    writeFileSync(paths.runState, JSON.stringify({ status: 'running', at: '2026-01-01T00:00:00.000Z' }), 'utf8')
    const report = loadReport({ paths, registered })
    assert.equal(report.state, LEVEL.NORMAL)
    assert.equal(report.notes.includes('上次没干净退出，能自愈'), true)
  })

  it('classify 只认第一处坏：配置坏压过数据坏', () => {
    const verdict = classify([
      { id: 'config', ok: false, detail: '配置坏了' },
      { id: 'data', ok: false, detail: '数据写不了' },
    ])
    assert.equal(verdict.state, LEVEL.DISABLED)
  })
})

describe('退出标记', () => {
  it('没有文件就是首次启动', () => {
    assert.equal(readRunState(goodPaths()), null)
  })

  it('留了 clean 就认得出干净退出', () => {
    const paths = goodPaths()
    assert.equal(markCleanExit(paths), true)
    const read = readRunState(paths)
    assert.equal(read.status, 'clean')
    assert.equal(typeof read.at, 'string')
  })

  it('退出标记写不了也不抛：返回 false', () => {
    assert.equal(markCleanExit({ runState: join(tempDir(), 'no', 'such', 'dir', 'run.json') }), false)
  })
})

describe('72 小时只读复核窗口', () => {
  it('没有更早的东西就不开窗', () => {
    const window = graceWindow({ root: join(tempDir(), 'absent') })
    assert.equal(window.active, false)
  })

  it('新装就开窗，到点自动关', () => {
    const paths = goodPaths()
    const since = installedAt(paths)
    assert.notEqual(since, null)
    const fresh = graceWindow(paths, Date.parse(since) + 60_000)
    assert.equal(fresh.active, true)
    assert.equal(Date.parse(fresh.readOnlyUntil), Date.parse(since) + 72 * 3600 * 1000)
    const later = graceWindow(paths, Date.parse(since) + 73 * 3600 * 1000)
    assert.equal(later.active, false)
  })
})

describe('数据目录落在库内时', () => {
  it('同目录或子目录算在内，兄弟目录不算', () => {
    assert.equal(dataDirInsideVault({ root: 'D:\\vault\\data' }, 'D:\\vault'), true)
    assert.equal(dataDirInsideVault({ root: 'D:\\vault' }, 'D:\\vault'), true)
    assert.equal(dataDirInsideVault({ root: 'D:\\vault-other' }, 'D:\\vault'), false)
    assert.equal(dataDirInsideVault({ root: 'D:\\data' }, ''), false)
  })
})
