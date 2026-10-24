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

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  // 启动补验：配置齐全但指纹还没通过时静默试一次，不指望用户记得点按钮
  void core.ai.autoVerify();
  /* 电脑端是局域网同步的服务端：把本机数据持续交给主进程，
     手机来拉取时主进程才有东西可给。手机端没有这个桥，调用会自己返回。 */
  setupDesktopSync();
});

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange);
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
          <svg aria-hidden="true"><use href="#i-logo" /></svg>
        </span>
        <div class="brand-text">
          <b>问津</b>
          <small>思想栖所</small>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          class="nav-btn"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >
          <Icon :name="t.icon" :size="18" />
          <span>{{ t.label }}</span>
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

        <div class="ai-chip" :class="aiTone" :title="aiTitle">
          <span class="dot" />
          <span class="chip-text">{{ aiLabel }}</span>
        </div>
      </div>
    </aside>

    <main class="stage">
      <StarView v-if="tab === 'star'" :focus="focusNode?.id ?? null" />
      <ReaderView v-else-if="tab === 'read'" :jump="jumpDoc" />
      <MethodsView v-else-if="tab === 'method'" />
      <GewuView v-else-if="tab === 'gewu'" />
      <DebateView v-else-if="tab === 'debate'" />
      <BookView v-else-if="tab === 'book'" />
      <SettingsView v-else-if="tab === 'set'" />
      <div v-else class="fallback">{{ activeTab.label }}</div>
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
}

.seal svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #fff;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
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
  padding: 7px 11px;
  border-radius: var(--radius-sm);
  background: var(--card);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--ink2);
  min-width: 0;
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
