/**
 * 暂存条目入库路由的单测。
 *
 * 验证「一次确认，四处落库」：勾选的条目按模块分发到各自的 store，
 * 计数对得上，被去重挡下的记进 skipped，坏形状进不了任何库。
 */

import { describe, expect, it } from 'vitest';
import { commitStaged, type CommitTargets } from './commit';
import {
  DebateTopicStore,
  GewuTopicStore,
  IngestStageStore,
  MethodLibraryStore,
} from './stores';
import { StarGraphStore } from '../star/custom';
import { KeyValueStore, MemoryStorage } from '../storage';
import { STAR_NODES, STAR_EDGES } from '../data/star-map';
import type { MethodEntry, StagedItem } from '../types';

function targets(): CommitTargets {
  const kv = new KeyValueStore(new MemoryStorage());
  return {
    methods: new MethodLibraryStore(kv),
    star: new StarGraphStore(kv),
    topics: new GewuTopicStore(kv),
    debates: new DebateTopicStore(kv),
  };
}

function stagedMethod(id = 'm_a', name = '否定之法'): StagedItem {
  const entry: MethodEntry = {
    id,
    name,
    cat: '思维工具',
    one: '先弄清不是什么',
    sop: ['列出候选'],
    misuse: '别只破不立',
    src: '《测试文献》',
    lit: [],
    docs: [],
  };
  return { id, module: 'method', name, entry };
}

function stagedConcept(id: string, name: string): StagedItem {
  return {
    id,
    module: 'concept',
    name,
    node: { id, name, kind: 'concept', school: '文献', brief: '自由在否定中显现', src: '《测试文献》', doc: null },
  };
}

function stagedRelation(from: string, to: string): StagedItem {
  return { id: `${from}>${to}`, module: 'relation', name: '关系', edge: [from, to, 'refines', '经由否定'] };
}

function stagedTopic(id = 't_a'): StagedItem {
  return {
    id,
    module: 'topic',
    name: '今晚的否定',
    topic: {
      id,
      title: '今晚的否定',
      question: '今天哪件事是靠"说不"守住的？',
      why: '否定是练习',
      src: '《测试文献》',
      script: [{ t: '第一步', end: true }],
    },
  };
}

function stagedDebate(id = 'b_a'): StagedItem {
  return {
    id,
    module: 'debate',
    name: '自由是否定吗',
    debate: {
      id,
      title: '自由是否定吗',
      question: '肯定算什么？',
      phil: '苏格拉底',
      philId: '',
      src: '《测试文献》',
    },
  };
}

const BUILTIN = { nodes: STAR_NODES, edges: STAR_EDGES };

describe('commitStaged', () => {
  it('横跨四模块的条目一次入库，计数对得上', () => {
    const t = targets();
    const items: StagedItem[] = [
      stagedConcept('u_a', '否定的自由'),
      stagedConcept('u_b', '绝对精神'),
      stagedRelation('u_a', 'u_b'),
      stagedMethod(),
      stagedTopic(),
      stagedDebate(),
    ];
    const r = commitStaged(items, t, BUILTIN);
    expect(r.methods).toBe(1);
    expect(r.concepts).toBe(2);
    expect(r.relations).toBe(1);
    expect(r.topics).toBe(1);
    expect(r.debates).toBe(1);
    expect(r.skipped).toBe(0);

    expect(t.methods.load()).toHaveLength(1);
    expect(t.star.load().nodes.map((n) => n.id)).toEqual(['u_a', 'u_b']);
    expect(t.star.load().edges).toHaveLength(1);
    expect(t.topics.load()).toHaveLength(1);
    expect(t.debates.load()).toHaveLength(1);
  });

  it('论题入库时解析哲人 id', () => {
    const t = targets();
    commitStaged([stagedDebate()], t, BUILTIN);
    expect(t.debates.load()[0]!.philId).toBe('socrates');
  });

  it('重复提交同一批：第二次全被去重，skipped 记总数', () => {
    const t = targets();
    const items: StagedItem[] = [stagedMethod(), stagedTopic(), stagedDebate()];
    const first = commitStaged(items, t, BUILTIN);
    expect(first.skipped).toBe(0);
    const second = commitStaged(items, t, BUILTIN);
    expect(second.methods).toBe(0);
    expect(second.topics).toBe(0);
    expect(second.debates).toBe(0);
    expect(second.skipped).toBe(3);
    expect(t.methods.load()).toHaveLength(1);
  });

  it('与内置星图同名的概念被挡下，warning 说明原因', () => {
    const t = targets();
    const r = commitStaged([stagedConcept('u_new', '控制二分法')], t, BUILTIN);
    expect(r.concepts).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.warnings.join()).toContain('已在星图里');
    expect(t.star.load().nodes).toHaveLength(0);
  });

  it('端点指向被挡下概念的关系，同批被弃（不写悬空边）', () => {
    const t = targets();
    // 概念与内置「控制二分法」同名会被去重；关系端点指向这个被挡下的新 id
    const r = commitStaged(
      [stagedConcept('u_dup', '控制二分法'), stagedRelation('u_dup', 'dichotomy')],
      t,
      BUILTIN,
    );
    expect(r.concepts).toBe(0);
    expect(r.relations).toBe(0);
    expect(t.star.load().edges).toHaveLength(0);
  });

  it('空输入返回零报告，不碰任何 store', () => {
    const t = targets();
    const r = commitStaged([], t, BUILTIN);
    expect(r).toEqual({ methods: 0, concepts: 0, relations: 0, topics: 0, debates: 0, skipped: 0, warnings: [] });
  });

  it('只勾了概念的批次也能单独入库', () => {
    const t = targets();
    const r = commitStaged([stagedConcept('u_solo', '孤独的概念')], t, BUILTIN);
    expect(r.concepts).toBe(1);
    expect(r.relations).toBe(0);
  });

  it('入库后暂存区可以整体清空（视图确认后的收尾）', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const t: CommitTargets = {
      methods: new MethodLibraryStore(kv),
      star: new StarGraphStore(kv),
      topics: new GewuTopicStore(kv),
      debates: new DebateTopicStore(kv),
    };
    const stage = new IngestStageStore(kv);
    stage.add([stagedMethod(), stagedTopic()]);
    expect(stage.load()).toHaveLength(2);
    commitStaged(stage.load(), t, BUILTIN);
    stage.clear();
    expect(stage.load()).toHaveLength(0);
    expect(t.methods.load()).toHaveLength(1);
    expect(t.topics.load()).toHaveLength(1);
  });
});
