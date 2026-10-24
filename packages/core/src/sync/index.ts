/**
 * 局域网同步 · 整机快照
 *
 * 设计取向：**整包覆盖，方向由用户点**。
 *
 * 为什么不自动双向合并：格物卡、论道记录、阅读进度都是「追加型 + 有先后语义」
 * 的数据，两边各改一半之后再靠 id 求并集，冲突了没法判断谁对。一旦猜错，
 * 用户看到的就是"我的记录怎么少了"。所以这里只做最可预测的事：
 * 手机点「从电脑拉取」就变成电脑那份，点「推送到电脑」电脑就变成手机那份，
 * 覆盖之前一律自动存一份本机备份（`wj_backup_<时间戳>`）。
 *
 * 键名沿用 v2.x 的 `wj_` 前缀，与 storage 模块保持一致；
 * 动态键（`wj_prog_<docId>`）也能被前缀扫描一并带走，不需要维护白名单。
 */

/** localStorage 的结构子集。写成接口是为了单测里能塞假实现。 */
export interface SyncStore {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const SYNC_APP = 'wenjin-sync';
export const SYNC_VERSION = 1;

/** 只在键名前缀上做文章，不留白名单，新增的 wj_ 键自动跟着同步 */
const KEY_PREFIX = 'wj_';

/** 本机专有：连接地址、备份本身，不参与同步（否则会把对方的本机地址覆盖过来） */
const LOCAL_ONLY_PREFIX = ['wj_lan_', 'wj_backup_'];

/** 单份快照上限。localStorage 一般 5MB，留足余量，超了直接拒绝而不是写坏它 */
const MAX_BYTES = 12 * 1024 * 1024;

/** 保留几份覆盖前备份。备份一律不删，但存储有限，只留最近三份 */
const KEEP_BACKUPS = 3;

export interface SyncSnapshot {
  app: typeof SYNC_APP;
  v: number;
  /** 采集时刻 */
  at: number;
  /** 「电脑」「手机」之类，只用于界面显示 */
  device: string;
  data: Record<string, string>;
}

export interface SnapshotStats {
  keys: number;
  bytes: number;
  books: number;
  cards: number;
  debates: number;
  readings: number;
  lit: number;
}

export type ParseResult =
  | { ok: true; snap: SyncSnapshot }
  | { ok: false; reason: string };

export type ApplyResult =
  | { ok: true; backupKey: string; stats: SnapshotStats }
  | { ok: false; reason: string };

function isSyncKey(k: string): boolean {
  return k.startsWith(KEY_PREFIX) && !LOCAL_ONLY_PREFIX.some((p) => k.startsWith(p));
}

function allKeys(store: SyncStore): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (k) out.push(k);
  }
  return out;
}

function byteLength(s: string): number {
  // 中文占 3 字节，用 Blob 会依赖浏览器 API；TextEncoder 在 Node 和 WebView 都有
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length * 2;
}

function safeParse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 把本机所有 wj_ 键打成一个快照 */
export function collectSnapshot(store: SyncStore, device = '本机'): SyncSnapshot {
  const data: Record<string, string> = {};
  for (const k of allKeys(store)) {
    if (!isSyncKey(k)) continue;
    const v = store.getItem(k);
    if (typeof v === 'string') data[k] = v;
  }
  return { app: SYNC_APP, v: SYNC_VERSION, at: Date.now(), device, data };
}

/** 统计一份快照里有什么，给界面显示「将要覆盖成什么样的数据」 */
export function describeSnapshot(snap: SyncSnapshot): SnapshotStats {
  const books = safeParse<unknown[]>(snap.data['wj_user_books'] ?? null);
  const materials = safeParse<Record<string, unknown[]>>(snap.data['wj_materials_v1'] ?? null);
  const lit = safeParse<unknown[]>(snap.data['wj_lit'] ?? null);

  let bytes = 0;
  for (const v of Object.values(snap.data)) bytes += byteLength(v);

  return {
    keys: Object.keys(snap.data).length,
    bytes,
    books: Array.isArray(books) ? books.length : 0,
    cards: Array.isArray(materials?.cards) ? materials.cards.length : 0,
    debates: Array.isArray(materials?.debates) ? materials.debates.length : 0,
    readings: Array.isArray(materials?.readings) ? materials.readings.length : 0,
    lit: Array.isArray(lit) ? lit.length : 0,
  };
}

/**
 * 校验从网上收来的东西。
 *
 * 这是个只听自己人说话的本地服务，但仍然要校验：手机和电脑在同一个局域网里，
 * 谁都能往这个端口 POST 一段 JSON。校验的目标不是防恶意攻击（拦不住），
 * 而是**不让一段乱七八糟的数据把本机存储写坏**——写坏之后用户是真的会丢数据。
 */
export function parseSnapshot(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是合法对象' };
  const o = raw as Partial<SyncSnapshot>;
  if (o.app !== SYNC_APP) return { ok: false, reason: '不是问津的快照' };
  if (o.v !== SYNC_VERSION) return { ok: false, reason: `快照版本不认识（${String(o.v)}）` };
  if (!o.data || typeof o.data !== 'object' || Array.isArray(o.data)) {
    return { ok: false, reason: '缺少 data' };
  }

  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.data)) {
    if (typeof k !== 'string' || k.length > 120) return { ok: false, reason: '键名不合法' };
    if (typeof v !== 'string') return { ok: false, reason: `键 ${k} 的值不是字符串` };
    data[k] = v;
  }

  const snap: SyncSnapshot = {
    app: SYNC_APP,
    v: SYNC_VERSION,
    at: typeof o.at === 'number' ? o.at : Date.now(),
    device: typeof o.device === 'string' ? o.device.slice(0, 24) : '未知',
    data,
  };

  if (describeSnapshot(snap).bytes > MAX_BYTES) {
    return { ok: false, reason: '快照太大（超过 12MB）' };
  }
  return { ok: true, snap };
}

/** 把本机当前数据整体存成一份备份，返回备份键名 */
function backupLocal(store: SyncStore, now: number): string {
  const snap = collectSnapshot(store, '备份');
  const key = `wj_backup_${now}`;
  try {
    store.setItem(key, JSON.stringify(snap));
  } catch {
    /* 配额满了就放弃这次备份，但绝不因此中断覆盖流程 */
  }
  pruneBackups(store);
  return key;
}

/** 只留最近 KEEP_BACKUPS 份，避免 localStorage 被备份挤爆 */
function pruneBackups(store: SyncStore): void {
  const keys = allKeys(store)
    .filter((k) => k.startsWith('wj_backup_'))
    .sort();
  while (keys.length > KEEP_BACKUPS) {
    const old = keys.shift();
    if (old) store.removeItem(old);
  }
}

/**
 * 用快照覆盖本机数据。
 *
 * 顺序不能改：先备份 → 再清旧键 → 最后写新键。
 * 反过来的话中途出错就把用户的原有数据抹掉了。
 */
export function applySnapshot(store: SyncStore, raw: unknown): ApplyResult {
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) return parsed;

  const { snap } = parsed;
  const now = Date.now();
  const backupKey = backupLocal(store, now);

  for (const k of allKeys(store)) {
    if (isSyncKey(k)) store.removeItem(k);
  }

  for (const [k, v] of Object.entries(snap.data)) {
    if (!isSyncKey(k)) continue;
    try {
      store.setItem(k, v);
    } catch {
      return { ok: false, reason: `写入 ${k} 失败（存储空间可能已满）` };
    }
  }

  return { ok: true, backupKey, stats: describeSnapshot(snap) };
}

/** 本机最近一次备份的键名，供界面提示「覆盖前的备份还在」 */
export function latestBackupKey(store: SyncStore): string | null {
  const keys = allKeys(store)
    .filter((k) => k.startsWith('wj_backup_'))
    .sort();
  return keys.length ? (keys[keys.length - 1] ?? null) : null;
}
