/**
 * 命令回执：成功不吭声，失败塞一行（2026-11-11 定的口径，原话「只让失败说话」）。
 *
 * 只有一条真实路径：`registerSurface` 注册给宿主的那个 handler。所以除了这里测文案边界，
 * `surface.test.mjs` 里还有一条从注册入口打进去的（跑的是线上那一个，不是返回值）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { receiptLine, withFailureReceipt } from '../lib/receipt.js'

describe('回执文案', () => {
  it('成功一个字都不说', () => {
    assert.equal(receiptLine({ kind: 'success', text: '绑好了' }, 'mode whale'), '')
  })

  it('失败才说，带上是哪条命令和原因', () => {
    const line = receiptLine({ kind: 'error', text: '没有这个模式' }, 'mode 阴阳')
    assert.equal(line, '[whale-pal] /whale mode 阴阳 失败：没有这个模式')
  })

  it('命令名压成单行、掐到 40 字：回执只用来认路，不复制整段参数', () => {
    const raw = `ctx search ${'很长的词 '.repeat(20)}`
    const line = receiptLine({ kind: 'error', text: '没找到' }, raw)
    assert.equal(line.includes('\n'), false)
    const command = line.slice('[whale-pal] /whale '.length, line.indexOf(' 失败：'))
    assert.ok(command.length <= 40)
  })

  it('原因也压成单行；太长就截到 300 字', () => {
    const line = receiptLine({ kind: 'error', text: `${'错'.repeat(500)}\n第二行` }, 'bind')
    assert.equal(line.includes('\n'), false)
    assert.ok(line.length <= '[whale-pal] /whale bind 失败：'.length + 300)
  })

  it('没有原因也说得出口，不编一个', () => {
    assert.equal(receiptLine({ kind: 'error', text: '' }, 'bind'), '[whale-pal] /whale bind 失败')
    assert.equal(receiptLine({ kind: 'error' }, ''), '[whale-pal] /whale 失败')
  })

  it('不是命令结果的（null、没 kind）一律不说', () => {
    assert.equal(receiptLine(null), '')
    assert.equal(receiptLine({}), '')
  })
})

describe('塞进会话', () => {
  it('失败时 inject 一条，形状照宿主收的那样，返回的还是原结果', () => {
    const injected = []
    const result = { kind: 'error', text: '绑不上' }
    const returned = withFailureReceipt({
      agent: { inject: (message) => injected.push(message) },
      result,
      rawInput: 'bind',
    })
    assert.equal(returned, result, '命令结果原样返回，回执不改它')
    assert.equal(injected.length, 1)
    assert.equal(injected[0].role, 'user')
    assert.equal(injected[0].source.kind, 'dsh-whale-pal')
    assert.equal(injected[0].content[0].text, '[whale-pal] /whale bind 失败：绑不上')
    assert.equal(typeof injected[0].id, 'string')
  })

  it('成功不塞；没有会话（没有 inject）也不塞、不抛', () => {
    const injected = []
    const agent = { inject: (message) => injected.push(message) }
    const ok = withFailureReceipt({ agent, result: { kind: 'success', text: '好了' }, rawInput: 'bind' })
    assert.equal(ok.kind, 'success')
    assert.equal(injected.length, 0)

    const logs = []
    const failed = { kind: 'error', text: '绑不上' }
    assert.equal(withFailureReceipt({ agent: null, result: failed, rawInput: 'bind', log: (m) => logs.push(m) }), failed)
    assert.equal(logs.length, 1, '塞不进去只在日志里留一句')
  })

  it('inject 自己抛错也不连累命令：结果照回，只记一行日志', () => {
    const logs = []
    const result = { kind: 'error', text: '绑不上' }
    const returned = withFailureReceipt({
      agent: {
        inject() {
          throw new Error('session is busy')
        },
      },
      result,
      rawInput: 'bind',
      log: (m) => logs.push(m),
    })
    assert.equal(returned, result)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /session is busy/)
  })
})
