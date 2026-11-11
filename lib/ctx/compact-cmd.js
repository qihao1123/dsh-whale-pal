// 路 D：借 `/compact` 命令压一次。
//
// 为什么不直接调 `ctx.compaction.compactNow`：那个服务在预设的
// `isolate: { compaction: true }` 里，插件侧五条路径都拿不到
// （属性访问抛、reflect 返回 null、provisions 空、子 fiber 没激活，
// 主插件 declare inject 会让整个插件停用）。详见
// `01-定稿/现状/交接-2026-11-09-压缩主路被封死.md`。
//
// 但 `/compact` 的 handler 是个**闭包**，捕获的是它自己的 ctx —— 那个 ctx 在
// isolate 域里面，看得见 compaction。我们借它的手，不自己碰那个服务。
// 这不是绕 isolate，是让 isolate 里面的人干活。
//
// 两个源码级的坑（照设计文档的字面写会踩）：
//   1. `commands.execute` 的返回值是 `{ commandId, result: { kind, text } }`，
//      **不是** `{ kind, text }` —— 直接读 `.kind` 会永远 undefined；
//   2. `runMaintenance` 要求 `agent.phase.kind === 'idle'` 严格相等，而
//      `agent.status` 把 `maintenance` 也算成 `'idle'` —— 用 status 判忙会误放行，
//      然后在 runMaintenance 里抛 "already has active work"。

/**
 * 借命令服务压一次。
 *
 * @param {object} options
 * @param {object} options.commands 宿主 `ctx.commands`（非 isolate，拿得到）
 * @param {object} options.agent 要压的那个 agent
 * @param {string} [options.line] 完整命令行，默认 `/compact`（要带斜杠）
 * @returns {Promise<{ ok: boolean, kind: string, text: string, commandId?: string }>}
 *   `kind` 取值：`success` / `error`（宿主自己的失败文案）/ `busy` / `not-in-view` /
 *   `threw` / `aborted` / `unavailable` / `no-agent`
 */
export async function compactViaCommand({ commands, agent, line = '/compact' } = {}) {
  if (!commands || typeof commands.execute !== 'function') {
    return { ok: false, kind: 'unavailable', text: '宿主没给 commands 服务' };
  }
  if (!agent) return { ok: false, kind: 'no-agent', text: '这一路没有 agent' };

  // runMaintenance 的准入：phase.kind 必须严格是 idle。
  // 用 agent.status 判会误放行 —— 它把 maintenance 也报成 'idle'。
  const phaseKind = agent.phase?.kind ?? 'unknown';
  if (phaseKind !== 'idle') {
    return { ok: false, kind: 'busy', text: `agent 正忙（phase.kind=${phaseKind}），现在压不了` };
  }

  // signal 必须给真对象：execute 第一句就是 `if (signal.aborted)`，
  // 传 undefined 直接 TypeError。用自己养的 controller，能主动取消。
  const controller = new AbortController();
  try {
    // line 带斜杠（内部走 parseCommand）；attachments 给 [] 不给 undefined（它按顺序遍历）。
    const settled = await commands.execute(agent, line, [], controller.signal);
    // 解析不到命令名、或不在这个 agent 的视图里 → undefined，日志里什么都不留。
    if (settled === undefined) {
      return { ok: false, kind: 'not-in-view', text: `${line} 不在这个 agent 的命令视图里` };
    }
    const result = settled.result ?? {};
    const kind = String(result.kind ?? 'unknown');
    return {
      ok: kind === 'success',
      kind,
      text: String(result.text ?? ''),
      commandId: String(settled.commandId ?? ''),
    };
  } catch (error) {
    // abort 静默；其他记下来但不抛，别把调用方拖死。
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    return { ok: false, kind: aborted ? 'aborted' : 'threw', text: String(error?.message ?? error) };
  }
}
