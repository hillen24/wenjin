<script setup lang="ts">
/**
 * 图标。用 sprite 里定义的 symbol，颜色跟随父级 color。
 *
 * 线描图标（导航、按钮）默认按实心渲染，需要描边的场景在父级写：
 *   .xxx svg { fill: none; stroke: currentColor; stroke-width: 2; }
 * 这和 v2.1 里的做法保持一致，所以视觉上不会有差异。
 *
 * 额外挂一个 `i-xxx` 类名：父级想给某个具体图标做微动效时（比如 hover 时
 * 齿轮转一下、指南针摆一下），直接写 `.i-gear` 就行，不用包额外结构。
 */
withDefaults(defineProps<{ name: string; size?: number | string }>(), { size: 18 });
</script>

<template>
  <svg :width="size" :height="size" fill="currentColor" aria-hidden="true" :class="['wj-icon', name]">
    <use :href="`#${name}`" />
  </svg>
</template>

<style scoped>
.wj-icon {
  display: block;
  flex: none;
  /* 所有图标共享一条过渡，父级只改目标值即可 */
  transition:
    transform 0.28s var(--ease),
    color 0.18s var(--ease),
    opacity 0.18s var(--ease);
}
</style>
