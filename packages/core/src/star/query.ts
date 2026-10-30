/**
 * 星图查询：搜索 / 筛选 / 两节点寻路
 *
 * 和 engine.ts 分开的理由：engine 是「物理」——每帧算位置，一秒钟调用六十次；
 * 这里是「心智」——用户点一下才跑一次。两类代码的生命周期、性能预算、
 * 测试方式都不同，混在一起会让 engine 越来越难读。
 *
 * 全都是纯函数：给数据、返回结果，不碰 DOM 也不碰 store。
 */

import type { EdgeRelation, NodeKind, StarEdge, StarNode } from '../types';

/* ============================================================
 * 搜索
 * ============================================================ */

export interface SearchHit {
  node: StarNode;
  /** 命中位置：名字 > 释义 > 出处 > 脉络。数字越小越靠前 */
  field: 'name' | 'brief' | 'src' | 'school';
  /** 名字里命中的起始下标，-1 表示名字没命中 */
  nameAt: number;
  score: number;
}

/**
 * 在节点里搜。
 *
 * 排序刻意做成「名字命中 > 释义命中 > 出处 > 脉络」——
 * 搜「康德」时想要的是那个叫康德的人，不是释义里提过一句康德的别的东西。
 * 名字里靠前命中也更相关（「庄」在「庄子」的第 0 位比在「麦当劳」的第 2 位强）。
 *
 * 空查询返回空数组（而不是全部）—— 调用方用「结果为空」表示「不过滤」，
 * 返回全部会让调用方多一个特判。
 */
export function searchNodes(
  nodes: readonly StarNode[],
  query: string,
  limit = 30,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];

  for (const node of nodes) {
    const name = node.name.toLowerCase();
    const nameAt = name.indexOf(q);

    let field: SearchHit['field'] | null = null;
    let score = 0;

    if (nameAt >= 0) {
      field = 'name';
      // 完全等于 > 从头开始 > 中间命中
      score = name === q ? 1000 : nameAt === 0 ? 800 - name.length : 600 - nameAt;
    } else if (node.brief.toLowerCase().includes(q)) {
      field = 'brief';
      score = 300;
    } else if (node.src.toLowerCase().includes(q)) {
      field = 'src';
      score = 200;
    } else if (node.school.toLowerCase().includes(q)) {
      field = 'school';
      score = 100;
    }

    if (field) hits.push({ node, field, nameAt, score });
  }

  hits.sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name, 'zh'));
  return hits.slice(0, limit);
}

/* ============================================================
 * 筛选
 * ============================================================ */

export interface FilterState {
  /** 选中的脉络，空数组表示不限 */
  schools: readonly string[];
  /** 选中的类型，空数组表示不限 */
  kinds: readonly NodeKind[];
  /** 点亮状态 */
  status: 'all' | 'lit' | 'unlit' | 'mine';
}

export const EMPTY_FILTER: FilterState = { schools: [], kinds: [], status: 'all' };

/** 筛选是否有任何条件生效 */
export function isFilterActive(f: FilterState): boolean {
  return f.schools.length > 0 || f.kinds.length > 0 || f.status !== 'all';
}

/**
 * 按条件筛节点。
 *
 * status='mine' 需要调用方传自定义 id 集合 —— 这里不 import store，
 * 保持纯函数。
 */
export function filterNodes(
  nodes: readonly StarNode[],
  f: FilterState,
  ctx: { litIds?: readonly string[]; customIds?: ReadonlySet<string> } = {},
): StarNode[] {
  const lit = new Set(ctx.litIds ?? []);
  const custom = ctx.customIds;

  return nodes.filter((n) => {
    if (f.schools.length && !f.schools.includes(n.school)) return false;
    if (f.kinds.length && !f.kinds.includes(n.kind)) return false;
    switch (f.status) {
      case 'lit':
        return lit.has(n.id);
      case 'unlit':
        return !lit.has(n.id);
      case 'mine':
        return custom ? custom.has(n.id) : false;
      default:
        return true;
    }
  });
}

/** 图谱里出现过的全部脉络，按节点数从多到少。给筛选条用。 */
export function allSchools(nodes: readonly StarNode[]): Array<{ school: string; count: number }> {
  const map = new Map<string, number>();
  for (const n of nodes) map.set(n.school, (map.get(n.school) ?? 0) + 1);
  return Array.from(map.entries())
    .map(([school, count]) => ({ school, count }))
    .sort((a, b) => b.count - a.count || a.school.localeCompare(b.school, 'zh'));
}

/* ============================================================
 * 两节点寻路
 * ============================================================ */

/** 路径上的一跳 */
export interface PathHop {
  from: string;
  to: string;
  relation: EdgeRelation;
  note: string;
}

export interface PathResult {
  /** 从起点到终点的节点 id 链（含两端） */
  nodes: string[];
  hops: PathHop[];
}

/**
 * 两个概念之间「怎么连起来的」——最短关系路径。
 *
 * ===== 为什么这个功能值得存在 =====
 * 星图的边是无向的（继承和反对都能互相追溯），所以任意两个概念几乎总能连上，
 * 只是绕几跳的问题。这条路径本身就是一次哲学讲解：
 *
 *   控制二分法 → 爱比克泰德 → 斯多葛学派 → 塞涅卡 → 命运之爱 → 尼采
 *
 * 用户看到的不再是「这两个词没关系」，而是「隔了几层、经由谁」。
 * 这是静态图谱里藏得最深的一层信息，只是以前没有入口。
 *
 * ===== 实现取舍 =====
 * 用 BFS 而不是 Dijkstra：所有边权重相同（都是一跳），BFS 就是最优，
 * 而且不需要优先队列。图只有几十个节点，性能上完全不是瓶颈。
 *
 * 同一对节点之间只保留第一条边（validateIncoming 已经保证不会重复连线），
 * 所以不需要处理多边最短的问题。
 */
export function shortestPath(
  edges: readonly StarEdge[],
  from: string,
  to: string,
): PathResult | null {
  if (from === to) return { nodes: [from], hops: [] };

  // 邻接表：无向
  const adj = new Map<string, Array<{ next: string; edge: StarEdge }>>();
  const push = (a: string, b: string, edge: StarEdge): void => {
    const list = adj.get(a);
    if (list) list.push({ next: b, edge });
    else adj.set(a, [{ next: b, edge }]);
  };
  for (const e of edges) {
    const [a, b] = e;
    if (!a || !b || a === b) continue;
    push(a, b, e);
    push(b, a, e);
  }

  if (!adj.has(from) || !adj.has(to)) return null;

  /** 记录每个节点是从哪来的，回溯路径用 */
  const cameFrom = new Map<string, { prev: string; edge: StarEdge }>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const { next, edge } of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, { prev: cur, edge });
      queue.push(next);
    }
  }

  if (!seen.has(to)) return null;

  // 回溯
  const nodes: string[] = [to];
  const hops: PathHop[] = [];
  let cur = to;
  while (cur !== from) {
    const step = cameFrom.get(cur);
    if (!step) return null; // 理论上不会发生
    const [a, b, relation, note] = step.edge;
    // 边的方向可能和走的方向相反，展示时按「实际走的方向」给
    hops.unshift(
      a === step.prev
        ? { from: a, to: b, relation, note: note ?? '' }
        : { from: b, to: a, relation, note: note ?? '' },
    );
    nodes.unshift(step.prev);
    cur = step.prev;
  }

  return { nodes, hops };
}

/**
 * 路径的可读描述，如「控制二分法 —继承→ 斯多葛学派 —反对→ 尼采」。
 *
 * 放在 core 而不是视图里，是因为这段文案要被「关系网面板」和
 * 「手机端 toast」两处共用，分开写必然不一致。
 */
export function describePath(
  path: PathResult,
  nameOf: (id: string) => string,
  relationName: Record<EdgeRelation, string>,
): string {
  if (!path.nodes.length) return '';
  const parts: string[] = [nameOf(path.nodes[0]!)];
  path.hops.forEach((h, i) => {
    const target = path.nodes[i + 1];
    parts.push(`—${relationName[h.relation]}→ ${nameOf(target ?? '')}`);
  });
  return parts.join(' ');
}
