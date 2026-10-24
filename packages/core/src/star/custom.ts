/**
 * 星图共建：用户自定义节点/边 + AI 输出规范化
 *
 * 设计取舍：
 * - 内置星图（STAR_NODES/STAR_EDGES）保持只读常量，用户内容单独存一份，
 *   展示时合并 —— 升级内置数据不会踩掉用户的心血。
 * - AI 只负责「规范化」，不直接写库：模型输出一律先过 validateIncoming 校验，
 *   合法才进预览，用户点「入库」才落 localStorage。模型说错话最多浪费一次生成，
 *   污染不进图。
 * - id 规则：小写字母/数字/下划线/连字符。中文名没法直接当 id，
 *   用名字哈希生成（同名重放会得到同一个 id，天然去重；改名才算新节点）。
 */

import type { EdgeRelation, NodeKind, StarEdge, StarNode } from '../types';
import { KeyValueStore, STORAGE_KEYS } from '../storage';

/* ============================================================
 * 类型与常量
 * ============================================================ */

/** 用户自定义子图（存取的基本单位） */
export interface CustomGraph {
  nodes: StarNode[];
  edges: StarEdge[];
}

export const EMPTY_GRAPH: CustomGraph = { nodes: [], edges: [] };

const KINDS: readonly NodeKind[] = ['school', 'method', 'figure', 'concept'];
const RELS: readonly EdgeRelation[] = ['proposes', 'refines', 'inherits', 'opposes'];

/** 用户星区的默认脉络名 */
export const CUSTOM_SCHOOL = '我的星区';

/** 容量上限：防一次模型抽风把 localStorage 撑爆 */
export const MAX_CUSTOM_NODES = 150;
export const MAX_CUSTOM_EDGES = 400;

const ID_RE = /^[a-z0-9_-]{2,40}$/;

/* ============================================================
 * id 生成
 * ============================================================ */

/** djb2 哈希的 36 进制截断。同名同哈希 → 天然去重。 */
export function nameToId(name: string, taken: ReadonlySet<string>): string {
  let h = 5381;
  for (let i = 0; i < name.length; i += 1) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  const base = `u_${Math.abs(h).toString(36)}`;
  if (!taken.has(base)) return base;
  // 哈希撞了（不同名同哈希）：追加序号直到空位
  for (let n = 2; n < 100; n += 1) {
    const id = `${base}_${n}`;
    if (!taken.has(id)) return id;
  }
  return `${base}_${Date.now().toString(36)}`;
}

/* ============================================================
 * 校验与规范化
 * ============================================================ */

export interface GraphFragment {
  nodes: Array<Partial<StarNode>>;
  /** 对象形状（AI 输出）或 StarEdge 元组形状（已规范化数据二次入库）都收 */
  edges: Array<
    | { from?: unknown; to?: unknown; rel?: unknown; label?: unknown }
    | readonly [string, string, EdgeRelation, string?]
  >;
}

/** 把边的两种形状统一读成对象 */
function edgeFields(
  raw: GraphFragment['edges'][number],
): { from: string; to: string; rel: unknown; label: string } | null {
  if (Array.isArray(raw)) {
    return { from: String(raw[0] ?? ''), to: String(raw[1] ?? ''), rel: raw[2], label: String(raw[3] ?? '') };
  }
  if (!raw || typeof raw !== 'object' || !('from' in raw)) return null;
  return {
    from: String(raw.from ?? ''),
    to: String(raw.to ?? ''),
    rel: raw.rel,
    label: String(raw.label ?? ''),
  };
}

export type ValidateResult =
  | { ok: true; nodes: StarNode[]; edges: StarEdge[]; warnings: string[] }
  | { ok: false; reason: string };

/**
 * 校验并规范化一批节点/边。
 *
 * existingIds 是「已经存在的全部节点 id」（内置 + 已存自定义），
 * 新边允许指向它们，也允许指向本批新节点。
 * existingNames 用于同名去重：AI 同一段话跑两遍不该产生两个一样的节点。
 */
export function validateIncoming(
  incoming: GraphFragment,
  existingIds: ReadonlySet<string>,
  existingNames: ReadonlySet<string> = new Set(),
): ValidateResult {
  const warnings: string[] = [];

  if (!Array.isArray(incoming.nodes) || !Array.isArray(incoming.edges)) {
    return { ok: false, reason: 'nodes/edges 不是数组' };
  }
  if (incoming.nodes.length === 0) {
    return { ok: false, reason: '没有给出任何节点' };
  }

  const taken = new Set(existingIds);
  const nodes: StarNode[] = [];
  const newIds = new Set<string>();
  const nameOf = new Map<string, string>(); // id → name，给边预览用

  for (const raw of incoming.nodes) {
    if (!raw || typeof raw !== 'object') {
      warnings.push('跳过一个不是对象的节点');
      continue;
    }
    const name = String(raw.name ?? '').trim();
    if (!name) {
      warnings.push('跳过一个没有名字的节点');
      continue;
    }
    if (existingNames.has(name)) {
      warnings.push(`「${name}」已存在，跳过重复节点`);
      continue;
    }
    if (name.length > 30) {
      warnings.push(`「${name.slice(0, 12)}…」名字超长，已截断`);
    }
    const kind = KINDS.includes(raw.kind as NodeKind) ? (raw.kind as NodeKind) : 'concept';
    const brief = String(raw.brief ?? '').trim() || name;
    const school = String(raw.school ?? '').trim() || CUSTOM_SCHOOL;
    const src = String(raw.src ?? '').trim() || '用户添加';

    let id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
    if (!id || taken.has(id) || newIds.has(id)) {
      id = nameToId(name, new Set([...taken, ...newIds]));
    }

    newIds.add(id);
    nameOf.set(id, name.slice(0, 30));
    nodes.push({ id, name: name.slice(0, 30), kind, school: school.slice(0, 20), brief: brief.slice(0, 200), src: src.slice(0, 60), doc: null });
  }

  if (nodes.length === 0) {
    return { ok: false, reason: '校验后一个节点都不剩（名字全空？）' };
  }
  if (taken.size + nodes.length > MAX_CUSTOM_NODES) {
    return { ok: false, reason: `自定义节点已达上限（${MAX_CUSTOM_NODES}）` };
  }

  const validIds: ReadonlySet<string> = new Set([...existingIds, ...newIds]);
  const edges: StarEdge[] = [];
  const seenEdges = new Set<string>();

  for (const raw of incoming.edges) {
    const f = edgeFields(raw);
    if (!f) {
      warnings.push('跳过一条格式不认识的边');
      continue;
    }
    const from = f.from;
    const to = f.to;
    if (!validIds.has(from) || !validIds.has(to)) {
      warnings.push(`跳过一条端点未知的边（${from || '?'} → ${to || '?'}）`);
      continue;
    }
    if (from === to) {
      warnings.push('跳过一条自环边');
      continue;
    }
    const rel = RELS.includes(f.rel as EdgeRelation) ? (f.rel as EdgeRelation) : 'refines';
    if (!RELS.includes(f.rel as EdgeRelation)) {
      warnings.push(`边 ${from}→${to} 的关系类型不认识，已按「修正」处理`);
    }
    const key = `${from}>${to}>${rel}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push([from, to, rel, f.label.slice(0, 40)]);
  }

  if (taken.size + nodes.length + edges.length > MAX_CUSTOM_NODES + MAX_CUSTOM_EDGES) {
    return { ok: false, reason: '内容超出容量上限' };
  }

  return { ok: true, nodes, edges, warnings };
}

/* ============================================================
 * AI 提示词与输出解析
 * ============================================================ */

/**
 * 构建「星图共建」的 system prompt。
 *
 * 关键约束写死在提示里：只输出 JSON、id 规则、复用既有节点 id。
 * existingNodes 传内置 + 已有自定义的 id/name/kind，让模型把新内容挂上去。
 */
export function buildAiPrompt(existingNodes: ReadonlyArray<Pick<StarNode, 'id' | 'name' | 'kind'>>): string {
  const list = existingNodes.map((n) => `${n.id}(${n.name},${n.kind})`).join('、');
  return [
    '你是「问津」哲学星图的结构化编辑器。用户会用自然语言描述想加入的思想概念/人物/流派/方法，',
    '你的唯一任务是把描述规范化成星图片段。必须只输出一个 JSON 对象，不要输出任何其他文字、不要用 markdown 代码块。',
    '',
    'JSON 格式：',
    '{"nodes":[{"id":"小写英文id","name":"中文名","kind":"figure|school|method|concept","school":"所属脉络","brief":"一句话释义，20-80字","src":"出处"}],',
    ' "edges":[{"from":"节点id","to":"节点id","rel":"proposes|refines|inherits|opposes","label":"一句话说明关系"}]}',
    '',
    '规则：',
    '1. id 只用小写字母数字下划线，2-40 字符；name 用中文，30 字以内。',
    '2. 新节点要跟已有节点连边时，直接用下面给的既有 id，不要新建重复概念。',
    '3. rel 四选一：proposes=提出，refines=修正，inherits=继承，opposes=反对。每条边给一句 label。',
    '4. 一次最多 5 个新节点、8 条边。brief 必须有实质内容，不要空话。',
    `5. 既有节点清单（id(名字,类型)）：${list}`,
  ].join('\n');
}

export type ParseAiResult =
  | { ok: true; nodes: StarNode[]; edges: StarEdge[]; warnings: string[] }
  | { ok: false; reason: string };

/**
 * 解析模型的自由文本输出 → 合法星图片段。
 *
 * 模型经常不听话：包 ```json 代码块、前后加说明、用中文引号。
 * 这里按「第一个 { 到最后一个 }」截取再 parse，容错第一层；
 * 结构错误交给 validateIncoming 给出人话原因。
 */
export function parseAiGraph(
  text: string,
  existingIds: ReadonlySet<string>,
  existingNames: ReadonlySet<string> = new Set(),
): ParseAiResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, reason: '模型没有输出 JSON' };
  }
  const slice = text.slice(start, end + 1);
  let data: unknown;
  try {
    data = JSON.parse(slice);
  } catch {
    return { ok: false, reason: '模型输出的 JSON 解析失败' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: '模型输出的不是 JSON 对象' };
  }
  const obj = data as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(obj.nodes)) {
    return { ok: false, reason: '模型输出缺少 nodes 数组' };
  }
  const r = validateIncoming(
    {
      nodes: obj.nodes as Array<Partial<StarNode>>,
      edges: (Array.isArray(obj.edges) ? obj.edges : []) as GraphFragment['edges'],
    },
    existingIds,
    existingNames,
  );
  return r;
}

/* ============================================================
 * 存储
 * ============================================================ */

/** 读出来的数据可疑就整体弃用（比带病渲染安全） */
function sanitizeGraph(raw: unknown): CustomGraph {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_GRAPH, nodes: [], edges: [] };
  const obj = raw as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(obj.nodes)
    ? obj.nodes.filter(
        (n): n is StarNode =>
          !!n &&
          typeof (n as StarNode).id === 'string' &&
          ID_RE.test((n as StarNode).id) &&
          typeof (n as StarNode).name === 'string',
      )
    : [];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = Array.isArray(obj.edges)
    ? (obj.edges as unknown[]).filter(
        (e): e is StarEdge =>
          Array.isArray(e) &&
          e.length >= 3 &&
          typeof e[0] === 'string' &&
          typeof e[1] === 'string' &&
          ids.has(e[0]) &&
          ids.has(e[1]) &&
          RELS.includes(e[2] as EdgeRelation),
      )
    : [];
  return { nodes, edges };
}

export class StarGraphStore {
  private readonly kv: KeyValueStore;
  private cache: CustomGraph | null = null;

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  /** 当前自定义子图（带缓存；测试里直接改 localStorage 后可调 resetCache） */
  load(): CustomGraph {
    if (this.cache) return this.cache;
    this.cache = sanitizeGraph(this.kv.readJSON<unknown>(STORAGE_KEYS.customGraph, null));
    return this.cache;
  }

  resetCache(): void {
    this.cache = null;
  }

  /**
   * 新增一批（先校验，全部合法才落盘）。
   * builtinNodes 传内置节点（id+name），用于 id 冲突检测与同名去重。
   */
  add(
    incoming: GraphFragment,
    builtinNodes: ReadonlyArray<Pick<StarNode, 'id' | 'name'>> = [],
  ): { ok: true; graph: CustomGraph; warnings: string[] } | { ok: false; reason: string } {
    const cur = this.load();
    const existingIds = new Set([...builtinNodes.map((n) => n.id), ...cur.nodes.map((n) => n.id)]);
    const existingNames = new Set([...builtinNodes.map((n) => n.name), ...cur.nodes.map((n) => n.name)]);
    const r = validateIncoming(incoming, existingIds, existingNames);
    if (!r.ok) return r;

    const next: CustomGraph = {
      nodes: [...cur.nodes, ...r.nodes],
      edges: [...cur.edges, ...r.edges],
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return { ok: true, graph: next, warnings: r.warnings };
  }

  /** 删除一个自定义节点及其所有连边。只能删自定义的，内置节点删不了。 */
  removeNode(id: string): CustomGraph {
    const cur = this.load();
    const next: CustomGraph = {
      nodes: cur.nodes.filter((n) => n.id !== id),
      edges: cur.edges.filter(([a, b]) => a !== id && b !== id),
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return next;
  }

  /** 内置 + 自定义合并视图。悬空边在这里兜底过滤。 */
  merged(
    builtinNodes: readonly StarNode[],
    builtinEdges: readonly StarEdge[],
  ): CustomGraph {
    const cur = this.load();
    const ids = new Set([...builtinNodes.map((n) => n.id), ...cur.nodes.map((n) => n.id)]);
    return {
      nodes: [...builtinNodes, ...cur.nodes],
      edges: [...builtinEdges, ...cur.edges.filter(([a, b]) => ids.has(a) && ids.has(b))],
    };
  }
}
