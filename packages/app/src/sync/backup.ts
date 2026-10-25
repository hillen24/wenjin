/**
 * 备份 · 渲染侧统一入口
 *
 * 桌面和手机的能力差一道墙：电脑端有 Electron 主进程，备份是**磁盘上的真文件**；
 * 手机端（Capacitor WebView）没有文件系统权限，退回 localStorage 快照。
 * 这个模块把两边抹平：调用方只说「备份一份」，落点由环境决定。
 *
 * 桌面触发点（自动）：文献入库前、关窗口前。手动：设置页导出 / 恢复。
 * 手机触发点：同上，只是落在 localStorage（配额内最多三份）。
 */

import {
  createBackup,
  deleteAutoBackup,
  listAutoBackups,
  parseBackupFile,
  readAutoBackup,
  restoreFromBackup,
  saveAutoBackup,
  serializeBackup,
  type AutoBackupInfo,
  type SyncSnapshot,
} from '@wenjin/core';
import { downloadText } from '@wenjin/core';

export type { AutoBackupInfo, SyncSnapshot };

/** 电脑端 preload 注入的桥（局域网同步 + 数据备份）。手机端的 window 上没有这个对象。 */
export interface LanBridge {
  desktop: true;
  /** 地址信息（本机 IPv4 + 端口 + 版本） */
  info(): Promise<LanInfo>;
  /** 把本机快照交给主进程，供手机拉取 */
  pushSnapshot(snap: SyncSnapshot): void;
  /** 手机推上来的数据 */
  onIncoming(cb: (raw: unknown) => void): void;
  /* ---------- 数据备份 ---------- */
  backupDir(): Promise<string>;
  saveBackup(text: string, reason: string): Promise<
    { ok: true; name: string; path: string } | { ok: false; reason: string }
  >;
  listBackups(): Promise<DiskBackupInfo[]>;
  readBackup(name: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  deleteBackup(name: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 弹系统另存为，用户自选位置 */
  exportBackup(
    defaultName: string,
    text: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string } | { canceled: true }>;
}

export interface LanInfo {
  ip: string;
  port: number;
  host: string;
  version: string;
}

export interface DiskBackupInfo {
  name: string;
  at: number;
  reason: string;
  bytes: number;
}

declare global {
  interface Window {
    wjBridge?: LanBridge;
  }
}

export function desktopBridge(): LanBridge | undefined {
  return typeof window !== 'undefined' ? window.wjBridge : undefined;
}

export function isDesktop(): boolean {
  return !!desktopBridge();
}

/* ============================================================
 * 手动导出
 * ============================================================ */

/** 备份文件的默认名：致知备份-2026-10-25_1315.json */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `致知备份-${d}_${t}.json`;
}

export type ExportResult =
  | { ok: true; where: 'disk' | 'download' }
  | { ok: false; reason: string };

/** 导出一份备份。桌面弹另存为；其他环境走浏览器下载。 */
export async function exportBackup(): Promise<ExportResult> {
  const bridge = desktopBridge();
  const snap = createBackup(localStorage, '手动导出', isDesktop() ? '电脑' : '手机');
  const text = serializeBackup(snap);
  const name = backupFileName();

  if (bridge) {
    const r = await bridge.exportBackup(name, text);
    if ('canceled' in r && r.canceled) return { ok: false, reason: '已取消' };
    if ('ok' in r && r.ok) return { ok: true, where: 'disk' };
    return { ok: false, reason: 'reason' in r ? r.reason : '导出失败' };
  }
  const ok = downloadText(name, text);
  return ok ? { ok: true, where: 'download' } : { ok: false, reason: '浏览器拒绝下载' };
}

/* ============================================================
 * 自动备份（桌面写磁盘，其他写 localStorage）
 * ============================================================ */

export type AutoBackupOutcome =
  | { ok: true; where: 'disk' | 'local'; key?: string }
  | { ok: false; reason: string };

/**
 * 存一份自动备份。
 *
 * 桌面端写磁盘（异步，失败只回报不抛——备份失败不该打断用户正在做的事）；
 * 其他环境写 localStorage 快照。
 */
export async function autoBackup(reason: string): Promise<AutoBackupOutcome> {
  const bridge = desktopBridge();
  if (bridge) {
    try {
      const snap = createBackup(localStorage, reason, '电脑');
      const r = await bridge.saveBackup(serializeBackup(snap), reason);
      if (r.ok) return { ok: true, where: 'disk' };
      return { ok: false, reason: r.reason };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
  const key = saveAutoBackup(localStorage, reason);
  return key ? { ok: true, where: 'local', key } : { ok: false, reason: '本机存储空间不足，自动备份跳过' };
}

/* ============================================================
 * 备份列表（桌面读磁盘，其他读 localStorage）
 * ============================================================ */

export async function listBackups(): Promise<AutoBackupInfo[]> {
  const bridge = desktopBridge();
  if (bridge) {
    try {
      const rows = await bridge.listBackups();
      return rows.map((r) => ({ key: r.name, at: r.at, reason: r.reason, bytes: r.bytes }));
    } catch {
      return [];
    }
  }
  return listAutoBackups(localStorage);
}

/** 读一份备份的原始内容（桌面按文件名，其他按 localStorage 键） */
export async function readBackup(key: string): Promise<string | null> {
  const bridge = desktopBridge();
  if (bridge) {
    const r = await bridge.readBackup(key);
    return r.ok ? r.text : null;
  }
  return readAutoBackup(localStorage, key);
}

export async function removeBackup(key: string): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge) {
    const r = await bridge.deleteBackup(key);
    return r.ok;
  }
  deleteAutoBackup(localStorage, key);
  return true;
}

/* ============================================================
 * 恢复
 * ============================================================ */

export type RestoreOutcome =
  | { ok: true; backupKey: string }
  | { ok: false; reason: string };

/** 从备份内容恢复。恢复前会自动备份当前数据（core 的 applySnapshot 负责）。 */
export function restoreBackupText(text: string): RestoreOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '不是合法的 JSON 文件' };
  }
  const parsed = parseBackupFile(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const r = restoreFromBackup(localStorage, raw);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, backupKey: r.backupKey };
}
