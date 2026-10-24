/**
 * 沉淀库：格物卡 / 论道记录 / 伴读问答
 *
 * 旧版是 `let materials = {cards:[],debates:[],readings:[]}` 加一个 saveMaterials()，
 * 谁都能直接 push 进数组，写盘靠调用方自己记得调。
 * 现在所有写入都必须过 add()，它负责落盘 + 通知订阅者。
 *
 * 另一处行为改动：**不再灌演示数据**。
 * 旧版首次启动会塞进 3 张格物卡、1 场论道、1 条伴读问答，侧栏「历史格物卡」还写死了 3 条。
 * 结果用户打开应用，看到的是一堆自己从没做过的记录——这比空荡荡更让人困惑。
 * 现在首次启动是干净的，空态里直接给出「今晚就能有第一张」的入口。
 */

import type { MaterialType, Materials } from '../types';
import { KeyValueStore, STORAGE_KEYS } from '../storage';

function empty(): Materials {
  return { cards: [], debates: [], readings: [] };
}

/** 兜底：磁盘上的数据可能来自旧版、可能被手改坏，缺哪一类补哪一类 */
function normalize(raw: unknown): Materials {
  const m = (raw ?? {}) as Partial<Materials>;
  return {
    cards: Array.isArray(m.cards) ? m.cards : [],
    debates: Array.isArray(m.debates) ? m.debates : [],
    readings: Array.isArray(m.readings) ? m.readings : [],
  };
}

export class MaterialsStore {
  private readonly kv: KeyValueStore;
  private readonly listeners = new Set<(m: Materials) => void>();
  private state: Materials;

  constructor(kv: KeyValueStore) {
    this.kv = kv;
    this.state = normalize(kv.readJSON<unknown>(STORAGE_KEYS.materials, null));
  }

  get(): Materials {
    return this.state;
  }

  /**
   * 新条目插到最前 —— 「我的哲学书」按时间倒序读，
   * 最新的复盘该出现在第一章顶上。
   */
  add<T extends MaterialType>(type: T, item: Materials[T][number]): Materials {
    const next: Materials = {
      ...this.state,
      [type]: [item as never, ...this.state[type]] as Materials[T],
    };
    this.state = next;
    this.persist();
    this.emit();
    return next;
  }

  clear(): Materials {
    this.state = empty();
    this.persist();
    this.emit();
    return this.state;
  }

  subscribe(fn: (m: Materials) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private persist(): void {
    this.kv.writeJSON(STORAGE_KEYS.materials, this.state);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        console.error('[materials] 监听器异常', e);
      }
    }
  }
}
