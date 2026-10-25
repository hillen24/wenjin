/**
 * 补充数据：v2.1 里散落在脚本顶部的几个小常量。
 *
 * 它们当初是手写在脚本里的裸常量，抽取脚本没覆盖到，这里补齐。
 * 与前 8 组数据一样，以本文件为唯一来源。
 */

import type { MethodEntry } from '../types';
import { METHOD_ENTRIES } from './methods';

/**
 * 格物卡里「练习句」那一行的标题。
 * 不同方法论产出的东西不一样：A1 出来的是「愿意其发生」，A11 出来的是「48 小时最小验证」，
 * 用统一的「下一步」会把它们讲成同一件事。
 */
export const CARD_LABELS: Record<string, string> = {
  A1: '「愿意其发生」练习',
  A4: '虚妄欲望清单',
  A11: '48 小时最小验证',
  B1: '剃刀结论',
  B6: '追问出来的答案',
  default: '下一步最小行动',
};

/**
 * 内置原著。用户自己载入的书排在其后。
 *
 * 3.9.0：三部完整公版书插入在对应节选之后（ddjFull 跟 laotzi、
 * zzFull 跟 xiaoyao、picoFull 跟 pico）——先尝浅，再读全。
 */
export const BUILTIN_DOCS: readonly string[] = [
  'epictetus',
  'zhuangzi',
  'laotzi',
  'ddjFull',
  'lunyu',
  'xiaoyao',
  'zzFull',
  'daxue',
  'pico',
  'picoFull',
  'petrarch',
  'montaigne',
  'simaqian',
  'wenrtxiang',
];

/**
 * 哲人头像底色。两色渐变，落在 .phil-btn 的 .av 上。
 * 头像是实心剪影、走 currentColor，所以底色决定整张脸的色相。
 */
export const PHIL_GRADIENTS: Record<string, { from: string; to: string }> = {
  socrates: { from: '#4FD1C5', to: '#1E7A8C' },
  epictetus: { from: '#7DA7D9', to: '#3D5A80' },
  kant: { from: '#A8B3C4', to: '#4A5568' },
  nietzsche: { from: '#FF6A4D', to: '#B02E2A' },
  zhuangzi: { from: '#E8B84B', to: '#9A6B1F' },
  wangym: { from: '#8B7CF6', to: '#4C3F91' },
  laotzi: { from: '#6BAF92', to: '#2E6B52' },
  confucius: { from: '#D9A06B', to: '#8C5A2B' },
  montaigne: { from: '#D8B36A', to: '#8C6520' },
  maslow: { from: '#7FC8A9', to: '#2E7D5B' },
};

/** 已点亮的概念。运行时状态在 ProgressStore 里，这里只给初始值。 */
export const INITIAL_LIT_NODES: readonly string[] = [
  'stoic',
  'epictetus',
  'socrates',
  'kant',
  'hume',
  'zhuangzi',
  'wangym',
  'laotzi',
  'confucius',
  'humanism',
  'dignity',
  'sartre',
  'camus',
  'maslow',
];

/** id → 条目 的索引，模块加载时建一次。方法论被引用得太频繁，每次 find 太浪费。 */
export const METHOD_INDEX: Record<string, MethodEntry> = Object.fromEntries(
  METHOD_ENTRIES.map((e) => [e.id, e]),
);

/** 按 id 取方法论条目 */
export function entryById(id: string): MethodEntry | undefined {
  return METHOD_INDEX[id];
}
