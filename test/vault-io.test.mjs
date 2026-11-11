/**
 * 碰盘那一层：只 readdir / stat，不改任何东西。
 *
 * 最要紧的一条是「`.obsidian/` 零写入」——拿整树 mtime+size 指纹前后比，
 * 只要碰过一次就断言失败。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  detectOnDisk,
  listVaultNotes,
  obsidianConfigPath,
  treePrint,
  vaultReady,
} from '../lib/vault-io.js'

let root = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'whale-pal-vault-'))
  mkdirSync(join(root, '日记'), { recursive: true })
  mkdirSync(join(root, '.obsidian'), { recursive: true })
  mkdirSync(join(root, '.trash'), { recursive: true })
  writeFileSync(join(root, '日记', '2026-11-03.md'), '# 今天\n')
  writeFileSync(join(root, '根笔记.md'), '# 根\n')
  writeFileSync(join(root, '不算.txt'), 'x')
  writeFileSync(join(root, '.obsidian', 'workspace.json'), '{}')
  writeFileSync(join(root, '.trash', '旧.md'), '# 旧\n')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('vault-io：配置文件路径', () => {
  it('按 APPDATA 拼，没有 APPDATA 就回空串', () => {
    assert.equal(
      obsidianConfigPath({ APPDATA: 'C:/Users/x/AppData/Roaming' }),
      join('C:/Users/x/AppData/Roaming', 'obsidian', 'obsidian.json'),
    )
    assert.equal(obsidianConfigPath({}), '')
  })

  it('开关关着时，检测只问存在性，不读内容', () => {
    const info = detectOnDisk({ enabled: false, env: { APPDATA: 'C:/definitely-not-here' } })
    assert.equal(info.state, 'absent')
    assert.equal(info.source, 'existence')
  })
})

describe('vault-io：列笔记', () => {
  it('只要 .md，跳过排除目录，路径用正斜杠并排序', () => {
    const result = listVaultNotes(root)
    assert.equal(result.ok, true)
    assert.deepEqual(result.notes, ['日记/2026-11-03.md', '根笔记.md'])
  })

  it('路径空着与目录不在，各回各的错', () => {
    assert.deepEqual(listVaultNotes(''), { ok: false, error: 'vaultPath-required', notes: [] })
    assert.deepEqual(listVaultNotes(join(root, '不存在')), { ok: false, error: 'vault-missing', notes: [] })
  })

  it('列一遍之后，整棵树一个字节都没动', () => {
    const before = treePrint(root)
    listVaultNotes(root)
    const after = treePrint(root)
    assert.deepEqual(after, before)
  })

  it('数据目录若落在库内，排除掉之后不把自己的 json 当笔记', () => {
    // 库内临时造一个数据目录，里面放一个 .md，装成我们自己的数据。
    const dataDir = join(root, '库内数据')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, '不该出现.md'), '# 我\n')
    try {
      const withData = listVaultNotes(root)
      assert.equal(withData.notes.includes('库内数据/不该出现.md'), true)
      const excluded = listVaultNotes(root, { excludePaths: [dataDir] })
      assert.equal(excluded.notes.includes('库内数据/不该出现.md'), false)
      assert.deepEqual(excluded.notes, ['日记/2026-11-03.md', '根笔记.md'])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('.obsidian/ 与 .trash/ 里的东西不进指纹结论之外，也不被当笔记', () => {
    const print = treePrint(root)
    assert.ok(Object.hasOwn(print, '.obsidian/workspace.json'))
    const result = listVaultNotes(root)
    assert.equal(
      result.notes.some((note) => note.startsWith('.obsidian') || note.startsWith('.trash')),
      false,
    )
  })
})

describe('vault-io：库就绪检查', () => {
  it('没路径、目录不在、正常，三种回法', () => {
    assert.deepEqual(vaultReady({}), {
      ok: false,
      error: 'vaultPath-required',
      message: '还没填笔记库路径，库相关的事都做不了',
    })
    assert.equal(vaultReady({ knowledge: { vaultPath: join(root, '不存在') } }).error, 'vault-missing')
    assert.deepEqual(vaultReady({ knowledge: { vaultPath: root } }), { ok: true, path: root })
  })
})
