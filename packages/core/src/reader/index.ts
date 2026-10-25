/**
 * 书架与阅读进度
 *
 * 两块内容合在一个仓库里，因为它们共享同一个键空间：
 * 内置原著的段落、用户载入的书、每本书读到第几段，都是「一本书」的属性。
 *
 * 旧版这块的坑：
 * - getDoc() 找不到就静默返回《论说集》，于是删掉一本书后界面「跳」到另一本书，
 *   用户以为删除失败了。新版返回 undefined，视图显式处理。
 * - 载入书籍失败只 toast 一句，2MB 以上直接拒收还不说清限制。新版返回结构化结果。
 */

import type { ReadingDoc, UserBook } from '../types';
import { KeyValueStore, progressKey, STORAGE_KEYS } from '../storage';
import { BUILTIN_DOCS } from '../data/extras';
import { READINGS } from '../data/readings';

/** 载入文件的大小上限。旧版是 2MB，这里保持。 */
export const MAX_BOOK_BYTES = 2 * 1024 * 1024;

/**
 * 切段。
 *
 * 优先按空行切（真正的段落）；如果整本书没有空行（很多 txt 就是一段到底），
 * 退回按行切。旧版这两步一模一样，只是没写注释，看着像碰运气。
 */
export function splitParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  let paras = normalized
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (paras.length < 2) {
    paras = normalized
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return paras;
}

/** 书架上的一本书（内置或用户载入），统一形状 */
export interface ShelfDoc extends ReadingDoc {
  readonly id: string;
  readonly custom: boolean;
}

export type AddBookResult =
  | { ok: true; id: string; title: string; paras: number }
  | { ok: false; reason: string };

export class ReaderStore {
  private readonly kv: KeyValueStore;
  private readonly listeners = new Set<() => void>();

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  /* ---------- 书架 ---------- */

  userBooks(): UserBook[] {
    const raw = this.kv.readJSON<unknown>(STORAGE_KEYS.userBooks, []);
    return Array.isArray(raw) ? (raw as UserBook[]) : [];
  }

  /** 全部可读的书：内置在前，用户书库在后 */
  shelf(): ShelfDoc[] {
    const out: ShelfDoc[] = [];

    for (const id of BUILTIN_DOCS) {
      const d = READINGS[id];
      if (!d) continue;
      out.push({
        id,
        short: d.short,
        title: d.title,
        meta: d.meta,
        paras: d.paras,
        custom: false,
      });
    }

    for (const b of this.userBooks()) {
      out.push({
        id: b.id,
        short: b.title,
        title: b.title,
        meta: b.meta,
        paras: b.paras,
        custom: true,
      });
    }

    return out;
  }

  find(id: string): ShelfDoc | undefined {
    if (READINGS[id]) {
      const d = READINGS[id];
      return { ...d, id, custom: false };
    }
    const b = this.userBooks().find((x) => x.id === id);
    if (!b) return undefined;
    return {
      id: b.id,
      short: b.title,
      title: b.title,
      meta: b.meta,
      paras: b.paras,
      custom: true,
    };
  }

  /**
   * 载入一本自己的书。
   * meta 可覆盖（文献研读导入的书标注「文献研读」，和手动载入的区分开）。
   * 失败原因回传成字符串而不是 toast —— 视图决定怎么显示，core 不关心 UI。
   */
  addUserBook(fileName: string, text: string, metaOverride?: string): AddBookResult {
    if (text.length > MAX_BOOK_BYTES) {
      // 注意：以字符数近似字节数，中文占 3 字节，这里刻意放宽以免误杀
      return { ok: false, reason: '文件太大（超过 2MB），先换一本小一点的' };
    }
    const paras = splitParagraphs(text);
    if (paras.length === 0) return { ok: false, reason: '没读到有效文本' };

    const id = `ub_${Date.now().toString(36)}`;
    const title = fileName.replace(/\.(txt|md)$/i, '') || '未命名';
    const books = this.userBooks();
    books.push({
      id,
      title,
      meta: metaOverride ?? `我的书库 · 载入于 ${today()}`,
      custom: true,
      paras,
    });

    if (!this.kv.writeJSON(STORAGE_KEYS.userBooks, books)) {
      return { ok: false, reason: '本地存储空间不足，这本书没存下' };
    }
    this.emit();
    return { ok: true, id, title, paras: paras.length };
  }

  /**
   * 文献研读导入的书。
   *
   * 用户导入的文献，原文也要能读 —— 提取完方法论/概念就走的书是耍流氓。
   * 按标题去重：同一本书反复导入不重复占书架，直接复用已存在那本。
   */
  addImportedBook(title: string, text: string): AddBookResult {
    const clean = title.trim() || '未命名文献';
    const dup = this.userBooks().find((b) => b.title === clean);
    if (dup) {
      return { ok: true, id: dup.id, title: dup.title, paras: dup.paras.length };
    }
    return this.addUserBook(`${clean}.txt`, text, `文献研读 · 导入于 ${today()}`);
  }

  removeUserBook(id: string): void {
    const books = this.userBooks().filter((b) => b.id !== id);
    this.kv.writeJSON(STORAGE_KEYS.userBooks, books);
    this.kv.remove(progressKey(id));
    this.emit();
  }

  /* ---------- 进度 ---------- */

  progress(id: string): number[] {
    const raw = this.kv.readJSON<unknown>(progressKey(id), []);
    return Array.isArray(raw) ? (raw as number[]) : [];
  }

  markRead(id: string, index: number): void {
    const p = this.progress(id);
    if (p.includes(index)) return;
    p.push(index);
    this.kv.writeJSON(progressKey(id), p);
    this.emit();
  }

  /** 已读段数 / 总段数，书架列表要显示 */
  readCount(id: string): { read: number; total: number } {
    const doc = this.find(id);
    return { read: this.progress(id).length, total: doc?.paras.length ?? 0 };
  }

  /* ---------- 订阅 ---------- */

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('[reader] 监听器异常', e);
      }
    }
  }
}

/** MM-DD。旧版的 today() 只到日，够用，不引日期库。 */
export function today(d: Date = new Date()): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 更完整的 YYYY-MM-DD，格物卡标题和文件名用 */
export function todayFull(d: Date = new Date()): string {
  return `${d.getFullYear()}-${today(d)}`;
}
