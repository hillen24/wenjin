/**
 * 存储抽象层
 *
 * 旧版到处是 `try{localStorage.setItem(...)}catch(e){}` —— 静默吞异常。
 * 配额满、隐私模式、被禁用时，用户以为存住了其实没存，只有重启后数据消失才发现。
 *
 * 这里做两件事：
 * 1. 把「存在哪」抽成 StorageAdapter，浏览器/Electron/Capacitor 用同一套，
 *    单测换 MemoryStorage 即可，不需要 jsdom。
 * 2. 写入失败不再静默，记到 lastError 上让 UI 显示。
 */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 内存实现。单测用，也可作为 localStorage 不可用时的降级。 */
export class MemoryStorage implements StorageAdapter {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** 检测当前环境是否真的能写 localStorage（Safari 隐私模式下 setItem 会抛）。 */
export function isLocalStorageUsable(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probe = '__wj_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function createAdapter(): StorageAdapter {
  return isLocalStorageUsable() ? localStorage : new MemoryStorage();
}

/**
 * 键值仓库：JSON 序列化 + 错误可见。
 *
 * 读取失败一律回落默认值——读坏数据不该让整个应用白屏；
 * 但失败原因会留在 lastError 里，设置页可以展示。
 */
export class KeyValueStore {
  private adapter: StorageAdapter;

  /** 最近一次失败原因，成功时清空。UI 可以直接读它做提示。 */
  lastError = '';

  /** 是否处于降级模式（localStorage 不可用，数据只在内存里） */
  readonly degraded: boolean;

  constructor(adapter?: StorageAdapter) {
    const auto = adapter ?? createAdapter();
    this.degraded = auto instanceof MemoryStorage && !adapter;
    this.adapter = auto;
  }

  readJSON<T>(key: string, fallback: T): T {
    try {
      const raw = this.adapter.getItem(key);
      if (raw === null || raw === '') return fallback;
      return JSON.parse(raw) as T;
    } catch (e) {
      this.lastError = `读取 ${key} 失败：${(e as Error).message}`;
      return fallback;
    }
  }

  /** 读原始字符串，不做 JSON 解析。AI 指纹存的就是裸串，与 v2.x 保持一致。 */
  readRaw(key: string, fallback = ''): string {
    try {
      return this.adapter.getItem(key) ?? fallback;
    } catch (e) {
      this.lastError = `读取 ${key} 失败：${(e as Error).message}`;
      return fallback;
    }
  }

  /** 写原始字符串 */
  writeRaw(key: string, value: string): boolean {
    try {
      this.adapter.setItem(key, value);
      this.lastError = '';
      return true;
    } catch (e) {
      this.lastError = `保存 ${key} 失败：${(e as Error).message}`;
      return false;
    }
  }

  /** 返回是否写入成功。失败时 lastError 有值。 */
  writeJSON(key: string, value: unknown): boolean {
    try {
      this.adapter.setItem(key, JSON.stringify(value));
      this.lastError = '';
      return true;
    } catch (e) {
      this.lastError = `保存 ${key} 失败：${(e as Error).message}`;
      return false;
    }
  }

  remove(key: string): boolean {
    try {
      this.adapter.removeItem(key);
      this.lastError = '';
      return true;
    } catch (e) {
      this.lastError = `清除 ${key} 失败：${(e as Error).message}`;
      return false;
    }
  }
}

/* ============================================================
 * 存储键名集中管理
 *
 * 刻意沿用 v2.x 的原键名，不做版本升级：
 * 用户升级到 3.0 后设置、藏书、阅读进度、格物卡全部仍在原地，
 * 不需要写任何迁移逻辑，也就没有迁移出错的可能。
 *
 * 旧版这些字符串散落在各处（含 progKey 这种动态拼接），
 * 改一个漏一个就会静默失忆 —— 现在只有这一份清单。
 * ============================================================ */

export const STORAGE_KEYS = {
  settings: 'wj_settings_v1',
  /** AI 接入指纹：v2.1 引入，是「配置过就等于接入」的正确解法 */
  aiSignature: 'wj_ai_sig',
  theme: 'wj_theme',
  userBooks: 'wj_user_books',
  /** 格物卡 / 论道记录 / 阅读记录，形如 { cards, debates, readings } */
  materials: 'wj_materials_v1',
  /** 星图共建：用户自定义节点与边，形如 { nodes, edges } */
  customGraph: 'wj_custom_graph_v1',
} as const;

/** 单篇阅读进度。旧版是 'wj_prog_' + docId，保持一致。 */
export function progressKey(docId: string): string {
  return `wj_prog_${docId}`;
}

