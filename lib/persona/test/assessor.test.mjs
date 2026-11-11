import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAssessmentRequest, extractJson, parseAssessment, runAssessment, validateAssessment } from '../lib/assessor.js'

test('能从 Markdown 代码块和尾随说明里抠出 JSON', () => {
  const raw = '```json\n{"salience":0.4,"memory":{"facts":["甲"]}}\n```\n以上。'
  assert.equal(extractJson(raw), '{"salience":0.4,"memory":{"facts":["甲"]}}')
})

test('字符串里的花括号不打断配对', () => {
  const raw = '{"memory":{"facts":["他说 {今天} 很冷"]}}'
  assert.equal(extractJson(raw), raw)
})

test('没有 JSON 时返回 null', () => {
  assert.equal(extractJson('我觉得挺好的'), null)
  assert.equal(parseAssessment('我觉得挺好的'), null)
  assert.equal(parseAssessment('{"unclosed":1'), null)
})

test('只留记忆与承诺：状态机字段被丢掉', () => {
  const parsed = parseAssessment(
    JSON.stringify({
      salience: 5,
      traits: [{ name: '甲', direction: 'reinforce', strength: 2 }],
      mood: { pleasure: 9 },
      relationship: { trust: 'up', stage: 'close' },
      titleSignals: [{ name: '小六', signal: 'trail' }],
      valueChanges: [{ name: '自由', direction: 'up' }],
      selfName: '  ',
      memory: { facts: ['用户在写插件', '用户在写插件'], preferences: [] },
      commitments: ['明天把测试补上'],
    }),
  )
  assert.equal(parsed.salience, 1)
  assert.deepEqual(parsed.memory.facts, ['用户在写插件'])
  assert.deepEqual(parsed.commitments, ['明天把测试补上'])
  assert.equal(parsed.traits, undefined)
  assert.equal(parsed.mood, undefined)
  assert.equal(parsed.relationship, undefined)
  assert.equal(parsed.titleSignals, undefined)
  assert.equal(parsed.valueChanges, undefined)
  assert.equal(parsed.selfName, undefined)
})

test('结构不合法的整体输入被拒绝', () => {
  assert.equal(validateAssessment(null), null)
  assert.equal(validateAssessment([]), null)
  assert.equal(validateAssessment('x'), null)
})

test('评估请求把对话当数据塞进 transcript 标签', () => {
  const request = buildAssessmentRequest('用户：你好\n你：在')
  assert.ok(request.system.includes('JSON'))
  assert.equal(request.messages.length, 1)
  assert.ok(request.messages[0].content[0].text.includes('<transcript>'))
})

test('没有 llm 服务时安静失败，不抛错', async () => {
  const result = await runAssessment({ llm: null, provider: 'p', model: 'm', transcript: 'x' })
  assert.deepEqual(result, { ok: false, error: 'llm-unavailable' })
})

test('流式分片拼起来后能解析出评估', async () => {
  const payload = '{"salience":0.6,"memory":{"facts":["用户在写人格插件"]}}'
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: payload.slice(0, 12) }
        yield { type: 'text-delta', index: 0, text: payload.slice(12) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const result = await runAssessment({ llm, provider: 'p', model: 'm', transcript: '用户：我在写插件' })
  assert.equal(result.ok, true)
  assert.equal(result.assessment.salience, 0.6)
  assert.deepEqual(result.assessment.memory.facts, ['用户在写人格插件'])
})

test('流里报错时返回失败而不是抛出', async () => {
  const llm = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error' } }
      })()
    },
  }
  const result = await runAssessment({ llm, provider: 'p', model: 'm', transcript: 'x' })
  assert.equal(result.ok, false)
})
