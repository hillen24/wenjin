import { describe, expect, it } from 'vitest';
import {
  BOOK_FULL_SCORE,
  bookPct,
  bookScore,
  bookStage,
  bookToMarkdown,
  buildBook,
  digestForEditor,
  entryUsage,
  parseEditorReply,
  topEntryId,
} from './book';
import { METHOD_ENTRIES } from '../data/methods';
import type { Materials } from '../types';

function empty(): Materials {
  return { cards: [], debates: [], readings: [] };
}

const sample: Materials = {
  cards: [
    {
      date: '10-22',
      entry: 'A1',
      title: '怕被议论',
      bother: '模考排名下滑，怕被议论',
      ctrl: ['我的复习节奏'],
      un: ['排名数字'],
      practice: '「排名是反馈，不是判决。」',
      next: '整理 5 道错题',
      lit: ['dichotomy'],
    },
    {
      date: '10-21',
      entry: 'A1',
      title: '又一次排名焦虑',
      bother: '月考成绩出来了',
      ctrl: ['错题复盘'],
      un: ['他人评价'],
      practice: '',
      next: '找老师问一次',
      lit: [],
    },
  ],
  debates: [{ date: '10-21', phil: '尼采', title: '「成为自己」怎么操作', lines: [] }],
  readings: [{ date: '10-20', doc: '《论说集》开篇', quote: '损害在于判断', skill: '讲解', reply: '…' }],
};

describe('成书进度', () => {
  it('格物卡权重是 2', () => {
    expect(bookScore(sample)).toBe(2 * 2 + 1 + 1);
    expect(bookScore(empty())).toBe(0);
  });

  it('进度按 40 点封顶，不会超过 100%', () => {
    expect(bookPct(empty())).toBe(0);
    expect(bookPct(sample)).toBe(Math.round((6 / BOOK_FULL_SCORE) * 100));

    const fat: Materials = {
      cards: Array.from({ length: 30 }, (_, i) => ({ ...sample.cards[0]!, date: `10-${i}` })),
      debates: [],
      readings: [],
    };
    expect(bookPct(fat)).toBe(100);
  });

  it('档位随进度切换', () => {
    expect(bookStage(0)).toBe('萌芽');
    expect(bookStage(19)).toBe('萌芽');
    expect(bookStage(20)).toBe('小册');
    expect(bookStage(50)).toBe('逼近成稿');
    expect(bookStage(80)).toBe('成书');
  });

  it('用得最多的条目排第一', () => {
    expect(entryUsage(sample)).toEqual([
      { id: 'A1', n: 2 },
    ]);
    expect(topEntryId(sample)).toBe('A1');
    expect(topEntryId(empty())).toBeUndefined();
  });
});

describe('编书结构', () => {
  it('四个正文章节，加上序言与尾声', () => {
    const b = buildBook(sample, METHOD_ENTRIES);
    expect(b.chapters).toHaveLength(4);
    expect(b.chapters[0]!.title).toContain('烦恼地图');
    expect(b.chapters[0]!.items).toHaveLength(2);
    expect(b.chapters[1]!.items[0]!.tag).toBe('×2');
    expect(b.chapters[2]!.items).toHaveLength(1); // 只有一条带 practice 的会被收
    expect(b.chapters[2]!.items[0]!.serif).toBe(true);
    expect(b.chapters[3]!.items).toHaveLength(2); // 论道 + 伴读
  });

  it('空书给的是提示语而不是空白', () => {
    const b = buildBook(empty(), METHOD_ENTRIES);
    b.chapters.forEach((ch) => {
      expect(ch.items).toHaveLength(0);
      expect(ch.hint.length).toBeGreaterThan(0);
    });
  });

  it('AI 润色过的序言会覆盖本地版', () => {
    const b = buildBook(sample, METHOD_ENTRIES, { preface: 'AI 写的序言', coda: 'AI 的叮嘱' });
    expect(b.preface).toBe('AI 写的序言');
    expect(b.coda).toBe('AI 的叮嘱');
  });

  it('没润色时尾声会引用最常用的方法论', () => {
    const b = buildBook(sample, METHOD_ENTRIES);
    expect(b.coda).toContain('A1');
    expect(b.coda).toContain(METHOD_ENTRIES.find((e) => e.id === 'A1')!.name);
  });
});

describe('解析 AI 编辑的回复', () => {
  it('标准格式两段都切得出', () => {
    const r = parseEditorReply('【序言】你很稳。\n【叮嘱】别急着下结论。');
    expect(r.preface).toBe('你很稳。');
    expect(r.coda).toBe('别急着下结论。');
  });

  it('模型多说了句客套话也不影响', () => {
    const r = parseEditorReply('好的，以下是两段：\n【序言】正文A\n【叮嘱】正文B');
    expect(r.preface).toBe('正文A');
    expect(r.coda).toBe('正文B');
  });

  it('只给了一段：另一段留空，交给本地兜底', () => {
    const r = parseEditorReply('【序言】只有序言');
    expect(r.preface).toBe('只有序言');
    expect(r.coda).toBeUndefined();
  });

  it('完全没按格式：整段当序言，不白跑一趟', () => {
    const r = parseEditorReply('这是一段自由发挥的文字');
    expect(r.preface).toBe('这是一段自由发挥的文字');
  });
});

describe('导出 Markdown', () => {
  it('章节与素材一一对应，空章节写提示语', () => {
    const md = bookToMarkdown(buildBook(sample, METHOD_ENTRIES), '2026-10-24');
    expect(md).toContain('# 我的哲学书');
    expect(md).toContain('2026-10-24');
    expect(md).toContain('## 第一章 · 我的烦恼地图');
    expect(md).toContain('- 10-22 模考排名下滑，怕被议论');
    expect(md).toContain('1. 10-22 「排名是反馈，不是判决。」'); // 命题用有序列表
    expect(md).toContain('## 尾声 · 叮嘱');

    const emptyMd = bookToMarkdown(buildBook(empty(), METHOD_ENTRIES), '2026-10-24');
    expect(emptyMd).toContain('（格物卡会在这里画出你的烦恼地形。）');
  });
});

describe('素材摘要', () => {
  it('三类素材都在，且按上限截断', () => {
    const many: Materials = {
      cards: Array.from({ length: 20 }, (_, i) => ({ ...sample.cards[0]!, title: `卡${i}` })),
      debates: sample.debates,
      readings: sample.readings,
    };
    const d = digestForEditor(many);
    expect(d).toContain('【格物卡】');
    expect(d).toContain('【论道】');
    expect(d).toContain('【伴读问答】');
    // 12 条上限 + 论道 1 + 伴读 1
    const bulletCount = d.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(bulletCount).toBe(14);
  });
});
