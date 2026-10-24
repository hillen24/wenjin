/**
 * 星图点亮状态
 *
 * 旧版 `let litNodes = ['stoic', ...]` 是纯内存数组 —— 用户点亮一个概念，
 * 刷新页面就退回初始的七个。界面上「已点亮」看起来是个成就系统，
 * 实际每次重启都在悄悄清空。
 *
 * 这里落到 localStorage，键名沿用 v2.x 没有的新键 wj_lit。
 * 首次运行若无记录，用 INITIAL_LIT_NODES 作初始值（与 v2.x 表现一致）。
 */

import { KeyValueStore } from '../storage';
import { INITIAL_LIT_NODES } from '../data/extras';

const KEY = 'wj_lit';

export class ProgressStore {
  private readonly kv: KeyValueStore;
  private readonly listeners = new Set<(lit: readonly string[]) => void>();
  private state: string[];

  constructor(kv: KeyValueStore) {
    this.kv = kv;
    const saved = kv.readJSON<unknown>(KEY, null);
    this.state = Array.isArray(saved) ? (saved as string[]) : [...INITIAL_LIT_NODES];
  }

  lit(): readonly string[] {
    return this.state;
  }

  isLit(id: string): boolean {
    return this.state.includes(id);
  }

  /** 点亮若干概念，返回真正新增的那些 */
  light(ids: readonly string[]): string[] {
    const added = ids.filter((id) => !this.state.includes(id));
    if (added.length === 0) return [];
    this.state = [...this.state, ...added];
    this.persist();
    this.emit();
    return added;
  }

  reset(): void {
    this.state = [...INITIAL_LIT_NODES];
    this.persist();
    this.emit();
  }

  subscribe(fn: (lit: readonly string[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private persist(): void {
    this.kv.writeJSON(KEY, this.state);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        console.error('[progress] 监听器异常', e);
      }
    }
  }
}
