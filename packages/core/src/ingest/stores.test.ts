/**
 * 文献 Agent 四个 store 的单测。
 *
 * store 是数据进库前的最后一道闸：磁盘上的东西可能来自旧版、
 * 可能被手改坏、可能被局域网同步带错。每条用例都在验证
 * 「可疑数据进不来，重复数据进不来，超容量的进不来」。
 */

import { describe, expect, it } from 'vitest';
import {
  DebateTopicStore,
  IngestStageStore,
  MAX_CUSTOM_DEBATES,
  MAX_CUSTOM_METHODS,
  MAX_CUSTOM_TOPICS,
  MAX_STAGED_ITEMS,
  MethodLibraryStore,
  GewuTopicStore,
  resolvePhilId,
} from './stores';
import { KeyValueStore, MemoryStorage, STORAGE_KEYS } from '../storage';
import type { DebateTopic, GewuTopic, MethodEntry, StagedItem } from '../types';

function methodEntry(over: Partial<MethodEntry> = {}): MethodEntry {
  return {
    id: 'm_test1',
    name: '否定之法',
    cat: '思维工具',
    one: '先弄清不是什么',
    sop: ['列出候选', '逐个排除'],
    misuse: '别只破不立',
    src: '《测试文献》',
    lit: [],
    docs: [],
    ...over,
  };
}

function topic(over: Partial<GewuTopic> = {}): GewuTopic {
  return {
    id: 't_test1',
    title: '今晚的否定',
    question: '今天哪件事是靠"说不"守住的？',
    why: '否定是练习',
    src: '《测试文献》',
    script: [{ t: '第一步', opts: ['a'] }, { t: '第二步', end: true }],
    ...over,
  };
}

function debate(over: Partial<DebateTopic> = {}): DebateTopic {
  return {
    id: 'b_test1',
    title: '自由是否定吗',
    question: '肯定算什么？',
    phil: '黑格尔',
    philId: '',
    src: '《测试文献》',
    ...over,
  };
}

function stagedMethod(id = 'm_test1'): StagedItem {
  return { id, module: 'method', name: '否定之法', entry: methodEntry({ id }) };
}

function stagedConcept(name = '否定的自由'): StagedItem {
  return {
    id: `u_${name}`,
    module: 'concept',
    name,
    node: {
      id: `u_${name}`,
      name,
      kind: 'concept',
      school: '文献',
      brief: '自由在否定中显现',
      src: '《测试文献》',
      doc: null,
    },
  };
}

function stagedTopic(): StagedItem {
  return { id: 't_test1', module: 'topic', name: '今晚的否定', topic: topic() };
}

/* ============================================================
 * 方法论库
 * ============================================================ */

describe('MethodLibraryStore', () => {
  function store(): MethodLibraryStore {
    return new MethodLibraryStore(new KeyValueStore(new MemoryStorage()));
  }

  it('入库后读得回来，写入落到了正确的键上', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const s = new MethodLibraryStore(kv);
    const r = s.add([methodEntry()]);
    expect(r.ok).toBe(true);
    expect(s.load()).toHaveLength(1);
    expect(kv.readJSON<unknown[]>(STORAGE_KEYS.customMethods, [])).toHaveLength(1);
  });

  it('同名条目第二次入库被挡下（换个 id 也不算新）', () => {
    const s = store();
    s.add([methodEntry()]);
    const r = s.add([methodEntry({ id: 'm_other' })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('已在');
    expect(s.load()).toHaveLength(1);
  });

  it('字段不全的条目被跳过', () => {
    const s = store();
    const bad = { ...methodEntry(), sop: [] } as MethodEntry;
    const r = s.add([bad]);
    expect(r.ok).toBe(false);
    expect(s.load()).toHaveLength(0);
  });

  it('超过容量上限整体拒绝后面的', () => {
    const s = store();
    const many = Array.from({ length: MAX_CUSTOM_METHODS + 5 }, (_, i) =>
      methodEntry({ id: `m_${i}`, name: `方法${i}` }),
    );
    const r = s.add(many);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(MAX_CUSTOM_METHODS);
    expect(r.warnings.join()).toContain('上限');
  });

  it('remove 只删指定条目', () => {
    const s = store();
    s.add([methodEntry(), methodEntry({ id: 'm_test2', name: '另一条' })]);
    s.remove('m_test1');
    expect(s.load().map((e) => e.id)).toEqual(['m_test2']);
  });

  it('磁盘上的坏数据整体弃用，不带病渲染', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeJSON(STORAGE_KEYS.customMethods, [{ id: 42, name: null }, '垃圾', methodEntry()]);
    const s = new MethodLibraryStore(kv);
    expect(s.load()).toHaveLength(1);
    expect(s.load()[0]!.name).toBe('否定之法');
  });

  it('订阅者在新条目入库时收到通知', () => {
    const s = store();
    let seen = 0;
    s.subscribe(() => {
      seen += 1;
    });
    s.add([methodEntry()]);
    expect(seen).toBe(1);
  });

  it('scriptFor 用 SOP 现场拼剧本：文献方法进得了库，也开得了局', () => {
    const s = store();
    s.add([methodEntry({ id: 'm_neg', name: '否定之法', sop: ['列出候选', '逐个排除'] })]);
    const script = s.scriptFor('m_neg');
    expect(script).toBeDefined();
    expect(script!.length).toBeGreaterThan(0);
    // 剧本里带着条目自己的 SOP —— 不是凭空来的通用套话
    expect(script!.some((step) => step.t.includes('列出候选'))).toBe(true);
    // 库里没有的 id 不瞎编
    expect(s.scriptFor('m_nope')).toBeUndefined();
  });
});

/* ============================================================
 * 文献格物题
 * ============================================================ */

describe('GewuTopicStore', () => {
  function store(): GewuTopicStore {
    return new GewuTopicStore(new KeyValueStore(new MemoryStorage()));
  }

  it('入库读回，scriptFor 能拿到剧本', () => {
    const s = store();
    s.add([topic()]);
    expect(s.load()).toHaveLength(1);
    expect(s.scriptFor('t_test1')).toHaveLength(2);
    expect(s.scriptFor('不存在')).toBeUndefined();
  });

  it('同题跳过', () => {
    const s = store();
    s.add([topic()]);
    const r = s.add([topic({ id: 't_other' })]);
    expect(r.ok).toBe(false);
    expect(s.load()).toHaveLength(1);
  });

  it('缺问题的题目进不来', () => {
    const s = store();
    const r = s.add([{ ...topic(), question: '' } as GewuTopic]);
    expect(r.ok).toBe(false);
  });

  it('容量上限', () => {
    const s = store();
    const many = Array.from({ length: MAX_CUSTOM_TOPICS + 3 }, (_, i) =>
      topic({ id: `t_${i}`, title: `题目${i}` }),
    );
    const r = s.add(many);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(MAX_CUSTOM_TOPICS);
  });
});

/* ============================================================
 * 文献论题
 * ============================================================ */

describe('resolvePhilId', () => {
  it('哲人全名精确匹配', () => {
    expect(resolvePhilId('苏格拉底')).toBe('socrates');
    expect(resolvePhilId('尼采')).toBe('nietzsche');
  });

  it('匹配不上留空，由用户自己选', () => {
    expect(resolvePhilId('黑格尔')).toBe('');
    expect(resolvePhilId('')).toBe('');
    expect(resolvePhilId('   ')).toBe('');
  });
});

describe('DebateTopicStore', () => {
  function store(): DebateTopicStore {
    return new DebateTopicStore(new KeyValueStore(new MemoryStorage()));
  }

  it('入库时把哲人名解析成 id', () => {
    const s = store();
    s.add([debate({ phil: '苏格拉底' })]);
    expect(s.load()[0]!.philId).toBe('socrates');
  });

  it('已经有 philId 的不覆盖', () => {
    const s = store();
    s.add([debate({ phil: '苏格拉底', philId: 'kant' })]);
    expect(s.load()[0]!.philId).toBe('kant');
  });

  it('同名论题跳过', () => {
    const s = store();
    s.add([debate()]);
    const r = s.add([debate({ id: 'b_other' })]);
    expect(r.ok).toBe(false);
    expect(s.load()).toHaveLength(1);
  });

  it('容量上限', () => {
    const s = store();
    const many = Array.from({ length: MAX_CUSTOM_DEBATES + 3 }, (_, i) =>
      debate({ id: `b_${i}`, title: `论题${i}` }),
    );
    const r = s.add(many);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(MAX_CUSTOM_DEBATES);
  });
});

/* ============================================================
 * 暂存区
 * ============================================================ */

describe('IngestStageStore', () => {
  function store(): IngestStageStore {
    return new IngestStageStore(new KeyValueStore(new MemoryStorage()));
  }

  it('条目进暂存区，按模块取得出来', () => {
    const s = store();
    const r = s.add([stagedMethod(), stagedConcept(), stagedTopic()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(3);
    expect(s.byModule('method')).toHaveLength(1);
    expect(s.byModule('concept')).toHaveLength(1);
    expect(s.byModule('topic')).toHaveLength(1);
    expect(s.byModule('debate')).toHaveLength(0);
  });

  it('同一段话跑两遍不产生两份（module+id 去重）', () => {
    const s = store();
    s.add([stagedMethod()]);
    const r = s.add([stagedMethod()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(s.load()).toHaveLength(1);
  });

  it('关系的端点概念名进 takenNames，但关系的展示串不进', () => {
    const s = store();
    s.add([
      stagedConcept('否定的自由'),
      {
        id: 'u_a>u_b',
        module: 'relation',
        name: '否定的自由→绝对精神',
        edge: ['u_a', 'u_b', 'refines', '经由否定'],
      } as StagedItem,
    ]);
    const names = s.takenNames();
    expect(names.has('否定的自由')).toBe(true);
    expect(names.has('否定的自由→绝对精神')).toBe(false);
  });

  it('takenIds 收录概念/方法/题目 id，不收关系的复合 id', () => {
    const s = store();
    s.add([
      stagedConcept('否定的自由'),
      stagedMethod(),
      stagedTopic(),
      { id: 'u_a>u_b', module: 'relation', name: 'A→B', edge: ['u_a', 'u_b', 'refines', ''] } as StagedItem,
    ]);
    const ids = s.takenIds();
    expect(ids.has('u_否定的自由')).toBe(true);
    expect(ids.has('m_test1')).toBe(true);
    expect(ids.has('t_test1')).toBe(true);
    expect(ids.has('u_a>u_b')).toBe(false);
  });

  it('conceptNameToId 供后续段的关系端点解析', () => {
    const s = store();
    s.add([stagedConcept('否定的自由')]);
    expect(s.conceptNameToId().get('否定的自由')).toBe('u_否定的自由');
  });

  it('形状可疑的条目被拦在暂存区外', () => {
    const s = store();
    const r = s.add([
      { id: 'x', module: 'method', name: '坏方法', entry: { id: 'x', name: '缺 sop' } } as unknown as StagedItem,
      { id: 'y', module: 'concept', name: '坏概念', node: { id: 'y', name: '没释义' } } as unknown as StagedItem,
      { id: 'z', module: 'relation', name: '坏关系', edge: ['只有一格'] } as unknown as StagedItem,
      null as unknown as StagedItem,
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(0);
    expect(r.skipped).toBe(4);
    expect(s.load()).toHaveLength(0);
  });

  it('超过容量上限停止收录', () => {
    const s = store();
    const many = Array.from({ length: MAX_STAGED_ITEMS + 10 }, (_, i) => stagedMethod(`m_${i}`));
    const r = s.add(many);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toHaveLength(MAX_STAGED_ITEMS);
    expect(s.load()).toHaveLength(MAX_STAGED_ITEMS);
  });

  it('remove / clear', () => {
    const s = store();
    s.add([stagedMethod(), stagedTopic()]);
    s.remove('method', 'm_test1');
    expect(s.load().map((i) => i.module)).toEqual(['topic']);
    s.clear();
    expect(s.load()).toHaveLength(0);
  });

  it('磁盘上的暂存数据坏掉时安全降级', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    kv.writeJSON(STORAGE_KEYS.ingestStage, '不是数组');
    const s = new IngestStageStore(kv);
    expect(s.load()).toEqual([]);
    kv.writeJSON(STORAGE_KEYS.ingestStage, [stagedMethod(), stagedMethod()]);
    s.resetCache();
    expect(s.load()).toHaveLength(1); // 读盘也去重
  });
});
