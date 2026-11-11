import test from 'node:test'
import assert from 'node:assert/strict'
import { FIELDS, FIELD_ORDER, describeFields, validateValue, validateDraft } from '../lib/validate.js'

test('规则表覆盖六个文本字段，且都能序列化给客户端', () => {
  assert.deepEqual(FIELD_ORDER, [
    'bot_name',
    'title_name_initial',
    'core_temperament',
    'core_values',
    'extra_boundaries',
    'language_baseline',
  ])
  const described = describeFields()
  assert.equal(described.length, 6)
  for (const item of described) {
    assert.equal(typeof item.bad, 'string')
    assert.equal(typeof item.hint, 'string')
    assert.ok(item.max > 0)
    // 序列化后的正则必须能编译
    assert.doesNotThrow(() => new RegExp(item.bad, 'gu'))
  }
})

test('名字：文字、空格、括号、间隔号合规；其他符号标红', () => {
  assert.equal(validateValue('bot_name', '六一').ok, true)
  assert.equal(validateValue('bot_name', '小六(2号)').ok, true)
  assert.equal(validateValue('bot_name', '六（二）·三').ok, true)
  assert.equal(validateValue('bot_name', '阿 六').ok, true)
  assert.equal(validateValue('bot_name', '').ok, true)

  const marked = validateValue('bot_name', '六<一>')
  assert.equal(marked.ok, false)
  assert.deepEqual(
    marked.marks.map((mark) => [mark.start, mark.end]),
    [
      [1, 2],
      [3, 4],
    ],
  )
  assert.equal(validateValue('bot_name', '六"一').ok, false)
  assert.equal(validateValue('bot_name', '六，一').ok, false)
})

test('称呼：不允许多余符号（括号、间隔号也标红）', () => {
  assert.equal(validateValue('title_name_initial', '用户').ok, true)
  assert.equal(validateValue('title_name_initial', '老 王').ok, true)
  assert.equal(validateValue('title_name_initial', '老王(2)').ok, false)
  assert.equal(validateValue('title_name_initial', '六·一').ok, false)
})

test('多条目字段：逗号/分号/顿号/换行都是合法分隔符', () => {
  const key = 'core_temperament'
  assert.equal(validateValue(key, '自然、有边界、不讨好').ok, true)
  assert.equal(validateValue(key, '自然，有边界；不讨好\n愿意说不知道').ok, true)
  assert.equal(validateValue('core_values', '自由、民主、正义、公平，认同共产主义意识形态').ok, true)
  // 句号、问号、尖括号都不行
  assert.equal(validateValue(key, '自然。').ok, false)
  assert.equal(validateValue(key, '自然？').ok, false)
  assert.equal(validateValue(key, '自然<一>').ok, false)
})

test('超长：从上限处开始标红整段尾巴', () => {
  const value = '一'.repeat(12)
  const result = validateValue('bot_name', value)
  assert.equal(result.ok, false)
  assert.equal(result.marks.length, 1)
  assert.deepEqual(result.marks[0], { start: 10, end: 12, kind: 'over' })
  assert.equal(result.length, 12)
  assert.equal(result.max, 10)
})

test('字符错误与超长会被合并标红，不重叠', () => {
  const value = `六${'一'.repeat(12)}<`
  const result = validateValue('bot_name', value)
  assert.equal(result.ok, false)
  // 尾巴从第 10 个字符开始一直红到结尾
  assert.deepEqual(result.marks, [{ start: 10, end: 14, kind: 'over' }])
})

test('软提示：半角/全角混用与连续分隔符只提示、不拦', () => {
  const mixed = validateValue('core_temperament', '自然，有边界,不讨好')
  assert.equal(mixed.ok, true)
  assert.ok(mixed.warnings.includes('半角和全角标点混用了'))

  // 顿号和逗号一起用是正常中文写法，不该被提示
  const natural = validateValue('core_temperament', '自然，有边界、不讨好')
  assert.deepEqual(natural.warnings, [])

  const doubled = validateValue('core_temperament', '自然、、有边界')
  assert.equal(doubled.ok, true)
  assert.ok(doubled.warnings.includes('有连续的分隔符'))

  const tail = validateValue('core_temperament', '自然、有边界；')
  assert.equal(tail.ok, true)
  assert.ok(tail.warnings.some((item) => item.includes('末尾')))

  const clean = validateValue('core_temperament', '自然、有边界')
  assert.deepEqual(clean.warnings, [])
})

test('出厂默认值必须全部合规，且不触发任何提示', async () => {
  const { DEFAULTS } = await import('../lib/config.js')
  for (const key of FIELD_ORDER) {
    const value = DEFAULTS[key] ?? ''
    const result = validateValue(key, value)
    assert.equal(result.ok, true, `${key} 的默认值 ${JSON.stringify(value)} 不合规`)
    assert.deepEqual(result.warnings, [], `${key} 的默认值触发了提示`)
  }
})

test('半角逗号也放行（人多半会直接敲 , ）', () => {
  assert.equal(validateValue('core_values', '自由,民主;正义').ok, true)
})

test('validateDraft：任一字段不合规就不可保存', () => {
  const ok = validateDraft({
    bot_name: '六一',
    title_name_initial: '用户',
    core_temperament: '自然、有边界',
    core_values: '自由、民主',
    extra_boundaries: '',
    language_baseline: '自然口语，少术语',
  })
  assert.equal(ok.ok, true)

  const bad = validateDraft({ ...{}, bot_name: '六<一>', title_name_initial: '用户' })
  assert.equal(bad.ok, false)
  assert.equal(bad.results.bot_name.ok, false)
  // 未提供的字段按空值处理，不算错
  assert.equal(bad.results.core_values.ok, true)
})

test('全角字母数字与全角空格都算文字', () => {
  assert.equal(validateValue('bot_name', 'ＡＢ１２').ok, true)
  assert.equal(validateValue('bot_name', '六\u3000一').ok, true)
})

test('规则表里的 hint 与 max 一致（避免提示和校验脱节）', () => {
  for (const key of FIELD_ORDER) {
    const rule = FIELDS[key]
    assert.ok(rule.hint.includes(String(rule.max)), `${key} 的提示里应写明 ${rule.max} 字上限`)
  }
})

test('只有「对我的称呼」和「价值观」的提示弹窗居中，其余向右展开', () => {
  const fields = describeFields()
  const center = fields.filter((field) => field.popup === 'center').map((field) => field.key)
  assert.deepEqual(center, ['title_name_initial', 'core_values'])
  for (const field of fields) assert.ok(field.popup === 'center' || field.popup === 'right', field.key + ' 缺少弹窗对齐方式')
})
