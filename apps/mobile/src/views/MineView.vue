<script setup lang="ts">
/**
 * 我的 · 手机端的聚合页
 *
 * 手机底栏只放得下五格，「方法论库 / 我的哲学 / 设置」这三项
 * 都是「偶尔进去调一下」的性质，收进这里比挤在底栏更合理。
 *
 * 这页只读 core 的数据，不做任何写入 —— 统计数字和各个视图里的完全一致，
 * 因为它们读的是同一个 store，不存在第二份计数。
 */

import { computed, onBeforeUnmount, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import { useCore, useNav } from '@wenjin/app';

const core = useCore();
const nav = useNav();

const m = ref(core.materials.get());
const litCount = ref(core.progress.lit().length);

const offMaterials = core.materials.subscribe((next) => {
  m.value = next;
});
const offProgress = core.progress.subscribe((ids) => {
  litCount.value = ids.length;
});

onBeforeUnmount(() => {
  offMaterials();
  offProgress();
});

const stats = computed<{ label: string; value: number }[]>(() => [
  { label: '格物卡', value: m.value.cards.length },
  { label: '论道场', value: m.value.debates.length },
  { label: '摘录', value: m.value.readings.length },
  { label: '点亮', value: litCount.value },
]);

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
});

/** 三句轮换，不重复灌鸡汤，只给一个「从哪儿进门」的提示 */
const LINE = '哲学不在读懂别人，在于你终于能说清自己卡在哪。';

interface Entry {
  key: 'method' | 'book' | 'set';
  icon: string;
  title: string;
  desc: string;
}

const ENTRIES: readonly Entry[] = [
  {
    key: 'method',
    icon: 'i-compass',
    title: '方法论库',
    desc: '斯多葛二分法、奥卡姆剃刀、现象学悬置…每一条都能直接拿去用',
  },
  {
    key: 'book',
    icon: 'i-pen',
    title: '我的哲学书',
    desc: '把格物卡、论道、摘录自动编成一本书，看自己的思想长到哪一步',
  },
  {
    key: 'set',
    icon: 'i-gear',
    title: '设置',
    desc: '接上自己的模型、切换黑天白天、调朗读音色',
  },
];
</script>

<template>
  <div class="mine scroll-y">
    <header class="hello">
      <p class="greet">{{ greeting }}</p>
      <p class="line serif">{{ LINE }}</p>
    </header>

    <div class="stats">
      <div v-for="s in stats" :key="s.label" class="stat">
        <b>{{ s.value }}</b>
        <span>{{ s.label }}</span>
      </div>
    </div>

    <nav class="entries">
      <button
        v-for="e in ENTRIES"
        :key="e.key"
        type="button"
        class="entry"
        @click="nav.go(e.key)"
      >
        <span class="ic"><Icon :name="e.icon" :size="19" /></span>
        <span class="txt">
          <b>{{ e.title }}</b>
          <small>{{ e.desc }}</small>
        </span>
        <span class="arrow">›</span>
      </button>
    </nav>

    <footer class="about">
      <span>致知 · 思想栖所</span>
      <span class="ver">v3.7</span>
      <span class="note">数据只存在这台设备上，断网可用</span>
    </footer>
  </div>
</template>

<style scoped>
.mine {
  height: 100%;
  padding: 20px 16px 32px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hello {
  padding: 4px 2px 0;
}

.greet {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.line {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--ink2);
}

/* ---------- 统计 ---------- */

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--line);
  border: 1px solid var(--line);
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 14px 4px;
  background: var(--card);
}

.stat b {
  font-size: 20px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.stat span {
  font-size: 11.5px;
  color: var(--ink3);
}

/* ---------- 入口 ---------- */

.entries {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.entry {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;
  padding: 15px 14px;
  text-align: left;
  border-radius: var(--radius);
  background: var(--card);
  border: 1px solid var(--line);
  transition: border-color 0.16s var(--ease);
}

.entry:active {
  border-color: var(--line-hi);
}

.ic {
  width: 38px;
  height: 38px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: var(--accent-soft);
  color: var(--accent);
}

.ic svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.txt b {
  font-size: 14.5px;
  font-weight: 500;
}

.txt small {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink3);
}

.arrow {
  flex: none;
  font-size: 18px;
  color: var(--ink3);
}

/* ---------- 关于 ---------- */

.about {
  margin-top: auto;
  padding: 12px 2px 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--ink3);
}

.ver {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--field);
  border: 1px solid var(--line);
  font-size: 11px;
}

.note {
  flex-basis: 100%;
  font-size: 11.5px;
}
</style>
