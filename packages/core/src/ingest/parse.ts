/**
 * 文献提取输出解析：模型自由文本 → 暂存条目
 *
 * 这是整套 Agent 的「质检漏斗」，和星图共建的 validateIncoming 同一个立场：
 * **模型只负责提议，校验器负责否决**。模型经常不听话 ——
 * 包 ```json 代码块、前后加说明、栏目缺失、关系端点写中文名、
 * 甚至整段输出幻觉内容。这里逐条收敛，坏数据进 warnings，好数据才出得去。
 *
 * 三个关键机制：
 * 1. 去重：takenNames（内置 + 已暂存 + 本批已收）三重去重，
 *    同一段话跑两遍、相邻两段提炼同一个概念，都只会留下一份；
 * 2. 端点解析：关系的 from/to 先当本批概念名，再当既有概念名，最后才当 id ——
 *    模型拿中文名当端点是最常见的毛病，查得到就别丢；
 * 3. 兜底默认值：缺 school 补「文献」、缺 rel 按「修正」、缺 misuse 补「暂无提醒」——
 *    但 name/brief/one/question 这类内容字段宁缺毋滥，缺了就跳过并记 warning。
 */

import type {
  ConceptDraft,
  DebateTopic,
  EdgeRelation,
  ExtractPayload,
  GewuTopic,
  IngestModule,
  MethodCategory,
  MethodEntry,
  NodeKind,
  StagedItem,
  StarEdge,
  StarNode,
} from '../types';
import { nameToId } from '../star/custom';
import { EXTRACT_CAPS } from './prompt';

export interface ParseContext {
  /** 本次任务要提取的模块（决定解析哪些栏目） */
  modules: readonly IngestModule[];
  /** 已占用的名字：内置数据 + 已暂存条目。用于去重 */
  takenNames: ReadonlySet<string>;
  /** 星图已有的全部节点 id（内置 + 已存自定义） */
  existingIds: ReadonlySet<string>;
  /** 既有「概念名 → 节点 id」表，供关系端点解析与方法论 lit 关联 */
  nodeNameToId: ReadonlyMap<string, string>;
  /** 文献出处名（文档标题），写进每条产物的 src */
  source: string;
}

export type ParseOutcome =
  | { ok: true; items: StagedItem[]; warnings: string[] }
  | { ok: false; reason: string };

const CATS: readonly MethodCategory[] = ['生活指导', '思维工具', '论辩表达'];
const KINDS: readonly NodeKind[] = ['school', 'figure', 'method', 'concept'];
const RELS: readonly EdgeRelation[] = ['proposes', 'refines', 'inherits', 'opposes'];

/** djb2 哈希 + 前缀。概念用 star 的 nameToId（u_ 前缀），这里补 m_/t_/b_ */
function hashId(prefix: string, name: string, taken: ReadonlySet<string>): string {
  let h = 5381;
  for (let i = 0; i < name.length; i += 1) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  const base = `${prefix}_${Math.abs(h).toString(36)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const id = `${base}_${n}`;
    if (!taken.has(id)) return id;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function strArray(v: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = str(x, max);
    if (s) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** 文献格物题 → 可执行的三步剧本（与 gewu/genericScript 同构，出卡逻辑不用改） */
export function topicToScript(title: string, question: string, why: string): GewuTopic['script'] {
  return [
    {
      t: `今晚的文献格物题：${title}。${question}——今天有什么事，想拿它过一遍？`,
      opts: ['手上正好有一件事', '先说说这个问题本身', '换个题目'],
    },
    {
      t: why ? `这件事里，${why}——你最早是什么时候注意到它的？` : '再往细处想一层：它最初是从哪一刻开始的？',
      opts: ['我说不上来…', '换个角度问'],
    },
    { t: '归归类，出卡。', end: true },
  ];
}

/**
 * 解析模型输出。
 *
 * 永远不要抛异常 —— 调用方（任务运行器）只看返回值决定重试还是翻页。
 * JSON 都拆不出来时返回 ok:false，运行器会按失败重试。
 */
export function parseExtractReply(text: string, ctx: ParseContext): ParseOutcome {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, reason: '模型没有输出 JSON' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, reason: '模型输出的 JSON 解析失败' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: '模型输出的不是 JSON 对象' };
  }

  const obj = data as Partial<ExtractPayload>;
  const want = new Set(ctx.modules);
  const warnings: string[] = [];
  const items: StagedItem[] = [];
  const takenNames = new Set(ctx.takenNames);
  const takenIds = new Set(ctx.existingIds);

  /* ---------- 概念（先解析：关系的端点要挂在上面的 id 上） ---------- */
  /** 本批「概念名 → id」，关系端点先查这里 */
  const batchNames = new Map<string, string>();

  if (want.has('concept') && Array.isArray(obj.concepts)) {
    let count = 0;
    for (const raw of obj.concepts) {
      if (count >= EXTRACT_CAPS.concepts) {
        warnings.push(`本段概念最多 ${EXTRACT_CAPS.concepts} 个，多余的已略过`);
        break;
      }
      const r = (raw ?? {}) as Partial<ConceptDraft>;
      const name = str(r.name, 30);
      if (!name) {
        warnings.push('跳过一个没有名字的概念');
        continue;
      }
      if (takenNames.has(name)) {
        warnings.push(`「${name}」已存在，跳过重复概念`);
        continue;
      }
      const brief = str(r.brief, 200);
      if (!brief) {
        warnings.push(`「${name}」没有释义，跳过`);
        continue;
      }
      const kind = KINDS.includes(r.kind as NodeKind) ? (r.kind as NodeKind) : 'concept';
      const id = nameToId(name, takenIds);
      takenIds.add(id);
      takenNames.add(name);
      batchNames.set(name, id);
      const node: StarNode = {
        id,
        name,
        kind,
        school: str(r.school, 20) || '文献',
        brief,
        src: str(r.src, 60) || ctx.source,
        doc: null,
      };
      items.push({ id, module: 'concept', name, node });
      count += 1;
    }
  }

  /* ---------- 关系（端点：本批概念名 → 既有概念名 → 裸 id） ---------- */
  if (want.has('concept') && Array.isArray(obj.relations)) {
    let count = 0;
    for (const raw of obj.relations) {
      if (count >= EXTRACT_CAPS.relations) {
        warnings.push(`本段关系最多 ${EXTRACT_CAPS.relations} 条，多余的已略过`);
        break;
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      const fromName = str(r.from, 30);
      const toName = str(r.to, 30);
      const resolve = (name: string): string => {
        const hit = batchNames.get(name) ?? ctx.nodeNameToId.get(name);
        if (hit && takenIds.has(hit)) return hit;
        return takenIds.has(name) ? name : '';
      };
      const from = resolve(fromName);
      const to = resolve(toName);
      if (!from || !to) {
        warnings.push(`跳过一条端点未知的关系（${fromName || '?'} → ${toName || '?'}）`);
        continue;
      }
      if (from === to) {
        warnings.push(`跳过一条自己连自己的关系（${fromName}）`);
        continue;
      }
      const rel = RELS.includes(r.rel as EdgeRelation) ? (r.rel as EdgeRelation) : 'refines';
      if (!RELS.includes(r.rel as EdgeRelation)) {
        warnings.push(`关系 ${fromName}→${toName} 的类型不认识，已按「修正」处理`);
      }
      const edge: StarEdge = [from, to, rel, str(r.label, 40)];
      items.push({ id: `${from}>${to}`, module: 'relation', name: `${fromName}→${toName}`, edge });
      count += 1;
    }
  }

  /* ---------- 方法论 ---------- */
  if (want.has('method') && Array.isArray(obj.methods)) {
    let count = 0;
    for (const raw of obj.methods) {
      if (count >= EXTRACT_CAPS.methods) {
        warnings.push(`本段方法最多 ${EXTRACT_CAPS.methods} 条，多余的已略过`);
        break;
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      const name = str(r.name, 30);
      if (!name) {
        warnings.push('跳过一条没有名字的方法');
        continue;
      }
      if (takenNames.has(name)) {
        warnings.push(`「${name}」已存在，跳过重复方法`);
        continue;
      }
      const one = str(r.one, 80);
      const sop = strArray(r.sop, 40, 6);
      if (!one || sop.length === 0) {
        warnings.push(`「${name}」缺一句话说明或操作步骤，跳过`);
        continue;
      }
      const cat = CATS.includes(r.cat as MethodCategory) ? (r.cat as MethodCategory) : '思维工具';
      // lit：本段概念里能对上既有星图节点的，顺手关联上（对不上就空着）
      const lit: string[] = [];
      for (const [cname, cid] of batchNames) {
        const existing = ctx.nodeNameToId.get(cname);
        if (existing && lit.length < 4) lit.push(existing);
        else if (cid && ctx.existingIds.has(cid) && lit.length < 4) lit.push(cid);
      }
      const id = hashId('m', name, takenIds);
      takenIds.add(id);
      takenNames.add(name);
      const entry: MethodEntry = {
        id,
        name,
        cat,
        one,
        sop,
        misuse: str(r.misuse, 120) || '暂无提醒',
        src: ctx.source,
        lit,
        docs: [],
      };
      items.push({ id, module: 'method', name, entry });
      count += 1;
    }
  }

  /* ---------- 格物题 ---------- */
  if (want.has('topic') && Array.isArray(obj.topics)) {
    let count = 0;
    for (const raw of obj.topics) {
      if (count >= EXTRACT_CAPS.topics) {
        warnings.push(`本段格物题最多 ${EXTRACT_CAPS.topics} 个，多余的已略过`);
        break;
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      const title = str(r.title, 20);
      const question = str(r.question, 120);
      if (!title || !question) {
        warnings.push('跳过一条缺标题或问题的格物题');
        continue;
      }
      if (takenNames.has(title)) {
        warnings.push(`格物题「${title}」已存在，跳过`);
        continue;
      }
      const why = str(r.why, 80);
      const id = hashId('t', title, takenIds);
      takenIds.add(id);
      takenNames.add(title);
      const topic: GewuTopic = {
        id,
        title,
        question,
        why,
        src: ctx.source,
        script: topicToScript(title, question, why),
      };
      items.push({ id, module: 'topic', name: title, topic });
      count += 1;
    }
  }

  /* ---------- 论题 ---------- */
  if (want.has('debate') && Array.isArray(obj.debates)) {
    let count = 0;
    for (const raw of obj.debates) {
      if (count >= EXTRACT_CAPS.debates) {
        warnings.push(`本段论题最多 ${EXTRACT_CAPS.debates} 个，多余的已略过`);
        break;
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      const title = str(r.title, 24);
      const question = str(r.question, 120);
      if (!title || !question) {
        warnings.push('跳过一条缺标题或问题的论题');
        continue;
      }
      if (takenNames.has(title)) {
        warnings.push(`论题「${title}」已存在，跳过`);
        continue;
      }
      const id = hashId('b', title, takenIds);
      takenIds.add(id);
      takenNames.add(title);
      const debate: DebateTopic = {
        id,
        title,
        question,
        phil: str(r.phil, 10),
        philId: '',
        src: ctx.source,
      };
      items.push({ id, module: 'debate', name: title, debate });
      count += 1;
    }
  }

  return { ok: true, items, warnings };
}
