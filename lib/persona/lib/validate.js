/**
 * 文本字段的输入校验。
 *
 * 原则：只拦会出真问题的字符，其余放行。
 * 硬错误（标红 + 禁用保存）只有两类：出现破坏提示词排版的字符、超出字数上限。
 * 分隔符混用、连续分隔符这类只是提示，不拦。
 *
 * 规则表是唯一来源：标红的落点、保存按钮的灰/亮、⁇ 提示窗的文案都从这里生成。
 */

// 允许的字符类（正则片段）
const HAN = '\\p{Script=Han}'
const LATIN = 'A-Za-z0-9\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF10-\\uFF19'
const SPACE = ' \\u3000'

/** 名字：文字 + 空格 + 半角/全角小括号 + 间隔号 */
const BAD_NAME = `[^${HAN}${LATIN}${SPACE}()\\uFF08\\uFF09·]`
/** 称呼：只有文字和空格 */
const BAD_TITLE = `[^${HAN}${LATIN}${SPACE}]`
/** 多条目文本：文字 + 空格 + 逗号/分号/顿号（半角与全角）+ 换行 */
const BAD_MULTI = `[^${HAN}${LATIN}${SPACE},;\\uFF0C\\uFF1B\\u3001\\n]`

/**
 * 字段规则。key 与 config 字段一一对应。
 * kind: name / title / multi —— 决定警告文案用的分隔符集合。
 */
export const FIELDS = {
  bot_name: {
    key: 'bot_name',
    label: '名字',
    kind: 'name',
    max: 10,
    bad: BAD_NAME,
    hint: '≤10 字。可用汉字、字母、数字、空格、半角或全角小括号、·；其他符号不行。',
  },
  title_name_initial: {
    // 弹窗居中：该字段在右列，向右展开会被面板切掉。
    popup: 'center',
    key: 'title_name_initial',
    label: '对我的称呼',
    kind: 'title',
    max: 10,
    bad: BAD_TITLE,
    hint: '≤10 字。只能文字（汉字/字母/数字）和空格，不能带符号。',
  },
  core_temperament: {
    key: 'core_temperament',
    label: '性格底色',
    kind: 'multi',
    max: 100,
    bad: BAD_MULTI,
    hint: '≤100 字。多条用 ，、； 或换行分开。写「是什么样」，不写「该怎么回答」。',
  },
  core_values: {
    popup: 'center',
    key: 'core_values',
    label: '价值观',
    kind: 'multi',
    max: 100,
    bad: BAD_MULTI,
    hint: '≤100 字。多条用 ，、； 或换行分开；每条会单独计权重，冲突时按它排先后。',
  },
  extra_boundaries: {
    key: 'extra_boundaries',
    label: '附加边界',
    kind: 'multi',
    max: 500,
    bad: BAD_MULTI,
    hint: '≤500 字。只能加强、不能放宽内置边界。多条用 ，、； 或换行分开，留空表示不加。',
  },
  language_baseline: {
    key: 'language_baseline',
    label: '语言基线',
    kind: 'multi',
    max: 100,
    bad: BAD_MULTI,
    hint: '≤100 字。多条用 ，、； 或换行分开。默认「自然口语，少术语，不客服腔」。',
  },
}

/** 字段顺序（设置页按这个顺序排）。 */
export const FIELD_ORDER = [
  'bot_name',
  'title_name_initial',
  'core_temperament',
  'core_values',
  'extra_boundaries',
  'language_baseline',
]

/** 给客户端用的可序列化规则（RegExp 源码字符串，客户端自己编译）。 */
export function describeFields() {
  return FIELD_ORDER.map((key) => {
    const rule = FIELDS[key]
    return {
      key: rule.key,
      label: rule.label,
      kind: rule.kind,
      max: rule.max,
      bad: rule.bad,
      hint: rule.hint,
      popup: rule.popup ?? 'right',
    }
  })
}

function mergeMarks(marks) {
  if (marks.length <= 1) return marks
  const sorted = [...marks].sort((a, b) => a.start - b.start || a.end - b.end)
  const out = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1]
    const next = sorted[i]
    if (next.start <= last.end) last.end = Math.max(last.end, next.end)
    else out.push(next)
  }
  return out
}

/**
 * 校验一个字段的值。
 * @returns {{ok: boolean, marks: Array<{start:number,end:number,kind:string}>, warnings: string[], max: number, length: number}}
 */
export function validateValue(ruleOrKey, value) {
  const rule = typeof ruleOrKey === 'string' ? FIELDS[ruleOrKey] : ruleOrKey
  const text = String(value ?? '')
  if (!rule) return { ok: true, marks: [], warnings: [], max: 0, length: text.length }

  const marks = []
  let re
  try {
    re = new RegExp(rule.bad, 'gu')
  } catch {
    re = null
  }
  if (re) {
    let hit
    while ((hit = re.exec(text)) !== null) {
      if (hit[0] === '') {
        re.lastIndex += 1
        continue
      }
      marks.push({ start: hit.index, end: hit.index + hit[0].length, kind: 'char' })
    }
  }
  if (text.length > rule.max) marks.push({ start: rule.max, end: text.length, kind: 'over' })

  const warnings = []
  if (rule.kind === 'multi') {
    // 只提醒「半角/全角」混用：顿号和逗号一起用是正常中文写法，不该被唠叨。
    const halfWidth = text.includes(',') || text.includes(';')
    const fullWidth = text.includes('，') || text.includes('；')
    if (halfWidth && fullWidth) warnings.push('半角和全角标点混用了')
    if (/[，；、,;\n]{2,}/.test(text)) warnings.push('有连续的分隔符')
    if (/[，；、,;\s]+$/.test(text)) warnings.push('末尾的分隔符保存时会自动去掉')
  }

  return {
    ok: marks.length === 0,
    marks: mergeMarks(marks),
    warnings,
    max: rule.max,
    length: text.length,
  }
}

/** 校验整份草稿：返回每个字段的结果与是否可保存。 */
export function validateDraft(draft) {
  const results = {}
  let ok = true
  for (const key of FIELD_ORDER) {
    const result = validateValue(key, draft?.[key] ?? '')
    results[key] = result
    if (!result.ok) ok = false
  }
  return { ok, results }
}
