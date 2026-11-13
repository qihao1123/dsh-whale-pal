// 口径出处：融合计划-v2.md §16.5.4（两条入口：用户 `/whale ctx search <词>`，模型自查最多 3 次）、
// §16.6（锚定块 ≤300 字、不落盘、每次注入现算）、§16.7（档案放库内 `_上下文/`，不进 01–07 域）。
//
// 这一层只做接线：把 ctx 纯逻辑模块挂成一条命令 + 一个工具 + `/status` 里的一格。
// 真正的读写都在 lib/ctx/store.js，判断在别的纯模块里，这里不重复实现。

import { anchorText, buildAnchor } from './inject.js';
import { cardsOfBatch, groupByBatch } from './batch.js';
import { extractRules, mergeEntries } from './entries.js';
import { rebuildFromCards } from './rebuild.js';
import { listFiles, readHint, searchIndex } from './search.js';
import { cardFileName, drainQueue, ctxRoot, pathsOf, pendingNew, rawCount, rawExists, rawFileOf, readCards, readTextFile, rebuildAll, refreshCards, setCardEntries, trashBatch } from './store.js';
import { makeProjection, drainPlan } from './watch.js';
import { rawFileName, renderRaw } from './raw.js';
import { pickSource } from './source.js';
import { rank, remainingOf, shouldAnnounce, tierOf } from './threshold.js';
import { ineffectiveText, makeCompactor } from './compact.js';
import { compactViaCommand } from './compact-cmd.js';
import { makeServiceOf, switchSession } from './switch.js';
import { COPY } from '../copy.js';
import { deepLink } from '../vault.js';
import { vaultReady } from '../vault-io.js';
import { messageFor } from '../inbox.js';

export const CTX_TOOL_NAME = 'whale_ctx';
export const CTX_SEARCH_MAX = 3;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function vaultOf(api) {
  const config = api?.getConfig?.() ?? {};
  return text(config?.knowledge?.vaultPath);
}

// 给 `/status` 与工具共用的一格：有多少份档案、库在哪、锚定块能不能算出来、投影到底挂上没有，
// 外加「还剩多少」——宿主 `contextPressure` 读到什么就是什么，读不到就如实标成估的。
export function ctxInfo({ api, projection = 'unknown', pressure } = {}) {
  const tier = tierFor({ pressure });
  const vault = vaultOf(api);
  if (vault === '') {
    return { ok: true, ready: false, cards: 0, raw: 0, projection, ...tier, message: COPY.ctxNeedsVault };
  }
  const root = ctxRoot(vault);
  const cards = readCards(root);
  const last = cards.length === 0 ? null : cards[cards.length - 1];
  return {
    ok: true,
    ready: true,
    root,
    cards: cards.length,
    raw: rawCount(root),
    projection,
    ...tier,
    lastId: last === null ? '' : last.id,
    lastTopic: last === null ? '' : text(last?.fields?.topic),
    // 锚定块不落盘了：这一格答的是「能不能算出内容」，不是「文件在不在」。
    anchor: anchorOf(root) !== '',
  };
}

/** 锚定块文本现算：卡片是唯一源，读一次卡片拼一次，不碰盘。 */
function anchorOf(root) {
  try {
    return anchorText({ lines: buildAnchor({ cards: readCards(root) }) });
  } catch {
    return '';
  }
}

/**
 * 原文回捞：投影里只留 seq（状态得小、得能 JSON 存档），正文留在会话里，
 * 真正落盘这一刻才去取。取不到就返回 null，让 drainQueue 把这份档案标成「没有原文」。
 */
export function rawPicker({ session, now = '' } = {}) {
  return (item) => {
    const eventAt = session?.eventAt;
    if (typeof eventAt !== 'function') return null;
    const seqs = Array.isArray(item?.seqs) ? item.seqs : [];
    if (seqs.length === 0) return null;
    const events = [];
    const missing = [];
    for (const seq of seqs) {
      let event = null;
      try {
        event = eventAt.call(session, seq);
      } catch {
        event = null;
      }
      // 取不到多半是宿主单点 prune 掉了：记下来交出去，让原文自己写明缺哪几条。
      if (event) events.push(event);
      else missing.push(seq);
    }
    if (events.length === 0) return null;
    return renderRaw({
      events,
      missing,
      blockId: item.blockId,
      gen: item.gen,
      range: item.range,
      at: item.at || now,
      provider: item.provider,
      model: item.model,
    });
  };
}

// 把待写档案收进库里、顺手留一份原文，再重算索引（锚定块按需现算）。
// 没有待写的东西也允许调用，那就是一次「重建索引」。
export function syncArchives({ api, pending = [], now = '', session = null } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const root = ctxRoot(vault);
  // 时钟只在这一层读：store 与 archive 都明说不看时钟。
  const stamp = text(now) === '' ? new Date().toISOString() : text(now);
  const drained = drainQueue({ root, pending, now: stamp, rawOf: rawPicker({ session, now: stamp }) });
  if (drained.ok !== true) return { ok: false, reason: drained.reason ?? 'sync-failed' };
  const cards = readCards(root);
  const anchor = anchorText({ lines: buildAnchor({ cards }) });
  return {
    ok: true,
    root,
    ids: drained.ids ?? [],
    // 这次发出去的批次号：一次压缩事件一个号，卡片的头里就记着它。
    batches: drained.batches ?? [],
    // 重放后同一块会被重新排进队列：已经落过的那几份跳过、不换编号，这里如实报出来。
    skipped: drained.skipped ?? [],
    cards: cards.length,
    raw: (drained.rawWritten ?? []).length,
    rawMissing: drained.rawMissing ?? [],
    rawFailed: drained.rawFailed ?? [],
    anchor: anchor === '',
    // 锚定块不落盘了（第二批形态审计）：每次注入时现算。这一格留着不让调用方拿到 undefined，
    // 但永远是 false —— 没有「写没写」这回事了。
    anchorWrote: false,
  };
}

/**
 * 自动落盘：一轮收尾时把队列里**还没落过盘**的那几条收进库。
 *
 * 为什么要有这一条：投影只在内存里折叠事件，`syncArchives` 原先只有手动入口
 * （`/whale ctx sync`、`whale_ctx` 工具的 sync）。宿主压了、投影记了，可没人去取，
 * 档案就一直不落盘——「无论压多早都存进档案」那句话只有手动跑过一次才成立。
 *
 * 规矩跟手动那条一样：没库、没新东西、写失败都只回一个说明，不抛。
 * 已经落过的条目这里先筛掉（`pendingNew`），不然每轮都要把几十万条被压事件
 * 重新拼一遍原文。
 */
export function autoArchive({ api, pending = [], now = '', session = null } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required' };
  const fresh = pendingNew(ctxRoot(vault), pending);
  if (fresh.length === 0) return { ok: true, wrote: false, ids: [], cards: readCards(ctxRoot(vault)).length };
  const done = syncArchives({ api, pending: fresh, now, session });
  if (done.ok !== true) return { ok: false, reason: done.reason ?? 'sync-failed' };
  return {
    ok: true,
    wrote: (done.ids ?? []).length > 0,
    ids: done.ids ?? [],
    cards: done.cards,
    raw: done.raw,
    rawMissing: done.rawMissing ?? [],
  };
}

// 取词口径改过以后，把已经落盘的档案按新口径重算一遍。只重写「主题」「关键词」两行。
// 锚定块不落盘，注入时现算，所以这里不用跟着写。
export function ctxRefresh({ api } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const root = ctxRoot(vault);
  const done = refreshCards(root);
  if (done.ok !== true) return { ok: false, reason: done.reason ?? 'refresh-failed', message: `重算没成功：${done.reason ?? '刷新失败'}` };
  const anchor = anchorText({ lines: buildAnchor({ cards: readCards(root) }) });
  return {
    ok: true,
    changed: done.changed ?? [],
    failed: done.failed ?? [],
    root,
    anchor: anchor === '',
    // 锚定块按需现算，没有「写没写」这回事；留一格不让调用方拿到 undefined。
    anchorWrote: false,
  };
}

// 锚定块进上下文的那一段：只放目录（编号 · 主题（关键词）），≤300 字、无任何时间戳，
// 所以档案不动它就一个字都不变——前缀缓存就靠这个活着。
// 它会占系统提示里的一格，所以**没内容就回空串**：没选库、库里没卡片，都不留一行空话。
// 每次渲染现算一遍（卡片是唯一源，不落盘），算不出来就回空串。
export function ctxAnchor({ api, head = '' } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return '';
  let body = '';
  try {
    body = text(anchorText({ lines: buildAnchor({ cards: readCards(ctxRoot(vault)) }) }));
  } catch {
    return '';
  }
  if (body === '') return '';
  const title = text(head);
  return title === '' ? body : `${title}\n${body}`;
}

/**
 * 条目表现算：读卡片、交给 `rebuildFromCards` 拼五列表。
 *
 * 表不再落盘（第二批形态审计：零持久读者，只是卡片的镜像）。算不出来就回空串，
 * 跟以前「文件读不到」同一口径，不把异常甩给调用方。
 */
function entriesTableOf(root) {
  const rebuilt = rebuildFromCards(readCards(root));
  return rebuilt?.ok === true && typeof rebuilt.entriesText === 'string' ? rebuilt.entriesText : '';
}

// 条目表：不给编号就把整张表端出来；给了编号就那一张卡的两路（规则 + 模型）条目。
// 表不再落盘：每次要就从卡片现算（`rebuildFromCards` 那套），卡片是唯一源。
// `rows` 非空才算补录——那是主模型顺手补的那一路，写进卡片再重算表（重算冲不掉）。
export function ctxEntries({ api, id = '', rows = [] } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const root = ctxRoot(vault);
  const want = text(id).toUpperCase();
  if (want === '') {
    const table = entriesTableOf(root);
    // 空不空看有没有数据行（序号那一列），不去猜表头长什么样。
    const dataRows = table.split('\n').filter((line) => /^\|\s*\d+\s*\|/u.test(line)).length;
    return { ok: true, scope: 'all', table, rows: dataRows, empty: dataRows === 0 };
  }
  const found = readCards(root).find((card) => card.id === want);
  if (!found) return { ok: false, reason: 'card-not-found', message: COPY.ctxCardMissing(want) };

  const rowOf = (one, way) => ({ type: one.type, content: one.content, sourceId: want, way });
  const ruleRows = (extractRules(found.fields.summary) ?? []).map((one) => rowOf(one, 'rule'));
  const modelRows = (Array.isArray(found.fields.entries) ? found.fields.entries : []).map((one) => rowOf(one, 'model'));

  if (Array.isArray(rows) && rows.length > 0) {
    const done = setCardEntries(root, { id: want, rows });
    if (done.ok !== true) {
      return { ok: false, reason: done.reason, message: done.reason === 'card-not-found' ? COPY.ctxCardMissing(want) : '条目没写进去' };
    }
    const table = entriesTableOf(root);
    return { ok: true, scope: 'card', id: want, added: done.added, wrote: done.wrote === true, rows: mergeEntries(ruleRows, done.entries.map((one) => rowOf(one, 'model'))), table };
  }

  return { ok: true, scope: 'card', id: want, rows: mergeEntries(ruleRows, modelRows), rule: ruleRows.length, model: modelRows.length };
}

// 整批撤下来：把这一批的卡片与原文挪进库内 `回收站/`，重算索引。
// 锚定块不落盘了，注入时按卡片现算，所以这里不用管它。
// 只挪不删——回收站里保持「压缩档案/」「原文/」两层，搬回去就等于还原。
export function ctxRollback({ api, batch = '', now = '' } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const root = ctxRoot(vault);
  const stamp = text(now) === '' ? new Date().toISOString() : text(now);
  const done = trashBatch(root, { batch, at: stamp });
  if (done.ok !== true) {
    if (done.reason === 'no-batch') return { ok: false, reason: 'no-batch', message: COPY.ctxNeedsBatch };
    if (done.reason === 'batch-unknown') return { ok: false, reason: 'batch-unknown', message: `库里没有 ${text(batch)} 这一批` };
    const stuck = (done.failed ?? []).map((one) => `${one.id}（${one.reason}）`).join('、');
    return {
      ok: false,
      reason: done.reason ?? 'rollback-failed',
      message: done.reason === 'rebuild-failed' ? '撤下来了，但索引没重算成功' : `有一份没挪动：${stuck}`,
      moved: done.moved ?? [],
      failed: done.failed ?? [],
    };
  }
  // 锚定块不落盘了：不在这儿算，也不写。要它的内容就现算（`ctxAnchor`）。
  return {
    ok: true,
    batch: done.batch,
    folder: done.folder,
    moved: done.moved,
    failed: done.failed,
    cards: done.cards,
    // 留一格不让调用方拿到 undefined：没有「写没写」这回事了，恒 false。
    anchorWrote: false,
  };
}

// 按批次查：不给批次号就列全部批次（号 + 份数 + 都是哪几个编号），给了就列这一批的每一份。
// 批次是「一次压缩事件落的一批卡片」的号，追溯与回滚都靠它。这个函数只读，不动盘。
export function ctxBatch({ api, batch = '' } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const root = ctxRoot(vault);
  const cards = readCards(root);
  const groups = groupByBatch(cards);
  const want = text(batch).toUpperCase();
  if (want === '') {
    return {
      ok: true,
      root,
      cards: cards.length,
      batches: groups.map((group) => ({
        batch: group.batch,
        count: group.cards.length,
        ids: group.cards.map((card) => card.id),
        at: group.cards.map((card) => card.at).sort()[0] ?? '',
      })),
    };
  }
  const hit = cardsOfBatch({ cards, batch: want });
  if (hit.length === 0) return { ok: false, reason: 'batch-unknown', message: `库里没有 ${want} 这一批` };
  return {
    ok: true,
    root,
    batch: want,
    count: hit.length,
    rows: hit.map((card) => ({
      id: card.id,
      blockId: card.blockId,
      gen: card.gen,
      range: card.fields.range,
      topic: card.fields.topic,
      at: card.at,
      source: card.source,
      file: cardFileName(card.blockId, card.gen),
      // 原文按块推名字；没留过就是空串，不假装有。
      raw: rawExists(root, card.blockId, card.gen) === true ? rawFileName(card.blockId, card.gen) : '',
    })),
  };
}

// 还剩多少、到没到提醒档：有宿主读数就用宿主的，没有就标出来是估的。
// 档位按**已用**判（第六批 §4.2）：按剩余判在 1M 窗口上永远响不了。
export function tierFor({ pressure } = {}) {
  const source = pickSource({ pressure });
  if (source.tokens === null) return { tier: 'ok', remaining: null, used: null, source: source.kind, exact: false };
  const remaining = remainingOf({ tokens: source.tokens, window: source.window });
  const tier = tierOf({ used: source.tokens, window: source.window });
  return { tier, remaining, used: source.tokens, source: source.kind, exact: source.exact };
}

// 宿主自己的投影键名。口径出处：`docs/P35-补全.md` 第二节（native 那一态）。
export const PRESSURE_KEY = 'contextPressure';

/**
 * 去宿主那儿取真实读数。宿主给的是
 * `{ pressureTokens, contextWindow, surfaceTokens?, projectedTokens? }`，
 * 直接交给 `pickSource`；取不到（没挂投影、没给会话、宿主换了形状）一律回 null，
 * 由 `pickSource` 退回自估——**不抛、不写盘、不缓存**，每次问每次现取。
 */
export function pressureOf({ session, projections } = {}) {
  if (!session) return null;
  if (!projections || typeof projections.stateOf !== 'function') return null;
  try {
    const state = projections.stateOf(session, PRESSURE_KEY);
    return state !== null && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

// 「还剩多少」的人话，命令里用；工具那一路直接给结构，不转话。
function leftoverText({ remaining, tier, source, exact } = {}) {
  if (remaining === null || remaining === undefined) {
    return `还剩：读不到读数（来源 ${source ?? 'none'}），只提醒不压缩这件事不受影响`;
  }
  const k = Math.round(remaining / 100) / 10;
  return `还剩 ${remaining} tokens（约 ${k}K），档位 ${tier}，来源 ${source}（${exact === true ? '真实读数' : '估的'}）`;
}

// 跨档时说的那一句。只提醒，绝不替人压 —— 宿主的自动压缩正常时这句永远不会出现。
//
// 口径（第六批 §4.2）：从「还剩多少」改成「用掉多少」。remind 的语义也跟着变了 ——
// 不再是「快满了」，而是「该压了」。
export function reminderText({ tier, remaining, used } = {}) {
  if (typeof tier !== 'string' || tier === 'ok') return '';
  const usedText = typeof used === 'number' && Number.isFinite(used) ? `已用约 ${Math.round(used / 1000)}K（${used} tokens）。` : '';
  const remainingText = typeof remaining === 'number' && Number.isFinite(remaining) ? `还剩约 ${Math.round(remaining / 100) / 10}K。` : '';
  if (usedText === '' && remainingText === '') return '';
  const tail = tier === 'critical'
    ? '已经见底，立刻 /compact。'
    : '该压了，可以手动 /compact。';
  return `[whale-pal] 上下文${usedText}${remainingText}${tail}`;
}

// 只有档位**往下探**才说一次；同一档说过就不再重复（回血后也不重说同一档）。
export function reminderOf({ prevTier, tier, remaining, used } = {}) {
  return shouldAnnounce(prevTier, tier) === true ? reminderText({ tier, remaining, used }) : '';
}

// 往会话里塞一条的形状在 `lib/inbox.js`（三处共用一份）。

export function ctxStatus({ api, pressure, projection = 'unknown' } = {}) {
  return ctxInfo({ api, projection, pressure });
}

export function ctxSearch({ api, query } = {}) {
  const word = text(query);
  const vault = vaultOf(api);
  if (word === '') return { ok: false, reason: 'query-required', message: COPY.ctxNeedsQuery };
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const indexText = readTextFile(pathsOf(ctxRoot(vault)).index);
  if (indexText === null) return { ok: true, rows: [], hit: false, text: COPY.ctxNotFound };
  return searchIndex({ text: indexText, query: word });
}

export function ctxRead({ api, id } = {}) {
  const code = text(id).toUpperCase();
  const vault = vaultOf(api);
  if (code === '') return { ok: false, reason: 'id-required', message: COPY.ctxNeedsId };
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const root = ctxRoot(vault);
  const cards = readCards(root);
  const hit = cards.find((card) => card.id === code);
  if (!hit) return { ok: true, hit: false, text: COPY.ctxNotFound, hint: readHint(code) };
  // 原文不留进卡片里（卡片要小、要进锚定块），位置按 blockId 推：可推导就不用在索引里多记一列。
  const hasRaw = rawExists(root, hit.blockId, hit.gen);
  return { ok: true, hit: true, card: hit, hasRaw, rawFile: hasRaw ? rawFileOf(root, hit.blockId, hit.gen) : '' };
}

export function ctxFiles({ api } = {}) {
  const vault = vaultOf(api);
  if (vault === '') return { ok: false, reason: 'vault-required', message: COPY.ctxNeedsVault };
  const cards = readCards(ctxRoot(vault));
  return { ok: true, rows: listFiles({ cards }), cards: cards.length };
}

// 打开一篇笔记：只拼深链，不读库、不写库。
// 原来是一支独立工具（`whale_pal_open`），并进 ctx 当 action —— 常驻工具 schema
// 是每轮都在的固定开销，低频入口少一个就少一格。
// 没有库、路径空着都直接拒：别给一个必然打不开的链接。
export function ctxOpen({ api, relPath = '' } = {}) {
  const config = api?.getConfig?.() ?? {};
  const ready = vaultReady(config);
  if (ready.ok !== true) return { ok: false, error: ready.error, message: ready.message };
  const link = deepLink({ vaultName: config?.knowledge?.vaultName, relPath });
  if (link === '') return { ok: false, error: 'relPath-required', message: COPY.relPathRequired };
  return { ok: true, link };
}

// `/whale ctx status`、`/whale ctx search <词>`、`/whale ctx read C007`、`/whale ctx files`、`/whale ctx sync`、`/whale ctx open <库内路径>`
// `statusOf` 是个函数：只在真问到 status 时才去读库、读投影，别的分支不白花。
export function ctxCommand({ api, rawInput, pending = [], now = '', session = null, statusOf = null } = {}) {
  const rest = text(rawInput).replace(/^ctx\b/iu, '').trim();
  const [head, ...tail] = rest.split(/\s+/u).filter((item) => item !== '');
  const argument = tail.join(' ');
  if (head === undefined) {
    return { ok: true, text: 'ctx 能做的：status 看还剩多少、remind 看提醒会不会说、search <词> 找档案、read C007 读一份、files 列全部、entries [C007] 看条目表、batch [B002] 按批次查、rollback B002 整批撤进回收站、sync 把待写的收进库里（顺手留原文）、refresh 按当前口径把旧档案的主题与关键词重算一遍、open <库内路径> 拼一篇笔记的 Obsidian 深链' };
  }
  if (head === 'status') {
    const status = typeof statusOf === 'function' ? statusOf() : null;
    if (!status || status.ok !== true) return { ok: false, text: status?.message ?? COPY.ctxNeedsVault };
    if (status.ready !== true) return { ok: true, text: status.message ?? COPY.ctxNeedsVault };
    return { ok: true, text: `${leftoverText(status)}\n档案 ${status.cards} 份 · 原文 ${status.raw} 份 · 投影 ${status.projection}` };
  }
  if (head === 'remind') {
    const status = typeof statusOf === 'function' ? statusOf() : null;
    if (!status || status.ok !== true) return { ok: false, text: status?.message ?? COPY.ctxNeedsVault };
    if (status.ready !== true) return { ok: true, text: status.message ?? COPY.ctxNeedsVault };
    const line = reminderText(status);
    return { ok: true, text: line === '' ? `现在不用提醒（${leftoverText(status)}）` : `跨档时会往会话里说这一句：${line}` };
  }
  if (head === 'refresh') {
    const done = ctxRefresh({ api });
    if (done.ok !== true) return { ok: false, text: done.message };
    if (done.changed.length === 0) {
      const broke = done.failed.length > 0 ? `，其中 ${done.failed.length} 张读不动` : '';
      return { ok: true, text: `没有要重算的：每张都是当前口径${broke}` };
    }
    const lines = done.changed.map((one) => `${one.id} → 主题 ${one.topic}（${one.keywords.join('、')}）`);
    const tail = '，锚定块按需现算（不落盘）';
    return { ok: true, text: `重算 ${done.changed.length} 张：\n${lines.join('\n')}${tail}` };
  }
  if (head === 'entries') {
    const found = ctxEntries({ api, id: argument });
    if (found.ok !== true) return { ok: false, text: found.message };
    if (found.scope === 'all') {
      if (found.empty) return { ok: true, text: '条目表还空着——规则那一路在英文摘要上抽不出东西，等模型那一路上来补' };
      return { ok: true, text: found.table.trimEnd() };
    }
    if (found.rows.length === 0) return { ok: true, text: `${found.id} 这张还没抽出条目（规则 0 条、模型补的 0 条）` };
    const lines = found.rows.map((one) => `${one.type}｜${one.content}｜${one.way}`);
    return { ok: true, text: `${found.id} 的条目 ${found.rows.length} 条：\n${lines.join('\n')}` };
  }
  if (head === 'batch') {
    const found = ctxBatch({ api, batch: argument });
    if (found.ok !== true) return { ok: false, text: found.message };
    if (Array.isArray(found.batches)) {
      if (found.batches.length === 0) return { ok: true, text: COPY.ctxEmpty };
      const lines = found.batches.map((one) => `${one.batch} · ${one.count} 份（${one.ids.join('、')}）`);
      return { ok: true, text: `共 ${found.batches.length} 批、${found.cards} 份：\n${lines.join('\n')}` };
    }
    const rows = found.rows.map((row) => {
      const raw = row.raw === '' ? '没留原文' : `原文 ${row.raw}`;
      return `${row.id} · ${row.topic} · ${row.range} · ${row.at} · ${row.file} · ${raw}`;
    });
    return { ok: true, text: `${found.batch} 这一批 ${found.count} 份：\n${rows.join('\n')}` };
  }
  if (head === 'rollback') {
    const done = ctxRollback({ api, batch: argument, now });
    if (done.ok !== true) {
      const left = (done.moved ?? []).length > 0 ? `（已经挪了 ${done.moved.length} 份）` : '';
      return { ok: false, text: `${done.message}${left}` };
    }
    const ids = done.moved.map((one) => one.id).join('、');
    const short = done.folder.replaceAll('\\', '/').split('/').slice(-1)[0];
    return { ok: true, text: `撤下 ${done.batch} 这一批 ${done.moved.length} 份（${ids}），挪到 回收站/${short}/；索引按剩下的重算了，库里还剩 ${done.cards} 份。只挪没删，搬回去就是还原。` };
  }
  if (head === 'search') {
    const found = ctxSearch({ api, query: argument });
    if (found.ok !== true) return { ok: false, text: found.message };
    if (found.hit === false) return { ok: true, text: found.text };
    const lines = found.rows.map((row) => `${row.id} · ${row.topic}（${row.keywords.join('、')}）`);
    return { ok: true, text: lines.join('\n') };
  }
  if (head === 'read') {
    const one = ctxRead({ api, id: argument });
    if (one.ok !== true) return { ok: false, text: one.message };
    if (one.hit === false) return { ok: true, text: `${one.text}\n${one.hint}` };
    const rawLine = one.hasRaw === true ? `\n原文：${one.rawFile}` : '\n原文：没留（这份档案落盘时没取到会话原文）';
    return { ok: true, text: `${one.card.fields?.summary ?? ''}${rawLine}` };
  }
  if (head === 'files') {
    const files = ctxFiles({ api });
    if (files.ok !== true) return { ok: false, text: files.message };
    if (files.cards === 0) return { ok: true, text: COPY.ctxEmpty };
    return { ok: true, text: files.rows.join('\n') };
  }
  if (head === 'open') {
    const one = ctxOpen({ api, relPath: argument });
    if (one.ok !== true) return { ok: false, text: one.message };
    return { ok: true, text: `深链拼好了：${one.link}` };
  }
  if (head === 'sync') {
    const synced = syncArchives({ api, pending, now, session });
    if (synced.ok !== true) return { ok: false, text: synced.message ?? COPY.ctxSyncFailed };
    const leftRaw = synced.rawMissing.length > 0 ? `，其中 ${synced.rawMissing.length} 份没取到原文` : '';
    const leftSkipped = (synced.skipped ?? []).length > 0 ? `，跳过 ${synced.skipped.length} 份已经落过的` : '';
    // 批次号写出来：一次压缩事件一个号，按它能把这一批整批列出来、整批回滚。
    const mine = [...new Set(synced.batches ?? [])];
    const leftBatch = mine.length > 0 ? `（批次 ${mine.join('、')}）` : '';
    return { ok: true, text: `${COPY.ctxSynced(synced.ids.length, synced.cards, leftBatch)}${leftSkipped}${leftRaw}` };
  }
  return { ok: false, text: COPY.ctxUnknownAction };
}

// 宿主接线：一个工具、一条命令分支、一个投影。任何一样挂不上都只记日志，不拖垮插件。
export function registerContext({ ctx, api, log = () => {}, tools: toolsOverride = null } = {}) {
  const disposed = [];
  // 挂不上不拖垮插件，但也不能悄悄算了：记进 warnings，健康检查那一步会把它念出来。
  const warnings = [];
  const keep = (label, fn) => {
    try {
      const off = fn();
      if (typeof off === 'function') disposed.push(off);
    } catch (error) {
      const detail = `${label}：${String(error?.message ?? error)}`;
      warnings.push(detail);
      log(`[dsh-whale-pal] ctx 有一项没挂上，${detail}`);
    }
  };

  const service = (key) => {
    try {
      return ctx?.[key] ?? null;
    } catch {
      return null;
    }
  };

  // 可选服务要「先直接取、再走 ctx.get」：没声明 inject 的服务直接访问会抛，
  // 上面那个 service() 正好把它吞成「服务缺席」。开新会话这条路必须拿到
  // sessionController / workingDirectory / agentPresets，不能吃这个亏。
  const optionalService = makeServiceOf(ctx);

  // 投影：只折叠，不写盘。宿主按会话日志重建，所以后装也能补历史。
  //
  // 服务用「可选注入」拿，不写进 export const inject：宿主没这服务时这插件不该被拖下水。
  // 但也不能像以前那样直接读 ctx.sessionProjections —— 没声明注入就取不到，
  // 取回来是 undefined，整段注册被 if 静默跳过：日志不响、健康检查一路绿灯、压缩事件白压。
  // 所以这里两级：先看 ctx 上有没有（宿主若已装配就直接用），没有就走 ctx.inject 等它到。
  const projectionRef = { status: 'pending' };
  const attachProjection = (registry) => {
    if (!registry || typeof registry.register !== 'function') return false;
    keep('投影没挂上', () => registry.register(makeProjection()));
    if (projectionRef.status !== 'ok') projectionRef.status = 'ok';
    projections = registry;
    return true;
  };
  let projections = null;
  attachProjection(service('sessionProjections'));
  if (projectionRef.status !== 'ok') {
    const injectFn = service('inject');
    if (typeof injectFn === 'function') {
      try {
        injectFn.call(ctx, ['sessionProjections'], (child) => {
          attachProjection(child?.sessionProjections ?? null);
        });
      } catch (error) {
        warnings.push(`投影：可选注入没挂上，${String(error?.message ?? error)}`);
      }
    } else {
      warnings.push('投影：宿主没给 sessionProjections，压缩事件收不到（原文与档案都不会落盘）');
    }
  }

  const pendingOf = (agent) => {
    if (!projections || typeof projections.stateOf !== 'function' || !agent) return [];
    try {
      const session = agent.session ?? agent;
      const state = projections.stateOf(session, 'whaleContext');
      const drained = drainPlan(state);
      return drained.archives;
    } catch {
      return [];
    }
  };

  // 原文要在落盘那一刻按 seq 去会话里捞，所以除了待写队列还得把会话本身带上。
  const sessionOf = (agent) => {
    if (!agent) return null;
    try {
      return agent.session ?? null;
    } catch {
      return null;
    }
  };

  // `session/event` 只给 (session, event)，不给 agent。所以从 `agent/created`
  // 先把 session → agent 记下来，turn/end 到来时再反查。
  // 用 WeakMap：会话走了自己就没了，不会攒住不放。
  const agentsBySession = new WeakMap();
  const agentOf = (session) => {
    if (!session || typeof session !== 'object') return null;
    return agentsBySession.get(session) ?? null;
  };

  // 宿主传进来的 tools 可能是包过计数的代理：走它，挂载数量才对得上。
  // 主路压缩器要在工具/命令注册**之前**建好：它们的闭包会引用它，
  // 虽然 execute 是运行时才跑，但先定义后引用读起来更清楚，也不会碰到 TDZ。
  const agentCtxRef = { current: null };
  const lastCompact = [];
  // 只留最近 8 条；这是排障用的，不写盘，重启就清。
  const pushCompact = (line) => {
    if (typeof line !== 'string' || line === '') return;
    lastCompact.push(line);
    if (lastCompact.length > 8) lastCompact.shift();
  };
  // 排障：session/event 到底有没有打进来。只看不判，记最后几条类型。
  const seenEvents = [];
  // 服务来源诊断：每个名字试了几个地方、各自拿到什么。
  const serviceProbe = {};

  /**
   * 从 fiber 树里按名字找服务实现。
   *
   * 为什么需要这条路：`isolate: { compaction: true }` 让 compaction 有了独立的
   * isolate 键，`ctx.reflect.get(name, false)` 也查不到（实测：tokenMeter 能拿到、
   * compaction 是 null）。但 cordis 把每个服务实现都存在 `fiber.provisions` 里，
   * 是个公开的 Set，元素形如 `{ name, value, ctx }` —— 按名字遍历一遍就能拿到，
   * 完全绕开 isolate 的键匹配。
   *
   * 从当前 ctx 的 fiber 一路找到根，再深搜整棵树。只在真需要时才走（前面几条路失败后）。
   */
  const findProvision = (startCtx, name) => {
    const seen = new Set();
    const queue = [];
    // 先爬到根
    try {
      let fiber = startCtx?.fiber;
      while (fiber) {
        queue.push(fiber);
        const parent = fiber.parent?.fiber;
        if (!parent || parent === fiber) break;
        fiber = parent;
      }
    } catch { /* 拿不到 fiber 就算了 */ }
    // 深搜
    while (queue.length > 0) {
      const fiber = queue.shift();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      try {
        for (const impl of fiber.provisions ?? []) {
          if (impl?.name === name && impl.value != null) return impl.value;
        }
      } catch { /* 单个 fiber 出错不影响别的 */ }
      // 往下找子 fiber：fiber 树通过 ctx.registry 或 children 暴露，两种都试
      try {
        for (const child of fiber.children ?? []) queue.push(child);
      } catch { /* ignore */ }
      try {
        for (const [, f] of fiber.ctx?.registry ?? []) {
          if (f && typeof f === 'object' && f.fiber) queue.push(f.fiber);
          else if (f) queue.push(f);
        }
      } catch { /* ignore */ }
    }
    return null;
  };

  /**
   * 取一个服务，按「最可能成功」的顺序试几个地方。
   *
   * 为什么不能只试一个：压缩服务在预设的 `isolate: { compaction: true }` realm 里，
   * cordis 的 proxy guard 会在 isolate 边界上抛
   * `cannot get property "compaction" without inject` —— 属性访问和 `get()` 都过不去。
   *
   * 绕法按可靠性排：
   *   1. `ctx.reflect.get(name, false)` —— guard 自己的 fallback，能过普通隔离
   *   2. `fiber.provisions` 按名字遍历 —— 绕开 isolate 键匹配，最硬的一条
   *   3. 属性访问 / `ctx.get` —— 非 isolate 服务能过
   */
  const pickService = (name) => {
    const tried = [];
    const ctxs = [
      ['agent.ctx', agentCtxRef.current],
      ['plugin.ctx', ctx],
    ];
    for (const [label, target] of ctxs) {
      if (!target) { tried.push(`${label}=no-ctx`); continue; }
      // 1. reflect.get —— 绕过普通 isolate
      try {
        const viaReflect = target.reflect?.get?.(name, false);
        if (viaReflect != null) { tried.push(`${label}.reflect=ok`); return viaReflect; }
        tried.push(`${label}.reflect=null`);
      } catch (e) { tried.push(`${label}.reflect=throw`); }
      // 2. fiber.provisions 按名字找 —— 连 isolate 键都不看
      try {
        const viaProvision = findProvision(target, name);
        if (viaProvision != null) { tried.push(`${label}.provision=ok`); return viaProvision; }
        tried.push(`${label}.provision=null`);
      } catch (e) { tried.push(`${label}.provision=throw`); }
      // 3. 属性访问（非 isolate 的服务能过）
      try {
        const direct = target[name];
        if (direct != null) { tried.push(`${label}.attr=ok`); return direct; }
        tried.push(`${label}.attr=null`);
      } catch (e) { tried.push(`${label}.attr=throw`); }
      // 4. ctx.get
      try {
        if (typeof target.get === 'function') {
          const viaGet = target.get(name);
          if (viaGet != null) { tried.push(`${label}.get=ok`); return viaGet; }
          tried.push(`${label}.get=null`);
        } else tried.push(`${label}.get=nofn`);
      } catch (e) { tried.push(`${label}.get=throw`); }
    }
    serviceProbe[name] = tried;
    return null;
  };

  // 子 fiber 探针：`ctx.inject(deps, cb)` 会建一个**子 fiber** 去要这些服务。
  //
  // 为什么不用主插件上的 `export const inject = ['compaction']`：
  // cordis 的 `_refresh()` 会遍历 `Object.keys(this.inject)`，任一依赖没有实现就把
  // epoch 置成 INACTIVE —— **整个插件不加载**。压缩服务在预设的 isolate realm 里，
  // 主插件大概率解析不到，那等于把整个 whale-pal 停掉。这个风险不能拿真实插件去试。
  //
  // 子 fiber 不一样：依赖不满足时，只有这个子 fiber 停在 inactive，主插件照常跑。
  // 所以用它验证「声明式注入能不能跨 isolate」是最低成本、可回退的做法。
  const injectedRef = { compaction: null, status: 'pending', error: null };
  try {
    const injectFn = typeof ctx?.inject === 'function' ? ctx.inject.bind(ctx) : null;
    if (injectFn) {
      injectFn(['compaction'], (subCtx) => {
        try {
          const got = subCtx?.compaction ?? null;
          if (got && typeof got.compactNow === 'function') {
            injectedRef.compaction = got;
            injectedRef.status = 'ok';
          } else {
            injectedRef.status = 'resolved-but-empty';
          }
        } catch (e) {
          injectedRef.status = 'access-throw';
          injectedRef.error = String(e?.message ?? e);
        }
        return () => { injectedRef.compaction = null; };
      });
      injectedRef.status = injectedRef.status === 'pending' ? 'callback-not-run' : injectedRef.status;
    } else {
      injectedRef.status = 'no-ctx.inject';
    }
  } catch (e) {
    injectedRef.status = 'install-throw';
    injectedRef.error = String(e?.message ?? e);
  }

  // 读 agent 当前阶段，读不到就说 unknown —— 不抛。
  const safePhase = (agent) => {
    try {
      return String(agent?.phase?.kind ?? 'unknown');
    } catch {
      return 'unknown';
    }
  };

  // 主路执行器：走宿主 `/compact` 命令。
  //
  // 为什么不直连 `compactNow`：预置里的 `compaction` 在 isolate realm 里，
  // 插件自己的 ctx（连 agent.ctx 的 reflect/provisions）都够不着 —— 五条取服务
  // 的路全试过，全空（交接文档 §10）。而 `/compact` 命令是宿主自己的闭包，
  // 实测能压成（2026-11-08 22:16，1,045 条 / 363,471 tokens）。
  //
  // 两件事必须在这一拍里做完：
  //   1. 延后一拍 —— `turn/end` 是同步派发的，当场 `phase.kind` 还是 `running`，
  //      此刻调 /compact 一定 busy（实测 t0=running、t1=idle）。
  //   2. 只有 idle 才调，否则直接回 busy，让辅路去叫人手动压。
  const commandExecutor = (agent) => new Promise((resolve) => {
    setTimeout(() => {
      const phase = safePhase(agent);
      if (phase !== 'idle') {
        resolve({ ok: false, kind: 'still-busy', text: `延后一拍仍是 ${phase}` });
        return;
      }
      Promise.resolve()
        .then(() => compactViaCommand({ commands: service('commands'), agent }))
        .then((done) => resolve(done ?? { ok: false, kind: 'no-result', text: '命令没有返回结果' }))
        .catch((error) => resolve({ ok: false, kind: 'threw', text: String(error?.message ?? error) }));
    }, 0);
  });

  const compactor = makeCompactor({
    getCompaction: () => {
      // 子 fiber 拿到的优先：它走的是 cordis 官方解析路径，不是读内部结构。
      if (injectedRef.compaction) return injectedRef.compaction;
      const got = pickService('compaction');      // compaction 是服务对象，要能调 compactNow
      if (got && typeof got.compactNow === 'function') return got;
      return null;
    },
    getExecutor: () => commandExecutor,
    getMeter: () => {
      const got = pickService('tokenMeter');
      if (got && typeof got.measure === 'function') return got;
      return null;
    },
    getPruner: () => pickService('toolResultPruner'),
    // 压缩触发点的两个系数从配置来（config.compaction.ratio / floorMargin），
    // 不写死在代码里：不同模型窗口差很多，部署者手改 config.json 就能调。
    // 给函数而不是当场取数字 —— 设置页改完配置，下一轮就该按新系数算。
    ratio: () => api?.getConfig?.()?.compaction?.ratio,
    floorMargin: () => api?.getConfig?.()?.compaction?.floorMargin,
    // 辅路：主路没压成时，把「请手动 /compact」这句塞进会话，让模型开口告诉人。
    notify: (line, agent) => {
      if (line === '' || typeof agent?.inject !== 'function') {
        warnings.push(`手动压缩提醒没塞进去：${line}`);
        return;
      }
      try {
        agent.inject(messageFor(line));
      } catch (error) {
        warnings.push(`手动压缩提醒没塞进去：${String(error?.message ?? error)}`);
      }
    },
    warn: (line) => warnings.push(line),
    observe: (line) => log(`[dsh-whale-pal] ${line}`),
    // 主路是异步的：`run()` 当场只报 `started`，真正成没成要等 `/compact` 回来。
    // 那一刻由压缩器回调这里补一条，否则 recent 永远停在「执行器已接手」。
    report: pushCompact,
  });

  const tools = toolsOverride ?? service('tools');
  if (tools && typeof tools.register === 'function') {
    keep('工具没挂上', () => tools.register({
      name: CTX_TOOL_NAME,
      description: 'Read or search the context archive in the note vault. action status counts archives; search finds entries by word; read shows one entry; files lists all; entries shows the derived entry table (computed from the cards, not stored), or one card rows when id is given (pass rows to record model-extracted entries into that card); batch lists every batch, or one batch when a batch id is given; sync writes the archives that the compaction events already queued; refresh re-derives the topic and keywords of every card from its own summary; compact asks the host to compress this session now (experimental, runs /compact under the hood); open builds an Obsidian deep link for one vault-relative note path (relPath) and refuses when no note vault is configured — it does not read or write the vault.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'search', 'read', 'files', 'entries', 'batch', 'sync', 'refresh', 'compact', 'open'], description: 'status 只读 / search 查 / read 读一份 / files 列全部 / entries 看条目 / batch 按批次查 / sync 落盘 / refresh 按当前口径重算主题与关键词 / compact 借 /compact 命令压一次（实验） / open 拼一篇笔记的 Obsidian 深链' },
          query: { type: 'string', description: 'search 用的词' },
          id: { type: 'string', description: 'read 与 entries 用的编号，例如 C007' },
          relPath: { type: 'string', description: 'open 用的笔记路径（库内相对路径），例如 日记/2026-11-03.md' },
          rows: {
            type: 'array',
            description: 'entries 补录用：要补进那张卡的条目；同一「类型 + 内容」再写一遍不算新增',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['事实', '决定', '待办', '偏好'], description: '事实 / 决定 / 待办 / 偏好' },
                content: { type: 'string', description: '一句话，别换行' },
              },
              required: ['type', 'content'],
            },
          },
          batch: { type: 'string', description: 'batch 用的批次号，像 B002；不给就列全部批次' },
          vaultPath: { type: 'string', description: '库目录；不给就用设置页填的那个' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: 20000,
      async execute(args = {}, exec = {}) {
        const action = text(args.action);
        const scoped = args.vaultPath === undefined ? api : { getConfig: () => ({ ...(api.getConfig?.() ?? {}), knowledge: { ...(api.getConfig?.()?.knowledge ?? {}), vaultPath: text(args.vaultPath) } }) };
        if (action === 'status') {
          const agent = exec?.agent;
          const code = codeOf(sessionOf(agent));
          return {
            ...ctxStatus({
              api: scoped,
              projection: projectionRef.status,
              pressure: pressureOf({ session: sessionOf(agent), projections }),
            }),
            // 排障用：压缩器最近几次判断 + 当前会话的地板/失败数。
            // 不写盘，重启就清 —— 它答的是「这一批到底有没有在跑」。
            compact: {
              wired: remindWired === true,
              recent: lastCompact.slice(),
              state: compactor.stateOf(code),
              seenEvents: seenEvents.slice(),
              probe: { ...serviceProbe },
              injected: { status: injectedRef.status, error: injectedRef.error, hasService: injectedRef.compaction != null },
              // 「压完仍超就自己开新会话」这条路能不能走：只报到不到服务，不建会话。
              switchReady: (() => {
                const sc = optionalService('sessionController');
                const registry = optionalService('workspaceRegistry');
                return {
                  controller: typeof sc?.create === 'function',
                  prompt: typeof sc?.prompt === 'function',
                  // 新会话要跟老会话同工作区：拿不到注册表就只能落「未分组」。
                  registry: typeof registry?.list === 'function',
                };
              })(),
            },
          };
        }
        if (action === 'search') return ctxSearch({ api: scoped, query: args.query });
        if (action === 'read') return ctxRead({ api: scoped, id: args.id });
        if (action === 'files') return ctxFiles({ api: scoped });
        if (action === 'open') return ctxOpen({ api: scoped, relPath: args.relPath });
        if (action === 'batch') return ctxBatch({ api: scoped, batch: args.batch });
        if (action === 'entries') return ctxEntries({ api: scoped, id: args.id, rows: args.rows });
        if (action === 'sync') return syncArchives({ api: scoped, pending: pendingOf(exec?.agent), session: sessionOf(exec?.agent) });
        if (action === 'refresh') return ctxRefresh({ api: scoped });
        // 实验入口：不是"现在压"，是"下一轮收尾时试着压一次"。
        //
        // 为什么不能现在压：工具是在 agent 的 turn 里面跑的，此刻 phase.kind 是
        // 'turn'，runMaintenance 第一句就抛 "already has active work"。
        // 所以要先武装，等 turn/end 之后再试 —— 这正是交接文档 §11.4 的第一步。
        if (action === 'compact') {
          compactProbeArmed = true;
          serviceProbe.lastCompactTry = null;
          return {
            ok: true,
            kind: 'armed',
            text: '已武装：下一轮收尾时会延后一拍试一次 /compact，结果记在 status 的 probe.lastCompactTry',
          };
        }
        return { ok: false, reason: 'unknown-action', message: COPY.ctxUnknownAction };
      },
    }));
  }

  // 跨档提醒：宿主的自动压缩正常时它一次都不会响，它是「宿主没压」时的兜底。
  // 挂点选每个 agent 的 `turn/end`——一轮收尾时正好拿得到这一轮最后的读数。
  // 说过的档位按会话记成高水位：同一档不重复。
  // **但档位掉下来了（人手动压过、宿主原生压过）就复位** —— 只记高水位不复位的话，
  // 同一会话里回血后再涨上来就永远不吭声了，等于把提醒作废。
  const announced = new Map();
  let remindWired = false;
  const codeOf = (session) => {
    try {
      return typeof session?.id === 'string' ? session.id : '';
    } catch {
      return '';
    }
  };
  const announce = (agent) => {
    const session = sessionOf(agent);
    const status = ctxStatus({ api, projection: projectionRef.status, pressure: pressureOf({ session, projections }) });
    const code = codeOf(session);
    const before = announced.get(code) ?? 'ok';
    // 档位降下来了 → 高水位作废，重新从当前档记起。压低一定是「真掉下来了」：
    // 要么人手动压了，要么宿主原生压了，要么读数落定后本来就没那么高。
    if (rank(status.tier) < rank(before)) announced.set(code, status.tier);
    if (shouldAnnounce(before, status.tier) !== true) return '';
    announced.set(code, status.tier);
    const line = reminderText(status);
    if (line === '') return '';
    if (typeof agent?.inject !== 'function') {
      warnings.push(`提醒没说出来：这一轮的 agent 没有 inject（${line}）`);
      return '';
    }
    try {
      agent.inject(messageFor(line));
      return line;
    } catch (error) {
      warnings.push(`提醒没塞进去：${String(error?.message ?? error)}`);
      return '';
    }
  };

  const on = service('on');
  // 实验开关：armed 之后，下一轮 turn/end 延后一拍试一次 /compact，试完就恢复。
  let compactProbeArmed = false;
  if (typeof on === 'function') {
    // 第一件事：把 session → agent 记下来。`session/event` 只给 (session, event)，
    // 拿不到 agent；但压缩和落盘都要 agent（compactNow 要它、inject 也要它）。
    // 宿主签名：`'agent/created'(payload: { agent, source, signal })` —— payload 是对象。
    keep('agent 映射没挂上', () => on('agent/created', (payload) => {
      const agent = payload?.agent ?? payload;
      const session = sessionOf(agent);
      const per = agent?.ctx;
      if (session && typeof session === 'object') agentsBySession.set(session, agent);
      if (per && typeof per.on === 'function') {
        agentCtxRef.current = per;
        remindWired = true;
      }
      // 排障：agent.ctx 上能不能通过 reflect / provisions 拿到关键服务。
      try {
        const probeName = (name) => {
          let viaReflect = 'n/a';
          try {
            const v = per?.reflect?.get?.(name, false);
            viaReflect = v == null ? 'null' : typeof v;
          } catch (e) { viaReflect = 'throw'; }
          let viaProvision = 'n/a';
          try {
            const v = findProvision(per, name);
            viaProvision = v == null ? 'null' : typeof v;
          } catch (e) { viaProvision = 'throw'; }
          return `reflect=${viaReflect},provision=${viaProvision}`;
        };
        serviceProbe.agentCtxHasReflect = typeof per?.reflect?.get === 'function';
        serviceProbe.probeCompaction = probeName('compaction');
        serviceProbe.probeTokenMeter = probeName('tokenMeter');
        // fiber 结构侦察
        try {
          const f = per?.fiber;
          serviceProbe.hasFiber = f != null;
          serviceProbe.fiberKeys = f ? ['provisions', 'children', 'parent', 'ctx', 'runtime'].filter((k) => { try { return f[k] != null; } catch { return false; } }) : [];
          serviceProbe.provisionCount = f?.provisions?.size ?? null;
          serviceProbe.provisionNames = f?.provisions ? [...f.provisions].map((p) => p?.name).slice(0, 20) : null;
        } catch (e) { serviceProbe.fiberError = String(e?.message ?? e); }
      } catch (e) {
        serviceProbe.probeError = String(e?.message ?? e);
      }
    }));

    // 挂点：**`session/event`**，不是 `turn/end`。
    //
    // `turn/end` 是 `session.append()` 写进日志的事件，**不经过 cordis 派发** ——
    // 它只调 `this.commit(event, entry)`，而 commit 里派发的是 `session/event`。
    // 所以 `ctx.on('turn/end', …)` 监听的是一个永远不会响的名字，
    // 77 次 turn/end 一次都没触发过（2026-11-08 读源码 + 实测确认）。
    //
    // 宿主签名：`'session/event'(session: Session, event: SessionEvent): void`
    // 作用域过滤：agent 作用域的监听者只收到从这个 agent 的上下文进入的会话。
    keep('提醒没挂上', () => on('session/event', (session, event) => {
      // 排障：先记一笔收到了什么，再判是不是 turn/end。
      const t = String(event?.type ?? '?');
      seenEvents.push(t);
      if (seenEvents.length > 30) seenEvents.shift();

      // 谁压的都算：只要这轮会话里真压过一次，上一个「主路失效」的局面就算翻篇了，
      // 「请手动 /compact」那句要重新武装 —— 否则人手动压完一次，同一个会话里
      // 再失效就永远没提醒了。
      if (t === 'compaction/end') {
        try {
          compactor.rearm(codeOf(session), '会话里压过一次');
          // 档位提醒的高水位也一起作废：这一轮真压过了，下次再涨上来要重新吭声。
          announced.delete(codeOf(session));
        } catch (error) {
          warnings.push(`提醒没重新武装：${String(error?.message ?? error)}`);
        }
        return;
      }

      if (t !== 'turn/end') return;
      const agent = agentOf(session);
      if (!agent) return;
      const per = agent?.ctx;
      if (!per || typeof per.on !== 'function') return;
      agentCtxRef.current = per;
      remindWired = true;
      const turnPayload = event.data ?? {};
      announce(agent);

      // 先压缩，后落盘：compactNow 产生 compaction/summary 事件，autoArchive 靠它
      // 折叠出档案；反过来的话这一轮的摘要要等下一次压缩才进库。
      // 压缩那一路自己收敛所有失败，永不抛，不会挡住下面的落盘。
      try {
        const compacted = compactor.run({
          agent,
          code: codeOf(session),
          turn: typeof turnPayload?.turn === 'number' ? turnPayload.turn : null,
        });
        // 诊断：把每次判断的结果留在内存里，health / status 能念出来。
        // 不写盘 —— 这是排障用的，不是事实源。
        // 同步收尾（直连 compactNow 那条测试路）已经在压缩器里报过一次，别再记一遍；
        // 异步（`started`）这里先记「已接手」，结果等 `/compact` 回来再由回调补在它后面。
        if (compacted.reported !== true) {
          pushCompact(`${compacted.acted}${compacted.reason ? `（${compacted.reason}）` : ''}`);
        }

        // 压完下一轮仍超触发点 → 这次压缩没吃到收益，自动压缩已停。
        // 不再只劝人开新会话：插件自己开一个（2026-11-12 人类定）。
        // 助手模式带一张交接条，鲸鲸模式干净开；旧会话说一句去向就停手。
        if (compacted.acted === 'switch') {
          const fallback = ineffectiveText({ used: compacted.used, trigger: compacted.trigger });
          const say = (line) => {
            if (line === '' || typeof agent?.inject !== 'function') return;
            try {
              agent.inject(messageFor(line));
            } catch (error) {
              warnings.push(`换会话那句话没塞进去：${String(error?.message ?? error)}`);
            }
          };
          // 建会话 + 递交接条都要等宿主回话，这一步不挡这一轮收尾。
          Promise.resolve()
            .then(async () => {
              let catalog = '';
              try {
                catalog = ctxAnchor({ api });
              } catch {
                catalog = '';
              }
              return switchSession({
                getService: optionalService,
                api,
                session,
                used: compacted.used,
                trigger: compacted.trigger,
                catalog,
              });
            })
            .then((done) => {
              if (done.ok !== true) {
                warnings.push(`自己开新会话没成：${done.reason}${done.detail ? `（${done.detail}）` : ''}`);
                say(COPY.switchFailed(fallback, done.reason, done.detail));
                return;
              }
              pushCompact(`switched → ${done.sessionId}（${done.mode}${done.seeded ? '，带交接条' : ''}）`);
              say(
                done.mode === 'whale'
                  ? COPY.switchDoneWhale(done.sessionId, done.groupDetail)
                  : COPY.switchDoneAssistant(done.sessionId, done.seeded, done.detail, done.groupDetail),
              );
            })
            .catch((error) => {
              warnings.push(`自己开新会话抛了：${String(error?.message ?? error)}`);
              say(COPY.switchThrew(fallback, String(error?.message ?? error)));
            });
        }
      } catch (error) {
        warnings.push(`压缩没跑成：${String(error?.message ?? error)}`);
      }

      // 同一轮收尾顺手把攒下的档案落盘：宿主压完只留投影，不落盘就等于没存。
      // 落盘失败不拦人、不抛，只记一条 warning——这一轮的话该说完还得说完。
      try {
        const done = autoArchive({ api, pending: pendingOf(agent), session });
        if (done.ok !== true) warnings.push(`档案没自动落盘：${done.reason ?? 'sync-failed'}`);
      } catch (error) {
        warnings.push(`档案没自动落盘：${String(error?.message ?? error)}`);
      }

      // ---- 实验：延后一拍试一次 /compact（交接文档 §11.4 第一步）
      //
      // turn/end 是 commit() 里**同步**派发的，此刻这一轮多半还没完全收尾，
      // phase.kind 很可能还是 'turn'。所以这里同时记两个时点：
      //   t0 = turn/end 当场
      //   t1 = setTimeout(0) 之后
      // 两次都记 phase.kind / status，再在 t1 若已 idle 就真调一次。
      // 这一整段只在 armed 时跑一次，平时零开销、零副作用。
      if (compactProbeArmed) {
        compactProbeArmed = false;
        const t0 = { phase: agent?.phase?.kind ?? 'unknown', status: agent?.status ?? 'unknown' };
        setTimeout(() => {
          const t1 = { phase: agent?.phase?.kind ?? 'unknown', status: agent?.status ?? 'unknown' };
          Promise.resolve()
            .then(async () => {
              if (t1.phase !== 'idle') {
                return { ok: false, kind: 'still-busy', text: `延后一拍仍是 ${t1.phase}` };
              }
              const done = await compactViaCommand({ commands: service('commands'), agent });
              return done;
            })
            .then((done) => {
              serviceProbe.lastCompactTry = { t0, t1, ...done, at: new Date().toISOString() };
            })
            .catch((error) => {
              serviceProbe.lastCompactTry = { t0, t1, ok: false, kind: 'threw', text: String(error?.message ?? error) };
            });
        }, 0);
      }
    }));
  } else {
    warnings.push('提醒没挂上：宿主没给 ctx.on，只能靠 /whale ctx status 自己看');
  }

  return {
    warnings,
    projectionStatus: () => projectionRef.status,
    remindStatus: () => (remindWired === true ? 'ok' : 'pending'),
    // 排障用：最近几次压缩判断的结果（不写盘，重启就清）。
    compactLog: () => lastCompact.slice(),
    seenSessionEvents: () => seenEvents.slice(),
    compactState: (code) => compactor.stateOf(code),
    announce,
    info: () => ctxInfo({ api, projection: projectionRef.status }),
    status: (options = {}) => ctxStatus({ api, projection: projectionRef.status, ...options }),
    // 带 agent 的那一格：把宿主读数一起捎上（`/status`、命令、工具三处共用）。
    statusOf: (agent) => ctxStatus({
      api,
      projection: projectionRef.status,
      pressure: pressureOf({ session: sessionOf(agent), projections }),
    }),
    pressureOf: (agent) => pressureOf({ session: sessionOf(agent), projections }),
    search: (query) => ctxSearch({ api, query }),
    read: (id) => ctxRead({ api, id }),
    files: () => ctxFiles({ api }),
    sync: (options = {}) => syncArchives({ api, ...options }),
    autoArchive: (options = {}) => autoArchive({ api, ...options }),
    command: (rawInput, options = {}) => ctxCommand({ api, rawInput, ...options }),
    rebuild: () => rebuildAll(ctxRoot(vaultOf(api))),
    pendingOf,
    sessionOf,
    dispose: () => {
      for (const off of disposed.splice(0)) {
        try {
          off();
        } catch {
          /* 卸载时抛错不值得再记一条 */
        }
      }
    },
  };
}
