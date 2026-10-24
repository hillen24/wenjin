/**
 * 依赖注入
 *
 * core 只创建一次，通过 provide/inject 下发。
 * 不用模块级单例：那样单测里每个用例都会共用同一份状态，无法隔离。
 */

import { inject, provide, type InjectionKey } from 'vue';
import { createCore, type CoreOptions, type WenjinCore } from '@wenjin/core';

export const CORE_KEY: InjectionKey<WenjinCore> = Symbol('wenjin:core');

export function provideCore(opts: CoreOptions = {}): WenjinCore {
  const core = createCore(opts);
  provide(CORE_KEY, core);
  return core;
}

export function useCore(): WenjinCore {
  const core = inject(CORE_KEY);
  if (!core) throw new Error('useCore() 必须在 provideCore() 的后代组件里调用');
  return core;
}
