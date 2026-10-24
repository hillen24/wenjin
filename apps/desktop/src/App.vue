<script setup lang="ts">
/**
 * 电脑端外壳：左侧竖排导航 + 中间视野中心
 *
 * 布局本身很简单，重点在于它是「壳」——视图切换、主题、AI 状态、跨视图导航与提示
 * 都在这里收口，各视图只管自己的内容。
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
  setupDesktopSync,
  type NavApi,
  type TabKey,
} from '@wenjin/app';

const core = provideCore();

interface TabDef {
  key: TabKey;
  label: string;
  icon: string;
}

const TABS: readonly TabDef[] = [
  { key: 'star', label: '概念星系', icon: 'i-star' },
  { key: 'read', label: '精读伴读', icon: 'i-book' },
  { key: 'method', label: '方法论库', icon: 'i-compass' },
  { key: 'gewu', label: '日常格物', icon: 'i-moon' },
  { key: 'debate', label: '论道', icon: 'i-scale' },
  { key: 'book', label: '我的哲学', icon: 'i-pen' },
  { key: 'set', label: '设置', icon: 'i-gear' },
];

/**
 * 视图切换与 URL hash 双向同步。
 * 好处很实际：刷新不会跳回星图，状态也能通过链接分享/复现。
 */
function readTabFromHash(): TabKey {
  const raw = window.location.hash.replace(/^#/, '');
  return TABS.find((t) => t.key === raw)?.key ?? 'star';
}

const tab = ref<TabKey>(readTabFromHash());

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

const activeTab = computed(() => TABS.find((t) => t.key === tab.value) ?? TABS[0]!);

/* ============================================================
 * 跨视图导航
 * ============================================================ */

/** 星图要选中的节点。每次跳转换一个新对象，保证同值也能触发。 */
const focusNode = ref<{ id: string } | null>(null);
/** 精读要定位的位置 */
const jumpDoc = ref<{ id: string; para: number } | null>(null);

const toastMsg = ref('');
let toastTimer = 0;

function showToast(message: string): void {
  toastMsg.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastMsg.value = '';
  }, 2800);
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

/* ============================================================
 * 主题与 AI 状态
 * ============================================================ */

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

const aiLabel = computed(() => {
  const s = aiStatus.value;
  switch (s.state) {
    case 'verified':
      return `${s.provider} 已接入`;
    case 'verifying':
      return '正在验证…';
    case 'unconfigured':
      return '预置脚本 · 未配置';
    case 'failed':
      return '预置脚本 · 连接失败';
    case 'unverified':
      return '预置脚本 · 待验证';
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
      return '到「设置 → AI 服务」填 Base URL 和 API Key';
    default:
      return '配置已填好，会自动验证一次；也可以到设置页点「测试连接」';
  }
});

function toggleTheme(): void {
  theme.value = core.theme.toggle();
}

/**
 * 键盘快捷键：Alt + 1..7 直接切页。
 *
 * 用 Alt 而不是裸数字，是因为这些页面里有输入框和数字表单，
 * 裸数字会把键入吃掉。Alt 组合在输入框里也不会误触。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > TABS.length) return;
  e.preventDefault();
  const target = TABS[n - 1];
  if (target) tab.value = target.key;
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onKeydown);
  // 启动补验：配置齐全但指纹还没通过时静默试一次，不指望用户记得点按钮
  void core.ai.autoVerify();
  /* 电脑端是局域网同步的服务端：把本机数据持续交给主进程，
     手机来拉取时主进程才有东西可给。手机端没有这个桥，调用会自己返回。 */
  setupDesktopSync();
});

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('keydown', onKeydown);
  window.clearTimeout(toastTimer);
  offAi();
});
</script>

<template>
  <WenjinSprite />

  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="seal">
          <svg aria-hidden="true"><use href="#i-mark" /></svg>
        </span>
        <div class="brand-text">
          <b>问津</b>
          <small>思想栖所</small>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="(t, i) in TABS"
          :key="t.key"
          type="button"
          class="nav-btn"
          :class="{ on: tab === t.key }"
          :title="`${t.label} · Alt+${i + 1}`"
          @click="tab = t.key"
        >
          <Icon :name="t.icon" :size="18" />
          <span>{{ t.label }}</span>
          <span class="nav-key">{{ i + 1 }}</span>
        </button>
      </nav>

      <div class="side-foot">
        <button
          type="button"
          class="theme-btn"
          :title="theme === 'dark' ? '切到白天' : '切到黑天'"
          @click="toggleTheme"
        >
          <Icon :name="theme === 'dark' ? 'i-sun' : 'i-moon'" :size="16" />
          <span>{{ theme === 'dark' ? '白天' : '黑天' }}</span>
        </button>

        <!-- 状态条原来是个纯展示的 div，点了没反应；现在直接进设置，省一次找路 -->
        <button type="button" class="ai-chip" :class="aiTone" :title="aiTitle" @click="nav.go('set')">
          <span class="dot" />
          <span class="chip-text">{{ aiLabel }}</span>
        </button>
      </div>
    </aside>

    <main class="stage">
      <Transition name="view" mode="out-in">
        <StarView v-if="tab === 'star'" key="star" :focus="focusNode?.id ?? null" />
        <ReaderView v-else-if="tab === 'read'" key="read" :jump="jumpDoc" />
        <MethodsView v-else-if="tab === 'method'" key="method" />
        <GewuView v-else-if="tab === 'gewu'" key="gewu" />
        <DebateView v-else-if="tab === 'debate'" key="debate" />
        <BookView v-else-if="tab === 'book'" key="book" />
        <SettingsView v-else-if="tab === 'set'" key="set" />
        <div v-else key="fallback" class="fallback">{{ activeTab.label }}</div>
      </Transition>
    </main>
  </div>

  <div class="toast" :class="{ on: !!toastMsg }">{{ toastMsg }}</div>
</template>

<style scoped>
.shell {
  display: flex;
  /* 用 100vh 而不是 100%：后者依赖 html/body/#app 三级 height 链，
     任何一环被外部样式打断就会塌成内容高度。 */
  height: 100vh;
  overflow: hidden;
}

/* ---------- 侧栏 ---------- */

.sidebar {
  width: 216px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 12px 14px;
  background: var(--sb-bg);
  border-right: 1px solid var(--line);
  backdrop-filter: blur(18px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 6px 16px;
}

.seal {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--accent);
  /* 标记是填充图形，靠 currentColor 上色 */
  color: #fff;
  transition: transform 0.3s var(--ease);
}

/* 悬停时火苗轻轻摇一下——符号是静的，但不能是死的 */
.brand:hover .seal {
  transform: rotate(-4deg) scale(1.04);
}

.seal svg {
  /* 火形是瘦高的（12.5×18），给足高度才不显小 */
  width: 20px;
  height: 24px;
  fill: currentColor;
  stroke: none;
  /* 火焰摇曳：极小的角度摆动，只在 hover 时跑，不打扰阅读 */
}

.brand:hover .seal svg {
  animation: flame-sway 2.4s var(--ease) infinite;
  transform-origin: 50% 78%;
}

@keyframes flame-sway {
  0%,
  100% {
    transform: rotate(0deg);
  }
  35% {
    transform: rotate(3deg);
  }
  70% {
    transform: rotate(-2deg);
  }
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text b {
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.06em;
}

.brand-text small {
  font-size: 11px;
  color: var(--ink3);
  letter-spacing: 0.14em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
}

.nav-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  color: var(--ink2);
  font-size: 13.5px;
  text-align: left;
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}

.nav-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nav-btn:hover {
  background: var(--card-hi);
  color: var(--ink);
}

.nav-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 快捷键提示：平时藏着，hover 整条导航时才浮出来 */
.nav-key {
  margin-left: auto;
  font-size: 10px;
  color: var(--ink3);
  opacity: 0;
  transition: opacity 0.16s var(--ease);
}

.nav:hover .nav-key {
  opacity: 0.55;
}

/* ---------- 图标的微动效 ----------
 * 每个图标只做「和它自己的语义有关」的一个小动作：
 * 齿轮转、指南针摆、笔倾、月亮斜、星星涨。做多了就是廉价的抖动。
 */

.nav-btn:hover .i-gear {
  transform: rotate(55deg);
}

.nav-btn:hover .i-compass {
  transform: rotate(-16deg);
}

.nav-btn:hover .i-pen {
  transform: rotate(-10deg) translateY(-0.5px);
}

.nav-btn:hover .i-moon {
  transform: rotate(-12deg);
}

.nav-btn:hover .i-star {
  transform: scale(1.14);
}

.nav-btn:hover .i-book,
.nav-btn:hover .i-scale {
  transform: translateY(-1.5px);
}

.nav-btn.on .i-star {
  transform: scale(1.06);
}

/* 切页：极短的淡入 + 上浮，够用来「确认操作生效」，不够用来察觉动画 */
.view-enter-active {
  transition: opacity 0.18s var(--ease), transform 0.22s var(--ease);
}

.view-leave-active {
  transition: opacity 0.1s var(--ease);
}

.view-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.view-leave-to {
  opacity: 0;
}

.side-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.theme-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  border-radius: var(--radius-sm);
  color: var(--ink2);
  font-size: 12.5px;
}

.theme-btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.theme-btn:hover {
  background: var(--card-hi);
  color: var(--ink);
}

.ai-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 11px;
  border-radius: var(--radius-sm);
  background: var(--card);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--ink2);
  min-width: 0;
  text-align: left;
}

.ai-chip:hover {
  border-color: var(--line-hi);
  color: var(--ink);
}

.chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--ink3);
}

.ai-chip.ok .dot {
  background: var(--jade);
}

.ai-chip.warn .dot {
  background: var(--gold);
}

.ai-chip.testing .dot {
  background: var(--steel);
  animation: pulse 1.2s var(--ease) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* ---------- 主区 ---------- */

.stage {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--bg);
}

.fallback {
  padding: 40px;
  color: var(--ink3);
}
</style>
