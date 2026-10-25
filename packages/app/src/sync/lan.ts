/**
 * 局域网同步 · 浏览器侧
 *
 * 两端的角色是不对称的，必须说清：
 *   · 电脑端能监听端口（Electron 主进程里跑了个小 HTTP 服务），所以它当服务端；
 *   · 手机端是 WebView，起不了服务，只能当客户端去连电脑。
 * 所以「互通」的实际含义是：手机连电脑，方向由用户点（拉取 / 推送）。
 *
 * 为什么不做自动双向合并：见 core/sync 的说明，覆盖方向交给用户点是最不容易丢数据的做法。
 */

import {
  applySnapshot,
  collectSnapshot,
  describeSnapshot,
  latestBackupKey,
  type SnapshotStats,
  type SyncSnapshot,
} from '@wenjin/core';
import type { LanBridge, LanInfo } from './backup';

export type { LanBridge, LanInfo };

export interface PingInfo {
  app: string;
  device: string;
  host: string;
  version: string;
  hasData: boolean;
  cards: number;
  books: number;
}

/** 电脑地址存在本机，不跟着快照同步（core/sync 里已把它列为本机专有键） */
const HOST_KEY = 'wj_lan_host';
export const DEFAULT_PORT = 47800;

export type LanResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/* ---------------- 地址处理 ---------------- */

/**
 * 把用户手输的东西归一成 `host:port`。
 * 允许直接粘贴 `http://192.168.1.8:47800/`，也允许只写 IP（自动补默认端口）。
 */
export function normalizeHost(input: string): string {
  const raw = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!raw) return '';
  const [host, port] = raw.split(':');
  if (!host) return '';
  return port ? `${host}:${port}` : `${host}:${DEFAULT_PORT}`;
}

export function baseURL(host: string): string {
  return `http://${normalizeHost(host)}`;
}

export function readHost(): string {
  try {
    return localStorage.getItem(HOST_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeHost(host: string): void {
  try {
    localStorage.setItem(HOST_KEY, normalizeHost(host));
  } catch {
    /* 存不进去也不影响本次连接 */
  }
}

/* ---------------- 网络 ---------------- */

async function withTimeout<T>(ms: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await task(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

function failText(e: unknown): string {
  const err = e as Error;
  if (err?.name === 'AbortError') return '超时：电脑那边没应答';
  // 浏览器给的原文是英文的，这里翻译成能看懂的话
  const msg = err?.message ?? '未知错误';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return '连不上：检查两端是否同一 Wi-Fi、地址端口是否正确、电脑防火墙是否放行';
  }
  return msg;
}

export async function ping(host: string, timeoutMs = 3000): Promise<LanResult<PingInfo>> {
  const base = baseURL(host);
  try {
    const r = await withTimeout(timeoutMs, (signal) => fetch(`${base}/wj/ping`, { signal }));
    if (!r.ok) return { ok: false, reason: `电脑返回 ${r.status}` };
    return { ok: true, value: (await r.json()) as PingInfo };
  } catch (e) {
    return { ok: false, reason: failText(e) };
  }
}

export async function fetchRemoteSnapshot(host: string, timeoutMs = 10000): Promise<LanResult<SyncSnapshot>> {
  const base = baseURL(host);
  try {
    const r = await withTimeout(timeoutMs, (signal) => fetch(`${base}/wj/snapshot`, { signal }));
    if (r.status === 503) return { ok: false, reason: '电脑还没准备好数据，稍等两秒再试' };
    if (!r.ok) return { ok: false, reason: `电脑返回 ${r.status}` };
    return { ok: true, value: (await r.json()) as SyncSnapshot };
  } catch (e) {
    return { ok: false, reason: failText(e) };
  }
}

export async function sendSnapshot(host: string, snap: SyncSnapshot, timeoutMs = 15000): Promise<LanResult<{ ok: boolean }>> {
  const base = baseURL(host);
  try {
    const r = await withTimeout(timeoutMs, (signal) =>
      fetch(`${base}/wj/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap),
        signal,
      }),
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, reason: `电脑返回 ${r.status}${text ? `：${text.slice(0, 80)}` : ''}` };
    }
    return { ok: true, value: { ok: true } };
  } catch (e) {
    return { ok: false, reason: failText(e) };
  }
}

/* ---------------- 本机数据 ---------------- */

export function localSnapshot(device: string): SyncSnapshot | null {
  try {
    return collectSnapshot(localStorage, device);
  } catch {
    return null;
  }
}

export function localStats(): SnapshotStats | null {
  const snap = localSnapshot('本机');
  return snap ? describeSnapshot(snap) : null;
}

export function lastBackup(): string | null {
  try {
    return latestBackupKey(localStorage);
  } catch {
    return null;
  }
}

/**
 * 应用一份收到的数据。
 *
 * 写完必须整页重载：设置、藏书、格物卡分别被不同的 store 缓存在内存里，
 * 一个个去通知刷新反而容易漏。整页重载虽然土，但绝不会出现"界面上还是旧数据"。
 */
export function applyIncoming(raw: unknown): { ok: boolean; reason?: string; stats?: SnapshotStats } {
  try {
    const res = applySnapshot(localStorage, raw);
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true, stats: res.stats };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export function reloadSoon(): void {
  setTimeout(() => window.location.reload(), 350);
}
