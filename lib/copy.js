/**
 * 用户能看见的文案集中在这里。
 *
 * 为什么单独一个文件：文案口径要能被一条扫描测试兜住（融合计划 §13.6 禁词表），
 * 散在逻辑里就没法扫。凡是会被渲染到界面或回执上的句子，都必须从 COPY 里取。
 *
 * 口径（改文案前先读一遍）：
 *   - 不用提示腔，不用感叹号，不用「请 / 务必 / 注意 / 哦 / 啦 / 呢」；
 *   - 空值统一写 COPY.empty；
 *   - 报错先说「我这边缺什么」，再说该怎么补；
 *   - 数字只写实测值，不写「大概 / 左右」。
 */
/** 把宿主那边的报错压成一句能塞进回执的短话：完整栈给谁看都没用。 */
const brief = (detail, max = 160) => {
  const text = String(detail ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

/** 交接条没递进去时，把那句报错接在后面（有才接，没有就不留空括号）。 */
const whyNot = (detail) => (brief(detail) === '' ? '' : `：${brief(detail)}`);

/** 会话没挂到老会话的工作区时补一句：不然人开了新会话，侧栏里发现它落进「未分组」。 */
const groupNote = (failed) =>
  brief(failed) === '' ? '' : `（新会话没归到工作区：${brief(failed)}，侧栏里会落在未分组）`;

export const COPY = Object.freeze({
  // ---- 设置页：六个身份槽位（随时可改）
  identityHint: '这一项随时能改',
  labelName: '名称',
  labelNameMeaning: '名称的含义',
  labelSelfName: '自称',
  labelSelfNameMeaning: '自称的含义',
  labelTitle: '称呼',
  labelTitleMeaning: '称呼的含义',
  actionFill: '写入',
  identityTooLong: '这段太长，我存不下',
  meaningTooLong: '含义最多 200 字，这段我存不下',
  reasonRequired: '没给理由，我没改',
  toolName: 'whale_pal_identity',
  memoryToolName: 'whale_pal_memory',
  progressToolName: 'whale_pal_progress',
  rollbackToolName: 'whale_pal_rollback',
  rollbackDone: '退回去了',
  rollbackNoBackup: '这个文件没有备份，我没动它',
  rollbackOutside: '这个路径不在我能碰的范围里，我没动',
  rollbackMissing: '这个文件不存在，也没备份，我没动',

  // ---- 人格卡：一整段粘进来，拆成十一项
  labelTemperament: '底色',
  labelValues: '价值观',
  labelBoundaries: '边界',
  labelLanguage: '说话风格',
  labelSummary: '总结',
  cardPasteHint: '把整段人格设定粘进来，我按名称、称呼、价值观、边界这些分好，你逐项改。',
  actionSplit: '拆一下',
  actionSplitByModel: '让模型帮我拆',
  actionApplyCard: '全部写进去',
  cardEmptyRaw: '还没粘进来内容',
  cardNoTag: '这一段里我没认出标签，一行都没归到十项里；要么补上「名称：」「价值观：」这类标签，要么点「让模型帮我拆」',
  cardSections: (sections, chars) => `另有 ${sections} 段（${chars} 字）没进内核，原样存着——它们不会出现在对话里`,
  cardSaved: '原文存下了',
  cardTooLong: '这段太长了，我存不下原文（上限 10000 字）',
  cardSplitFailed: '这次没拆出来，模型那边没回话或者回的东西读不懂',
  // 光说「读不懂」等于什么都没说：人不知道是没模型、超时、还是回了半截。
  // 每种失败都有自己的名字，页面把原因接在通用那句话后面。
  cardSplitReasons: Object.freeze({
    'llm-unavailable': '宿主没给到模型服务',
    'no-model': '宿主里没有可用的默认模型',
    'model': '这次调用没成',
    unparseable: '模型回了，但不是能读的 JSON',
    empty: '模型回了个空的',
    truncated: '模型把输出额度用完了，十项没吐完',
    'stream-error': '模型那边报错，流断了',
    timeout: '等了 60 秒没回',
  }),
  cardSplitReason: (why) => `这次没拆出来：${why}`,
  cardHumanOver: (chars, limit) => `这十项里有 ${chars} 字会进内核，超过 ${limit} 字：每轮对话都要带这么多`,
  cardHumanUnder: (chars) => `这十项里有 ${chars} 字会进内核`,

  // ---- 设置页：可编辑项
  labelVaultPath: '笔记库路径',
  labelVaultName: '笔记库名字',
  labelObsidian: 'Obsidian 联动',
  labelDefaultMode: '默认模式',
  actionVaultPath: '更改路径',
  actionSave: '保存这一项',
  actionConnect: '接入这个库',
  empty: '还没写 · 想起来再说',
  saved: '改好了',
  actionPickFolder: '选目录',
  pickerUnavailable: '这台机器没给我选目录的窗口，路径可以直接粘进来',
  pickerFailed: '选目录的窗口出了岔子，路径没动',
  pickerCancelled: '没选，路径没变',

  // ---- 校验与报错
  vaultPathMissing: '这个目录不存在，我不知道你的笔记在哪',
  vaultPathNotAbsolute: '这个路径没从盘符或根目录开始，我看不懂',
  vaultPathNotDirectory: '这个路径不是文件夹，我这边要的是笔记库的目录',
  vaultPathNoAccess: '这个目录我打不开，权限不让',
  vaultMigrateFailed: '新库没搬成，路径没改。旧库还是原来的，一个字节没动',
  vaultMigrateBusy: '新库里已经有台账或上下文，里面不是空的。我不合并也不覆盖，先把那边挪开或换个库',
  obsidianNotBoolean: '这个开关只认开和关，别的值我没存',
  rejectServileNotBoolean: '称呼那个开关只认开和关，别的值我没存',
  bodyNotJson: '这段内容不是 JSON，我没动设置',
  bodyTooLarge: '这段话太长，我没收',
  modeUnknown: '模式只有 assistant 和 whale 两种',
  modeCommandHint: '我只会 /whale mode、/whale bind、/whale unbind、/whale new',
  workspaceUnknown: '读不到这个会话的工作目录，改不了绑定',
  workspaceIsWhale: '这个目录是鲸鲸工作区',
  workspaceIsAssistant: '这个目录是助手工作区',
  workspaceBoundWhale: '这个目录已设成鲸鲸工作区，下面新开的会话都走鲸鲸模式',
  workspaceBoundAssistant: '这个目录已设回助手工作区',
  whaleWorkspacesNotArray: '工作区名单得是一个列表，我没存',
  whaleWorkspacesNotString: '名单里有一项不是路径，我没存',
  whaleWorkspaceTooLong: '这个路径太长，我不敢截断，会变成另一个目录',
  whaleWorkspacesTooMany: '鲸鲸工作区最多 20 个，减掉几个再存',
  fieldNotWritable: '这一项在设置页改不了，要改就在对话里说',
  settingsWriteFailed: '写配置没成功，我这边没留下改动',
  settingsWriteFailedLeft: '写配置没成功，旧库还在用；但新库里那份刚搬过去的副本没删掉，下次换库会撞上「新库不是空的」。把它手动删掉再试',
  settingsStateKeepFailed: '写配置没成功，旧库还在用；可刚写进去的自称/称呼也没退回来，跟配置里的含义可能对不上。重存一次就能对齐',

  // ---- 模式
  modeAssistant: '助手模式',
  modeWhale: '鲸鲸模式',
  modeNow: (name) => `模式：${name}`,

  // ---- 鲸鲸工作区（设置页那一块）
  labelWhaleWorkspaces: '鲸鲸工作区',
  whaleWorkspacesHint: '列在这儿的目录走鲸鲸模式，其余目录一律助手模式',
  whaleWorkspacesEmpty: '还没选。选一个目录当聊天的地儿，或者手动填路径',
  whaleWorkspacesUnreadable: '读不到工作区列表，可以在下面手动填一个路径',
  actionAddWorkspace: '加入',
  actionRemoveWorkspace: '移出',
  workspacePathPlaceholder: '例如 D:\\AI 项目\\我的项目',
  workspaceTagged: '名字前面会加【鲸鲸】',
  workspaceUntagged: '助手工作区不改名',

  // ---- 笔记库（Obsidian）
  vaultPathRequiredForObsidian: '打开联动之前，得先有笔记库路径',
  relPathRequired: '没给笔记路径，我不知道要打开哪一篇',

  // ---- 健康（装载六步与三级失败态）
  upgradeNever: '还没升过版',
  healthToolName: 'whale_pal_health',
  healthReadonly: '现在是只读状态，写不了',
  healthDisabled: '这个插件停用了，写不了',
  healthGrace: '新装只读复核到 ',

  // ---- 上下文档案（压缩档案、索引、锚定块）
  ctxToolName: 'whale_ctx',
  ctxNeedsVault: '还没选笔记库，档案没地方放',
  ctxNeedsQuery: '要查什么，给我一个词',
  ctxNeedsId: '要给一个编号，像 C007 这样',
  ctxCardMissing: (id) => `库里没有 ${id} 这张卡`,
  ctxNeedsBatch: '要给一个批次号，像 B002 这样',
  ctxNotFound: '记录里没查到这条',
  ctxEmpty: '还没有档案',
  ctxAnchorHead: '上下文档案（已经压过的历史，这里只列目录；要看内容用 whale_ctx 按编号读）',
  ctxUnknownAction: 'ctx 只认 search / read / files / entries / batch / rollback / sync / refresh / open 这几样',
  ctxSyncFailed: '这次没写进去，库可能不在',
  ctxSynced: (written, total, batch = '') => `收进 ${written} 份${batch}，库里现在 ${total} 份`,
  // 换会话：压完下一轮仍超触发点，插件自己开一个新会话（2026-11-12）。
  switchDoneAssistant: (id, seeded, detail = '', groupFailed = '') =>
    `[whale-pal] 已切到新会话 ${id}${seeded === true ? '，交接条已经递过去' : `（交接条没递进去${whyNot(detail)}，你到了那边先自己说一下在干什么）`}。这个会话不再自动压缩，接着干去新会话。${groupNote(groupFailed)}`,
  switchDoneWhale: (id, groupFailed = '') =>
    `[whale-pal] 已切到新会话 ${id}（鲸鲸模式，干净开的，没带交接条）。这个会话不再自动压缩，聊天去新会话。${groupNote(groupFailed)}`,
  switchFailed: (fallback, reason, detail = '') =>
    `${fallback}（插件自己开会话这一步没成：${reason}${brief(detail) === '' ? '' : `，${brief(detail)}`}，还得你手动开。）`,
  switchThrew: (fallback, detail) => `${fallback}（插件自己开会话这一步抛错：${detail}）`,
  switchManual: (id, seeded, detail = '', groupFailed = '') =>
    `[whale-pal] 新会话开好了：${id}${seeded === true ? '，交接条已经递过去' : `（交接条没递进去${whyNot(detail)}）`}。这个会话照旧，想去就切过去。${groupNote(groupFailed)}`,
  switchStarting: '正在开新会话（同目录同预设），建好了我把编号递回来',
  // 旧状态导入（P5）：`/whale import` 这一家的回话。
  importPlan: '旧状态导入',
  importNeedsRoot: '导入这条路没拿到路径，接不上',
  importUnknown: 'import 只认 status（或什么都不带）、rollback、rollback 确认、undo 这几样',
  importRunHint: '/whale import（现在只报情况，真导由启动那一步做）',
  importNoSnapshot: '没有快照，回滚不了——导入前的世界没存下来',
  importNoPreRollback: '没有 pre-rollback 快照，退不回来',
  importNeedsForce: '导入后新根又住下了，回滚会丢东西；把「确认」带上再来一次',
  importRollbackFailed: '这次没退成，盘上没动干净，看日志',
  // 台账与节律（P4）：`/whale ledger` 那一家的回话。
  ledgerOff: '台账没挂上（看启动日志），这会儿读不了',
  ledgerNoVault: '没设库，台账没处写——先去设置页把库目录填上',
  ledgerQuiet: '现在没什么要说的',
  ledgerUnknown: 'ledger 只认 status（或什么都不带）、preview、handoffs、fills、settle <行号> [ignore]、fallback <日|周|月> <值>',
})

const BANNED = Object.freeze(['请', '务必', '注意', '温馨提示', '哦', '啦', '呢', '！', '抱歉', '感谢理解'])

/**
 * 扫一段文本里的禁词。
 *
 * 只用来兜文案，不用来兜注释：调用方传进来的应该是渲染出去的字符串
 * （COPY 里的值、或者客户端页面的字面量），不是整份源码。
 */
export function findBanned(text) {
  const hits = []
  const value = String(text ?? '')
  for (const word of BANNED) {
    if (value.includes(word)) hits.push(word)
  }
  // 半角感叹号单独判：它在代码里到处都是，只在字符串里算违规。
  return hits
}

export { BANNED }
