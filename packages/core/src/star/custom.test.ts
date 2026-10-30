/**
 * 星图共建的校验漏斗与存储。
 *
 * 这些是「模型输出直接入库」路上的闸门——闸门漏了，
 * 坏数据就会进用户的星图跟着升级走一辈子，所以测得比较密。
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_NODES_PER_BATCH,
  NO_BRIEF,
  PROMPT_NODE_LIMIT,
  StarGraphStore,
  buildAiPrompt,
  edgeKey,
  nameToId,
  parseAiGraph,
  validateIncoming,
} from './custom';
import { KeyValueStore, MemoryStorage, STORAGE_KEYS } from '../storage';
import { STAR_NODES } from '../data/star-map';
import type { StarNode } from '../types';

const BUILTIN_IDS = new Set(STAR_NODES.map((n) => n.id));

function store(): StarGraphStore {
  return new StarGraphStore(new KeyValueStore(new MemoryStorage()));
}

const GOOD_NODE: Partial<StarNode> = {
  name: '忒修斯之船',
  kind: 'concept',
  school: '形而上学',
  brief: '换掉全部零件的船还是原来那条船吗？',
  src: '普鲁塔克《平行传记》',
};

describe('nameToId', () => {
  it('同名得到同一个 id（天然去重）', () => {
    const a = nameToId('忒修斯之船', new Set());
    const b = nameToId('忒修斯之船', new Set());
    expect(a).toBe(b);
    expect(a).toMatch(/^u_[a-z0-9_]+$/);
  });

  it('哈希撞车时追加序号避让', () => {
    const first = nameToId('A', new Set());
    const second = nameToId('B', new Set([first]));
    expect(second).not.toBe(first);
  });
});

describe('validateIncoming', () => {
  it('合法片段原样通过并补齐默认值', () => {
    const r = validateIncoming({ nodes: [{ name: 'X' }], edges: [] }, BUILTIN_IDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes[0]!.kind).toBe('concept');
    expect(r.nodes[0]!.school.length).toBeGreaterThan(0);
  });

  it('模型给的非法 id 会被重新生成而不是直接采纳', () => {
    const r = validateIncoming(
      { nodes: [{ ...GOOD_NODE, id: '不合法 ID!' }], edges: [] },
      BUILTIN_IDS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes[0]!.id).toMatch(/^u_/);
  });

  it('id 与内置节点冲突时换新 id', () => {
    const r = validateIncoming(
      { nodes: [{ ...GOOD_NODE, id: 'stoic' }], edges: [] },
      BUILTIN_IDS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes[0]!.id).not.toBe('stoic');
  });

  it('端点未知的边被跳过并给出警告', () => {
    const r = validateIncoming(
      { nodes: [{ ...GOOD_NODE }], edges: [{ from: 'nope', to: 'stoic', rel: 'refines' }] },
      BUILTIN_IDS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edges).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('新边允许指向本批新节点', () => {
    const r = validateIncoming(
      {
        nodes: [
          { ...GOOD_NODE, id: 'ship_a' },
          { name: '同一性', id: 'identity_a', brief: 'x 在什么意义上还是 x' },
        ],
        edges: [{ from: 'ship_a', to: 'identity_a', rel: 'refines', label: '同一性案例' }],
      },
      BUILTIN_IDS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edges).toHaveLength(1);
    expect(r.warnings).toHaveLength(0);
  });

  it('自环边被跳过', () => {
    const r = validateIncoming(
      { nodes: [{ ...GOOD_NODE, id: 'ship_x' }], edges: [{ from: 'ship_x', to: 'ship_x', rel: 'refines' }] },
      BUILTIN_IDS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edges).toHaveLength(0);
  });

  it('空节点集直接拒绝', () => {
    const r = validateIncoming({ nodes: [], edges: [] }, BUILTIN_IDS);
    expect(r.ok).toBe(false);
  });
});

describe('parseAiGraph', () => {
  it('解析裸 JSON', () => {
    const r = parseAiGraph(
      JSON.stringify({ nodes: [{ ...GOOD_NODE }], edges: [] }),
      BUILTIN_IDS,
    );
    expect(r.ok).toBe(true);
  });

  it('容忍 markdown 代码块与前后废话', () => {
    const text = `好的，这是结果：\n\`\`\`json\n${JSON.stringify({ nodes: [{ ...GOOD_NODE }], edges: [] })}\n\`\`\`\n如需调整请告诉我。`;
    const r = parseAiGraph(text, BUILTIN_IDS);
    expect(r.ok).toBe(true);
  });

  it('非 JSON 输出给出人话原因', () => {
    expect(parseAiGraph('抱歉我不知道', BUILTIN_IDS)).toMatchObject({ ok: false });
    expect(parseAiGraph('{"nodes": "不是数组"}', BUILTIN_IDS)).toMatchObject({ ok: false });
  });
});

describe('StarGraphStore', () => {
  it('入库 → 重开实例仍能读到（localStorage 持久化）', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const s1 = new StarGraphStore(kv);
    const r = s1.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, { nodes: STAR_NODES });
    expect(r.ok).toBe(true);

    const s2 = new StarGraphStore(kv);
    expect(s2.load().nodes).toHaveLength(1);
  });

  it('合并视图：内置在前、自定义在后', () => {
    const s = store();
    s.add({ nodes: [{ ...GOOD_NODE, id: 'ship_t' }], edges: [] }, { nodes: STAR_NODES });
    const m = s.merged(STAR_NODES, []);
    expect(m.nodes[0]!.id).toBe(STAR_NODES[0]!.id);
    expect(m.nodes.at(-1)!.id).toBe('ship_t');
  });

  it('删除节点连带删除其连边', () => {
    const s = store();
    s.add(
      {
        nodes: [
          { ...GOOD_NODE, id: 'ship_t' },
          { name: '同一性', id: 'ident_t', brief: 'x 还是 x 吗' },
        ],
        edges: [{ from: 'ship_t', to: 'ident_t', rel: 'refines', label: '' }],
      },
      { nodes: STAR_NODES },
    );
    const g = s.removeNode('ship_t');
    expect(g.nodes.map((n) => n.id)).toEqual(['ident_t']);
    expect(g.edges).toHaveLength(0);
  });

  it('存储层坏数据被清洗而不崩溃', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeJSON(STORAGE_KEYS.customGraph, { nodes: [{ garbage: true }], edges: 'oops' });
    const s = new StarGraphStore(kv);
    expect(s.load().nodes).toHaveLength(0);
    expect(s.load().edges).toHaveLength(0);
  });

  it('同一内容入库两次不产生重复节点', () => {
    const s = store();
    s.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, { nodes: STAR_NODES });
    s.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, { nodes: STAR_NODES });
    expect(s.load().nodes).toHaveLength(1);
  });
});

describe('buildAiPrompt', () => {
  it('包含既有节点清单与 JSON 规则', () => {
    const p = buildAiPrompt([{ id: 'stoic', name: '斯多葛学派', kind: 'school' }]);
    expect(p).toContain('stoic(斯多葛学派,school)');
    expect(p).toContain('proposes');
    expect(p).toContain('JSON');
  });

  it('节点清单超长时截断，不让 prompt 吃掉整个上下文', () => {
    const many = Array.from({ length: PROMPT_NODE_LIMIT + 40 }, (_, i) => ({
      id: `n${i}`,
      name: `节点${i}`,
      kind: 'concept' as const,
    }));
    const p = buildAiPrompt(many);
    expect(p).toContain(`仅列出前 ${PROMPT_NODE_LIMIT} 个`);
    expect(p).not.toContain(`n${PROMPT_NODE_LIMIT + 39}(`);
  });
});

/* ============================================================
 * 3.5.1 修掉的几个坑，逐条钉住
 * ============================================================ */

describe('连边去重', () => {
  it('同一对节点之间不重复连线（否则画布上叠双线）', () => {
    const r = validateIncoming(
      {
        nodes: [{ ...GOOD_NODE, id: 'ship_d' }],
        edges: [
          { from: 'ship_d', to: 'stoic', rel: 'refines', label: 'a' },
          { from: 'stoic', to: 'ship_d', rel: 'opposes', label: 'b' },
        ],
      },
      BUILTIN_IDS,
      new Set(),
      { existingEdges: [] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 两条互为反向、指向同一对节点：第二条该被拦
    expect(r.edges).toHaveLength(1);
  });

  it('已存在的边不再建第二次', () => {
    const r = validateIncoming(
      { nodes: [{ ...GOOD_NODE, id: 'ship_e' }], edges: [{ from: 'ship_e', to: 'stoic', rel: 'refines' }] },
      BUILTIN_IDS,
      new Set(),
      { existingEdges: [['ship_e', 'stoic', 'opposes', '']] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edges).toHaveLength(0);
    expect(r.warnings.join()).toContain('已经有关系');
  });
});

describe('边端点的名字兜底', () => {
  it('模型拿中文名当端点时也能接上，而不是整条边被丢', () => {
    const r = validateIncoming(
      { nodes: [GOOD_NODE], edges: [{ from: '忒修斯之船', to: 'stoic', rel: 'refines' }] },
      BUILTIN_IDS,
      new Set(),
      { existingEdges: [], alias: new Map([['stoic', 'stoic']]) },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]![0]).toBe(r.nodes[0]!.id);
  });
});

describe('批量与容量', () => {
  it('单批节点数被截断（模型抽风也不会一次塞 200 个）', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({ name: `概念${i}` }));
    const r = validateIncoming({ nodes, edges: [] }, BUILTIN_IDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes).toHaveLength(MAX_NODES_PER_BATCH);
  });

  it('容量上限只数用户自己加的，内置节点再多也不误报', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const s = new StarGraphStore(kv);
    // 内置节点本身就有几十个，旧版把它算进限额会直接拒绝入库
    const r = s.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, { nodes: STAR_NODES });
    expect(r.ok).toBe(true);
  });

  it('清空我的星区', () => {
    const s = store();
    s.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, { nodes: STAR_NODES });
    expect(s.clear().nodes).toHaveLength(0);
    expect(s.load().nodes).toHaveLength(0);
  });
});

describe('释义兜底', () => {
  it('没给 brief 时不会把名字当释义印第二遍', () => {
    const r = validateIncoming({ nodes: [{ name: '无名概念' }], edges: [] }, BUILTIN_IDS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nodes[0]!.brief).toBe(NO_BRIEF);
    expect(r.nodes[0]!.brief).not.toBe('无名概念');
  });
});

/* ============================================================
 * 边的治理：否决 / 待定池 / 翻案
 *
 * ===== 这组测试在守什么 =====
 * 「自生长」有两个方向：AI 和用户都能往图上长边。但必须留一个「审」的环节。
 * 直接删掉否决的边，会丢两样东西：AI 当时为什么这么判断（信息），
 * 以及日后翻案的可能（读深了可能发现那条边其实对）。
 *
 * 所以否决 = 移进待定池，不是删除。这组测试钉住这个语义。
 * ============================================================ */
describe('边的否决与待定池', () => {
  it('否决一条边：从生效集合移进待定池，图上看不见了', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'refines', label: '修正' }],
      },
      { nodes: STAR_NODES },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;

    const after = s.rejectEdge(edge);
    expect(after.edges.find((e) => edgeKey(e) === edgeKey(edge))).toBeUndefined();
    expect(after.pending).toHaveLength(1);
    // 节点还在 —— 否决的是关系，不是概念
    expect(after.nodes).toHaveLength(2);

    // merged 只返回生效边，待定边不进图
    const m = s.merged(STAR_NODES, []);
    expect(m.edges.some((e) => edgeKey(e) === edgeKey(edge))).toBe(false);
  });

  it('否决不删除：待定池里还留着原样（含说明文字）', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'opposes', label: '甲反对乙' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;

    s.rejectEdge(edge);
    const p = s.load().pending[0]!;

    expect(p[0]).toBe(edge[0]);
    expect(p[1]).toBe(edge[1]);
    expect(p[2]).toBe('opposes');
    expect(p[3]).toBe('甲反对乙');
  });

  it('翻案：从待定池放回生效集合', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'inherits' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;

    s.rejectEdge(edge);
    const back = s.restoreEdge(edge);

    expect(back.ok).toBe(true);
    expect(back.graph.edges).toHaveLength(1);
    expect(back.graph.pending).toHaveLength(0);
  });

  it('端点被删掉后不能翻案（避免放回一条悬空边）', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'inherits' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;
    s.rejectEdge(edge);
    s.removeNode(edge[0]);

    const back = s.restoreEdge(edge);
    expect(back.ok).toBe(false);
    // 拒绝时不能把池子搞脏
    expect(s.load().pending).toHaveLength(0);
  });

  it('删节点时连带清掉池子里指向它的边（不留点了没反应的死记录）', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'inherits' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;
    s.rejectEdge(edge);

    const after = s.removeNode(edge[1]);
    expect(after.pending).toHaveLength(0);
  });

  it('永久删除待定边', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'inherits' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;
    s.rejectEdge(edge);

    const after = s.dropRejected(edge);
    expect(after.pending).toHaveLength(0);
    expect(after.edges).toHaveLength(0);
  });

  it('重复否决同一条边不会在池子里留下两份', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'inherits' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    const edge = r.graph.edges[0]!;

    s.rejectEdge(edge);
    s.rejectEdge(edge);
    s.rejectEdge(edge);

    expect(s.load().pending).toHaveLength(1);
  });

  it('同一对节点可以有两条不同类型的关系（哲学图谱的常态）', () => {
    // 用 edgeKey 而不是「无序对」区分：康德既反对休谟的因果论，又继承了他的问题意识
    const e1: readonly [string, string, 'opposes', string] = ['a', 'b', 'opposes', ''];
    const e2: readonly [string, string, 'inherits', string] = ['a', 'b', 'inherits', ''];
    expect(edgeKey(e1)).not.toBe(edgeKey(e2));
  });

  it('旧数据没有 pending 字段也能读（不需要写迁移）', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      STORAGE_KEYS.customGraph,
      JSON.stringify({
        nodes: [{ id: 'u_x', name: '旧节点', kind: 'concept', school: '我的星区', brief: 'b', src: 's', doc: null }],
        edges: [],
      }),
    );
    const s = new StarGraphStore(new KeyValueStore(storage));
    expect(s.load().pending).toEqual([]);
    expect(s.load().nodes).toHaveLength(1);
  });

  it('待定边不会因为同时在生效集合里而重复出现', () => {
    // 手工造一份脏数据：同一条边既在 edges 又在 pending
    const storage = new MemoryStorage();
    storage.setItem(
      STORAGE_KEYS.customGraph,
      JSON.stringify({
        nodes: [
          { id: 'u_a', name: 'A', kind: 'concept', school: 'S', brief: 'b', src: 's', doc: null },
          { id: 'u_b', name: 'B', kind: 'concept', school: 'S', brief: 'b', src: 's', doc: null },
        ],
        edges: [['u_a', 'u_b', 'inherits', 'x']],
        pending: [['u_a', 'u_b', 'inherits', 'x']],
      }),
    );
    const s = new StarGraphStore(new KeyValueStore(storage));
    expect(s.load().edges).toHaveLength(1);
    expect(s.load().pending).toHaveLength(0);
  });

  it('清空我的星区时池子一起清', () => {
    const s = store();
    const r = s.add(
      {
        nodes: [{ name: '甲' }, { name: '乙' }],
        edges: [{ from: '甲', to: '乙', rel: 'inherits' }],
      },
      { nodes: STAR_NODES },
    );
    if (!r.ok) return;
    s.rejectEdge(r.graph.edges[0]!);

    const after = s.clear();
    expect(after.nodes).toHaveLength(0);
    expect(after.edges).toHaveLength(0);
    expect(after.pending).toHaveLength(0);
  });
});
