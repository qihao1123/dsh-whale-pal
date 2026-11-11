import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  blocksToText,
  createTranscript,
  describeSubstance,
  hasSubstance,
  ingestEvent,
  messageToText,
  renderTranscript,
  takePending,
} from '../lib/transcript.js'

function userEvent(text, kind = 'user') {
  return {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source: kind ? { kind } : undefined },
  }
}

function assistantEvent(blocks) {
  return { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: blocks } } }
}

test('blocksToText 只取 text 块，工具调用与图片丢掉', () => {
  const text = blocksToText([
    { type: 'text', text: '第一句' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'text', text: '第二句' },
    { type: 'image', source: {} },
  ])
  assert.equal(text, '第一句\n第二句')
})

test('messageToText 兼容裸字符串与 message.content', () => {
  assert.equal(blocksToText('直接是字符串'), '直接是字符串')
  assert.equal(messageToText({ content: [{ type: 'text', text: '  hello  ' }] }), 'hello')
  assert.equal(messageToText({ text: '短写' }), '短写')
  assert.equal(messageToText(null), '')
})

test('人说的话会被记下', () => {
  const buffer = createTranscript()
  assert.equal(ingestEvent(buffer, userEvent('帮我把这段代码改一下')), true)
  assert.equal(buffer.entries.length, 1)
  assert.equal(buffer.entries[0].role, 'user')
})

test('宿主注入的伪 user 消息一律不记（这条是踩过的坑）', () => {
  const buffer = createTranscript()
  for (const kind of ['time-context', 'runtime-context', 'skill-catalog', 'agent-instructions', 'user-approval']) {
    assert.equal(ingestEvent(buffer, userEvent(`注入的 ${kind}`, kind)), false, `${kind} 不该入账`)
  }
  assert.equal(buffer.entries.length, 0)
})

test('没有 source 的 user 消息仍然按人处理（保守放行）', () => {
  const buffer = createTranscript()
  assert.equal(ingestEvent(buffer, userEvent('没带 source 的话', undefined)), true)
  assert.equal(buffer.entries.length, 1)
})

test('纯工具调用的 assistant 消息不记', () => {
  const buffer = createTranscript()
  assert.equal(ingestEvent(buffer, assistantEvent([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }])), false)
  assert.equal(ingestEvent(buffer, assistantEvent([{ type: 'text', text: '说点人话' }])), true)
  assert.equal(buffer.entries.length, 1)
})

test('被打断的 assistant 消息不记', () => {
  const buffer = createTranscript()
  const event = assistantEvent([{ type: 'text', text: '说到一半' }])
  event.data.interrupted = true
  assert.equal(ingestEvent(buffer, event), false)
})

test('turn 事件只更新当前回合号，不占转录条目', () => {
  const buffer = createTranscript()
  assert.equal(ingestEvent(buffer, { type: 'turn/start', data: { turn: 7 } }), false)
  assert.equal(buffer.turn, 7)
  ingestEvent(buffer, userEvent('你好'))
  assert.equal(buffer.entries[0].turn, 7)
})

test('hasSubstance 要求一问一答且不短', () => {
  const buffer = createTranscript()
  assert.equal(hasSubstance(buffer), false)
  ingestEvent(buffer, userEvent('你好'))
  assert.equal(hasSubstance(buffer), false, '只有用户消息不算')
  ingestEvent(buffer, assistantEvent([{ type: 'text', text: '我把库存同步那段改成了幂等写入，顺手补了两条测试，细节都在 diff 里。' + '顺便把重试的退避改成了指数退避，最坏情况下多等三秒。' + '你要是觉得等待时间太长，我可以把上限压到一秒，代价是高峰期失败率会高一点。' }]))
  assert.equal(hasSubstance(buffer), true)
  const info = describeSubstance(buffer)
  assert.deepEqual([info.entries, info.hasUser, info.hasAssistant], [2, true, true])
})

test('太短的寒暄不算实质内容', () => {
  const buffer = createTranscript()
  ingestEvent(buffer, userEvent('嗯'))
  ingestEvent(buffer, assistantEvent([{ type: 'text', text: '好' }]))
  assert.equal(hasSubstance(buffer), false)
  assert.equal(describeSubstance(buffer).size, 2)
})

test('renderTranscript 从尾部取，不超过上限', () => {
  const buffer = createTranscript()
  for (let i = 0; i < 12; i += 1) {
    ingestEvent(buffer, userEvent(`用户第 ${i} 句 ` + 'x'.repeat(50)))
    ingestEvent(buffer, assistantEvent([{ type: 'text', text: `助手第 ${i} 句 ` + 'y'.repeat(50) }]))
  }
  const rendered = renderTranscript(buffer, 400)
  assert.ok(rendered.length <= 700, `渲染结果 ${rendered.length} 字，超了`)
  assert.ok(rendered.includes('用户第 11 句'), '应该保留最新的')
  assert.ok(!rendered.includes('用户第 0 句'), '旧的应该被丢掉')
})

test('takePending 取尾部且不破坏缓冲', () => {
  const buffer = createTranscript()
  ingestEvent(buffer, userEvent('一'))
  ingestEvent(buffer, assistantEvent([{ type: 'text', text: '二' }]))
  const pending = takePending(buffer, 2)
  assert.equal(pending.length, 2)
  assert.equal(buffer.entries.length, 2)
})

test('转录条目上限不会无限涨', () => {
  const buffer = createTranscript()
  for (let i = 0; i < 40; i += 1) ingestEvent(buffer, userEvent(`第 ${i} 句`))
  assert.ok(buffer.entries.length <= 24, `实际 ${buffer.entries.length}`)
  assert.equal(buffer.entries[buffer.entries.length - 1].text, '第 39 句')
})

test('每条转录带上事件 seq：ref 靠它回档案捞原话', () => {
  const buffer = createTranscript()
  const event = userEvent('我的编辑器一直是 neovim')
  event.seq = 1234
  ingestEvent(buffer, event)
  assert.equal(buffer.entries[0].seq, 1234)
  // 没有 seq 的事件留 0：0 是「没有来源」，不是「来源是第 0 条」。
  ingestEvent(buffer, userEvent('没有 seq 的一句'))
  assert.equal(buffer.entries[1].seq, 0)
})
