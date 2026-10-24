/**
 * 窄屏判定
 *
 * 视图里到处要判断「现在是不是手机形态」，但阈值必须只有一个：
 * CSS 里的断点是 760px，JS 里如果各写各的（620 / 700 / 760 混着来），
 * 就会出现「样式已经切成单列，逻辑还以为自己在宽屏」的错位。
 *
 * 用 matchMedia 而不是 resize + innerWidth：
 * matchMedia 只在跨过断点那一刻触发一次，不会因为拖窗口每像素都重算。
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** 与各视图 <style> 里的 @media (max-width: 760px) 保持一致 */
export const NARROW_MAX = 760;

export function useNarrow(max: number = NARROW_MAX): Ref<boolean> {
  const narrow = ref(false);
  let mq: MediaQueryList | null = null;

  function onChange(e: MediaQueryListEvent | MediaQueryList): void {
    narrow.value = e.matches;
  }

  onMounted(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      narrow.value = typeof window !== 'undefined' && window.innerWidth <= max;
      return;
    }
    mq = window.matchMedia(`(max-width: ${max}px)`);
    onChange(mq);
    mq.addEventListener('change', onChange);
  });

  onBeforeUnmount(() => {
    mq?.removeEventListener('change', onChange);
    mq = null;
  });

  return narrow;
}
