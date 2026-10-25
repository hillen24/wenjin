/**
 * 暂存条目入库路由：一次确认，四处落库
 *
 * 用户在预览页勾选的条目可能横跨四个模块（方法 / 概念 / 关系 / 格物题 / 论题），
 * 这里按模块分发到各自的 store。分发顺序有意为之：
 *   概念 → 关系 → 方法 → 格物题 → 论题
 * 星图是其他模块的挂靠点（方法的 lit、关系的端点都指向概念 id），
 * 所以概念必须最先过闸——它被去重挡下时，关系会因为端点未知被同批挡下，
 * 而不是把一条悬空边写进图里。
 *
 * 每个 store 都会独立再做一次消毒与去重（磁盘数据 ≠ 内存数据），
 * 所以这里只做分发和记账，不信任任何输入。
 */

import type { StarEdge, StarNode, StagedItem } from '../types';
import type { StarGraphStore } from '../star/custom';
import type { DebateTopicStore, GewuTopicStore, MethodLibraryStore } from './stores';

export interface CommitTargets {
  methods: MethodLibraryStore;
  star: StarGraphStore;
  topics: GewuTopicStore;
  debates: DebateTopicStore;
}

export interface CommitReport {
  methods: number;
  concepts: number;
  relations: number;
  topics: number;
  debates: number;
  /** 被去重 / 容量 / 校验挡下的条数（勾了但没进去的） */
  skipped: number;
  warnings: string[];
}

/**
 * 把一批暂存条目写进四个 store。
 *
 * builtin 传内置星图（节点 + 边），用于 id 冲突检测、同名去重、连边去重 ——
 * 和 StarGraphStore.add 的约定一致。
 */
export function commitStaged(
  items: readonly StagedItem[],
  targets: CommitTargets,
  builtin: { nodes?: readonly StarNode[]; edges?: readonly StarEdge[] } = {},
): CommitReport {
  const report: CommitReport = {
    methods: 0,
    concepts: 0,
    relations: 0,
    topics: 0,
    debates: 0,
    skipped: 0,
    warnings: [],
  };
  if (items.length === 0) return report;

  // TS 5.5+ 的 filter 能按判别字段窄化联合类型，不用写类型谓词
  const methods = items.filter((i) => i.module === 'method').map((i) => i.entry);
  const nodes = items.filter((i) => i.module === 'concept').map((i) => i.node);
  const edges = items.filter((i) => i.module === 'relation').map((i) => i.edge);
  const topics = items.filter((i) => i.module === 'topic').map((i) => i.topic);
  const debates = items.filter((i) => i.module === 'debate').map((i) => i.debate);

  // 1. 概念（其他模块的挂靠点，最先过闸）
  if (nodes.length > 0) {
    const r = targets.star.add({ nodes, edges }, builtin);
    if (r.ok) {
      report.concepts = r.graph.nodes.length;
      report.relations = r.graph.edges.length;
      report.warnings.push(...r.warnings);
    } else {
      // 整批被挡下时，逐条 warnings 比笼统原因有用（「谁和内置重名了」）
      report.warnings.push(r.reason, ...r.warnings);
    }
  }

  // 2. 方法论
  if (methods.length > 0) {
    const r = targets.methods.add(methods);
    if (r.ok) {
      report.methods = r.added.length;
      report.warnings.push(...r.warnings);
    } else {
      report.warnings.push(r.reason);
    }
  }

  // 3. 格物题
  if (topics.length > 0) {
    const r = targets.topics.add(topics);
    if (r.ok) {
      report.topics = r.added.length;
      report.warnings.push(...r.warnings);
    } else {
      report.warnings.push(r.reason);
    }
  }

  // 4. 论题
  if (debates.length > 0) {
    const r = targets.debates.add(debates);
    if (r.ok) {
      report.debates = r.added.length;
      report.warnings.push(...r.warnings);
    } else {
      report.warnings.push(r.reason);
    }
  }

  report.skipped =
    items.length - (report.methods + report.concepts + report.relations + report.topics + report.debates);
  return report;
}
