/**
 * 安卓硬件返回键
 *
 * ===== 这是一个真实的坑 =====
 *
 * 手机上用户按返回键，期望的是「回到上一层」。
 * 但本应用早期用 hash 路由（`#read` / `#set`…），而 Android 的返回键
 * 在 WebView 里走的是**历史栈**。问题在于：
 *
 * 1. 切页面时代码写 `window.location.hash = v` —— 这会**压入**一条历史记录；
 * 2. 于是「星系 → 精读 → 我的 → 设置」会留下 4 条历史；
 * 3. 用户在设置页按返回键 → 回到「我的」，再按一次 → 回到「星系」，
 *    但用户心里想的可能是「退出应用」；
 * 4. 更糟的是某些机型上返回键直接**杀掉应用**，用户的阅读进度看起来「丢了」。
 *
 * 现在的做法：
 * - 用一个显式的**页面栈**记录用户的导航路径（不是浏览器的历史）；
 * - 返回键优先在页面栈里回退，栈空了才交给系统（退出应用）；
 * - 双击返回键在栈顶时给一次「再按一次退出」的提示，给用户反悔的余地。
 *
 * 浏览器 dev 模式下没有原生返回键，函数直接返回 —— 不影响 Web 预览。
 */

import { App as CapApp } from '@capacitor/app';

/** 返回键处理器：返回 true 表示「我处理了，别再传给系统」 */
export type BackHandler = () => boolean | Promise<boolean>;

/**
 * 装上返回键监听。
 *
 * @param onBack 自定义返回逻辑。返回 true = 已处理；返回 false = 交回系统（通常退出应用）
 * @returns 卸载函数
 */
export function setupBackButton(onBack: BackHandler): () => void {
  if (!isNative()) return () => {};

  let disposed = false;

  const listener = CapApp.addListener('backButton', () => {
    if (disposed) return;
    void Promise.resolve(onBack()).then((handled) => {
      // 返回 false → 让系统自己处理（退出应用）
      if (!handled) void CapApp.minimizeApp();
    });
  });

  return () => {
    disposed = true;
    void listener.then((l) => l.remove()).catch(() => {});
  };
}

function isNative(): boolean {
  return typeof window !== 'undefined' && !!(window as { Capacitor?: unknown }).Capacitor;
}
