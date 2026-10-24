import { describe, expect, it } from 'vitest';
import { GewuSession, genericScript, scriptFor } from './index';
import { METHOD_ENTRIES } from '../data/methods';
import { CARD_TEXTS } from '../data/gewu';

describe('剧本选择', () => {
  it('有手写剧本的条目用自己的', () => {
    expect(scriptFor('A1')[0]!.t).toContain('今天有什么烦扰着你');
  });

  it('没有的用 SOP 现场拼一个', () => {
    // B2 / A10 / C1 这几条没有手写剧本，走通用兜底
    const e = METHOD_ENTRIES.find((x) => x.id === 'B2')!;
    const s = scriptFor(e.id);
    expect(s.length).toBe(3);
    expect(s[0]!.t).toContain(e.name);
    expect(s[2]!.end).toBe(true);
  });

  it('未知条目给空剧本，不炸', () => {
    expect(scriptFor('不存在的条目')).toEqual([]);
  });

  it('通用剧本最后一步是收尾', () => {
    const e = METHOD_ENTRIES[0]!;
    const s = genericScript(e);
    expect(s[0]!.opts).toBeDefined();
    expect(s[2]!.opts).toBeUndefined();
    expect(s[2]!.end).toBe(true);
  });
});

describe('会话推进', () => {
  it('begin 回到第一步', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    const step = g.begin();
    expect(step).toBeDefined();
    expect(g.stepIndex).toBe(0);
    expect(g.atEnd).toBe(false);
  });

  it('每答一句前进一步，并记下回答', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    g.begin();
    g.answer('第一句');
    expect(g.stepIndex).toBe(1);
    g.answer('第二句');
    expect(g.said).toEqual(['第一句', '第二句']);
  });

  it('走完所有步骤后 atEnd 为真', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    g.begin();
    const total = g.total;
    for (let i = 0; i < total; i++) g.answer(`答${i}`);
    expect(g.atEnd).toBe(true);
    expect(g.current).toBeUndefined();
  });

  it('换条目会把进度和回答清零', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    g.begin();
    g.answer('写点什么');
    g.setEntry('A4');
    expect(g.stepIndex).toBe(0);
    expect(g.said).toEqual([]);
    expect(g.entryId).toBe('A4');
  });
});

describe('二分归类', () => {
  it('用预填文案初始化两列', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    const items = g.prepareSort();
    expect(items.filter((i) => i.side === 'ctrl')).toHaveLength(CARD_TEXTS.A1!.ctrl.length);
    expect(items.filter((i) => i.side === 'un')).toHaveLength(CARD_TEXTS.A1!.un.length);
  });

  it('点一下换边', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    const items = g.prepareSort();
    const first = items.find((i) => i.side === 'ctrl')!;
    const moved = g.toggle(first.key);
    expect(moved.find((i) => i.key === first.key)!.side).toBe('un');
    // 原数组不被就地改写（Vue 需要新引用）
    expect(items.find((i) => i.key === first.key)!.side).toBe('ctrl');
  });

  it('可以自己加一条', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    g.prepareSort();
    const before = g.sortItems.length;
    g.addItem('我自己想到的', 'ctrl');
    expect(g.sortItems).toHaveLength(before + 1);
    expect(g.sortItems.at(-1)!.text).toBe('我自己想到的');
  });

  it('空白输入不产生条目', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    g.prepareSort();
    const before = g.sortItems.length;
    g.addItem('   ', 'un');
    expect(g.sortItems).toHaveLength(before);
  });
});

describe('出卡', () => {
  it('有预填文案时用预填', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    g.begin();
    const card = g.buildCard(['dichotomy']);
    expect(card.entry).toBe('A1');
    expect(card.bother).toBe(CARD_TEXTS.A1!.bother);
    expect(card.ctrl).toEqual(CARD_TEXTS.A1!.ctrl);
    expect(card.lit).toEqual(['dichotomy']);
    expect(card.date).toMatch(/^\d{2}-\d{2}$/);
  });

  it('没有预填文案时从对话与归类里拼，而不是糊一句「已记录」', () => {
    // B2 既没有手写剧本也没有预填卡文案，正好走兜底分支
    const g = new GewuSession();
    g.setEntry('B2');
    g.begin();
    g.answer('今天被同学冷落了');
    g.prepareSort();
    g.addItem('我的态度', 'ctrl');
    g.addItem('他怎么想', 'un');

    const card = g.buildCard();
    expect(card.bother).toBe('今天被同学冷落了');
    expect(card.ctrl).toEqual(['我的态度']);
    expect(card.un).toEqual(['他怎么想']);
    expect(card.practice).toContain('SOP');
  });

  it('练习句标题随条目变化', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    expect(g.practiceLabel).toContain('愿意其发生');
    g.setEntry('A11');
    expect(g.practiceLabel).toContain('48 小时');
    g.setEntry('C9');
    expect(g.practiceLabel).toBe('下一步最小行动');
  });
});

describe('点亮概念', () => {
  it('只返回还没点过的', () => {
    const g = new GewuSession();
    g.setEntry('A1');
    expect(g.newLights([])).toEqual(g.entry!.lit);
    expect(g.newLights([...g.entry!.lit])).toEqual([]);
  });

  it('条目不存在时返回空', () => {
    const g = new GewuSession();
    g.setEntry('不存在');
    expect(g.newLights([])).toEqual([]);
  });
});
