import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectProfile, resolvePaths } from '../lib/state/store.js'

test('detectProfile：显式配置优先于一切', () => {
  const profile = detectProfile({ env: { DSH_PROFILE: 'lab' } })
  assert.equal(profile, 'lab')
})

test('detectProfile：从 DSH_PROFILE_DIR 末段取名', () => {
  const profile = detectProfile({ env: { DSH_PROFILE_DIR: 'C:\\Users\\me\\.dsh\\profiles\\web' } })
  assert.equal(profile, 'web')
})

test('detectProfile：从 argv 里的 profile 目录取名（宿主进程没有 env 时）', () => {
  const argv = [
    'D:\\deepseek Harness\\DeepSeek Harness.exe',
    'D:\\deepseek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
    'D:\\deepseek Harness\\resources\\app.asar\\dsh',
    'C:\\Users\\123\\.dsh\\profiles\\desktop',
    'D:\\deepseek Harness\\resources\\runtime\\primary-runtime',
  ]
  assert.equal(detectProfile({ env: {}, argv, cwd: 'C:\\Users\\123\\.dsh\\profiles\\desktop' }), 'desktop')
})

test('detectProfile：认不出来才退回 default', () => {
  assert.equal(detectProfile({ env: {}, argv: ['exe'], cwd: '/tmp' }), 'default')
})

test('resolvePaths：profile 落到目录名上', () => {
  const paths = resolvePaths({ dshHome: 'C:\\h', profile: 'desktop' })
  assert.equal(paths.root, 'C:\\h\\persona-framework\\desktop')
  assert.equal(paths.config, 'C:\\h\\persona-framework\\desktop\\config.json')
})
