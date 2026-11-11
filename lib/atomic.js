/**
 * 原子写 + 备份 + 读回校验。
 *
 * 口径来自 `融合计划-v2.md:189`（`.bak` → 临时文件 → 原子 rename → 读回逐字校验）
 * 与不变量 3（任何写入前有 .bak、写入后逐字读回、读回失败自动回滚）。
 * 判据：kill -9 断电后不留半个文件——靠的是「先写 tmp、再 rename」，
 * rename 在同一目录内是原子的，所以读到的新内容要么是旧的、要么是完整的新的。
 *
 * 三条边界（串联时定下的，别破）：
 *   1. 这里不 import `lib/persona/**` 的任何写函数，只吃文件路径；
 *   2. 自己的文件（progress.json 这类）也走这里，不另起一套；
 *   3. `state.json` / `config.json` 不经这里——它们归人格内核管。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 保留几份备份。用户 2026-11-03 定 10 份；内核快照那套是另一码事（`SNAPSHOT_KEEP = 20`）。 */
export const BACKUP_KEEP = 10

/** 备份后缀：`.bak-<ISO>`，冒号换成短横，Windows 文件名才合法。 */
const BACKUP_MARK = '.bak-'

/**
 * 滚动窗口外的备份挪到哪儿：同目录下的这个子目录。
 * listBackups 只认 `<名>.bak-<stamp>` 精确前缀，子目录里的不会被误算进窗口。
 */
export const ARCHIVE_DIR = '.bak-archive'

/**
 * 归档里**每个文件**留几份备份（2026-11-12 定 20）。
 *
 * 为什么必须有个数：`pruneBackups` 只把挤出去的挪进归档，从不看归档有多大，
 * 于是「写一次台账 = 归档多一份」，台账那张表就攒到过 410 份、约 12 MB。
 * 二十份之外的那些没人会翻，留着只是慢慢吃盘。
 */
export const ARCHIVE_KEEP = 20

/** 2026-11-03T04:40:39.123Z 这种形态，把 `:` 换成 `-`。 */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, '-')
}

/** 某个文件的备份文件名。 */
export function backupNameOf(file, date = new Date()) {
  return `${file}${BACKUP_MARK}${stamp(date)}`
}

/** 同目录下的临时文件名：换卷不跨盘，rename 才是原子的。 */
function tmpNameOf(file) {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${stamp()}.tmp`)
}

/**
 * 列一个文件的全部备份，新的在前。
 *
 * 判据只看文件名：`<名>.bak-<stamp>`。别的文件一概不理，
 * 所以同目录里混着用户自己的东西也不会被误删。
 */
export function listBackups(file) {
  const dir = dirname(file)
  const prefix = `${basename(file)}${BACKUP_MARK}`
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => join(dir, name))
}

/** 只留最近 keep 份，返回被删掉的路径。 */
export function pruneBackups(file, { keep = BACKUP_KEEP, archiveKeep = ARCHIVE_KEEP } = {}) {
  const all = listBackups(file)
  const dropped = all.slice(Math.max(0, keep))
  const removed = []
  const archiveDir = join(dirname(file), ARCHIVE_DIR)
  for (const path of dropped) {
    try {
      mkdirSync(archiveDir, { recursive: true })
      const target = join(archiveDir, basename(path))
      renameSync(path, target)
      removed.push(target)
    } catch {
      try {
        unlinkSync(path)
        removed.push(path)
      } catch {
        // 连删都失败就留着，不影响这次写盘。
      }
    }
  }
  // 归档自己也得有上限：不然「再滚一轮就挪一份进去」会一路长下去。这里没东西可删就什么都不做。
  pruneArchive(file, { keep: archiveKeep })
  return removed
}

/**
 * 列一个文件在 `.bak-archive/` 里的备份，新的在前。
 *
 * 只认 `<名>.bak-<stamp>`：同一个归档目录里混着别的文件的备份（台账好几本都往里挪），
 * 按前缀切才不会把别人的备份当自己的删掉。
 */
export function listArchive(file) {
  const dir = join(dirname(file), ARCHIVE_DIR)
  const prefix = `${basename(file)}${BACKUP_MARK}`
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => join(dir, name))
}

/** 归档只留最近 keep 份（只算这个文件的），多出来的直接删。返回删掉的路径。 */
export function pruneArchive(file, { keep = ARCHIVE_KEEP } = {}) {
  const dropped = listArchive(file).slice(Math.max(0, Number(keep) || 0))
  const removed = []
  for (const path of dropped) {
    try {
      unlinkSync(path)
      removed.push(path)
    } catch {
      // 删不掉就留着，不因为一份旧备份挡住这次写。
    }
  }
  return removed
}

/**
 * 两个文件是否逐字相同。
 *
 * 比的是字节，不是 mtime：跨盘复制后 mtime 会变，但内容相同就够。
 */
export function sameBytes(a, b) {
  try {
    const left = readFileSync(a)
    const right = readFileSync(b)
    return left.length === right.length && left.equals(right)
  } catch {
    return false
  }
}

/** 备份是不是真的拿到手了：字节相同，且备份的创建时间不早于源的最后修改。 */
export function backupIsSound(source, backup) {
  try {
    const sourceStat = statSync(source)
    const backupStat = statSync(backup)
    if (sourceStat.size !== backupStat.size) return false
    if (!sameBytes(source, backup)) return false
    // CreationTime 可能拿不到（某些文件系统），拿不到就不据此否决。
    const born = Number(backupStat.birthtimeMs ?? 0)
    return born === 0 || born + 2 >= Number(sourceStat.mtimeMs ?? 0)
  } catch {
    return false
  }
}

/**
 * 扫掉同一文件留下的临时文件。
 *
 * 进程在 rename 之前被杀（kill -9、蓝屏、断电）时，`.tmp` 会留在目录里：
 * 目标文件是好的，但这坨残留没人管。下次写之前先清自己那几个，
 * 不清别人的（前缀带文件名 + `.` 开头 + `.tmp` 结尾，三条都满足才算）。
 */
export function sweepTemp(file) {
  const dir = dirname(file)
  const prefix = `.${basename(file)}.`
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    if (name.startsWith(prefix) === false || name.endsWith('.tmp') === false) continue
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch {
      // 清不掉的留着，不因为残留挡住这次写。
    }
  }
  return removed
}

/**
 * 写一个文件：备份 → tmp → rename → 读回。
 *
 * hooks 是给测试用的失败注入点，生产调用不传：
 *   - `write(text)` 返回实际要落盘的文本（模拟写一半）；
 *   - `beforeRename()` 抛错即模拟 rename 前断电；
 *   - `readBack(text)` 返回替换内容，模拟读回不一致。
 *
 * 返回 `{ok, backup, rolledBack, error}`：
 *   - 成功 `{ok:true, backup, rolledBack:false}`；
 *   - 读回不一致 → 用备份还原，`{ok:false, error:'read-back-mismatch', rolledBack:true}`；
 *   - 写或换名失败 → 文件没动过，`{ok:false, error:'write-failed'|'rename-failed', rolledBack:false}`。
 */
export function writeWithBackup(file, text, options = {}) {
  const { keep = BACKUP_KEEP, hooks = {} } = options
  mkdirSync(dirname(file), { recursive: true })
  // 上次崩在 rename 之前会留下 .tmp，这里先扫干净再开工。
  sweepTemp(file)
  const existed = existsSync(file)
  let backup = null

  if (existed) {
    backup = backupNameOf(file)
    try {
      copyFileSync(file, backup)
    } catch (error) {
      // 备份拿不到就不动原文件：宁可这次写失败，也不要在没有退路的情况下改东西。
      return { ok: false, backup: null, rolledBack: false, error: 'backup-failed', detail: String(error?.message ?? error) }
    }
    if (!backupIsSound(file, backup)) {
      return { ok: false, backup, rolledBack: false, error: 'backup-unsound' }
    }
  }

  const tmp = tmpNameOf(file)
  try {
    const body = typeof hooks.write === 'function' ? hooks.write(text) : text
    writeFileSync(tmp, body, 'utf8')
  } catch (error) {
    removeQuietly(tmp)
    return { ok: false, backup, rolledBack: false, error: 'write-failed', detail: String(error?.message ?? error) }
  }

  try {
    if (typeof hooks.beforeRename === 'function') hooks.beforeRename()
    renameSync(tmp, file)
  } catch (error) {
    removeQuietly(tmp)
    return { ok: false, backup, rolledBack: false, error: 'rename-failed', detail: String(error?.message ?? error) }
  }

  let readBack
  try {
    readBack = readFileSync(file, 'utf8')
  } catch (error) {
    readBack = `\u0000read-failed:${String(error?.message ?? error)}`
  }
  if (typeof hooks.readBack === 'function') readBack = hooks.readBack(readBack)

  if (readBack !== text) {
    // 读回不一致：有备份就用备份盖回去，没有就报出来让调用方决定。
    let rolledBack = false
    if (backup && existsSync(backup)) {
      try {
        copyFileSync(backup, file)
        rolledBack = sameBytes(backup, file)
      } catch {
        rolledBack = false
      }
    }
    return { ok: false, backup, rolledBack, error: 'read-back-mismatch' }
  }

  const removed = pruneBackups(file, { keep })
  return { ok: true, backup, rolledBack: false, error: null, bytes: Buffer.byteLength(text, 'utf8'), pruned: removed.length }
}

/**
 * 自己走一遍目录树复制，**不用 `fs.cpSync`**。
 *
 * 为什么不用它：node 22 在 Windows 上 `cpSync(…, {recursive:true})` 会把进程直接打死 ——
 * 没有异常可 catch，退出码 3221226505（0xC0000409），`--test` 里只看到一句
 * `error: 'test failed'`；同样的代码在 node 24 上正常。换库和导入回滚是插件里最重的
 * 两条写路径，不能指望运行时版本刚好是对的，所以这里用 readdir + copyFileSync 自己走。
 *
 * `to` 已存在时：`overwrite: true`（默认）按同名覆盖，`overwrite: false` 抛 EEXIST
 * ——对齐 `cpSync` 的 `force/errorOnExist` 两档。
 *
 * 符号链接按目标内容复制（跟进），本插件的台账与档案里没有链接。
 */
export function copyTree(from, to, { overwrite = true } = {}) {
  const info = statSync(from)
  if (info.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      copyTree(join(from, entry.name), join(to, entry.name), { overwrite })
    }
    return
  }
  if (overwrite === false && existsSync(to)) {
    const error = new Error(`EEXIST: file already exists, copy '${from}' -> '${to}'`)
    error.code = 'EEXIST'
    throw error
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

/** 从最近一份备份还原。没有备份就回 ok:false。 */export function restoreLatest(file) {
  const [latest] = listBackups(file)
  if (!latest) return { ok: false, error: 'no-backup', backup: null }
  try {
    copyFileSync(latest, file)
  } catch (error) {
    return { ok: false, error: 'restore-failed', backup: latest, detail: String(error?.message ?? error) }
  }
  if (!sameBytes(latest, file)) return { ok: false, error: 'restore-mismatch', backup: latest }
  return { ok: true, backup: latest }
}

function removeQuietly(path) {
  try {
    unlinkSync(path)
  } catch {
    // 临时文件残留不致命，下次同名覆盖即可。
  }
}

/**
 * 写者闸：落盘前问一句「盘上那份是不是还停在我上次写的样子」。
 *
 * 为什么需要：人格状态装载时读一次、之后整份在内存里，落盘是整份覆盖。
 * 只要有人从外部改过 state.json（脚本、手工编辑、另一个进程），
 * 宿主下一次 flush 就会把它静默盖掉。
 *
 * 判据：盘上 revision 大于内存基线 = 有别人写过，拦。
 * 相等或更小都放行（更小说明文件被还原过，不该拿它当拦路理由）。
 */
export function writerGate({ file, expectedRevision = 0 } = {}) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: true, diskRevision: 0 }
  }
  let disk = 0
  try {
    disk = Number(JSON.parse(text)?.revision) || 0
  } catch {
    return { ok: true, diskRevision: 0 }
  }
  const mine = Math.max(0, Number(expectedRevision) || 0)
  if (disk > mine) return { ok: false, reason: 'external-write', diskRevision: disk }
  return { ok: true, diskRevision: disk }
}
