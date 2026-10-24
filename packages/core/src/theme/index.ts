/**
 * 主题
 *
 * 两套 token 由 CSS 侧的 :root[data-theme="dark"] / [data-theme="light"] 承载，
 * 这里只负责切换属性和持久化。
 */

import type { ThemeMode } from '../types';
import { KeyValueStore, STORAGE_KEYS } from '../storage';

export const THEME_ATTR = 'data-theme';

/** 主题属性挂在哪个元素上。旧版挂 documentElement，保持一致。 */
export function applyTheme(theme: ThemeMode, doc?: Document): void {
  // 纯逻辑环境（Node 单测、构建期预渲染）里没有 document，跳过即可，
  // 不该因为「改主题」把整个 core 包炸掉。
  const d = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!d) return;

  const root = d.documentElement;
  root.setAttribute(THEME_ATTR, theme);
  /**
   * color-scheme 让浏览器原生控件（滚动条、输入框、日期选择器）
   * 跟着切换明暗。旧版没设这个，于是暗色页面里滚出一条亮色滚动条。
   */
  root.style.colorScheme = theme;
}

export function readStoredTheme(kv: KeyValueStore): ThemeMode | null {
  const raw = kv.readRaw(STORAGE_KEYS.theme, '');
  return raw === 'dark' || raw === 'light' ? raw : null;
}

export function storeTheme(kv: KeyValueStore, theme: ThemeMode): boolean {
  return kv.writeRaw(STORAGE_KEYS.theme, theme);
}

/**
 * 优先级：磁盘里存过的 > 系统偏好 > 暗色。
 * 旧版直接硬编码 'dark' 开局，系统是亮色的用户每次都要手动切一次。
 */
export function resolveInitialTheme(
  stored: ThemeMode | null,
  prefersDark?: boolean,
): ThemeMode {
  if (stored) return stored;
  if (prefersDark !== undefined) return prefersDark ? 'dark' : 'light';
  return 'dark';
}

export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}
