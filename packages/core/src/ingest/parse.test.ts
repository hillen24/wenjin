/**
 * 文献提取质检漏斗的单测。
 *
 * 这是「模型输出直接进暂存区」路上的闸门。模型的不听话方式这里都模拟一遍：
 * 包代码块、前后加说明、栏目缺失、端点写中文名、整段幻觉。
 * 闸门漏了，脏数据就会顺着暂存区进用户的四个模块。
 */

import { describe, expect, it } from 'vitest';
import { parseExtractReply, topicToScript, type ParseContext } from './parse';
import { STAR_NODES } from '../data/star-map';
import type { GewuTopic } from '../types';

const NAME_TO_ID = new Map(STAR_NODES.map((n) => [n.name, n.id]));
const EXISTING_IDS = new Set(STAR_NODES.map((n) => n.id));

function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return {
    modules: ['method', 'concept', 'topic', 'debate'],
    takenNames: new Set<string>(),
    existingIds: EXISTING_IDS,
    nodeNameToId: NAME_TO_ID,
    source: '《测试文献》',
    ...over,
  };
}

const FULL_PAYLOAD = JSON.stringify({
  methods: [
    { name: '否定之法', cat: '思维工具', one: '先弄清不是什么', sop: ['列出候选', '逐个排除'], misuse: '别只破不立' },
  ],
  concepts: [
    { name: '否定的自由', kind: 'concept', school: '德国古典', brief: '自由在否定中显现' },
    { name: '绝对精神', kind: 'concept', school: '德国古典', brief: '黑格尔的核心概念' },
  ],
  relations: [
    { from: '否定的自由', to: '绝对精神', rel: 'refines', label: '经由否定达成' },
  ],
  topics: [
    { title: '今晚的否定', question: '今天哪件事是你靠"说不"守住的？', why: '否定是自由的练习' },
  ],
  debates: [
    { title: '自由是否定吗', question: '如果自由只是否定，肯定算什么？', phil: '黑格尔' },
  ],
});

describe('parseExtractReply 基本路径', () => {
  it('合法 JSON 全量解析成五种暂存条目', () => {
    const r = parseExtractReply(FULL_PAYLOAD, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mods = r.items.map((i) => i.module);
    expect(mods).toContain('method');
    expect(mods).toContain('concept');
    expect(mods).toContain('relation');
    expect(mods).toContain('topic');
    expect(mods).toContain('debate');
    expect(r.warnings).toEqual([]);
  });

  it('模型包 ```json 代码块、前后加说明，照样拆得出来', () => {
    const messy = `好的，我来分析这段文献。\n\`\`\`json\n${FULL_PAYLOAD}\n\`\`\`\n以上是分析结果。`;
    const r = parseExtractReply(messy, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.length).toBeGreaterThan(0);
  });

  it('没有 JSON 返回 ok:false（运行器按失败重试）', () => {
    const r = parseExtractReply('这段文献主要讲了黑格尔的辩证法……', ctx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('JSON');
  });

  it('JSON 语法坏返回 ok:false', () => {
    const r = parseExtractReply('{"methods": [缺引号]}', ctx());
    expect(r.ok).toBe(false);
  });

  it('不抛异常：乱输入也稳稳返回', () => {
    expect(() => parseExtractReply('}{', ctx())).not.toThrow();
    expect(() => parseExtractReply('{}', ctx())).not.toThrow();
    expect(() => parseExtractReply('null', ctx())).not.toThrow();
  });
});

describe('模块勾选', () => {
  it('没勾的模块连提都不提（防模型编空数组）', () => {
    const r = parseExtractReply(FULL_PAYLOAD, ctx({ modules: ['concept'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.every((i) => i.module === 'concept' || i.module === 'relation')).toBe(true);
  });

  it('只勾方法时关系栏目被忽略', () => {
    const r = parseExtractReply(FULL_PAYLOAD, ctx({ modules: ['method'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.module).toBe('method');
  });
});

describe('去重', () => {
  it('同名概念第二次出现被跳过', () => {
    const payload = JSON.stringify({
      concepts: [{ name: '否定的自由', kind: 'concept', brief: '自由在否定中显现' }],
    });
    const r = parseExtractReply(payload, ctx({ takenNames: new Set(['否定的自由']) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join()).toContain('已存在');
  });

  it('同一批里两个同名概念只收第一个', () => {
    const payload = JSON.stringify({
      concepts: [
        { name: '甲', kind: 'concept', brief: '第一个' },
        { name: '甲', kind: 'concept', brief: '第二个' },
      ],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(1);
    expect((r.items[0] as { node: { brief: string } }).node.brief).toBe('第一个');
  });

  it('内置星图里已有的概念名不再新建（模型重提炼）', () => {
    const payload = JSON.stringify({
      concepts: [{ name: '控制二分法', kind: 'concept', brief: '爱比克泰德的二分法' }],
    });
    const r = parseExtractReply(payload, ctx({ takenNames: new Set(['控制二分法']) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(0);
  });
});

describe('关系端点解析', () => {
  it('端点写中文名：先查本批概念，再查既有星图', () => {
    const payload = JSON.stringify({
      concepts: [{ name: '否定的自由', kind: 'concept', brief: '自由在否定中显现' }],
      relations: [
        { from: '否定的自由', to: '控制二分法', rel: 'opposes', label: '张力' },
      ],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rel = r.items.find((i) => i.module === 'relation');
    expect(rel).toBeDefined();
    const edge = (rel as { edge: readonly [string, string, string, string] }).edge;
    expect(edge[0]).toMatch(/^u_/); // 本批新概念的哈希 id
    expect(edge[1]).toBe('dichotomy'); // 既有节点按名字解析回内置 id
  });

  it('端点两边都查不到 → 跳过并记 warning', () => {
    const payload = JSON.stringify({
      concepts: [{ name: '否定的自由', kind: 'concept', brief: '自由在否定中显现' }],
      relations: [{ from: '否定的自由', to: '不存在的概念', rel: 'refines', label: '？' }],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.some((i) => i.module === 'relation')).toBe(false);
    expect(r.warnings.join()).toContain('端点未知');
  });

  it('自己连自己的关系被拦下', () => {
    const payload = JSON.stringify({
      concepts: [{ name: '否定的自由', kind: 'concept', brief: '自由在否定中显现' }],
      relations: [{ from: '否定的自由', to: '否定的自由', rel: 'refines', label: '自指' }],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.some((i) => i.module === 'relation')).toBe(false);
    expect(r.warnings.join()).toContain('自己连自己');
  });

  it('rel 不认识按「修正」兜底', () => {
    const payload = JSON.stringify({
      concepts: [
        { name: '甲', kind: 'concept', brief: '甲' },
        { name: '乙', kind: 'concept', brief: '乙' },
      ],
      relations: [{ from: '甲', to: '乙', rel: '天生一对', label: '？' }],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rel = r.items.find((i) => i.module === 'relation') as { edge: readonly [string, string, string, string] };
    expect(rel.edge[2]).toBe('refines');
    expect(r.warnings.join()).toContain('不认识');
  });
});

describe('方法论条目', () => {
  it('缺一句话说明或 sop 的跳过', () => {
    const payload = JSON.stringify({
      methods: [
        { name: '没步骤的', cat: '思维工具', one: '只有一句话' },
        { name: '没说明的', cat: '思维工具', sop: ['第一步'] },
      ],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(0);
    expect(r.warnings.length).toBe(2);
  });

  it('cat 不在白名单按「思维工具」兜底', () => {
    const payload = JSON.stringify({
      methods: [{ name: '野路子', cat: '玄学', one: '一句话', sop: ['第一步'] }],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.items[0] as { entry: { cat: string } };
    expect(m.entry.cat).toBe('思维工具');
  });

  it('缺 misuse 补「暂无提醒」，src 用文献出处', () => {
    const payload = JSON.stringify({
      methods: [{ name: '否定之法', cat: '思维工具', one: '先弄清不是什么', sop: ['列候选', '逐个排除'] }],
    });
    const r = parseExtractReply(payload, ctx({ source: '《精神现象学》' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.items[0] as { entry: { misuse: string; src: string } };
    expect(m.entry.misuse).toBe('暂无提醒');
    expect(m.entry.src).toBe('《精神现象学》');
  });
});

describe('格物题与论题', () => {
  it('格物题缺问题被跳过', () => {
    const payload = JSON.stringify({ topics: [{ title: '只有标题' }] });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(0);
    expect(r.warnings.join()).toContain('格物题');
  });

  it('格物题自带三步剧本', () => {
    const payload = JSON.stringify({
      topics: [{ title: '今晚的否定', question: '今天哪件事是靠"说不"守住的？', why: '否定是练习' }],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.items[0] as { topic: GewuTopic };
    expect(t.topic.script).toHaveLength(3);
  });

  it('论题的 philId 留空（人名解析是 store 层的事）', () => {
    const payload = JSON.stringify({
      debates: [{ title: '自由是否定吗', question: '肯定算什么？', phil: '黑格尔' }],
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.items[0] as { debate: { phil: string; philId: string } };
    expect(d.debate.phil).toBe('黑格尔');
    expect(d.debate.philId).toBe('');
  });
});

describe('产量上限', () => {
  it('单段概念超过 5 个截断并 warning', () => {
    const payload = JSON.stringify({
      concepts: Array.from({ length: 8 }, (_, i) => ({
        name: `概念${i}`,
        kind: 'concept',
        brief: `释义${i}`,
      })),
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(5);
    expect(r.warnings.join()).toContain('最多 5');
  });

  it('单段方法超过 3 条截断', () => {
    const payload = JSON.stringify({
      methods: Array.from({ length: 5 }, (_, i) => ({
        name: `方法${i}`,
        cat: '思维工具',
        one: '一句话',
        sop: ['第一步'],
      })),
    });
    const r = parseExtractReply(payload, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(3);
  });
});

describe('topicToScript', () => {
  it('生成的三步剧本最后一步是收尾', () => {
    const s = topicToScript('今晚的否定', '今天守住了什么？', '否定是练习');
    expect(s).toHaveLength(3);
    expect(s[2]!.end).toBe(true);
    expect(s[0]!.t).toContain('今晚的否定');
  });

  it('没有 why 时第二步换问法，不出现 undefined', () => {
    const s = topicToScript('题', '问？', '');
    expect(s[1]!.t).not.toContain('undefined');
  });
});
