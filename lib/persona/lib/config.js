/**
 * 配置层（「底层人格」）。
 *
 * 这一层的唯一写入口是人类：设置页、导入文件、或直接改 config.json。
 * 模型没有任何写通道。
 *
 * v6（2026-11-10）：状态机拆掉后，配置里只剩「身份」与「评估器开关」。
 * 称呼意愿、价值观权重、traits 限幅那一整组参数已删除——它们服务的机制
 * 不再存在。旧 config.json 里的残留字段会被原样保留（前向兼容），但不再被读取。
 *
 * 所有读入路径都必须过 normalize()：
 *   - 字符串去控制字符 / 拆模板变量 / 按字段上限截断；
 *   - 未知字段原样保留（前向兼容：新版本写的配置被旧版本读到时不该丢数据）。
 */
import { clean, oneLine } from './sanitize.js'

/** v2：底色拆成「性格底色 + 价值观」，新增「对我的称呼」。v6 未再变。 */
export const CONFIG_VERSION = 2

export const ENUM_LIMITS = {
  assessor_mode: ['off', 'important', 'every-turn'],
}

export const TEXT_LIMITS = {
  bot_name: 10,
  self_name_initial: 10,
  // 2026-11-10：人格卡改成「整段粘进来再拆」，原文可能很长，这几个字段的
  // 硬上限跟着放大。它们是保险丝（挡住整本书），不是目标值——真正该看的
  // 是内核账里的 human 软上限 1000 字（render.js 的 KERNEL_LIMITS），
  // 超了只提醒、不拦。
  core_temperament: 2000,
  core_values: 2000,
  extra_boundaries: 2000,
  language_baseline: 500,
  // 总结是卡片的收束句（「你是什么、为什么存在」），一句就够，不该写成小作文。
  core_summary: 300,
  assessor_model: 80,
}

/** 已无数字型配置；保留空表是给 describeLimits / 设置页一个稳定形状。 */
export const NUMBER_LIMITS = {}

export const DEFAULTS = Object.freeze({
  configVersion: CONFIG_VERSION,
  // 名字、自称、底色、价值观、附加边界默认留空：空着就等人类自己填，
  // 别预设一套“像样”的人格冒充用户填的。
  bot_name: '',
  self_name_initial: '',
  core_temperament: '',
  core_values: '',
  extra_boundaries: '',
  // 说话也是：以前默认垫一句「自然口语，少术语，不客服腔」，那等于插件替所有
  // 部署者定了风格。现在空就空着（内核显示「（未填写）」），要什么口吻由卡自己写。
  language_baseline: '',
  core_summary: '',
  allow_refusal: true,
  // 称呼上「不接顺从角色」是某个部署者的立场，不是所有卡的默认：默认关，
  // 称呼怎么处理全由人格卡决定。开着时内核会多一条写死的边界。
  reject_servile_address: false,
  assessor_mode: 'important',
  assessor_model: '',
})

/** 只有单项的布尔字段，写错时回到默认值而不是抛错。 */
const BOOLEAN_FIELDS = ['allow_refusal', 'reject_servile_address']

function clampNumber(value, limit, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  let out = Math.min(limit.max, Math.max(limit.min, n))
  if (limit.integer) out = Math.round(out)
  // 浮点比较之后仍然可能因为四舍五入越界一点点，再夹一次。
  return Math.min(limit.max, Math.max(limit.min, out))
}

/**
 * v1 → v2：把长文本里的底色拆成「性格底色」和「价值观」。
 *
 * 老版本把两样写在一个字段里，常见写法用分号分隔。只在没有 core_values 时执行，
 * 且只在分号切得开或原文本来就短的时候动手——切不开又超长的，保留原文并报一条
 * warning（设置页会显示「修正了 N 个字段」），交给人自己重写，绝不静默截断。
 */
function splitTemperament(input, warnings) {
  const raw = typeof input.core_temperament === 'string' ? input.core_temperament : ''
  const text = raw.trim()
  if (!text) return { temperament: '', values: '' }

  const parts = text
    .split(/[；;]/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length > 1) {
    return { temperament: parts[0], values: parts.slice(1).join('；') }
  }
  if ([...text].length > TEXT_LIMITS.core_temperament) {
    if (warnings) warnings.push('core_temperament')
    return { temperament: text, values: '' }
  }
  return { temperament: text, values: '' }
}

/**
 * 把任意来源的原始配置变成可用配置。
 * @param {unknown} raw 配置文件内容 / 设置页提交 / 导入包里的 config
 * @param {string[]} [warnings] 收集被修正的字段名，供设置页提示
 */
export function normalize(raw, warnings = []) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...input, configVersion: CONFIG_VERSION }

  // v1 → v2 迁移：先拆底色，再往下走统一的钳制流程。
  let temperament = input.core_temperament
  let values = input.core_values
  if (values === undefined) {
    const split = splitTemperament(input, warnings)
    temperament = split.temperament
    values = split.values
  }

  // 文本：bot_name 允许暂时为空（首次安装还没填），渲染时回退为「鲸鲸」；
  // 缺名字是状态不是错误，用 needsSetup 提示，不塞进 warnings。
  out.bot_name = oneLine(input.bot_name, TEXT_LIMITS.bot_name)
  out.self_name_initial = oneLine(input.self_name_initial, TEXT_LIMITS.self_name_initial)
  out.core_temperament = clean(temperament, TEXT_LIMITS.core_temperament)
  out.core_values = clean(values, TEXT_LIMITS.core_values)
  out.extra_boundaries = clean(input.extra_boundaries, TEXT_LIMITS.extra_boundaries)
  out.language_baseline = clean(input.language_baseline, TEXT_LIMITS.language_baseline, DEFAULTS.language_baseline)
  out.core_summary = clean(input.core_summary, TEXT_LIMITS.core_summary)
  out.assessor_model = oneLine(input.assessor_model, TEXT_LIMITS.assessor_model)

  // 数字：钳制 + 取整（v6 起没有数字型配置，循环空转以保持结构）
  for (const [key, limit] of Object.entries(NUMBER_LIMITS)) {
    const value = clampNumber(input[key], limit, DEFAULTS[key])
    if (Number.isFinite(Number(input[key])) && value !== Number(input[key])) warnings.push(key)
    out[key] = value
  }

  // 枚举
  for (const [key, allowed] of Object.entries(ENUM_LIMITS)) {
    if (allowed.includes(input[key])) out[key] = input[key]
    else {
      if (input[key] !== undefined) warnings.push(key)
      out[key] = DEFAULTS[key]
    }
  }

  // 布尔
  for (const key of BOOLEAN_FIELDS) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
    else {
      if (input[key] !== undefined) warnings.push(key)
      out[key] = DEFAULTS[key]
    }
  }

  return out
}

/** 首次安装：还没填名字。渲染时用占位名，设置页顶部提示。 */
export function needsSetup(config) {
  return !config || clean(config.bot_name, TEXT_LIMITS.bot_name) === ''
}

/** 提示词里用的名字：没填时用占位名（产品名「鲸鲸」），保证人格段永远可用。 */
export function effectiveBotName(config) {
  return clean(config?.bot_name, TEXT_LIMITS.bot_name) || '鲸鲸'
}

/** 初始自称：没单独设就用名字。 */
export function effectiveSelfNameInitial(config) {
  return clean(config?.self_name_initial, TEXT_LIMITS.self_name_initial) || effectiveBotName(config)
}

/** 导出给设置页的字段说明（避免前端硬编码上限）。 */
export function describeLimits() {
  return {
    text: TEXT_LIMITS,
    number: NUMBER_LIMITS,
    enum: ENUM_LIMITS,
    defaults: DEFAULTS,
  }
}
