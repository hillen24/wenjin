/**
 * 星图共建的校验漏斗与存储。
 *
 * 这些是「模型输出直接入库」路上的闸门——闸门漏了，
 * 坏数据就会进用户的星图跟着升级走一辈子，所以测得比较密。
 */

import { describe, expect, it } from 'vitest';
import { StarGraphStore, buildAiPrompt, nameToId, parseAiGraph, validateIncoming } from './custom';
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
    const r = s1.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, STAR_NODES);
    expect(r.ok).toBe(true);

    const s2 = new StarGraphStore(kv);
    expect(s2.load().nodes).toHaveLength(1);
  });

  it('合并视图：内置在前、自定义在后', () => {
    const s = store();
    s.add({ nodes: [{ ...GOOD_NODE, id: 'ship_t' }], edges: [] }, STAR_NODES);
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
      STAR_NODES,
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
    s.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, STAR_NODES);
    s.add({ nodes: [{ ...GOOD_NODE }], edges: [] }, STAR_NODES);
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
});
