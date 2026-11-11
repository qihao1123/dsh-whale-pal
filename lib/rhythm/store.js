/**
 * 节律状态的落盘层：`rhythm-state.json`（哪一档报到哪个键了、上次真报出去是什么时候）。
 *
 * 口径出处：`融合计划-v2.md` D5——「提醒的幂等键要能说清，状态落在插件数据目录里」。
 * 所以这份状态**不落库**：它不属于用户的知识，落库还会让 `台账/` 里混进一个机器文件。
 * 目录由调用方（`api.paths.root`）传进来，不探测、不预填。
 *
 * 这是 rhythm 目录里唯一 import `node:fs` 的文件，跟 `lib/ledger/store.js` 同一条硬线。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeWithBackup } from '../atomic.js';

export const RHYTHM_STATE_FILE = 'rhythm-state.json';

export const KIND_KEYS = Object.freeze(['day', 'week', 'month']);

export function rhythmStatePath(dataDir) {
  return join(String(dataDir ?? ''), RHYTHM_STATE_FILE);
}

/** 这份状态在不在盘上。第一次装（没有这份文件）与「报过又清了」要分开，所以单独问。 */
export function rhythmStateExists(file) {
  return existsSync(file);
}

export function defaultRhythmState() {
  return { version: 1, fired: { day: '', week: '', month: '' }, lastReport: '', updatedAt: '' };
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 读状态。文件不在 / 读不动都当没报过——最坏结果是同一个周期多报一次，不会漏报。 */
export function readRhythmState(file) {
  const text = readText(file);
  if (text === null) return defaultRhythmState();
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return defaultRhythmState();
  }
  if (!raw || typeof raw !== 'object') return defaultRhythmState();
  const fired = {};
  for (const kind of KIND_KEYS) {
    fired[kind] = typeof raw?.fired?.[kind] === 'string' ? raw.fired[kind] : '';
  }
  return {
    version: 1,
    fired,
    lastReport: typeof raw.lastReport === 'string' ? raw.lastReport : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export function writeRhythmState(file, state) {
  const fired = {};
  for (const kind of KIND_KEYS) fired[kind] = typeof state?.fired?.[kind] === 'string' ? state.fired[kind] : '';
  const body = {
    version: 1,
    fired,
    lastReport: typeof state?.lastReport === 'string' ? state.lastReport : '',
    updatedAt: typeof state?.updatedAt === 'string' ? state.updatedAt : '',
  };
  const done = writeWithBackup(file, `${JSON.stringify(body, null, 2)}\n`);
  if (done.ok !== true) return { ok: false, reason: done.error ?? 'write-failed', rolledBack: done.rolledBack === true };
  return { ok: true, wrote: true, backup: done.backup ?? null, state: body };
}
