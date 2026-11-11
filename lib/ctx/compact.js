// 主路：在 `turn/end` 上量 token，到点就压。
//
// 顺序（对齐官方原生压缩路径，见第六批 §2.0）：
//   1. measure(session)                     → 已用 ≥ 触发点？
//   2. 是 → toolResultPruner?.pruneSession  → 重新 measure
//   3. 仍 ≥ 触发点 → compactNow；否则到此为止，不摘要
//
// 为什么要先修剪：官方原生路径（compactPressure）就是先 prune 再重测，
// 降下阈值就 return null、连摘要都不用。手动 compactNow 没有这一步。
// 修剪不调模型，成本约等于 0，而且原文仍在会话日志里可按 seq 回放。
//
// 一切失败都不许阻断这一轮：只记 warning / 观察，然后让这一轮正常收尾。

import { shouldRemind, shouldTrigger, triggerPoints } from './trigger.js';

/** 连续失败几次后停用本批功能，交给提醒兜底。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

const usedOf = (measurement) => {
  if (!measurement || typeof measurement !== 'object') return null;
  const value = measurement.totalTokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * 从测量结果里取窗口大小。宿主可能给 contextWindow，也可能给 budget。
 */
const windowOf = (measurement) => {
  if (!measurement || typeof measurement !== 'object') return null;
  for (const key of ['contextWindow', 'window', 'limit']) {
    const value = measurement[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
};

/**
 * 建一个「每会话」的压缩器。状态全在内存里，不写盘。
 *
 * 主路与辅路的边界（人类 2026-11-09 定）：
 * - **主路**：真的把这一轮压下去。执行器优先用注入的 `getExecutor`（宿主 `/compact`
 *   命令那条路 —— 预置里的 `compaction` 在 isolate realm 里，插件自己的 ctx 够不着）；
 *   没注执行器才退回直接调 `compactNow`（测试与本机直连时用）。
 * - **辅路**：到点了但压不成 → 提醒人手动 `/compact`。辅路不代替主路，主路正常时
 *   它应该一次都不响。
 * - **路 C（靠宿主原生 0.8）已放弃**，不再作为方案；`trigger.js` 里 0.8 只留作
 *   「触发点别越过原生线」的上界校验。
 *
 * @param {object} options
 * @param {Function} options.getCompaction 返回 ctx.compaction 或 null
 * @param {Function} options.getMeter 返回 ctx.tokenMeter 或 null
 * @param {Function} [options.getExecutor] 返回 `(agent) => Promise<{ok,kind,text}>` 或 null（主路执行器）
 * @param {Function} [options.getPruner] 返回 ctx.get('toolResultPruner') 或 null
 * @param {Function} [options.notify] `(line, agent)` → 往会话里塞一句给人看的话
 * @param {Function} [options.warn] 记一条 warning
 * @param {Function} [options.observe] 记一条观察
 * @param {Function} [options.report] `(line)` → 把这一次「成没成」记进诊断账（status.recent）
 * @param {number} [options.cooldownTurns] 防抖：压完 N 轮内不再压，默认 3
 * @param {number} [options.ratio] 比例支系数
 * @param {number} [options.floorMargin] 地板支系数
 * @returns {{ run: Function, stateOf: Function, reset: Function }}
 */
export function makeCompactor({
  getCompaction,
  getMeter,
  getExecutor = () => null,
  getPruner = () => null,
  notify = () => {},
  warn = () => {},
  observe = () => {},
  report = () => {},
  cooldownTurns = 3,
  ratio,
  floorMargin,
} = {}) {
  // sessionCode → { floor, lastCompactedAtTurn, failures, disabled, remindedAt, verifyPending }
  const perSession = new Map();

  const stateFor = (code) => {
    let state = perSession.get(code);
    if (!state) {
      state = {
        floor: null,
        lastCompactedAtTurn: null,
        failures: 0,
        disabled: null,
        remindedAt: null,
        compactions: 0,
        // 压完等下一轮收尾复检：true 表示「这一轮必须判一次压了到底有没有用」。
        verifyPending: false,
        // 压完那一刻实测到的已用量，复检时用来对照。
        usedAtCompact: null,
        // 复检判成「没用」时留下的证据，status 里念出来。
        ineffective: null,
        // 主路执行器的收尾结果（{ at, kind, text }）。压在 turn/end 之后才落定，
        // 所以只能记在状态里给 status 看，不能靠 run() 的返回值。
        lastExec: null,
        // 「自动压缩没生效」这句提醒说过没有：一个会话只说一次，压成功后再武装。
        failureNotified: false,
        // 宿主动压时按哪个窗口算的（留给 status 念，免得 1M vs 1,048,576 再争）。
        window: null,
      };
      perSession.set(code, state);
    }
    return state;
  };

  /**
   * 跑一轮。**永不抛**：所有失败都收敛成 warning。
   *
   * @param {object} options
   * @param {object} options.agent 宿主 agent
   * @param {string} options.code 会话标识（用于分会话记状态）
   * @param {number} [options.turn] 当前轮次，用于防抖
   * @param {AbortSignal} [options.signal] 取消信号
   * @returns {{ acted: string, used: number|null, trigger: number|null, reason: string|null, reported: boolean }}
   *   `acted` 取值：`compacted` / `pruned` / `reminded` / `skipped` / `disabled` /
   *   `unavailable` / `switch`（压完下一轮仍超，停自动压缩、叫人换会话）
   */
  function run({ agent, code, turn = null, signal } = {}) {
    const state = stateFor(code ?? 'unknown');
    const out = { acted: 'skipped', used: null, trigger: null, reason: null, reported: false };

    // 结论要进诊断账 —— 主路是异步的，`run()` 当场只能说「已接手」，
    // 不给结果补一条，recent 就停在接手那一刻，事后问「那次压成没压成」答不上来。
    const mark = (line) => {
      out.reported = true;
      try {
        report(line);
      } catch (error) {
        // 记账不许反过来影响压缩：吞掉，只当没记。
        warn(`压缩记账没成：${String(error?.message ?? error)}`);
      }
    };

    if (state.disabled !== null) {
      out.acted = 'disabled';
      out.reason = state.disabled;
      return out;
    }

    const compaction = safe(() => getCompaction?.());
    const meter = safe(() => getMeter?.());
    const executor = safe(() => getExecutor?.());
    const canDirect = compaction !== null && typeof compaction?.compactNow === 'function';
    const canCommand = typeof executor === 'function';
    if (!meter || typeof meter.measure !== 'function' || (!canDirect && !canCommand)) {
      // 服务不在：不记 warning（宿主本来就可能没挂），只报 unavailable，提醒那条线照常。
      out.acted = 'unavailable';
      out.reason = canCommand ? 'tokenMeter 没挂上' : 'compaction/tokenMeter 没挂上';
      return out;
    }

    const session = agent?.session;
    if (!session) {
      out.acted = 'unavailable';
      out.reason = '这一轮没有 session';
      return out;
    }

    // ---- 1. 量一次
    let measurement = safe(() => meter.measure(session));
    let used = usedOf(measurement);
    if (used === null) {
      out.acted = 'unavailable';
      out.reason = '读数里没有 totalTokens';
      return out;
    }
    const window = windowOf(measurement) ?? safe(() => session?.requestContext?.()?.contextWindow) ?? null;
    // 留档：宿主到底按哪个窗口算的。文档里 1,000,000 与 1,048,576 两说并存过，
    // 与其继续争，不如让 status 把实测到的那个数念出来。
    if (window !== null) state.window = window;
    const points = triggerPoints({ contextWindow: window, floor: state.floor, ratio, floorMargin });
    out.used = used;
    out.trigger = points?.trigger ?? null;

    if (!points) {
      out.acted = 'unavailable';
      out.reason = '读不到窗口大小';
      return out;
    }

    // 外面压过一次（人手动 `/compact`、宿主原生）→ 读数掉回触发点之下，
    // 「已经提醒过」这件事就该翻篇。不能只靠 `compaction/end` 事件：
    // 事件万一没收到，读数也会落在这里，两条路任意一条通就够。
    if (state.failureNotified === true && used < points.trigger) {
      state.failureNotified = false;
      observe(`读数掉到触发点之下（${used} < ${points.trigger}），提醒重新武装`);
    }

    if (points.disabled !== null) {
      state.disabled = points.disabled;
      out.acted = 'disabled';
      out.reason = points.disabled;
      observe(`压缩自动档停用：${points.disabled}`);
      return out;
    }

    // ---- 复检：压完不立刻再压，等下一轮收尾再量（2026-11-09 人类定）
    //
    // 压完那一刻的读数不可靠：实测 22:16 那次压掉 1,045 条、约 36 万 token，
    // 但界面上的百分比要等这一轮收尾、下一次请求发出去才落定 —— 所以
    // 「压了到底有没有用」只能等下一轮 `turn/end` 才判得出来。
    //
    // 判成没用以后**不再压第二次**：继续压就是每轮烧一次摘要的钱，而且压不下去
    // 说明会话本身已经到极限了。处理方式是停掉自动压缩、叫人开新会话（档案都在）。
    // 这一条先只做「停 + 提醒」，插件自己切会话待议。
    if (state.verifyPending === true) {
      state.verifyPending = false;
      if (used >= points.trigger) {
        state.ineffective = { used, trigger: points.trigger, atCompact: state.usedAtCompact };
        state.disabled = `压缩后下一轮仍超触发点（已用 ${used} ≥ ${points.trigger}），不再自动压缩，建议开新会话`;
        out.acted = 'switch';
        out.reason = state.disabled;
        observe(state.disabled);
        mark(`switch（压完 ${state.usedAtCompact ?? '?'} → 这一轮 ${used}，仍 ≥ 触发点 ${points.trigger}）`);
        return out;
      }
      observe(`压缩复检通过：压完 ${state.usedAtCompact ?? '?'} → 这一轮 ${used}，在触发点 ${points.trigger} 之下`);
      // 复检是这个功能最常被人问的一句「到底有没有用」，也得留在账上。
      mark(`verify-ok（压完 ${state.usedAtCompact ?? '?'} → 这一轮 ${used}，在 ${points.trigger} 之下）`);
    }

    // 没到点：只在跨过提醒线时兜一句（主路正常时永远走不到这里）。
    if (!shouldTrigger({ used, points })) {
      if (shouldRemind({ used, points }) && state.remindedAt !== points.remind) {
        state.remindedAt = points.remind;
        out.acted = 'reminded';
        out.reason = `已用 ${used}，过了提醒线 ${points.remind}`;
        return out;
      }
      return out;
    }

    // 防抖：刚压过就不再压。
    if (state.lastCompactedAtTurn !== null && turn !== null && turn - state.lastCompactedAtTurn < cooldownTurns) {
      out.reason = `上 ${turn - state.lastCompactedAtTurn} 轮刚压过，防抖中`;
      return out;
    }

    // ---- 2. 先修剪（不调模型）。取不到就跳过这一档，不算失败。
    const pruner = safe(() => getPruner?.());
    if (pruner && typeof pruner.pruneSession === 'function') {
      try {
        pruner.pruneSession(session);
        measurement = safe(() => meter.measure(session));
        const after = usedOf(measurement);
        if (after !== null) {
          used = after;
          out.used = after;
          if (!shouldTrigger({ used, points })) {
            out.acted = 'pruned';
            out.reason = `修剪后降到 ${after}，不必摘要`;
            state.failures = 0;
            return out;
          }
        }
      } catch (error) {
        observe(`修剪这一档没成：${String(error?.message ?? error)}`);
      }
    }

    // ---- 3. 摘要：主路走执行器（宿主 /compact 命令），没执行器才直连 compactNow
    try {
      const result = canCommand ? executor(agent) : compaction.compactNow(agent, signal);

      // 收尾：成功就记地板并挂复检；失败就走辅路 —— 叫人手动压。
      const settled = (done) => {
        const verdict = verdictOf(done);
        state.lastExec = { at: new Date().toISOString(), ...verdict };
        if (verdict.ok !== true) {
          out.acted = 'failed';
          out.reason = verdict.text || verdict.kind;
          // 同一个「失效局面」只说一次：每轮都念等于没念。
          // 但只要哪次真压过了（谁压的都算），这个局面就翻篇、重新武装。
          if (state.failureNotified !== true) {
            state.failureNotified = true;
            notify(compactionFailedText({ kind: verdict.kind, text: verdict.text, used, trigger: points.trigger }), agent);
          }
          observe(`自动压缩没成（${verdict.kind}${verdict.text ? `：${verdict.text}` : ''}），已转手动`);
          mark(`failed（${verdict.text || verdict.kind}）`);
          return;
        }
        if (verdict.kind === 'nothing') {
          observe(`没有可压范围（已用 ${used}）`);
          mark(`nothing（已用 ${used}，没有可压范围）`);
          return;
        }
        state.failures = 0;
        state.failureNotified = false;
        state.compactions += 1;
        state.lastCompactedAtTurn = turn;
        // 压完立刻测一次，记成地板；下次走完整公式。
        const now = safe(() => meter.measure(session));
        const floorNow = usedOf(now);
        if (floorNow !== null) state.floor = floorNow;
        // 记下压完的读数，并在下一轮收尾复检「压了到底有没有用」。
        state.usedAtCompact = floorNow ?? used;
        state.verifyPending = true;
        const delta = floorNow === null ? `已用 ${used}` : `${used} → ${floorNow}`;
        observe(`自动压缩成了：${verdict.text || '已压'}（${delta}），下一轮收尾复检`);
        mark(`compacted（${delta}）`);
      };

      if (result && typeof result.then === 'function') {
        // 执行器是异步的（/compact 那条路要等一拍）：这一轮不等它，
        // 结果落进 state.lastExec，下一轮 status / 复检会看到。
        result.then(settled, (error) => {
          onFailure(state, error, warn);
          mark(`failed（${String(error?.message ?? error)}）`);
        });
        out.acted = 'started';
        out.reason = `已用 ${used} ≥ 触发点 ${points.trigger}，执行器已接手`;
        return out;
      }
      if (result === null) {
        observe(`没有可压范围（已用 ${used}）`);
        out.reason = '没有可压范围';
        return out;
      }
      settled(result);
      out.acted = out.acted === 'failed' ? 'failed' : 'compacted';
      if (out.reason === null) out.reason = `已用 ${used} ≥ 触发点 ${points.trigger}`;
      return out;
    } catch (error) {
      onFailure(state, error, warn);
      out.acted = 'skipped';
      out.reason = String(error?.message ?? error);
      return out;
    }
  }

  function onFailure(state, error, warn) {
    state.failures += 1;
    warn(`压缩没成：${String(error?.message ?? error)}`);
    if (state.failures >= MAX_CONSECUTIVE_FAILURES) {
      state.disabled = `连续失败 ${state.failures} 次，自动压缩停用，只留提醒`;
      warn(state.disabled);
    }
  }

  return {
    run,
    /**
     * 会话说「这轮真压过一次」时调用：把「已经提醒过」翻篇。
     *
     * 之前是「一个会话只说一次」，那样人手动压完一次之后，同一会话里主路再失效
     * 就永远没提醒了 —— 提醒的边界应该是**一个失效局面**，不是一整个会话。
     */
    rearm(code, reason) {
      const state = perSession.get(code ?? 'unknown');
      if (!state || state.failureNotified !== true) return false;
      state.failureNotified = false;
      observe(`提醒重新武装：${reason ?? '会话里压过一次'}`);
      return true;
    },
    stateOf: (code) => {
      const state = perSession.get(code ?? 'unknown');
      if (!state) return null;
      return {
        floor: state.floor,
        window: state.window,
        compactions: state.compactions,
        failures: state.failures,
        disabled: state.disabled,
        verifyPending: state.verifyPending,
        usedAtCompact: state.usedAtCompact,
        ineffective: state.ineffective,
        lastExec: state.lastExec,
        failureNotified: state.failureNotified,
      };
    },
    reset: (code) => perSession.delete(code ?? 'unknown'),
  };
}

/**
 * 把「执行结果」归一成 `{ ok, kind, text }`。
 *
 * 两条路的返回形状不一样：
 * - 直连 `compactNow`：`CompactionResult | null`（null = 没有可压范围）
 * - `/compact` 命令（`compactViaCommand`）：`{ ok, kind, text }`
 * 这里不猜语义，只认 `ok` 是不是布尔；不是就当成功，别把正常结果误报成失败。
 */
const verdictOf = (done) => {
  if (done === null || done === undefined) return { ok: true, kind: 'nothing', text: '' };
  if (typeof done === 'object' && typeof done.ok === 'boolean') {
    return {
      ok: done.ok,
      kind: String(done.kind ?? (done.ok === true ? 'success' : 'unknown')),
      text: typeof done.text === 'string' ? done.text : '',
    };
  }
  return { ok: true, kind: 'success', text: '' };
};

/** `/compact` 没跑成时那几个 kind 翻成人话；认不出就照抄原样。 */
const FAIL_REASONS = {
  busy: '会话还占着（这一轮没收完）',
  'still-busy': '延后一拍会话仍占着',
  'not-in-view': '当前视图里没有 /compact 这条命令',
  threw: '调用 /compact 时抛错',
  error: '/compact 自己报了错',
  aborted: '调用被取消',
  unavailable: '命令服务没挂上',
  'no-agent': '拿不到这一轮的 agent',
};

/**
 * 主路不通时那句话。**是写给模型看的指令**，不是给人看的通知 ——
 * 会话里塞的是 user 角色的一条消息，模型下一轮读到它，由它开口告诉人。
 */
export function compactionFailedText({ kind, text, used, trigger } = {}) {
  const reason = FAIL_REASONS[kind] ?? (typeof text === 'string' && text !== '' ? text : String(kind ?? '原因不明'));
  const numbers = typeof used === 'number' && Number.isFinite(used)
    ? `这一轮已用 ${used}${typeof trigger === 'number' && Number.isFinite(trigger) ? `（触发点 ${trigger}）` : ''}。`
    : '';
  return `[whale-pal] 自动压缩没生效（${reason}）。${numbers}请告诉用户：手动输入 /compact 压缩一次。`;
}

/**
 * 复检判成「压了没用」时对人说的那一句。
 *
 * 只在这个会话已经停掉自动压缩时出现一次，所以不必押韵也不重复；
 * 话里必须带上「还会不会被压」的答案，否则人只会以为功能坏了。
 */
export function ineffectiveText({ used, trigger } = {}) {
  const n = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const u = n(used);
  const t = n(trigger);
  const head = u !== null && t !== null
    ? `上一轮压完又到 ${u}（触发点 ${t}）`
    : '上一轮压完没有降下来';
  return `[whale-pal] ${head}：这次压缩没吃到收益，自动压缩已停，不会再压。建议开一个新会话接着干 —— 档案都在，whale_ctx 能取回。`;
}

/** 包一层：取服务时宿主可能抛，一律当没取到。 */
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
