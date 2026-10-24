/**
 * 数据层统一出口
 *
 * 所有内置内容都从这里取。UI 层不需要知道数据放在哪个文件里，
 * 以后换 IndexedDB、换远程同步，改的也只是这里。
 */

export { PHILOSOPHERS } from './philosophers';
export { STAR_NODES, STAR_EDGES } from './star-map';
export { METHOD_ENTRIES } from './methods';
export { READINGS } from './readings';
export { GEWU_SCRIPTS, CARD_TEXTS } from './gewu';
export { DEBATE_FLOW } from './debate';
export { PROVIDERS } from './providers';
export { EDGE_VOICES } from './voices';
export {
  BUILTIN_DOCS,
  CARD_LABELS,
  INITIAL_LIT_NODES,
  METHOD_INDEX,
  PHIL_GRADIENTS,
  entryById,
} from './extras';
