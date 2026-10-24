import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage';
import { KeyValueStore } from '../storage';
import { ReaderStore, splitParagraphs, today, todayFull } from './index';

function store(): ReaderStore {
  return new ReaderStore(new KeyValueStore(new MemoryStorage()));
}

describe('切段', () => {
  it('按空行切', () => {
    expect(splitParagraphs('第一段\n\n第二段\n\n第三段')).toEqual(['第一段', '第二段', '第三段']);
  });

  it('没有空行时退回按行切', () => {
    expect(splitParagraphs('第一段\n第二段\n第三段')).toEqual(['第一段', '第二段', '第三段']);
  });

  it('CRLF 也能处理', () => {
    expect(splitParagraphs('A\r\n\r\nB')).toEqual(['A', 'B']);
  });

  it('空文本得到空数组', () => {
    expect(splitParagraphs('   \n\n  ')).toEqual([]);
  });
});

describe('书架', () => {
  it('内置原著在前', () => {
    const s = store();
    const shelf = s.shelf();
    expect(shelf.map((d) => d.id)).toEqual(['epictetus', 'zhuangzi', 'laotzi', 'lunyu', 'xiaoyao', 'daxue']);
    expect(shelf.every((d) => !d.custom)).toBe(true);
  });

  it('载入自己的书后出现在末尾', () => {
    const s = store();
    const r = s.addUserBook('我的笔记.txt', '第一段\n\n第二段');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const shelf = s.shelf();
    expect(shelf).toHaveLength(7);
    expect(shelf[6]!.custom).toBe(true);
    expect(shelf[6]!.title).toBe('我的笔记');
    expect(shelf[6]!.paras).toEqual(['第一段', '第二段']);
  });

  it('空文件拒收并说明原因', () => {
    const s = store();
    const r = s.addUserBook('空.txt', '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('有效文本');
  });

  it('找不到的书返回 undefined，而不是悄悄给另一本', () => {
    // 旧版 getDoc() 找不到就返回《论说集》，删书后界面会「跳」到它，看起来像删除失败
    const s = store();
    expect(s.find('不存在的书')).toBeUndefined();
  });

  it('移除用户书，内置不受影响', () => {
    const s = store();
    const r = s.addUserBook('a.txt', 'x\n\ny');
    if (!r.ok) throw new Error('准备失败');
    s.removeUserBook(r.id);
    expect(s.shelf().map((d) => d.id)).toEqual(['epictetus', 'zhuangzi', 'laotzi', 'lunyu', 'xiaoyao', 'daxue']);
  });
});

describe('阅读进度', () => {
  it('标记已读并去重', () => {
    const s = store();
    s.markRead('epictetus', 0);
    s.markRead('epictetus', 0);
    s.markRead('epictetus', 2);
    expect(s.progress('epictetus')).toEqual([0, 2]);
  });

  it('进度按书隔离', () => {
    const s = store();
    s.markRead('epictetus', 1);
    expect(s.progress('zhuangzi')).toEqual([]);
  });

  it('计数给书架列表用', () => {
    const s = store();
    s.markRead('epictetus', 0);
    const { read, total } = s.readCount('epictetus');
    expect(read).toBe(1);
    expect(total).toBeGreaterThan(1);
  });

  it('删书连进度一起清掉，不留孤儿键', () => {
    const store2 = new KeyValueStore(new MemoryStorage());
    const s = new ReaderStore(store2);
    const r = s.addUserBook('b.txt', 'p1\n\np2');
    if (!r.ok) throw new Error('准备失败');
    s.markRead(r.id, 0);
    expect(s.progress(r.id)).toEqual([0]);

    s.removeUserBook(r.id);
    expect(s.progress(r.id)).toEqual([]);
  });

  it('持久化：换一个实例仍然读得到', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const a = new ReaderStore(kv);
    const r = a.addUserBook('c.txt', 'x\n\ny\n\nz');
    if (!r.ok) throw new Error('准备失败');
    a.markRead(r.id, 1);

    const b = new ReaderStore(kv);
    expect(b.find(r.id)).toBeDefined();
    expect(b.progress(r.id)).toEqual([1]);
  });
});

describe('日期', () => {
  it('两位月日', () => {
    expect(today(new Date(2026, 0, 5))).toBe('01-05');
    expect(todayFull(new Date(2026, 9, 24))).toBe('2026-10-24');
  });
});
