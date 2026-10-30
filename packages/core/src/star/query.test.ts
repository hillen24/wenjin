import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  allSchools,
  describePath,
  filterNodes,
  isFilterActive,
  searchNodes,
  shortestPath,
  type FilterState,
} from './query';
import type { EdgeRelation, NodeKind, StarEdge, StarNode } from '../types';

function node(
  id: string,
  name: string,
  patch: Partial<StarNode> = {},
): StarNode {
  return {
    id,
    name,
    kind: 'concept' as NodeKind,
    school: '希腊化罗马',
    brief: '一句话释义',
    src: '某本书',
    doc: null,
    ...patch,
  };
}

const REL_NAME: Record<EdgeRelation, string> = {
  proposes: '提出',
  refines: '修正',
  inherits: '继承',
  opposes: '反对',
};

describe('搜索', () => {
  const nodes = [
    node('kant', '康德', { brief: '德国古典哲学的开创者' }),
    node('neokant', '新康德主义', { brief: '19 世纪回流的一支' }),
    node('hume', '休谟', { brief: '康德自称被他从独断论中唤醒', src: '《人性论》' }),
    node('zhuangzi', '庄子', { school: '先秦中国' }),
  ];

  it('空查询返回空数组（表示不过滤，不是返回全部）', () => {
    expect(searchNodes(nodes, '')).toEqual([]);
    expect(searchNodes(nodes, '   ')).toEqual([]);
  });

  it('名字命中排在释义命中前面', () => {
    const hits = searchNodes(nodes, '康德');
    expect(hits[0]!.node.name).toBe('康德');
    expect(hits[0]!.field).toBe('name');
    // 休谟的释义里提到康德 → 也应命中，但排在后面
    const hume = hits.find((h) => h.node.id === 'hume');
    expect(hume?.field).toBe('brief');
    expect(hits.indexOf(hume!)).toBeGreaterThan(0);
  });

  it('名字完全等于的排最前', () => {
    const hits = searchNodes(nodes, '康德');
    expect(hits[0]!.node.id).toBe('kant');
  });

  it('名字前缀命中优先于中间命中', () => {
    const hits = searchNodes(nodes, '康德');
    // 「康德」完全匹配排最前，「新康德主义」在中间
    expect(hits.map((h) => h.node.name)).toContain('新康德主义');
    const idxExact = hits.findIndex((h) => h.node.name === '康德');
    const idxMid = hits.findIndex((h) => h.node.name === '新康德主义');
    expect(idxExact).toBeLessThan(idxMid);
  });

  it('能按出处和脉络搜', () => {
    expect(searchNodes(nodes, '人性论')[0]!.node.id).toBe('hume');
    expect(searchNodes(nodes, '先秦')[0]!.node.id).toBe('zhuangzi');
  });

  it('名字命中时给出命中下标（给文字高亮用）', () => {
    const hit = searchNodes(nodes, '康德').find((h) => h.node.id === 'neokant')!;
    expect(hit.nameAt).toBe(1);
    expect(hit.node.name.slice(hit.nameAt, hit.nameAt + 2)).toBe('康德');
  });

  it('搜不到就返回空', () => {
    expect(searchNodes(nodes, '苏格拉底')).toEqual([]);
  });

  it('大小写不敏感（英文 id 场景）', () => {
    const en = [node('aletheia', 'Aletheia', { brief: 'Unconcealment' })];
    expect(searchNodes(en, 'aleth')).toHaveLength(1);
    expect(searchNodes(en, 'ALETH')).toHaveLength(1);
  });

  it('limit 生效', () => {
    const many = Array.from({ length: 40 }, (_, i) => node(`n${i}`, `概念${i}`));
    expect(searchNodes(many, '概念', 10)).toHaveLength(10);
  });
});

describe('筛选', () => {
  const nodes = [
    node('a', '甲', { school: '古希腊', kind: 'figure' }),
    node('b', '乙', { school: '古希腊', kind: 'method' }),
    node('c', '丙', { school: '先秦中国', kind: 'concept' }),
    node('d', '丁', { school: '先秦中国', kind: 'concept' }),
  ];

  it('空筛选返回全部', () => {
    expect(filterNodes(nodes, EMPTY_FILTER)).toHaveLength(4);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it('按脉络筛', () => {
    const f: FilterState = { ...EMPTY_FILTER, schools: ['古希腊'] };
    expect(filterNodes(nodes, f).map((n) => n.id)).toEqual(['a', 'b']);
    expect(isFilterActive(f)).toBe(true);
  });

  it('按类型筛', () => {
    const f: FilterState = { ...EMPTY_FILTER, kinds: ['concept'] };
    expect(filterNodes(nodes, f).map((n) => n.id)).toEqual(['c', 'd']);
  });

  it('脉络 + 类型是「且」关系', () => {
    const f: FilterState = { ...EMPTY_FILTER, schools: ['先秦中国'], kinds: ['concept'] };
    expect(filterNodes(nodes, f).map((n) => n.id)).toEqual(['c', 'd']);
    const f2: FilterState = { ...EMPTY_FILTER, schools: ['古希腊'], kinds: ['concept'] };
    expect(filterNodes(nodes, f2)).toEqual([]);
  });

  it('按点亮状态筛', () => {
    const litIds = ['a', 'c'];
    expect(
      filterNodes(nodes, { ...EMPTY_FILTER, status: 'lit' }, { litIds }).map((n) => n.id),
    ).toEqual(['a', 'c']);
    expect(
      filterNodes(nodes, { ...EMPTY_FILTER, status: 'unlit' }, { litIds }).map((n) => n.id),
    ).toEqual(['b', 'd']);
  });

  it('按「我添加的」筛，没有集合时返回空而不是全部', () => {
    const custom = new Set(['b']);
    expect(
      filterNodes(nodes, { ...EMPTY_FILTER, status: 'mine' }, { customIds: custom }).map(
        (n) => n.id,
      ),
    ).toEqual(['b']);
    // 忘了传集合时不能悄悄返回全部（那会让用户以为筛选坏了）
    expect(filterNodes(nodes, { ...EMPTY_FILTER, status: 'mine' })).toEqual([]);
  });

  it('allSchools 按节点数从多到少排', () => {
    const r = allSchools(nodes);
    expect(r[0]).toEqual({ school: '古希腊', count: 2 });
    expect(r).toHaveLength(2);
  });
});

describe('两节点寻路', () => {
  const edges: StarEdge[] = [
    ['dichotomy', 'epictetus', 'proposes', '爱比克泰德提出'],
    ['epictetus', 'stoic', 'inherits', ''],
    ['stoic', 'amorfati', 'refines', ''],
    ['amorfati', 'nietzsche', 'proposes', ''],
    ['kant', 'hume', 'opposes', '康德反对休谟的因果观'],
  ];

  const nameOf = (id: string): string =>
    ({ dichotomy: '控制二分法', epictetus: '爱比克泰德', stoic: '斯多葛', amorfati: '命运之爱', nietzsche: '尼采', kant: '康德', hume: '休谟' })[
      id
    ] ?? id;

  it('相邻两节点直接连', () => {
    const p = shortestPath(edges, 'dichotomy', 'epictetus')!;
    expect(p.nodes).toEqual(['dichotomy', 'epictetus']);
    expect(p.hops).toHaveLength(1);
  });

  it('隔几跳能找到最短路径', () => {
    const p = shortestPath(edges, 'dichotomy', 'nietzsche')!;
    expect(p.nodes).toEqual(['dichotomy', 'epictetus', 'stoic', 'amorfati', 'nietzsche']);
    expect(p.hops).toHaveLength(4);
  });

  it('反着走也通（边是无向的）', () => {
    const p = shortestPath(edges, 'nietzsche', 'dichotomy')!;
    expect(p.nodes).toEqual(['nietzsche', 'amorfati', 'stoic', 'epictetus', 'dichotomy']);
  });

  it('同一个节点返回自身，零跳', () => {
    const p = shortestPath(edges, 'kant', 'kant')!;
    expect(p.nodes).toEqual(['kant']);
    expect(p.hops).toEqual([]);
  });

  it('两个互不连通的部分返回 null', () => {
    // kant-hume 是另一座岛
    expect(shortestPath(edges, 'dichotomy', 'kant')).toBeNull();
  });

  it('不存在的节点返回 null', () => {
    expect(shortestPath(edges, 'dichotomy', 'ghost')).toBeNull();
  });

  it('这一跳的关系类型和说明被带出来', () => {
    const p = shortestPath(edges, 'kant', 'hume')!;
    expect(p.hops[0]!.relation).toBe('opposes');
    expect(p.hops[0]!.note).toBe('康德反对休谟的因果观');
  });

  it('反向走时 hop 的 from/to 按实际行进方向给', () => {
    const p = shortestPath(edges, 'hume', 'kant')!;
    expect(p.hops[0]!.from).toBe('hume');
    expect(p.hops[0]!.to).toBe('kant');
  });

  it('忽略自环与空端点，不会死循环', () => {
    const dirty: StarEdge[] = [
      ['a', 'a', 'proposes', ''],
      ['a', '', 'inherits', ''],
      ['a', 'b', 'proposes', ''],
    ];
    const p = shortestPath(dirty, 'a', 'b')!;
    expect(p.nodes).toEqual(['a', 'b']);
  });

  it('describePath 能说人话', () => {
    const p = shortestPath(edges, 'dichotomy', 'nietzsche')!;
    expect(describePath(p, nameOf, REL_NAME)).toBe(
      '控制二分法 —提出→ 爱比克泰德 —继承→ 斯多葛 —修正→ 命运之爱 —提出→ 尼采',
    );
  });

  it('环形图里不会因为绕圈给出更长的路径', () => {
    const ring: StarEdge[] = [
      ['a', 'b', 'proposes', ''],
      ['b', 'c', 'proposes', ''],
      ['c', 'd', 'proposes', ''],
      ['d', 'a', 'proposes', ''],
    ];
    const p = shortestPath(ring, 'a', 'c')!;
    expect(p.nodes).toHaveLength(3); // a→b→c 或 a→d→c，都是两跳
  });
});
