/**
 * 设置层：插件自己的那部分配置（融合计划 §13.1、§10.1）。
 *
 * 边界先说清楚：
 *   - 名称 / 自称 / 称呼，以及它们各自的含义 —— 六个槽位，**空白可以填一次，
 *     填过就只读**；只读之后要改只能在对话里说，由模型先问一句为什么。
 *   - 笔记库路径 / 库名 / Obsidian 开关 / 默认模式 —— 设施项，随时可改。
 *
 * 六个槽位的值存在哪：
 *   名称     config.bot_name（人格内核第 3 节读的就是它）
 *   自称     state.selfName.current
 *   称呼     state.titleName.current
 *   三者含义 config.identity.{nameMeaning,selfNameMeaning,titleMeaning}
 *
 * 存哪：仍是同一个 config.json。人格内核的 config 层「未知字段原样保留」，
 * 所以 identity / mode / knowledge / obsidian 这几格能和平共处，
 * 不用动 lib/persona/lib/config.js —— 那 168 条测试也就不受牵连。
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { COPY } from './copy.js'
import { CARD_KEYS } from './persona-card.js'
import { DEFAULTS as CONFIG_DEFAULTS, TEXT_LIMITS } from './persona/lib/config.js'
import { clean, oneLine } from './persona/lib/sanitize.js'
import { migrateVault, undoMigrate } from './vault-migrate.js'

export const MODES = Object.freeze(['assistant', 'whale'])
export const DEFAULT_MODE = 'assistant'
export const DEFAULT_VAULT_NAME = '记忆空间'
/** 只接个人 Obsidian 库，双链一种就够；留成常量是为了以后放开时只有一个出处。 */
export const LINK_MODES = Object.freeze(['wiki'])

/** 含义只存一段话，最长 200 字，超出截断不报错（融合计划 §13.3）。 */
export const MEANING_MAX = 200

/** 六个身份槽位：随时可改，改完跟着新的走。 */
export const IDENTITY_KEYS = Object.freeze([
  'name',
  'nameMeaning',
  'selfName',
  'selfNameMeaning',
  'title',
  'titleMeaning',
])

/**
 * 十项各自写多长。
 *
 * 前六项是身份（短，名称一行、含义一段）；后四项是内核第 1、2 节读的自由文本，
 * 多行、上限直接引用 config.js 的 TEXT_LIMITS —— 抄一份数字过来，改了一边忘了
 * 另一边，界面显示的长度就和内核实际注入的长度对不上。
 */
export const CARD_MAX = Object.freeze({
  name: 40,
  nameMeaning: MEANING_MAX,
  selfName: 40,
  selfNameMeaning: MEANING_MAX,
  title: 40,
  titleMeaning: MEANING_MAX,
  temperament: TEXT_LIMITS.core_temperament,
  values: TEXT_LIMITS.core_values,
  boundaries: TEXT_LIMITS.extra_boundaries,
  language: TEXT_LIMITS.language_baseline,
})

/** 这四项是一个块：边界常常是一串条目，不能压成一行。 */
const MULTILINE_KEYS = new Set(['temperament', 'values', 'boundaries', 'language'])

/** 粘贴的原文存档上限：挡住失控粘贴，正常人格卡碰不到。 */
export const CARD_RAW_MAX = 10000

/**
 * 鲸鲸工作区：名单里的目录开出的会话走鲸鲸模式，其余一律助手模式。
 * 没有「默认工作区」这层：模式由会话的 cwd 现算，一个目录只能是其中一种。
 * 上限只是防配置失控，正常就一个 —— 陪伴聊天不需要第二块地方。
 */
export const WHALE_WORKSPACE_MAX = 20

/**
 * 目录怎么比才不认错。
 *
 * 同一个目录会被写成 `D:\a\b`、`D:/a/b`、带尾斜杠；Windows 上还常差大小写。
 * 所以归一分隔符与尾斜杠，Windows 再统一小写。Linux 路径大小写敏感，不转。
 */
export function workspaceKey(value) {
  if (typeof value !== 'string') return ''
  const flat = value.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? flat.toLowerCase() : flat
}

/**
 * 名单归一：只收非空字符串，按目录去重，超上限截断。
 * 路径本身原样留着（人看着顺眼），比较时才走 workspaceKey。
 */
function normalizeWhaleWorkspaces(value, cap = WHALE_WORKSPACE_MAX) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const list = []
  for (const item of value) {
    const path = text(item, 400)
    const key = workspaceKey(path)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    list.push(path)
    if (list.length >= cap) break
  }
  return list
}

/** 设置页随时能改的项（设施项 + 人格卡十项 + 原文存档）。库名不在里面：它只用于 Obsidian 深链，
 *  用户在设置页里既看不见它落在哪、也改不动它带来的效果，2026-11-11 按用户要求撤掉了这一格。 */
export const EDITABLE_KEYS = Object.freeze([
  'vaultPath',
  'obsidianEnabled',
  'whaleWorkspaces',
  ...CARD_KEYS,
  'personaCard',
])

function text(value, max = 200) {
  // 只吃字符串：配置里写成数字或布尔时不猜人的意思，回默认值。
  if (typeof value !== 'string') return ''
  const flat = oneLine(clean(value))
  return flat.length > max ? flat.slice(0, max) : flat
}

/** 多行字段的读法：只去控制字符与模板语法，换行照留。 */
function block(value, max = 2000) {
  if (typeof value !== 'string') return ''
  return clean(value, max)
}

function bool(value) {
  return value === true
}

/**
 * 把 config.json 里属于本插件的那几格收成固定形状。
 * 缺失或写坏一律回默认值，不抛错：设置页读到半个配置也该能显示。
 */
export function normalizeExtras(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const knowledge = src.knowledge && typeof src.knowledge === 'object' ? src.knowledge : {}
  const obsidian = src.obsidian && typeof src.obsidian === 'object' ? src.obsidian : {}
  const identity = src.identity && typeof src.identity === 'object' ? src.identity : {}
  const card = src.personaCard && typeof src.personaCard === 'object' && !Array.isArray(src.personaCard)
    ? src.personaCard
    : {}

  return {
    identity: {
      // 旧配置里「名称的含义」只叫 meaning，读的时候当 nameMeaning 的兜底。
      nameMeaning: text(identity.nameMeaning ?? identity.meaning, MEANING_MAX),
      selfNameMeaning: text(identity.selfNameMeaning, MEANING_MAX),
      titleMeaning: text(identity.titleMeaning, MEANING_MAX),
    },
    card: {
      temperament: block(src.core_temperament, CARD_MAX.temperament),
      values: block(src.core_values, CARD_MAX.values),
      boundaries: block(src.extra_boundaries, CARD_MAX.boundaries),
      // 没填时内核用的是 DEFAULTS.language_baseline：设置页要显示真正生效的那句，
      // 不然界面写「还没写」、内核却在用一句话，两边对不上。
      language: block(src.language_baseline, CARD_MAX.language) || CONFIG_DEFAULTS.language_baseline,
    },
    personaCard: {
      raw: typeof card.raw === 'string' ? card.raw : '',
      at: text(card.at, 40),
    },
    // 旧配置里的 mode 不再读：模式现在由会话目录决定，全局默认那一层没有了。
    whaleWorkspaces: normalizeWhaleWorkspaces(src.whaleWorkspaces),
    knowledge: {
      vaultPath: text(knowledge.vaultPath, 400),
      vaultName: text(knowledge.vaultName, 40) || DEFAULT_VAULT_NAME,
    },
    obsidian: {
      enabled: bool(obsidian.enabled),
      prompted: bool(obsidian.prompted),
      // 只写双链：库里自己用，不需要照顾别的工具，配置里存过别的值也归一回来。
      linkMode: 'wiki',
    },
  }
}

/** 读原始 config.json（不经过人格层的 normalize），用来做「读-改-写」的底稿。 */
export function readConfigFile(paths) {
  try {
    const parsed = JSON.parse(readFileSync(paths.config, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 六个身份槽位：值、是否还能填、以及该显示哪句提示。 */
/**
 * 名字块里有没有「人自己选的」值。
 *
 * 内核会在配置空着时把自称退化成「鲸鲸」、把称呼按配置留空或写成初始值，
 * 那些都只是占位，不算人选过。判据只有一条：历史里出现过一条 trigger 不是
 * initial 的记录（设置页填的、对话里改的）。空名条目会被内核过滤掉，所以
 * 不能靠 history.length 判断。
 */
function chosenName(block) {
  const current = text(block?.current, 40)
  if (current === '') return ''
  const history = Array.isArray(block?.history) ? block.history : []
  const picked = history.some((item) => String(item?.trigger ?? 'initial') !== 'initial')
  return picked ? current : ''
}

/** 十项的行名。文案统一从 COPY 取，别在别处再抄一份。 */
const CARD_LABEL = Object.freeze({
  name: COPY.labelName,
  nameMeaning: COPY.labelNameMeaning,
  selfName: COPY.labelSelfName,
  selfNameMeaning: COPY.labelSelfNameMeaning,
  title: COPY.labelTitle,
  titleMeaning: COPY.labelTitleMeaning,
  temperament: COPY.labelTemperament,
  values: COPY.labelValues,
  boundaries: COPY.labelBoundaries,
  language: COPY.labelLanguage,
})

/**
 * 设置页那十项：值、可写、提示。
 *
 * 前六项是身份；后四项是内核读的底色与规则。原本它们分散在「身份」和
 * 「一行 config」两处，现在统一成一张卡——人粘贴一整段，看的也是这一张。
 */
export function describeIdentity(config, state) {
  const extras = normalizeExtras(config)
  const values = {
    name: text(config?.bot_name, 40),
    nameMeaning: extras.identity.nameMeaning,
    selfName: chosenName(state?.selfName),
    selfNameMeaning: extras.identity.selfNameMeaning,
    title: chosenName(state?.titleName),
    titleMeaning: extras.identity.titleMeaning,
    temperament: extras.card.temperament,
    values: extras.card.values,
    boundaries: extras.card.boundaries,
    language: extras.card.language,
  }

  return CARD_KEYS.map((key) => ({
    key,
    label: CARD_LABEL[key],
    value: values[key],
    multiline: MULTILINE_KEYS.has(key),
    limit: CARD_MAX[key],
    writable: true,
    hint: COPY.identityHint,
    action: COPY.actionFill,
  }))
}

/**
 * 粘贴区的现状：原文存了多少、什么时候存的。
 *
 * 原文不进内核，只在这儿留档——人回头要重新拆、或者想确认自己当初写了什么，
 * 靠的是它。真正进内核多少字，看 statusPayload 里的 kernel 账，别在这里估。
 */
export function describeCard(config) {
  const extras = normalizeExtras(config)
  return {
    raw: extras.personaCard.raw,
    chars: extras.personaCard.raw.length,
    at: extras.personaCard.at,
  }
}

/** 可编辑三项。路径永不给预填值（§10.1），空就空着。 */
export function describeEditable(config) {
  const extras = normalizeExtras(config)
  return {
    vaultPath: { value: extras.knowledge.vaultPath, placeholder: '笔记库在哪个目录' },
    obsidianEnabled: { value: extras.obsidian.enabled },
    whaleWorkspaces: { value: [...extras.whaleWorkspaces], max: WHALE_WORKSPACE_MAX },
  }
}

/** 页脚那几行小字的实测数字（设置页不许写估数）。 */
export function describeAccounting(state) {
  const memory = state?.memory ?? {}
  const counts = (list) => (Array.isArray(list) ? list.length : 0)
  const commitments = Array.isArray(state?.commitments) ? state.commitments : []
  return {
    shortFacts: counts(memory.facts),
    shortPreferences: counts(memory.preferences),
    shortEvents: counts(memory.events),
    shortOpenTopics: counts(memory.openTopics),
    longMemory: counts(state?.longMemory),
    commitments: commitments.filter((item) => item?.status === 'open').length,
    revision: Number(state?.revision) || 0,
  }
}

export function readImportRecord(importRecord) {
  if (!importRecord || !existsSync(importRecord)) return null
  try {
    const parsed = JSON.parse(readFileSync(importRecord, 'utf8'))
    return {
      from: text(parsed?.from, 40) || 'persona-framework',
      at: text(parsed?.at, 40),
      diff: Array.isArray(parsed?.diff) ? parsed.diff : [],
      counts: parsed?.counts && typeof parsed.counts === 'object' ? parsed.counts : null,
    }
  } catch {
    return null
  }
}

/** 给客户端那一半的 GET 响应体。 */
export function describeStatus({ api, importRecord }) {
  const config = api.getConfig()
  const state = api.getState()
  return {
    ok: true,
    identity: describeIdentity(config, state),
    card: describeCard(config),
    editable: describeEditable(config),
    accounting: describeAccounting(state),
    imported: readImportRecord(importRecord),
  }
}

/** 统一的失败形状：code 给机器，message 给人。 */
function fail(status, code, message, extra = {}) {
  return { ok: false, status, error: code, message, ...extra }
}

/**
 * 笔记库路径的校验：必须已存在、是目录、写得进去。
 * 只校验「能不能用」，不替人创建目录 —— 建库是人的动作。
 */
export function validateVaultPath(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return fail(400, 'vaultPath-required', COPY.vaultPathMissing)
  // 相对路径一律不接：当前工作目录不是人的笔记库，猜出来的一定是错的。
  if (!isAbsolute(raw)) return fail(400, 'vaultPath-not-absolute', COPY.vaultPathNotAbsolute)
  let info
  try {
    info = statSync(raw)
  } catch {
    return fail(400, 'vaultPath-not-a-directory', COPY.vaultPathMissing)
  }
  if (!info.isDirectory()) return fail(400, 'vaultPath-not-a-directory', COPY.vaultPathNotDirectory)
  try {
    accessSync(raw, constants.W_OK)
  } catch {
    return fail(400, 'vaultPath-no-access', COPY.vaultPathNoAccess)
  }
  return { ok: true, value: raw }
}

/**
 * 对话里改身份项：设置页填过之后只能走这条路。
 *
 * 与设置页的区别只有一条——这里**允许覆盖已有值**，但必须带理由，
 * 理由随配置事件一起进审计（「先问一句为什么」的落点就在这个参数上）。
 */
export function applyIdentityChange(api, paths, { key, value, reason } = {}) {
  if (!IDENTITY_KEYS.includes(key)) {
    return fail(400, 'key-not-allowed', COPY.fieldNotWritable, { keys: [key] })
  }
  const why = text(reason, 300)
  if (why === '') return fail(400, 'reason-required', COPY.reasonRequired)

  const limit = key.endsWith('Meaning') ? 300 : 40
  // 同上：先按原长拿，再自己判，别让 oneLine 的默认上限替人截断。
  const typed = typeof value === 'string' ? oneLine(clean(value, 100000), 100000) : ''
  if (typed.length > limit) return fail(400, 'identity-too-long', COPY.identityTooLong)
  // 空白不是错：清空一项 = 回到内核的默认值（名称/自称回「鲸鲸」、称呼留空）。
  // 2026-11-11 用户把称呼清空后点写入，这里曾经直接 400，页面表现为「没保存」。
  const next = text(typed, limit)

  const raw = readConfigFile(paths) ?? {}
  const extras = normalizeExtras(raw)
  const state = api.getState() ?? {}
  let nextState = null
  let nextBotName = null

  if (key === 'name') nextBotName = next
  else if (key === 'nameMeaning') extras.identity.nameMeaning = next
  else if (key === 'selfName') nextState = { ...state, selfName: renameBlock(state?.selfName, next, 'conversation') }
  else if (key === 'selfNameMeaning') extras.identity.selfNameMeaning = next
  else if (key === 'title') nextState = { ...state, titleName: renameBlock(state?.titleName, next, 'conversation') }
  else if (key === 'titleMeaning') extras.identity.titleMeaning = next

  const config = {
    ...raw,
    identity: {
      nameMeaning: extras.identity.nameMeaning,
      selfNameMeaning: extras.identity.selfNameMeaning,
      titleMeaning: extras.identity.titleMeaning,
    },
    whaleWorkspaces: extras.whaleWorkspaces,
    knowledge: extras.knowledge,
    obsidian: extras.obsidian,
  }
  // 名字可以清空：空串也是一个明确的值（内核回退成「鲸鲸」），不能因为假值跳过。
  if (nextBotName !== null) config.bot_name = nextBotName

  delete config.onboarding
  delete config.identity.meaning
  // 旧的全局模式字段一并清掉：留着它只会让人以为还有一层兜底。
  delete config.mode
  const result = api.setConfig(config, `identity:${why}`)
  if (!result || result.ok !== true) {
    return fail(500, 'config-write-failed', COPY.settingsWriteFailed)
  }
  if (nextState) {
    const saved = api.setState(nextState, 'identity', { source: 'conversation', keys: [key], reason: why })
    if (!saved) return fail(500, 'state-write-failed', COPY.settingsWriteFailed)
  }
  return { ok: true, applied: [key], reason: why }
}

/**
 * 把一个身份值写进 name 块：旧那段收尾，新那段开着口。
 * 与人格层 `state.selfName/titleName` 的形状保持一致（{current, history}）。
 */
export function renameBlock(block, name, trigger = 'settings-page') {
  const now = Date.now()
  const history = Array.isArray(block?.history) ? block.history.map((item) => ({ ...item })) : []
  for (const item of history) {
    if (item && item.to === null) item.to = now
  }
  history.push({ name, from: now, to: null, trigger })
  const limit = 20
  return { current: name, history: history.slice(-limit) }
}

/**
 * 写状态，失败一律折成 false。
 *
 * `api.setState` 成功时返回新状态对象，失败时会**抛**（落盘那一步直接炸）。
 * 两种都要接住：一个抛出来的磁盘错误要是直接穿透 `applySettings`，
 * 「这一单退不退」的判断就整段跳过去了——那正是 2026-11-12 收掉的那条边界的入口。
 */
function trySetState(api, next, source, keys) {
  try {
    return Boolean(api.setState(next, 'identity', { source, keys }))
  } catch {
    return false
  }
}

/**
 * 写设置页的项（四个设施项 + 人格卡十项 + 原文存档）。
 *
 * 十项随时可改，改完立刻生效。多行的那四项（底色 / 价值观 / 边界 / 说话）
 * 按块存：换行不压平，边界常常是一串条目，压成一行就没法读了。
 *
 * 写盘借 `api.setConfig` / `api.setState`，配置和状态各自只有一个写者。
 */
export function applySettings(api, paths, patch) {
  const body = patch && typeof patch === 'object' ? patch : {}
  // 换库时要不要搬那两块目录：默认搬，`migrateVault: false` 是给人留的退路
  // （比如两台库轮着用，只想换指向）。它不是配置项，摘掉再走键检查。
  const shouldMove = body.migrateVault !== false
  const input = { ...body }
  delete input.migrateVault
  const keys = Object.keys(input)
  const illegal = keys.filter((key) => !EDITABLE_KEYS.includes(key))
  if (illegal.length > 0) {
    return fail(403, 'key-not-allowed', COPY.fieldNotWritable, { keys: illegal })
  }

  const raw = readConfigFile(paths) ?? {}
  const extras = normalizeExtras(raw)
  const config = api.getConfig() ?? {}
  const state = api.getState() ?? {}
  const applied = []
  let nextState = null
  /** 换库待办：迁移放在所有校验都过、写盘之前，失败就整单不写。 */
  let vaultMove = null

  // ---- 人格卡十项：随时可改
  for (const key of CARD_KEYS) {
    if (!Object.hasOwn(input, key)) continue
    const limit = CARD_MAX[key]
    const multiline = MULTILINE_KEYS.has(key)
    // oneLine 自带 200 字上限，会把超长悄悄切掉——这里先按原长拿，再自己判。
    const rawText = typeof input[key] === 'string' ? clean(input[key], 100000) : ''
    const typed = multiline ? rawText : oneLine(rawText, 100000)
    // 超长一律拒收：说了要改就拿回手改，不替人截断。
    if (typed.length > limit) {
      return fail(
        400,
        'card-field-too-long',
        `${COPY.identityTooLong}（${CARD_LABEL[key]}最多 ${limit} 字）`,
        { keys: [key], limit },
      )
    }
    const value = multiline ? block(typed, limit) : text(typed, limit)
    // 空白照收：清空底色/边界、清掉称呼、把说话风格交回默认那句，都是人的合法动作。
    // （内核读不到值时自己兜底：名称回「鲸鲸」、语言回 DEFAULTS.language_baseline。）
    if (key === 'name') {
      extras.identity.nameValue = value // 只是暂存，落盘时写到 bot_name
    } else if (key === 'nameMeaning') {
      extras.identity.nameMeaning = value
    } else if (key === 'selfName') {
      nextState = { ...(nextState ?? state), selfName: renameBlock(state?.selfName, value) }
    } else if (key === 'selfNameMeaning') {
      extras.identity.selfNameMeaning = value
    } else if (key === 'title') {
      nextState = { ...(nextState ?? state), titleName: renameBlock(state?.titleName, value) }
    } else if (key === 'titleMeaning') {
      extras.identity.titleMeaning = value
    } else if (key === 'temperament') {
      extras.card.temperament = value
    } else if (key === 'values') {
      extras.card.values = value
    } else if (key === 'boundaries') {
      extras.card.boundaries = value
    } else if (key === 'language') {
      extras.card.language = value
    }
    applied.push(key)
  }

  // ---- 原文存档：只留着给人回看和重拆，不进内核
  if (Object.hasOwn(input, 'personaCard')) {
    const pasted = typeof input.personaCard === 'string' ? input.personaCard.replace(/\r\n?/g, '\n') : ''
    if (pasted.length > CARD_RAW_MAX) return fail(400, 'personaCard-too-long', COPY.cardTooLong)
    extras.personaCard.raw = pasted
    extras.personaCard.at = new Date().toISOString()
    applied.push('personaCard')
  }

  // ---- 四个设施项
  if (Object.hasOwn(input, 'vaultPath')) {
    const checked = validateVaultPath(input.vaultPath)
    if (!checked.ok) return checked
    // 记下旧路径再覆盖：换库时要把台账和上下文搬过去。
    const previous = extras.knowledge.vaultPath
    extras.knowledge.vaultPath = checked.value
    applied.push('vaultPath')
    if (shouldMove && previous !== '' && previous !== checked.value) {
      vaultMove = { from: previous, to: checked.value }
    }
  }

  if (Object.hasOwn(input, 'obsidianEnabled')) {
    if (typeof input.obsidianEnabled !== 'boolean') {
      return fail(400, 'obsidianEnabled-not-boolean', COPY.obsidianNotBoolean)
    }
    extras.obsidian.enabled = input.obsidianEnabled
    extras.obsidian.prompted = true
    applied.push('obsidianEnabled')
  }

  if (Object.hasOwn(input, 'whaleWorkspaces')) {
    const list = input.whaleWorkspaces
    if (!Array.isArray(list)) return fail(400, 'whaleWorkspaces-not-array', COPY.whaleWorkspacesNotArray)
    const paths = []
    for (const item of list) {
      if (typeof item !== 'string') return fail(400, 'whaleWorkspaces-not-string', COPY.whaleWorkspacesNotString)
      const path = item.trim()
      if (path === '') continue
      // 不静默截断路径：截断后的目录是另一个目录，比报错危险得多。
      if (path.length > 400) return fail(400, 'whaleWorkspace-too-long', COPY.whaleWorkspaceTooLong)
      paths.push(path)
    }
    // 先按「不截断」归一，才量得出到底超没超 —— 截断之后再比，永远比不出来。
    const unique = normalizeWhaleWorkspaces(paths, Number.POSITIVE_INFINITY)
    if (unique.length > WHALE_WORKSPACE_MAX) {
      return fail(400, 'whaleWorkspaces-too-many', COPY.whaleWorkspacesTooMany)
    }
    extras.whaleWorkspaces = unique
    applied.push('whaleWorkspaces')
  }

  // 打开联动必须有库路径：判据里写明「路径为空时设置页不能保存，依赖库的功能不可用」。
  // 放在四个设施项之后判，是因为同一个请求里可能先开开关、再给路径。
  if (extras.obsidian.enabled === true && extras.knowledge.vaultPath === '') {
    return fail(400, 'vaultPath-required', COPY.vaultPathRequiredForObsidian)
  }

  if (applied.length === 0) return { ok: true, applied: [], warnings: [] }

  // 换库：先把台账和上下文搬过去，搬成了才写配置。
  // 搬不成整单返回，配置不动 —— 不会留下「指向新库、内容还在旧库」那种局面。
  let migrated = null
  if (vaultMove) {
    const done = migrateVault(vaultMove)
    if (done.ok !== true) {
      const busy = done.reason === 'target-busy'
      return fail(409, done.reason, busy ? COPY.vaultMigrateBusy : COPY.vaultMigrateFailed, {
        dirs: Array.isArray(done.dirs) ? done.dirs : [],
        detail: done.detail ?? '',
      })
    }
    migrated = done
  }

  const nextBotName = extras.identity.nameValue ?? null
  const identity = {
    nameMeaning: extras.identity.nameMeaning,
    selfNameMeaning: extras.identity.selfNameMeaning,
    titleMeaning: extras.identity.titleMeaning,
  }

  const next = {
    ...raw,
    identity,
    whaleWorkspaces: extras.whaleWorkspaces,
    knowledge: extras.knowledge,
    obsidian: extras.obsidian,
    // 这四项是内核第 1、2 节真正读的文本，跟界面上的十项必须同一份来源。
    core_temperament: extras.card.temperament,
    core_values: extras.card.values,
    extra_boundaries: extras.card.boundaries,
    language_baseline: extras.card.language,
    // 原文只留档：给人回看和重拆用，不进提示词。
    personaCard: { raw: extras.personaCard.raw, at: extras.personaCard.at },
  }
  if (nextBotName !== null) next.bot_name = nextBotName
  // 首次询问那套已经不做了，旧盘里那份配置顺手清掉，别留死数据。
  delete next.onboarding
  delete next.identity.meaning
  delete next.mode

  // 顺序：迁移 → 写状态 → 写配置。
  // **配置是这一单的提交点**：它落盘之前每一步都能退，落了盘才算整单成。
  // 反过来先写配置的话，状态那一步失败就只剩「库指新库、自称还是旧的」这半截局面，
  // 得靠人再存一次才对得上——2026-11-12 收掉的就是这条。
  const stateBefore = state
  if (nextState) {
    const saved = trySetState(api, nextState, 'settings-page', applied)
    if (!saved) {
      // 状态没写进去：配置一个字都没动，刚搬过去的副本也撤掉。
      const undone = migrated === null ? null : undoMigrate(migrated)
      if (undone !== null && undone.left.length > 0) {
        return fail(500, 'state-write-failed', COPY.settingsWriteFailedLeft, {
          left: undone.left.map((item) => item.dir),
          target: migrated.target,
        })
      }
      return fail(500, 'state-write-failed', COPY.settingsWriteFailed)
    }
  }

  let result = null
  try {
    result = api.setConfig(next, 'settings-page')
  } catch (error) {
    // 写配置抛错跟返回失败是同一种局面，一样要把刚才那一步退掉。
    result = { ok: false, detail: String(error?.message ?? error) }
  }
  if (!result || result.ok !== true) {
    // 配置没落盘：刚写进去的状态退回原样，落地的副本也撤掉，整单不留半截。
    // 源库一直没动，删副本不丢数据；留着反而会让下次换库被自己的副本拦住。
    const restored = nextState ? trySetState(api, stateBefore, 'settings-page-rollback', applied) : true
    const undone = migrated === null ? null : undoMigrate(migrated)
    if (!restored) return fail(500, 'config-write-failed', COPY.settingsStateKeepFailed)
    if (undone !== null && undone.left.length > 0) {
      return fail(500, 'config-write-failed', COPY.settingsWriteFailedLeft, {
        left: undone.left.map((item) => item.dir),
        target: migrated.target,
      })
    }
    return fail(500, 'config-write-failed', COPY.settingsWriteFailed)
  }

  return {
    ok: true,
    applied,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    // 换库时搬了什么：只在真的搬了文件时出现，设置页拿它拼提示。
    ...(migrated ? { migrated } : {}),
  }
}
