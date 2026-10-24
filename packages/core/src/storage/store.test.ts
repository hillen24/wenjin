/**
 * 存储层：坏数据、坏环境都不能让应用失忆还不吭声
 */

import { describe, expect, it } from 'vitest';
import {
  KeyValueStore,
  MemoryStorage,
  isLocalStorageUsable,
  progressKey,
  type StorageAdapter,
} from './index';

/** 写就炸的存储，模拟配额满 / 隐私模式 */
class BrokenStorage implements StorageAdapter {
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

describe('KeyValueStore', () => {
  it('正常读写 JSON', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeJSON('k', { a: 1, b: '中文' });
    expect(kv.readJSON('k', null)).toEqual({ a: 1, b: '中文' });
  });

  it('坏 JSON 回落默认值，不抛异常', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeRaw('k', '{不是合法 JSON');

    expect(kv.readJSON('k', { safe: true })).toEqual({ safe: true });
    expect(kv.lastError).toContain('读取');
  });

  it('空串按缺失处理', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeRaw('k', '');
    expect(kv.readJSON('k', 42)).toBe(42);
  });

  it('写失败时返回 false 并记下原因，而不是静默吞掉', () => {
    const kv = new KeyValueStore(new BrokenStorage());

    const ok = kv.writeJSON('k', { a: 1 });

    expect(ok).toBe(false);
    expect(kv.lastError).toContain('QuotaExceededError');
  });

  it('删失败也记原因', () => {
    const kv = new KeyValueStore(new BrokenStorage());
    expect(kv.remove('k')).toBe(false);
    expect(kv.lastError).toContain('SecurityError');
  });

  it('裸字符串读写（AI 指纹这类不存 JSON 的）', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeRaw('sig', 'a\u0001b');
    expect(kv.readRaw('sig')).toBe('a\u0001b');
    expect(kv.readRaw('missing', 'fallback')).toBe('fallback');
  });
});

describe('环境探测', () => {
  it('Node 环境里 localStorage 不可用', () => {
    expect(isLocalStorageUsable()).toBe(false);
  });
});

describe('键名', () => {
  it('阅读进度键与旧版完全一致', () => {
    expect(progressKey('epictetus')).toBe('wj_prog_epictetus');
  });
});
