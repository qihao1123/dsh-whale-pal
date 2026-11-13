// 审计日志不能无限长。
//
// 真机 2026-11 的 audit.jsonl 已经 900 多条 / 1.2 MB，写入口只追加、没人清。
// 轮转函数（`rotateIfNeeded`）本来就有，但一直没有调用方 —— 等于没有。
// 这两个用例锁的是「写前判轮转」这一步真的接上了，而且轮转不会把序号打回去。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveDataPaths } from '../lib/paths.js'
import { applyPersona } from '../lib/persona/index.js'

/** 和 lib/persona/index.js 的 AUDIT_MAX_BYTES 同一个数：超过它就轮转。 */
const LIMIT = 4 * 1024 * 1024

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'whale-pal-audit-'))
  const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })
  const ctx = {
    effect(fn) {
      fn()
    },
    on() {
      return () => {}
    },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
  }
  return { home, resolved, ctx }
}

test('审计超过 4 MB 就轮转：旧档留一份、当前文件重新开始、序号接着旧盘走', () => {
  const { home, resolved, ctx } = setup()
  try {
    // 造一份超过阈值的审计，每行都是一条合法 JSON，和真盘同形。
    const filler = 'x'.repeat(1000)
    const lines = []
    for (let seq = 1; seq <= 4400; seq += 1) {
      lines.push(JSON.stringify({ seq, at: '2026-11-01T00:00:00.000Z', type: 'bulk', detail: filler }))
    }
    mkdirSync(resolved.paths.root, { recursive: true })
    writeFileSync(resolved.paths.audit, `${lines.join('\n')}\n`, 'utf8')
    const before = statSync(resolved.paths.audit).size
    assert.ok(before >= LIMIT, '夹具本身就得超过阈值')

    // 序号记在 state 里，不在文件里数出来：盘上已经写到 4400。
    writeFileSync(resolved.paths.state, JSON.stringify({ revision: 1, audit: { lastSeq: 4400 } }), 'utf8')

    const api = applyPersona(ctx, { paths: resolved.paths, log: () => {} })
    api.setConfig({ ...api.getConfig() }, 'test')

    const backup = `${resolved.paths.audit}.1`
    assert.ok(existsSync(backup), '超过阈值该轮转出 .1')
    assert.equal(statSync(backup).size, before, '.1 收下全部旧内容')

    const rows = readFileSync(resolved.paths.audit, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(rows.length, 1, '当前文件只剩轮转之后新写的那条')
    assert.equal(rows[0].type, 'config')
    assert.equal(rows[0].seq, 4401, '序号接着旧盘往下走，不从 1 重数')

    // 没到阈值就不再动 .1：轮转是阈值触发，不是每次都备份。
    api.setConfig({ ...api.getConfig() }, 'test-again')
    assert.equal(statSync(backup).size, before, '.1 只留上一次轮转的内容')
    assert.equal(
      readFileSync(resolved.paths.audit, 'utf8').trim().split('\n').length,
      2,
      '第二条照常追加进当前文件',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
