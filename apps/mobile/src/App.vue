<script setup lang="ts">
/**
 * 手机端外壳：顶部状态栏 + 内容区 + 底部标签栏
 *
 * 和电脑端是同一个 shell 概念，只是导航摆的位置不同：
 * 电脑端竖排七项放得下，手机上五格是极限，所以「方法论库 / 我的哲学 / 设置」
 * 收进「我的」聚合页（MineView），进去之后顶栏出现返回。
 *
 * 视图本身来自 @wenjin/app，两端共用同一份实现。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Icon, WenjinSprite } from '@wenjin/ui';
import type { AiStatus } from '@wenjin/core';
import {
  BookView,
  DebateView,
  GewuView,
  MethodsView,
  ReaderView,
  SettingsView,
  StarView,
  provideCore,
  provideNav,
  type NavApi,
  type TabKey,
} from '@wenjin/app';
import MineView from './views/MineView.vue';
import { capFetch, isNativeHttp } from './capFetch';

/**
 * AI 请求在真机上必须走原生通道：WebView 拦第三方 API 的跨源响应，
 * DeepSeek / SiliconFlow 都不带 CORS 头，标准 fetch 会全军覆没。
 * 浏览器 dev 模式没有原生层，自动落回标准 fetch。
 */
const core = provideCore(isNativeHttp() ? { fetchImpl: capFetch } : {});

/** 手机端多一个 'me'：它不是 TabKey，是聚合页 */
type MobileTab = TabKey | 'me';

interface TabDef {
  key: MobileTab;
  label: string;
  icon: string;
}

const TABS: readonly TabDef[] = [
  { key: 'star', label: '星系', icon: 'i-star' },
  { key: 'read', label: '精读', icon: 'i-book' },
  { key: 'gewu', label: '格物', icon: 'i-moon' },
  { key: 'debate', label: '论道', icon: 'i-scale' },
  { key: 'me', label: '我的', icon: 'i-pen' },
];

/** 「我的」这个底部格，在进到它的子页时也应该亮着 */
const MINE_SUBS: readonly TabKey[] = ['method', 'book', 'set'];

const ALL_KEYS: readonly MobileTab[] = [...TABS.map((t) => t.key), ...MINE_SUBS];

function readTabFromHash(): MobileTab {
  const raw = window.location.hash.replace(/^#/, '');
  return ALL_KEYS.find((k) => k === raw) ?? 'star';
}

const tab = ref<MobileTab>(readTabFromHash());

watch(tab, (v) => {
  if (window.location.hash !== `#${v}`) window.location.hash = v;
});

function onHashChange(): void {
  tab.value = readTabFromHash();
}

const theme = ref(core.theme.current);
const aiStatus = ref<AiStatus>(core.ai.status);

const offAi = core.ai.subscribe((s) => {
  aiStatus.value = s;
});

/** 当前是否在「我的」的子页里 —— 顶栏据此决定要不要出返回箭头 */
const inMineSub = computed(() => MINE_SUBS.includes(tab.value as TabKey));

function isTabOn(key: MobileTab): boolean {
  if (key === 'me') return tab.value === 'me' || inMineSub.value;
  return tab.value === key;
}

const pageTitle = computed(() => {
  switch (tab.value) {
    case 'star':
      return '概念星系';
    case 'read':
      return '精读伴读';
    case 'gewu':
      return '日常格物';
    case 'debate':
      return '论道';
    case 'method':
      return '方法论库';
    case 'book':
      return '我的哲学书';
    case 'set':
      return '设置';
    default:
      return '我的';
  }
});

/* ---------------- 跨视图导航 ---------------- */

const focusNode = ref<{ id: string } | null>(null);
const jumpDoc = ref<{ id: string; para: number } | null>(null);

const toastMsg = ref('');
let toastTimer = 0;

function showToast(message: string): void {
  toastMsg.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMsg.value = '';
  }, 2400);
}

const nav: NavApi = {
  go(next: TabKey): void {
    tab.value = next;
  },
  gotoNode(nodeId: string): void {
    focusNode.value = { id: nodeId };
    tab.value = 'star';
  },
  startGewu(entryId: string): void {
    core.gewu.setEntry(entryId);
    tab.value = 'gewu';
    showToast(`已切到格物 · ${entryId}`);
  },
  openDoc(docId: string, para: number): void {
    jumpDoc.value = { id: docId, para };
    tab.value = 'read';
  },
  toast: showToast,
};

provideNav(nav);

/* ---------------- 主题与 AI ---------------- */

const aiTone = computed<'ok' | 'warn' | 'testing'>(() => {
  switch (aiStatus.value.state) {
    case 'verified':
      return 'ok';
    case 'verifying':
      return 'testing';
    default:
      return 'warn';
  }
});

const aiTitle = computed(() => {
  const s = aiStatus.value;
  switch (s.state) {
    case 'verified':
      return `正在用真实模型：${s.provider} / ${s.model}`;
    case 'failed':
      return `上次失败：${s.reason}`;
    case 'unconfigured':
      return '未配置 · 现在走预置脚本，点这里去设置';
    default:
      return '配置已填好，会自动验证一次';
  }
});

function toggleTheme(): void {
  theme.value = core.theme.toggle();
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  void core.ai.autoVerify();
});

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.clearTimeout(toastTimer);
  offAi();
});
</script>

<template>
  <WenjinSprite />

  <div class="m-shell">
    <header class="m-top">
      <button v-if="inMineSub" type="button" class="back" @click="tab = 'me'">
        <Icon name="i-chevron" :size="18" />
      </button>
      <span v-else class="seal">
        <svg aria-hidden="true"><use href="#i-mark" /></svg>
      </span>

      <b class="title">{{ pageTitle }}</b>

      <button
        type="button"
        class="ai-dot"
        :class="aiTone"
        :title="aiTitle"
        @click="tab = 'set'"
      >
        <span class="d" />
      </button>

      <button
        type="button"
        class="theme"
        :title="theme === 'dark' ? '切到白天' : '切到黑天'"
        @click="toggleTheme"
      >
        <Icon :name="theme === 'dark' ? 'i-sun' : 'i-moon'" :size="17" />
      </button>
    </header>

    <main class="m-stage">
      <Transition name="view" mode="out-in">
        <StarView v-if="tab === 'star'" key="star" :focus="focusNode?.id ?? null" />
        <ReaderView v-else-if="tab === 'read'" key="read" :jump="jumpDoc" />
        <GewuView v-else-if="tab === 'gewu'" key="gewu" />
        <DebateView v-else-if="tab === 'debate'" key="debate" />
        <MineView v-else-if="tab === 'me'" key="me" />
        <MethodsView v-else-if="tab === 'method'" key="method" />
        <BookView v-else-if="tab === 'book'" key="book" />
        <SettingsView v-else-if="tab === 'set'" key="set" />
      </Transition>
    </main>

    <nav class="m-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        type="button"
        class="m-tab"
        :class="{ on: isTabOn(t.key) }"
        @click="tab = t.key"
      >
        <Icon :name="t.icon" :size="20" />
        <span>{{ t.label }}</span>
      </button>
    </nav>
  </div>

  <div class="toast" :class="{ on: !!toastMsg }">{{ toastMsg }}</div>
</template>

<style scoped>
.m-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ---------- 顶栏 ---------- */

.m-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  /* 刘海屏：把状态栏高度让出来，否则标题会被挡住 */
  padding: calc(env(safe-area-inset-top, 0px) + 10px) 14px 10px;
  /*
   * 手机端不用半透明 + backdrop-filter：
   * Android WebView 对它支持不稳，滚动时还会掉帧；屏幕上也没有需要「透出下面内容」的场景。
   * 用不透明的 bg2，颜色和主区只差一档，层级关系照样成立。
   */
  background: var(--bg2);
  border-bottom: 1px solid var(--line);
}

.seal,
.back {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 8px;
}

.seal {
  background: var(--accent);
  color: #fff;
}

.seal svg {
  /* 压缩标是瘦高的火形，给足高度 */
  width: 15px;
  height: 19px;
  fill: currentColor;
  stroke: none;
}

.back {
  color: var(--ink2);
  margin-left: -4px;
}

.back svg {
  /* 复用 i-chevron（右箭头）翻转成返回箭头，省一个 symbol */
  transform: rotate(180deg);
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-dot {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
}

.ai-dot .d {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink3);
}

.ai-dot.ok .d {
  background: var(--jade);
}

.ai-dot.warn .d {
  background: var(--gold);
}

.ai-dot.testing .d {
  background: var(--steel);
  animation: pulse 1.2s var(--ease) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.theme {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--ink2);
}

.theme svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ---------- 内容区 ---------- */

.m-stage {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--bg);
}

/* ---------- 底栏 ---------- */

.m-tabs {
  flex: none;
  display: flex;
  align-items: stretch;
  /* 同顶栏：不用半透明，避免 WebView 的合成层问题 */
  background: var(--bg2);
  border-top: 1px solid var(--line);
  /* 手势条：留出底部安全区 */
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.m-tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 0 7px;
  /* 手机上 10.5px 太细，压到看不清；用 ink2 而不是 ink3 保证对比度 */
  color: var(--ink2);
  font-size: 11px;
  letter-spacing: 0.02em;
  transition: color 0.16s var(--ease);
}

.m-tab svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 选中的那一格：图标轻轻抬起来，是「我在这一页」最省力的暗示 */
.m-tab.on .wj-icon {
  transform: translateY(-2px) scale(1.08);
}

.m-tab.on {
  color: var(--accent);
}

/* 提示条要抬到底部标签栏和手势条之上，否则会被压掉一半 */
.toast {
  bottom: calc(env(safe-area-inset-bottom, 0px) + 66px);
  max-width: calc(100vw - 28px);
  padding: 9px 16px;
  font-size: 12px;
}

/* 手机端切页：只做淡入，不做位移 —— 位移在 60Hz 屏上容易看见跳帧 */
.view-enter-active {
  transition: opacity 0.16s var(--ease);
}

.view-leave-active {
  transition: opacity 0.08s var(--ease);
}

.view-enter-from,
.view-leave-to {
  opacity: 0;
}
</style>
