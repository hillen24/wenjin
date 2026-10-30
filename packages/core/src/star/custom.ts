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
  /** 生效的边：图上画实线 */
  edges: StarEdge[];
  /**
   * 待定池：被用户否决、但没有永久删掉的边。
   *
   * ===== 为什么要这个池子 =====
   * 「自生长」有两个方向：AI 和用户都能往图上长边，但**必须留一个「审」的环节**。
   * 直接删掉否决的边看似干净，实际上丢掉了两样东西：
   * 1. AI 的判断痕迹 —— 它为什么会认为这两个概念有关系？这个信息本身有价值；
   * 2. 翻案的可能 —— 读书读深了，三个月前否决的那条边可能正好是对的。
   *
   * 所以否决 = 移进池子（图上不画），而不是删除。真不要了再「永久删除」。
   */
  pending: StarEdge[];
}

export const EMPTY_GRAPH: CustomGraph = { nodes: [], edges: [], pending: [] };

const KINDS: readonly NodeKind[] = ['school', 'method', 'figure', 'concept'];
const RELS: readonly EdgeRelation[] = ['proposes', 'refines', 'inherits', 'opposes'];

/** 用户星区的默认脉络名 */
export const CUSTOM_SCHOOL = '我的星区';

/** 释义兜底。旧版这里 fallback 成 name，结果面板上名字下面又印一遍名字。 */
export const NO_BRIEF = '释义待补充';

/** 容量上限：防一次模型抽风把 localStorage 撑爆（只数用户自己加的，内置不算） */
export const MAX_CUSTOM_NODES = 150;
export const MAX_CUSTOM_EDGES = 400;

/** 一次入库的节点上限。提示词里让模型控制在 5 个，这里兜底截断。 */
export const MAX_NODES_PER_BATCH = 8;
export const MAX_EDGES_PER_BATCH = 16;

/** 喂给模型的既有节点清单上限：清单太长会把 prompt 撑爆，也更容易让模型乱连 */
export const PROMPT_NODE_LIMIT = 60;

const ID_RE = /^[a-z0-9_-]{2,40}$/;

/** validateIncoming 的可选上下文 */
export interface ValidateOptions {
  /** 图里已有的边，用于去重（同一对节点不重复连线，否则图上会出现双线） */
  existingEdges?: ReadonlyArray<readonly unknown[]>;
  /** 「名字 → id」兜底表：模型经常拿中文名当边的端点，查得到就别丢 */
  alias?: ReadonlyMap<string, string>;
}

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
  /** 失败也带 warnings：整批被挡下时，调用方要知道是被什么逐条挡下的 */
  | { ok: false; reason: string; warnings: string[] };

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
  opts: ValidateOptions = {},
): ValidateResult {
  const warnings: string[] = [];

  if (!Array.isArray(incoming.nodes) || !Array.isArray(incoming.edges)) {
    return { ok: false, reason: 'nodes/edges 不是数组', warnings: [] };
  }
  if (incoming.nodes.length === 0) {
    return { ok: false, reason: '没有给出任何节点', warnings: [] };
  }

  const taken = new Set(existingIds);
  const nodes: StarNode[] = [];
  const newIds = new Set<string>();
  /** 本批新节点的「名字 → id」，边端点是名字时先查这里 */
  const alias = new Map<string, string>(opts.alias ?? []);

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
      warnings.push(`「${name}」已在星图里，跳过重复节点`);
      continue;
    }
    if (nodes.length >= MAX_NODES_PER_BATCH) {
      warnings.push(`一次最多加 ${MAX_NODES_PER_BATCH} 个节点，多余的已略过`);
      break;
    }
    if (name.length > 30) {
      warnings.push(`「${name.slice(0, 12)}…」名字超长，已截断`);
    }
    const kind = KINDS.includes(raw.kind as NodeKind) ? (raw.kind as NodeKind) : 'concept';
    const brief = String(raw.brief ?? '').trim() || NO_BRIEF;
    const school = String(raw.school ?? '').trim() || CUSTOM_SCHOOL;
    const src = String(raw.src ?? '').trim() || '用户添加';

    let id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
    if (!id || taken.has(id) || newIds.has(id)) {
      id = nameToId(name, new Set([...taken, ...newIds]));
    }

    newIds.add(id);
    alias.set(name, id);
    // 截短后的名字也认，模型偶尔会给带别名的长名
    alias.set(name.slice(0, 30), id);
    nodes.push({
      id,
      name: name.slice(0, 30),
      kind,
      school: school.slice(0, 20),
      brief: brief.slice(0, 200),
      src: src.slice(0, 60),
      doc: null,
    });
  }

  if (nodes.length === 0) {
    return { ok: false, reason: '校验后一个节点都不剩（名字全空或全是重复？）', warnings };
  }

  const validIds: ReadonlySet<string> = new Set([...existingIds, ...newIds]);
  const nameOf = new Map<string, string>();
  for (const n of nodes) nameOf.set(n.id, n.name);

  /** 端点解析：先当 id，不像 id 再当名字查表 */
  const resolve = (raw: string): string => {
    const v = raw.trim();
    if (validIds.has(v)) return v;
    const hit = alias.get(v);
    if (hit && validIds.has(hit)) return hit;
    return '';
  };

  // 已有边的「无序对」集合：同一对节点之间不再连第二条，否则画布上叠双线
  const takenPairs = new Set<string>();
  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const e of opts.existingEdges ?? []) {
    const a = String(e?.[0] ?? '');
    const b = String(e?.[1] ?? '');
    if (a && b) takenPairs.add(pairKey(a, b));
  }

  const edges: StarEdge[] = [];
  const seenEdges = new Set<string>();

  for (const raw of incoming.edges) {
    if (edges.length >= MAX_EDGES_PER_BATCH) {
      warnings.push(`一次最多加 ${MAX_EDGES_PER_BATCH} 条关系，多余的已略过`);
      break;
    }
    const f = edgeFields(raw);
    if (!f) {
      warnings.push('跳过一条格式不认识的边');
      continue;
    }
    let from = resolve(f.from);
    let to = resolve(f.to);
    // 名字在 alias 里解析成同一个 id 的情况（自环）也要拦
    if (!from || !to) {
      warnings.push(`跳过一条端点未知的边（${f.from || '?'} → ${f.to || '?'}）`);
      continue;
    }
    if (from === to) {
      warnings.push(`跳过一条自己连自己的边（${nameOf.get(from) ?? from}）`);
      continue;
    }
    const pk = pairKey(from, to);
    if (takenPairs.has(pk)) {
      warnings.push(
        `「${nameOf.get(from) ?? from}」和「${nameOf.get(to) ?? to}」之间已经有关系了，跳过重复连线`,
      );
      continue;
    }
    const rel = RELS.includes(f.rel as EdgeRelation) ? (f.rel as EdgeRelation) : 'refines';
    if (!RELS.includes(f.rel as EdgeRelation)) {
      warnings.push(`边 ${from}→${to} 的关系类型不认识，已按「修正」处理`);
    }
    const key = `${from}>${to}>${rel}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    takenPairs.add(pk);
    edges.push([from, to, rel, f.label.slice(0, 40)]);
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
 * existingNodes 传内置 + 已有自定义的 id/name/kind，让模型把新内容挂上去；
 * 清单会截断到 PROMPT_NODE_LIMIT 条，防止 prompt 把上下文吃光。
 */
export function buildAiPrompt(existingNodes: ReadonlyArray<Pick<StarNode, 'id' | 'name' | 'kind'>>): string {
  const all = existingNodes.map((n) => `${n.id}(${n.name},${n.kind})`);
  const shown = all.slice(0, PROMPT_NODE_LIMIT);
  const truncated = all.length > shown.length ? `（清单较长，仅列出前 ${shown.length} 个）` : '';
  return [
    '你是「致知」哲学星图的结构化编辑器。用户会用自然语言描述想加入的思想概念/人物/流派/方法，',
    '你的唯一任务是把描述规范化成星图片段。必须只输出一个 JSON 对象，不要输出任何其他文字、不要用 markdown 代码块。',
    '',
    'JSON 格式：',
    '{"nodes":[{"id":"小写英文id","name":"中文名","kind":"figure|school|method|concept","school":"所属脉络","brief":"一句话释义，20-80字","src":"出处"}],',
    ' "edges":[{"from":"节点id","to":"节点id","rel":"proposes|refines|inherits|opposes","label":"一句话说明关系"}]}',
    '',
    '规则：',
    '1. id 只用小写字母数字下划线，2-40 字符；name 用中文，30 字以内。',
    '2. 新节点要跟已有节点连边时，直接用下面给的既有 id，不要新建重复概念。',
    '   如果概念在清单里已存在，就不要再建，直接拿它的 id 连边。',
    '3. rel 四选一：proposes=提出，refines=修正，inherits=继承，opposes=反对。每条边给一句 label。',
    `4. 一次最多 5 个新节点、8 条边。brief 必须有实质内容，不要空话、不要照抄 name。`,
    `5. 既有节点清单${truncated}（id(名字,类型)）：${shown.join('、')}`,
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
  opts: ValidateOptions = {},
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
  return validateIncoming(
    {
      nodes: obj.nodes as Array<Partial<StarNode>>,
      edges: (Array.isArray(obj.edges) ? obj.edges : []) as GraphFragment['edges'],
    },
    existingIds,
    existingNames,
    opts,
  );
}

/* ============================================================
 * 存储
 * ============================================================ */

/** 读出来的数据可疑就整体弃用（比带病渲染安全） */
function sanitizeGraph(raw: unknown): CustomGraph {
  if (!raw || typeof raw !== 'object') return { nodes: [], edges: [], pending: [] };
  const obj = raw as { nodes?: unknown; edges?: unknown; pending?: unknown };
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
  const readEdges = (raw2: unknown): StarEdge[] =>
    Array.isArray(raw2)
      ? (raw2 as unknown[]).filter(
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

  const edges = readEdges(obj.edges);
  /**
   * 待定池里的边必须「不属于生效边」——
   * 否则会出现同一条边既在图上画着、又在池子里躺着。
   * 旧数据没有 pending 字段，这里自然得到空数组，不需要写迁移。
   */
  const live = new Set(edges.map(edgeKey));
  const pending = readEdges(obj.pending).filter((e) => !live.has(edgeKey(e)));

  return { nodes, edges, pending };
}

/* ============================================================
 * 边的标识与治理
 * ============================================================ */

/**
 * 一条边的唯一标识。
 *
 * 用 `from>to>rel` 而不是「无序对」——同一对节点之间**可以**有两种不同的关系
 * （康德反对休谟的因果论，同时继承了他的问题意识），这是哲学图谱的常态，
 * 不能当成重复。
 */
export function edgeKey(e: StarEdge): string {
  return `${e[0]}>${e[1]}>${e[2]}`;
}

export class StarGraphStore {
  private readonly kv: KeyValueStore;
  private cache: CustomGraph | null = null;

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  /** 当前自定义子图（带缓存；外部直接改了 localStorage 后可调 resetCache） */
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
   *
   * builtin 传内置节点/边（用于 id 冲突检测、同名去重、连边去重）。
   * 容量上限只数「用户自己加的」——旧版把内置节点也算进去，内置一多就误报超限。
   */
  add(
    incoming: GraphFragment,
    builtin: { nodes?: ReadonlyArray<Pick<StarNode, 'id' | 'name'>>; edges?: ReadonlyArray<StarEdge> } = {},
  ): { ok: true; graph: CustomGraph; warnings: string[] } | { ok: false; reason: string; warnings: string[] } {
    const cur = this.load();
    const builtinNodes = builtin.nodes ?? [];
    const existingIds = new Set([...builtinNodes.map((n) => n.id), ...cur.nodes.map((n) => n.id)]);
    const existingNames = new Set([...builtinNodes.map((n) => n.name), ...cur.nodes.map((n) => n.name)]);
    const existingEdges: StarEdge[] = [...(builtin.edges ?? []), ...cur.edges];

    const r = validateIncoming(incoming, existingIds, existingNames, { existingEdges });
    if (!r.ok) return r;

    if (cur.nodes.length + r.nodes.length > MAX_CUSTOM_NODES) {
      return { ok: false, reason: `自定义节点已达上限（${MAX_CUSTOM_NODES}），先清理一些再加`, warnings: [] };
    }
    if (cur.edges.length + r.edges.length > MAX_CUSTOM_EDGES) {
      return { ok: false, reason: `自定义关系已达上限（${MAX_CUSTOM_EDGES}）`, warnings: [] };
    }

    const next: CustomGraph = {
      nodes: [...cur.nodes, ...r.nodes],
      edges: [...cur.edges, ...r.edges],
      // 待定池原样保留：新加一批不该复活旧否决，也不该清掉它
      pending: cur.pending,
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return { ok: true, graph: next, warnings: r.warnings };
  }

  /**
   * 否决一条边：从生效集合移进待定池。
   *
   * 不是删除 —— 用户日后可能翻案，而且 AI 当时为什么这么判断本身是信息。
   * 内置边不受影响（本方法只碰自定义子图）。
   */
  rejectEdge(edge: StarEdge): CustomGraph {
    const cur = this.load();
    const key = edgeKey(edge);
    // 已经不在生效集合里就不再动（重复点击 / 并发）
    if (!cur.edges.some((e) => edgeKey(e) === key)) return cur;

    const next: CustomGraph = {
      nodes: cur.nodes,
      edges: cur.edges.filter((e) => edgeKey(e) !== key),
      pending: cur.pending.some((e) => edgeKey(e) === key) ? cur.pending : [...cur.pending, edge],
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return next;
  }

  /**
   * 翻案：把一条被否决的边放回生效集合。
   *
   * 放回前要确认两个端点还在 —— 节点可能已经被删了，
   * 那种情况下放回去会得到一条悬空边，merged() 会把它过滤掉，
   * 但用户的点击就白费了。直接拒绝并保持池子里的原样更诚实。
   */
  restoreEdge(edge: StarEdge): { graph: CustomGraph; ok: boolean } {
    const cur = this.load();
    const key = edgeKey(edge);
    if (!cur.pending.some((e) => edgeKey(e) === key)) return { graph: cur, ok: false };

    const ids = new Set(cur.nodes.map((n) => n.id));
    if (!ids.has(edge[0]) || !ids.has(edge[1])) return { graph: cur, ok: false };

    const next: CustomGraph = {
      nodes: cur.nodes,
      edges: [...cur.edges, edge],
      pending: cur.pending.filter((e) => edgeKey(e) !== key),
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return { graph: next, ok: true };
  }

  /** 永久删除一条待定边。真不要了才用。 */
  dropRejected(edge: StarEdge): CustomGraph {
    const cur = this.load();
    const key = edgeKey(edge);
    const next: CustomGraph = {
      nodes: cur.nodes,
      edges: cur.edges,
      pending: cur.pending.filter((e) => edgeKey(e) !== key),
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return next;
  }

  /** 删除一个自定义节点及其所有连边。只能删自定义的，内置节点删不了。 */
  removeNode(id: string): CustomGraph {
    const cur = this.load();
    /**
     * 待定池里指向这个节点的边也要清掉。
     *
     * 不清的话池子里会留下永远无法翻案的死记录（restoreEdge 会因为端点不存在
     * 而拒绝），用户看到一个点了没反应的「恢复」按钮 —— 比没有更糟。
     */
    const next: CustomGraph = {
      nodes: cur.nodes.filter((n) => n.id !== id),
      edges: cur.edges.filter(([a, b]) => a !== id && b !== id),
      pending: cur.pending.filter(([a, b]) => a !== id && b !== id),
    };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return next;
  }

  /** 清空「我的星区」。用户加错一堆时得有后悔药。 */
  clear(): CustomGraph {
    const next: CustomGraph = { nodes: [], edges: [], pending: [] };
    this.kv.writeJSON(STORAGE_KEYS.customGraph, next);
    this.cache = next;
    return next;
  }

  /**
   * 内置 + 自定义合并视图。悬空边在这里兜底过滤。
   *
   * 注意：**只返回生效的边**，待定池不进图。
   * 待定边是「被否决过的」，画在图上会让用户怀疑自己的否决没生效。
   */
  merged(
    builtinNodes: readonly StarNode[],
    builtinEdges: readonly StarEdge[],
  ): CustomGraph {
    const cur = this.load();
    const ids = new Set([...builtinNodes.map((n) => n.id), ...cur.nodes.map((n) => n.id)]);
    return {
      nodes: [...builtinNodes, ...cur.nodes],
      edges: [...builtinEdges, ...cur.edges.filter(([a, b]) => ids.has(a) && ids.has(b))],
      pending: cur.pending,
    };
  }
}
