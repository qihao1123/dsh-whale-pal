import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, effectiveBotName, needsSetup, normalize } from '../lib/config.js'

test('空对象 → 除名字外全部默认值', () => {
  const config = normalize({})
  // 名字刻意不做默认回填：空串表示「还没填」，由 needsSetup 提示；
  // 首次安装的默认值由 loadConfig 用 {...DEFAULTS} 播种。
  assert.equal(config.bot_name, '')
  assert.equal(config.assessor_mode, 'important')
  // v6 起没有状态机配置：旧字段即使传进来也不再出现在 DEFAULTS 里。
  assert.equal(DEFAULTS.title_will_decay, undefined)
  assert.equal(DEFAULTS.proactive_level, undefined)
})

test('默认值里名字、底色、价值观、附加边界都是空的', () => {
  const config = normalize({ ...DEFAULTS })
  for (const key of ['bot_name', 'core_temperament', 'core_values', 'extra_boundaries']) {
    assert.equal(config[key], '', `${key} 默认应该留空`)
  }
  // 留空是状态不是错误：不塞 warning，用 needsSetup 提示。
  assert.equal(needsSetup(config), true)
  assert.equal(effectiveBotName(config), '鲸鲸')
})

test('非法枚举回落到默认值', () => {
  const warnings = []
  const config = normalize({ assessor_mode: 'sometimes' }, warnings)
  assert.equal(config.assessor_mode, DEFAULTS.assessor_mode)
  assert.deepEqual(warnings, ['assessor_mode'])
})

test('旧状态机配置原样保留，但不再被读取', () => {
  // 前向兼容：旧 config.json 里的残留字段不丢，但 normalize 不再管它们，
  // 也不再因为越界而塞 warning。
  const warnings = []
  const config = normalize({ title_will_decay: 9, proactive_level: 'whatever', mid_max_delta: 5 }, warnings)
  assert.equal(config.title_will_decay, 9)
  assert.equal(config.proactive_level, 'whatever')
  assert.deepEqual(warnings, [])
  assert.equal(DEFAULTS.decay_rate, undefined)
})

test('未知字段原样保留（前向兼容）', () => {
  const config = normalize({ futureField: { a: 1 } })
  assert.deepEqual(config.futureField, { a: 1 })
})

test('自由文本：拆模板变量、去控制字符、截断', () => {
  const config = normalize({
    // 人格卡的硬上限放到 2000：这里得喂超过它的长度才测得到截断。
    core_temperament: `{{名字}}\u0000 很长的${'字'.repeat(2400)}`,
    language_baseline: 'a\r\nb',
  })
  assert.equal(config.core_temperament.includes('{{'), false)
  assert.equal(config.core_temperament.includes('\u0000'), false)
  assert.equal(config.core_temperament.length, 2000)
  assert.equal(config.language_baseline, 'a\nb')
})

test('名字只保留一行、最多 10 字', () => {
  const config = normalize({ bot_name: '  六\n一  二三四五六七八九十十一十二  ' })
  assert.equal(config.bot_name.length <= 10, true)
  assert.equal(config.bot_name.includes('\n'), false)
})

test('空名字 → needsSetup，渲染名回退为鲸鲸', () => {
  const config = normalize({ bot_name: '' })
  assert.equal(needsSetup(config), true)
  assert.equal(effectiveBotName(config), '鲸鲸')
  assert.equal(needsSetup(normalize({ bot_name: '六一' })), false)
})

test('normalize 幂等', () => {
  const once = normalize({ bot_name: '六一', assessor_mode: 'every-turn' })
  const twice = normalize(once)
  assert.deepEqual(once, twice)
})
