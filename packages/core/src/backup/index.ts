/**
 * 数据备份：一键导出 / 自动备份 / 从备份恢复
 *
 * 为什么要有这一层：局域网同步解决「换设备搬家」，但搬家的前提是旧设备还活着。
 * 误操作（覆盖、清空）、存储配额满、系统抽风，都需要一份**本机留着**的备份。
 * 这份备份和 sync 的覆盖前备份（wj_backup_<ts>）是两回事：
 *   · sync 的备份是安全网，静默保留三份，用户看不见；
 *   · 这里的备份是功能，用户看得见、列得出、能恢复、能删。
 *
 * 文件格式就是 sync 的快照格式（app=wenjin-sync, v=1），额外带一个 reason
 * 说明这份备份是哪来的（手动导出 / 文献入库前 / 退出前）。
 * 复用 parseSnapshot / applySnapshot 的校验与覆盖逻辑——恢复一条路上
 * 已经踩过的坑（先备份再覆盖、逐键校验、超限拒绝）不重新踩一遍。
 *
 * 落点分工：
 *   · 电脑端（Electron）：备份写进本机磁盘文件（主进程负责，见 preload.cjs），
 *     真文件、可拷贝、可手动找回；
 *   · 手机端 / 浏览器：没有文件系统权限，退回 localStorage 快照
 *     （wj_backup_auto_<ts>，容量受 5MB 配额约束，见 MAX_AUTO_BYTES）。
 */

import {
  applySnapshot,
  collectSnapshot,
  parseSnapshot,
  SYNC_VERSION,
  type SnapshotStats,
  type SyncSnapshot,
  type SyncStore,
} from '../sync';

/** 自动备份前缀。沿用 wj_backup_ —— sync 的本机专有前缀扫描会自动排除它，不会被同步带走 */
export const AUTO_BACKUP_PREFIX = 'wj_backup_auto_';

/** localStorage 里最多留几份自动备份（手机端） */
export const MAX_AUTO_BACKUPS = 3;

/**
 * 单份自动备份的体积上限。localStorage 总量约 5MB，三份 1.5MB 是安全线；
 * 超限就只留最新一份，再超限就放弃——备份失败不该把应用搞崩。
 */
export const MAX_AUTO_BYTES = 1_500_000;

export interface BackupFile extends SyncSnapshot {
  /** 这份备份的来历：「手动导出」「文献入库前」「退出前」… */
  reason: string;
}

export interface AutoBackupInfo {
  key: string;
  at: number;
  reason: string;
  bytes: number;
}

export type BackupParseResult =
  | { ok: true; snap: SyncSnapshot; reason: string }
  | { ok: false; reason: string };

function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length * 2;
}

/* ============================================================
 * 导出
 * ============================================================ */

/** 把本机所有 wj_ 键打成一个带来历的备份 */
export function createBackup(store: SyncStore, reason: string, device = '本机'): BackupFile {
  return { ...collectSnapshot(store, device), reason };
}

export function serializeBackup(b: BackupFile): string {
  return JSON.stringify(b);
}

/* ============================================================
 * 解析与恢复
 * ============================================================ */

/**
 * 解析备份文件内容。
 *
 * 兼容两种来历：本功能的 BackupFile（app=wenjin-sync + reason）和
 * 裸的 sync 快照（app=wenjin-sync，无 reason）——手机从电脑
 * 「另存的快照」也能当备份导入。
 */
export function parseBackupFile(raw: unknown): BackupParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是合法对象' };
  const o = raw as Partial<BackupFile>;
  if (o.app !== 'wenjin-sync') return { ok: false, reason: '不是致知的备份文件' };
  if (o.v !== SYNC_VERSION) return { ok: false, reason: `备份版本不认识（${String(o.v)}）` };
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return parsed;
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.slice(0, 40) : '手动导入';
  return { ok: true, snap: parsed.snap, reason };
}

export type RestoreResult =
  | { ok: true; backupKey: string; stats: SnapshotStats }
  | { ok: false; reason: string };

/**
 * 从备份恢复：先自动备份当前数据，再整包覆盖。
 *
 * 「先备份再覆盖」的顺序不能反——反了中途出错，用户连退路都没有。
 * 覆盖逻辑复用 sync 的 applySnapshot（它内部就会先备份）。
 */
export function restoreFromBackup(store: SyncStore, raw: unknown): RestoreResult {
  return applySnapshot(store, raw);
}

/* ============================================================
 * 自动备份（localStorage 版，手机端用；电脑端另有磁盘文件）
 * ============================================================ */

function autoKeys(store: SyncStore): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (k && k.startsWith(AUTO_BACKUP_PREFIX)) out.push(k);
  }
  return out.sort();
}

/** 自增序号。同一毫秒内连点两次导出时，纯时间戳键会撞车互相覆盖 */
let seq = 0;

/** 写一份自动备份。返回备份键名；失败（配额满等）返回 null，绝不抛。 */
export function saveAutoBackup(store: SyncStore, reason: string): string | null {
  const b = createBackup(store, reason);
  const text = serializeBackup(b);
  if (byteLength(text) > MAX_AUTO_BYTES) {
    // 超限：只保留最新一份，且先清掉旧的再试
    for (const k of autoKeys(store)) store.removeItem(k);
    if (byteLength(text) > MAX_AUTO_BYTES) return null;
  }
  seq = (seq + 1) % 1296; // 36^2，够撇开同一毫秒的连击
  const key = `${AUTO_BACKUP_PREFIX}${Date.now().toString(36)}_${seq.toString(36).padStart(2, '0')}`;
  try {
    store.setItem(key, text);
  } catch {
    // 配额满：丢掉最旧的一份再试一次，还不行就放弃
    const keys = autoKeys(store);
    if (keys.length > 0) store.removeItem(keys[0]!);
    try {
      store.setItem(key, text);
    } catch {
      return null;
    }
  }
  pruneAutoBackups(store);
  return key;
}

function pruneAutoBackups(store: SyncStore): void {
  const keys = autoKeys(store);
  while (keys.length > MAX_AUTO_BACKUPS) {
    const old = keys.shift();
    if (old) store.removeItem(old);
  }
}

export function listAutoBackups(store: SyncStore): AutoBackupInfo[] {
  const out: AutoBackupInfo[] = [];
  for (const k of autoKeys(store)) {
    const raw = store.getItem(k);
    if (!raw) continue;
    let parsed;
    try {
      parsed = parseBackupFile(JSON.parse(raw));
    } catch {
      parsed = { ok: false as const, reason: '（损坏）' };
    }
    out.push({
      key: k,
      at: parsed.ok ? parsed.snap.at : 0,
      reason: parsed.ok ? parsed.reason : '（损坏）',
      bytes: byteLength(raw),
    });
  }
  return out.reverse(); // 新的在前
}

export function readAutoBackup(store: SyncStore, key: string): string | null {
  if (!key.startsWith(AUTO_BACKUP_PREFIX)) return null;
  return store.getItem(key);
}

export function deleteAutoBackup(store: SyncStore, key: string): void {
  if (!key.startsWith(AUTO_BACKUP_PREFIX)) return;
  store.removeItem(key);
}
