// 换会话：压缩确认没吃到收益时，插件自己开一个新会话，别只劝人手动开。
//
// 口径（2026-11-12 人类定）：
//   - 什么时候开：只在「压完下一轮复检仍超触发点」那一次开（compact.js 的 `switch`），
//     平时照旧自动压缩。
//   - 开出来的会话怎么起头：助手模式带一张交接条（目录、做到哪、未完成、档案编号），
//     鲸鲸模式干净开 —— 聊天模式不该被一张机器写的交接条破坏。
//   - 旧会话：说一句「已切到新会话 <id>」就停手；自动压缩保持停用，不再开第二个。
//
// 这一层只拼文本、调两个宿主服务，不碰盘：
//   `sessionController.create` 建会话（Web GUI 看得见的那种普通会话），
//   `sessionController.prompt` 把交接条作为第一条消息递进去。
// 服务取不到就如实说取不到，不假装开成了。

import { resolveMode } from '../mode.js';

/** 交接条上限：太长就不像交接条、像把旧会话又搬了一遍。 */
export const HANDOFF_MAX = 1600;
/** 未完成的事最多列几条。 */
export const HANDOFF_ITEMS_MAX = 6;
/** 目录最多带几行：给编号够用了，正文她自己会取。 */
export const HANDOFF_CATALOG_MAX = 6;

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * 宿主 `prompt` 的第二个参数是必填的 AbortSignal：它第一行就 `signal.throwIfAborted()`，
 * 漏了会直接抛 TypeError（2026-11-12 真机第一次就是这么栽的，会话建出来、交接条没进去）。
 * 用带超时的信号：递一张交接条本该是几百毫秒的事，久等不回来就放手，别把会话卡住。
 */
export function promptSignal(ms = 20000) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // 运行时不认 timeout 就退手动控制器。
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

/** 取服务：先直接取、再走 ctx.get —— 没声明 inject 的服务直接取会抛。 */
export function makeServiceOf(ctx) {
  return (key) => {
    try {
      const direct = ctx?.[key];
      if (direct !== undefined && direct !== null) return direct;
    } catch {
      // 没 inject 的服务直接访问会抛：这条只是「先试试」，抛了就往下走。
    }
    try {
      return typeof ctx?.get === 'function' ? ctx.get(key) ?? null : null;
    } catch {
      return null;
    }
  };
}

/** 会话当前目录：投影优先，拿不到退回会话头。两个都空就空串。 */
export function cwdOfSession(session, workingDirectory) {
  try {
    const live = typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : '';
    const dir = oneLine(live);
    if (dir !== '') return dir;
  } catch {
    // 投影读不到就退会话头，跟模式段同一个兜底口径。
  }
  return oneLine(session?.header?.cwd);
}

/**
 * 老会话挂在哪个工作区：先按会话编号在注册表里找，再按目录反查。
 * 两条路都不建新的 —— 老会话本来没有工作区，新会话也就不归组，不替人决定多出一个工作区。
 */
export async function workspaceOfSession(session, getService, cwd = '') {
  const registry = getService('workspaceRegistry');
  if (!registry) return null;
  const id = oneLine(session?.id ?? session?.header?.id);
  try {
    const list = typeof registry.list === 'function' ? registry.list() : [];
    if (id !== '') {
      for (const workspace of Array.isArray(list) ? list : []) {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [];
        if (ids.includes(id)) return workspace;
      }
    }
  } catch {
    // 注册表读不到就退按目录反查。
  }
  const dir = oneLine(cwd);
  if (dir === '' || typeof registry.resolveByPath !== 'function') return null;
  try {
    return (await registry.resolveByPath(dir)) ?? null;
  } catch {
    // 目录不存在或本来就不是工作区：不归组。
    return null;
  }
}

/** 未完成的事：未结话题 + 还开着的约定，各留一句短的。 */
export function openItemsOf(state) {
  const out = [];
  const topics = Array.isArray(state?.memory?.openTopics) ? state.memory.openTopics : [];
  for (const topic of topics) {
    const text = oneLine(topic);
    if (text !== '') out.push(text);
  }
  const commitments = Array.isArray(state?.commitments) ? state.commitments : [];
  for (const item of commitments) {
    if (item?.status !== 'open') continue;
    const text = oneLine(item?.text);
    if (text !== '') out.push(text);
  }
  return out.slice(0, HANDOFF_ITEMS_MAX);
}

/**
 * 拼交接条。
 *
 * 第一句必须写明「这不是用户本人说的话」——它在对面那条会话里是一条 user 消息，
 * 不写清，模型会当成用户一上来就甩了个纸条。
 */
export function handoffText({ oldSessionId = '', cwd = '', used = null, trigger = null, items = [], catalog = '', reason = '' } = {}) {
  const lines = [];
  lines.push('[whale-pal 交接] 这条不是用户本人发的，是上一个会话自动交过来的班。');
  const known = oneLine(reason);
  const why = known !== ''
    ? known
    : Number.isFinite(used) && Number.isFinite(trigger)
      ? `压完下一轮已用到 ${used}，仍在触发点 ${trigger} 之上，自动压缩已停，所以换了新会话`
      : '上一个会话压完仍在触发点之上，自动压缩已停，所以换了新会话';
  const old = oneLine(oldSessionId);
  lines.push(`- 旧会话：${old === '' ? '（不知道编号）' : old}（${why}）`);
  if (oneLine(cwd) !== '') lines.push(`- 当前目录：${oneLine(cwd)}`);
  if (Array.isArray(items) && items.length > 0) {
    lines.push('- 未完成的事：');
    for (const item of items.slice(0, HANDOFF_ITEMS_MAX)) {
      const text = oneLine(item);
      if (text !== '') lines.push(`  - ${text}`);
    }
  }
  const body = oneLine(catalog) === '' ? '' : String(catalog).trim();
  if (body !== '') {
    const rows = body.split('\n').filter((line) => oneLine(line) !== '').slice(0, HANDOFF_CATALOG_MAX);
    lines.push('- 档案目录（按编号用 whale_ctx 取回正文）：');
    for (const row of rows) lines.push(`  ${oneLine(row)}`);
  }
  lines.push('接着干：先看一眼目录和未完成的事，需要细节就用编号取回；不确定的地方问用户。');
  const text = lines.join('\n');
  return text.length <= HANDOFF_MAX ? text : `${text.slice(0, HANDOFF_MAX)}…`;
}

/**
 * 开新会话，必要时把交接条递进去。
 *
 * @returns {Promise<{ok:boolean, reason:string, sessionId:string, mode:string, preset:string, seeded:boolean, detail?:string}>}
 *   `ok:true` 只代表「会话建成了」；`seeded:false` 表示交接条没递进去（鲸鲸模式本来就不递）。
 */
export async function switchSession({ getService, api, session, used = null, trigger = null, catalog = '', reason = '' } = {}) {
  const out = { ok: false, reason: '', sessionId: '', mode: '', preset: '', seeded: false, workspace: '', grouped: null };
  const controller = getService('sessionController');
  if (!controller || typeof controller.create !== 'function') {
    out.reason = 'no-session-controller';
    return out;
  }

  const cwd = cwdOfSession(session, getService('workingDirectory'));
  const mode = resolveMode({ config: api?.getConfig?.() ?? {}, cwd });
  out.mode = mode;

  let preset = '';
  try {
    const presets = getService('agentPresets');
    preset = oneLine(
      typeof presets?.presetForSession === 'function'
        ? presets.presetForSession(session)
        : session?.header?.agentPreset,
    );
  } catch {
    preset = oneLine(session?.header?.agentPreset);
  }
  out.preset = preset;

  let created = null;
  try {
    created = await controller.create({
      ...(cwd === '' ? {} : { cwd }),
      ...(preset === '' ? {} : { agentPreset: preset }),
    });
  } catch (error) {
    out.reason = 'create-failed';
    out.detail = String(error?.message ?? error);
    return out;
  }
  const sessionId = oneLine(created?.sessionId);
  if (sessionId === '') {
    out.reason = 'create-failed';
    out.detail = '宿主没回会话编号';
    return out;
  }
  out.ok = true;
  out.sessionId = sessionId;

  // 挂到老会话的工作区。`create` 只在传 workspaceId 时才 attachSession，
  // 传 cwd 建出来的会话是「无主」的 —— GUI 侧栏就会把它放进「未分组」，跟老会话分开。
  // 挂不上不算没开成：会话已经在了，只是没归组，照实说。
  try {
    const workspace = await workspaceOfSession(session, getService, cwd);
    if (workspace && typeof workspace.attachSession === 'function') {
      out.workspace = oneLine(workspace.id ?? workspace.workspaceId);
      await workspace.attachSession(sessionId);
      out.grouped = true;
    }
  } catch (error) {
    out.grouped = false;
    out.groupDetail = String(error?.message ?? error);
  }

  // 鲸鲸模式干净开：聊天不需要一张机器写的交接条。
  if (mode === 'whale') return out;
  if (typeof controller.prompt !== 'function') {
    out.reason = 'no-prompt';
    return out;
  }

  const text = handoffText({ oldSessionId: oneLine(session?.id ?? session?.header?.id), cwd, used, trigger, reason, items: openItemsOf(api?.getState?.() ?? {}), catalog });
  try {
    await controller.prompt(
      {
        requestId: `whale-pal-switch-${Date.now()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      promptSignal(),
    );
    out.seeded = true;
  } catch (error) {
    // 会话已经建出来了：这一步失败不算白开，只是没接到班——照实说。
    out.reason = 'prompt-failed';
    out.detail = String(error?.message ?? error);
  }
  return out;
}
