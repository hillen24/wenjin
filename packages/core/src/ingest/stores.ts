/**
 * 文献提取产物的四个落脚点 + 暂存区
 *
 * 一套 Agent 四条入库通道，全部沿用星图共建的立场：
 * **模型只提议，store 负责否决**。parse.ts 先把模型输出收敛成规范形状，
 * 这里再做一次独立消毒（磁盘数据可能来自旧版、可能被手改坏、可能被同步带错），
 * 脏数据整体弃用，不带病渲染。
 *
 * 四个 store 的分工：
 * - MethodLibraryStore  方法论库的自建条目（wj_custom_methods_v1），内置 11 条之外的血肉
 * - GewuTopicStore      文献格物题（wj_custom_gewu_v1），自带可执行剧本
 * - DebateTopicStore    文献论题（wj_custom_debate_v1），phil 名在入库时解析成哲人 id
 * - IngestStageStore    暂存区（wj_ingest_stage_v1），提取完成、用户确认前的停机坪
 *
 * 暂存区是容灾的最后一块：任务跑到一半关窗口、中止、失败重试，
 * 已提取的成果都在这里躺着，下次打开页面还能预览、勾选、入库。
 * 它的键名沿用 wj_ 前缀，局域网同步的前缀扫描会自动带走它。
 */

import type {
  DebateTopic,
  GewuScript,
  GewuTopic,
  IngestModule,
  MethodCategory,
  MethodEntry,
  StarEdge,
  StarNode,
  StagedItem,
} from '../types';
import { KeyValueStore, STORAGE_KEYS } from '../storage';
import { PHILOSOPHERS } from '../data/philosophers';
import { genericScript } from '../gewu';

/* ============================================================
 * 公共
 * ============================================================ */

const CATS: readonly MethodCategory[] = ['生活指导', '思维工具', '论辩表达'];
const RELS: readonly StarEdge[2][] = ['proposes', 'refines', 'inherits', 'opposes'];
const MODULES: readonly IngestModule[] = ['method', 'concept', 'topic', 'debate'];

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

/* ============================================================
 * 一、方法论库（自定义条目）
 * ============================================================ */

/** 自定义方法条目上限。内置 11 条不算在内——内置一多就误报超限是老毛病 */
export const MAX_CUSTOM_METHODS = 60;

/** 消毒一条方法论。返回 null 表示这条不该进库。 */
function sanitizeMethod(raw: unknown): MethodEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40);
  const name = str(r.name, 30);
  const one = str(r.one, 80);
  const sop = strArray(r.sop, 40, 6);
  if (!id || !name || !one || sop.length === 0) return null;
  return {
    id,
    name,
    cat: CATS.includes(r.cat as MethodCategory) ? (r.cat as MethodCategory) : '思维工具',
    one,
    sop,
    misuse: str(r.misuse, 120) || '暂无提醒',
    src: str(r.src, 60) || '文献提取',
    lit: strArray(r.lit, 40, 8),
    docs: [],
  };
}

function sanitizeMethods(raw: unknown): MethodEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MethodEntry[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const x of raw) {
    const e = sanitizeMethod(x);
    // 读盘时也去重：旧版数据、同步带错的数据都可能有重复
    if (!e || ids.has(e.id) || names.has(e.name)) continue;
    ids.add(e.id);
    names.add(e.name);
    out.push(e);
  }
  return out;
}

export class MethodLibraryStore {
  private readonly kv: KeyValueStore;
  private cache: MethodEntry[] | null = null;
  private readonly listeners = new Set<(m: readonly MethodEntry[]) => void>();

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  load(): readonly MethodEntry[] {
    if (this.cache) return this.cache;
    this.cache = sanitizeMethods(this.kv.readJSON<unknown>(STORAGE_KEYS.customMethods, null));
    return this.cache;
  }

  resetCache(): void {
    this.cache = null;
  }

  /**
   * 入库一批。按 id 和名字双重去重（同一个概念换个 id 也不算新），
   * 超容量上限整体拒绝——宁可让用户分两次确认，也不悄悄丢一半。
   */
  add(entries: readonly MethodEntry[]): { ok: true; added: MethodEntry[]; warnings: string[] } | { ok: false; reason: string } {
    const cur = this.load();
    const warnings: string[] = [];
    const ids = new Set(cur.map((e) => e.id));
    const names = new Set(cur.map((e) => e.name));
    const added: MethodEntry[] = [];

    for (const raw of entries) {
      const e = sanitizeMethod(raw);
      if (!e) {
        warnings.push('跳过一条字段不全的方法');
        continue;
      }
      if (ids.has(e.id) || names.has(e.name)) {
        warnings.push(`「${e.name}」已在方法论库里，跳过重复条目`);
        continue;
      }
      if (cur.length + added.length >= MAX_CUSTOM_METHODS) {
        warnings.push(`自定义方法已达上限（${MAX_CUSTOM_METHODS}），多余的已略过`);
        break;
      }
      ids.add(e.id);
      names.add(e.name);
      added.push(e);
    }

    if (added.length === 0) {
      return { ok: false, reason: warnings[0] ?? '没有可入库的方法' };
    }
    const next = [...cur, ...added];
    this.kv.writeJSON(STORAGE_KEYS.customMethods, next);
    this.cache = next;
    this.emit();
    return { ok: true, added, warnings };
  }

  remove(id: string): readonly MethodEntry[] {
    const cur = this.load();
    const next = cur.filter((e) => e.id !== id);
    this.kv.writeJSON(STORAGE_KEYS.customMethods, next);
    this.cache = next;
    this.emit();
    return next;
  }

  clear(): readonly MethodEntry[] {
    this.kv.writeJSON(STORAGE_KEYS.customMethods, []);
    this.cache = [];
    this.emit();
    return this.cache;
  }

  /**
   * 文献方法没有手写剧本，用 SOP 现场拼一个。
   *
   * 和 gewu/genericScript 是同一条兜底路径：11 条内置方法里本来就只有
   * 3 条有手写剧本，剩下的全靠它。文献方法不走这条就「进得了库、开不了局」。
   */
  scriptFor(id: string): GewuScript | undefined {
    const e = this.load().find((m) => m.id === id);
    return e ? genericScript(e) : undefined;
  }

  subscribe(fn: (m: readonly MethodEntry[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.load());
      } catch (e) {
        console.error('[method-library] 监听器异常', e);
      }
    }
  }
}

/* ============================================================
 * 二、文献格物题
 * ============================================================ */

export const MAX_CUSTOM_TOPICS = 40;

function sanitizeTopic(raw: unknown): GewuTopic | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40);
  const title = str(r.title, 20);
  const question = str(r.question, 120);
  if (!id || !title || !question) return null;
  const script = Array.isArray(r.script) ? (r.script as GewuTopic['script']) : [];
  return {
    id,
    title,
    question,
    why: str(r.why, 80),
    src: str(r.src, 60) || '文献提取',
    script,
  };
}

function sanitizeTopics(raw: unknown): GewuTopic[] {
  if (!Array.isArray(raw)) return [];
  const out: GewuTopic[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const x of raw) {
    const t = sanitizeTopic(x);
    if (!t || ids.has(t.id) || titles.has(t.title)) continue;
    ids.add(t.id);
    titles.add(t.title);
    out.push(t);
  }
  return out;
}

export class GewuTopicStore {
  private readonly kv: KeyValueStore;
  private cache: GewuTopic[] | null = null;
  private readonly listeners = new Set<(t: readonly GewuTopic[]) => void>();

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  load(): readonly GewuTopic[] {
    if (this.cache) return this.cache;
    this.cache = sanitizeTopics(this.kv.readJSON<unknown>(STORAGE_KEYS.customGewu, null));
    return this.cache;
  }

  resetCache(): void {
    this.cache = null;
  }

  add(topics: readonly GewuTopic[]): { ok: true; added: GewuTopic[]; warnings: string[] } | { ok: false; reason: string } {
    const cur = this.load();
    const warnings: string[] = [];
    const ids = new Set(cur.map((t) => t.id));
    const titles = new Set(cur.map((t) => t.title));
    const added: GewuTopic[] = [];

    for (const raw of topics) {
      const t = sanitizeTopic(raw);
      if (!t) {
        warnings.push('跳过一条字段不全的格物题');
        continue;
      }
      if (ids.has(t.id) || titles.has(t.title)) {
        warnings.push(`格物题「${t.title}」已存在，跳过`);
        continue;
      }
      if (cur.length + added.length >= MAX_CUSTOM_TOPICS) {
        warnings.push(`文献格物题已达上限（${MAX_CUSTOM_TOPICS}），多余的已略过`);
        break;
      }
      ids.add(t.id);
      titles.add(t.title);
      added.push(t);
    }

    if (added.length === 0) {
      return { ok: false, reason: warnings[0] ?? '没有可入库的格物题' };
    }
    const next = [...cur, ...added];
    this.kv.writeJSON(STORAGE_KEYS.customGewu, next);
    this.cache = next;
    this.emit();
    return { ok: true, added, warnings };
  }

  remove(id: string): readonly GewuTopic[] {
    const cur = this.load();
    const next = cur.filter((t) => t.id !== id);
    this.kv.writeJSON(STORAGE_KEYS.customGewu, next);
    this.cache = next;
    this.emit();
    return next;
  }

  clear(): readonly GewuTopic[] {
    this.kv.writeJSON(STORAGE_KEYS.customGewu, []);
    this.cache = [];
    this.emit();
    return this.cache;
  }

  /** 给 GewuSession 的剧本解析器用：文献题用自己的剧本，内置条目不受影响 */
  scriptFor(id: string): GewuScript | undefined {
    return this.load().find((t) => t.id === id)?.script;
  }

  subscribe(fn: (t: readonly GewuTopic[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.load());
      } catch (e) {
        console.error('[gewu-topics] 监听器异常', e);
      }
    }
  }
}

/* ============================================================
 * 三、文献论题
 * ============================================================ */

export const MAX_CUSTOM_DEBATES = 40;

/**
 * 哲学家名 → 哲人 id。模型给的是「苏格拉底」这样的名字，
 * 界面要的是能直接打开对话线的 id。匹配不上就留空，
 * 由用户在预览时自己选——猜错人比空着更糟。
 */
export function resolvePhilId(phil: string): string {
  const name = phil.trim();
  if (!name) return '';
  const exact = PHILOSOPHERS.find((p) => p.name === name);
  if (exact) return exact.id;
  const loose = PHILOSOPHERS.find((p) => p.name.includes(name) || name.includes(p.name));
  return loose ? loose.id : '';
}

function sanitizeDebate(raw: unknown): DebateTopic | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 40);
  const title = str(r.title, 24);
  const question = str(r.question, 120);
  if (!id || !title || !question) return null;
  const phil = str(r.phil, 10);
  const philId = str(r.philId, 40) || resolvePhilId(phil);
  return { id, title, question, phil, philId, src: str(r.src, 60) || '文献提取' };
}

function sanitizeDebates(raw: unknown): DebateTopic[] {
  if (!Array.isArray(raw)) return [];
  const out: DebateTopic[] = [];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const x of raw) {
    const d = sanitizeDebate(x);
    if (!d || ids.has(d.id) || titles.has(d.title)) continue;
    ids.add(d.id);
    titles.add(d.title);
    out.push(d);
  }
  return out;
}

export class DebateTopicStore {
  private readonly kv: KeyValueStore;
  private cache: DebateTopic[] | null = null;
  private readonly listeners = new Set<(d: readonly DebateTopic[]) => void>();

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  load(): readonly DebateTopic[] {
    if (this.cache) return this.cache;
    this.cache = sanitizeDebates(this.kv.readJSON<unknown>(STORAGE_KEYS.customDebate, null));
    return this.cache;
  }

  resetCache(): void {
    this.cache = null;
  }

  add(debates: readonly DebateTopic[]): { ok: true; added: DebateTopic[]; warnings: string[] } | { ok: false; reason: string } {
    const cur = this.load();
    const warnings: string[] = [];
    const ids = new Set(cur.map((d) => d.id));
    const titles = new Set(cur.map((d) => d.title));
    const added: DebateTopic[] = [];

    for (const raw of debates) {
      const d = sanitizeDebate(raw);
      if (!d) {
        warnings.push('跳过一条字段不全的论题');
        continue;
      }
      if (ids.has(d.id) || titles.has(d.title)) {
        warnings.push(`论题「${d.title}」已存在，跳过`);
        continue;
      }
      if (cur.length + added.length >= MAX_CUSTOM_DEBATES) {
        warnings.push(`文献论题已达上限（${MAX_CUSTOM_DEBATES}），多余的已略过`);
        break;
      }
      ids.add(d.id);
      titles.add(d.title);
      added.push(d);
    }

    if (added.length === 0) {
      return { ok: false, reason: warnings[0] ?? '没有可入库的论题' };
    }
    const next = [...cur, ...added];
    this.kv.writeJSON(STORAGE_KEYS.customDebate, next);
    this.cache = next;
    this.emit();
    return { ok: true, added, warnings };
  }

  remove(id: string): readonly DebateTopic[] {
    const cur = this.load();
    const next = cur.filter((d) => d.id !== id);
    this.kv.writeJSON(STORAGE_KEYS.customDebate, next);
    this.cache = next;
    this.emit();
    return next;
  }

  clear(): readonly DebateTopic[] {
    this.kv.writeJSON(STORAGE_KEYS.customDebate, []);
    this.cache = [];
    this.emit();
    return this.cache;
  }

  subscribe(fn: (d: readonly DebateTopic[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.load());
      } catch (e) {
        console.error('[debate-topics] 监听器异常', e);
      }
    }
  }
}

/* ============================================================
 * 四、暂存区
 * ============================================================ */

/**
 * 暂存条目上限。一次导入一本 30 万字的书，按每段 5 个概念估算也就几百条，
 * 400 足够覆盖正常使用，又能防止解析bug导致无限堆积把 localStorage 撑爆。
 */
export const MAX_STAGED_ITEMS = 400;

/** 暂存条目的稳定键：module + id。关系的 id 是「起点>终点」，天然稳定 */
function stageKey(item: StagedItem): string {
  return `${item.module}:${item.id}`;
}

/** 消毒一条暂存条目。形状不对返回 null（宁可丢一条，不让坏数据躺进暂存区） */
function sanitizeStaged(raw: unknown): StagedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const module = str(r.module, 10);
  const id = str(r.id, 60);
  if (!id || !MODULES.includes(module as IngestModule) && module !== 'relation') return null;
  const name = str(r.name, 60);

  switch (module) {
    case 'method': {
      const e = sanitizeMethod(r.entry);
      return e && e.id === id ? { id, module: 'method', name, entry: e } : null;
    }
    case 'concept': {
      const n = r.node;
      if (!n || typeof n !== 'object') return null;
      const node = n as StarNode;
      if (str(node.id, 40) !== id || !str(node.name, 30) || !str(node.brief, 200)) return null;
      return { id, module: 'concept', name, node };
    }
    case 'relation': {
      const edge = r.edge;
      if (!Array.isArray(edge) || edge.length < 3) return null;
      const [from, to, rel] = edge as unknown[];
      if (str(from, 40) !== id.split('>')[0] || !str(to, 40)) return null;
      if (!RELS.includes(rel as StarEdge[2])) return null;
      return { id, module: 'relation', name, edge: [str(from, 40), str(to, 40), rel as StarEdge[2], str(edge[3], 40)] };
    }
    case 'topic': {
      const t = sanitizeTopic(r.topic);
      return t && t.id === id ? { id, module: 'topic', name, topic: t } : null;
    }
    case 'debate': {
      const d = sanitizeDebate(r.debate);
      return d && d.id === id ? { id, module: 'debate', name, debate: d } : null;
    }
    default:
      return null;
  }
}

export class IngestStageStore {
  private readonly kv: KeyValueStore;
  private cache: StagedItem[] | null = null;
  private readonly listeners = new Set<(s: readonly StagedItem[]) => void>();

  constructor(kv: KeyValueStore) {
    this.kv = kv;
  }

  load(): readonly StagedItem[] {
    if (this.cache) return this.cache;
    const raw = this.kv.readJSON<unknown>(STORAGE_KEYS.ingestStage, null);
    const out: StagedItem[] = [];
    const seen = new Set<string>();
    if (Array.isArray(raw)) {
      for (const x of raw) {
        const item = sanitizeStaged(x);
        const key = item ? stageKey(item) : '';
        if (!item || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    this.cache = out;
    return out;
  }

  resetCache(): void {
    this.cache = null;
  }

  /** 新提取的条目进暂存区。重复键跳过（跨段去重的最后一道闸） */
  add(items: readonly StagedItem[]): { ok: true; added: StagedItem[]; skipped: number } | { ok: false; reason: string } {
    const cur = this.load();
    const seen = new Set(cur.map(stageKey));
    const added: StagedItem[] = [];
    let skipped = 0;

    for (const raw of items) {
      const item = sanitizeStaged(raw);
      if (!item) {
        skipped += 1;
        continue;
      }
      const key = stageKey(item);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      if (cur.length + added.length >= MAX_STAGED_ITEMS) {
        skipped += items.length - added.length - skipped;
        break;
      }      seen.add(key);
      added.push(item);
    }

    if (added.length > 0) {
      const next = [...cur, ...added];
      this.kv.writeJSON(STORAGE_KEYS.ingestStage, next);
      this.cache = next;
      this.emit();
    }
    return { ok: true, added, skipped };
  }

  remove(module: StagedItem['module'], id: string): readonly StagedItem[] {
    const cur = this.load();
    const next = cur.filter((i) => !(i.module === module && i.id === id));
    this.kv.writeJSON(STORAGE_KEYS.ingestStage, next);
    this.cache = next;
    this.emit();
    return next;
  }

  clear(): readonly StagedItem[] {
    this.kv.writeJSON(STORAGE_KEYS.ingestStage, []);
    this.cache = [];
    this.emit();
    return this.cache;
  }

  byModule(m: StagedItem['module']): readonly StagedItem[] {
    return this.load().filter((i) => i.module === m);
  }

  /**
   * 已占用的名字（供下一段的 ParseContext 去重）。
   * 关系条目的 name 是「A→B」展示串，不是概念名，不掺和进来。
   */
  takenNames(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const i of this.load()) {
      if (i.module === 'relation') continue;
      out.add(i.name);
    }
    return out;
  }

  /** 已占用的 id（概念的节点 id + 方法/格物题/论题 id）。关系的 id 不是节点 id，排除 */
  takenIds(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const i of this.load()) {
      if (i.module === 'relation') continue;
      out.add(i.id);
    }
    return out;
  }

  /** 暂存概念的「名字 → 节点 id」表：后续段的关系端点可能指向前面段提炼的概念 */
  conceptNameToId(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const i of this.load()) {
      if (i.module === 'concept') out.set(i.node.name, i.node.id);
    }
    return out;
  }

  subscribe(fn: (s: readonly StagedItem[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.load());
      } catch (e) {
        console.error('[ingest-stage] 监听器异常', e);
      }
    }
  }
}
