/**
 * 跨视图导航
 *
 * 视图之间有一堆「去那边」的动作：从方法论卡去格物、从星图概念跳到原文段落、
 * 从伴读回答跳回星图。旧版靠全局函数 switchTab / gotoNode 直接操作 DOM，
 * 谁都调得动，也谁都可能把状态改坏。
 *
 * 这里收成一个接口：视图只能申请「跳转」，由外壳决定怎么实现。
 * 好处是 StarView 不需要知道格物存在，也不需要层层 emit。
 */

import { inject, provide, type InjectionKey } from 'vue';

export type TabKey = 'star' | 'read' | 'ingest' | 'method' | 'gewu' | 'debate' | 'book' | 'set';

export interface NavApi {
  /** 切到某个视图 */
  go(tab: TabKey): void;
  /** 去星图并选中某个概念 */
  gotoNode(nodeId: string): void;
  /** 去格物并从指定条目开始 */
  startGewu(entryId: string): void;
  /** 去精读并定位到某篇的第 para 段 */
  openDoc(docId: string, para: number): void;
  /** 底部提示，2.8 秒自动消失 */
  toast(message: string): void;
}

export const NAV_KEY: InjectionKey<NavApi> = Symbol('wenjin:nav');

export function provideNav(nav: NavApi): void {
  provide(NAV_KEY, nav);
}

export function useNav(): NavApi {
  const nav = inject(NAV_KEY);
  if (!nav) throw new Error('useNav() 必须在 provideNav() 的后代组件里调用');
  return nav;
}
