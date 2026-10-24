<script setup lang="ts">
/**
 * 图标。用 sprite 里定义的 symbol，颜色跟随父级 color。
 *
 * 线描图标（导航、按钮）默认按实心渲染，需要描边的场景在父级写：
 *   .xxx svg { fill: none; stroke: currentColor; stroke-width: 2; }
 * 这和 v2.1 里的做法保持一致，所以视觉上不会有差异。
 */
withDefaults(defineProps<{ name: string; size?: number | string }>(), { size: 18 });
</script>

<template>
  <svg :width="size" :height="size" fill="currentColor" aria-hidden="true" class="wj-icon">
    <use :href="`#${name}`" />
  </svg>
</template>

<style scoped>
.wj-icon {
  display: block;
  flex: none;
}
</style>
