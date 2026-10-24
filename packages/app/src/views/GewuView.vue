<script setup lang="ts">
/**
 * 日常格物
 *
 * 一条状态机：选条目 → 追问三轮 → 二分归类 → 出卡 → 存入沉淀。
 *
 * 与旧版最大的区别：脚本推进、二分归类、出卡内容都由 core 的 GewuSession 决定，
 * 这里只负责画。所以「在 A1 的剧本里看到 A4 的选项」这类错位，
 * 在新结构里根本表达不出来。
 *
 * AI 与预置剧本共用同一条界面流：AI 能用就用，用不了就落回手写剧本，
 * 用户看到的都是「致知 AI · 格物教练」，但提示条会说实话。
 */

import { computed, nextTick, onMounted, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  GEWU_OPENING_HINT,
  METHOD_ENTRIES,
  gewuContinueHint,
  promptGewu,
  todayFull,
  type GewuCardRecord,
  type SortItem,
} from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';
import { useNarrow } from '../useNarrow';

const core = useCore();
const nav = useNav();
const narrow = useNarrow();

/**
 * 窄屏下「历史格物卡」默认收起。
 *
 * 手机上这一栏如果一直展开，就会变成「上面一屏选条目、下面一屏历史」的
 * 双滚动条，滚哪个都不顺手。收起来之后整页只有一条滚动线，
 * 想翻历史再展开。
 */
const histOpen = ref(false);

type Phase = 'pick' | 'chat' | 'sort' | 'card';

interface Bubble {
  who: 'ai' | 'me';
  text: string;
  /** 最后一条 AI 消息附带的快捷选项 */
  opts?: readonly string[];
  /** true 表示这条来自预置剧本而非真模型 */
  canned?: boolean;
}

const phase = ref<Phase>('pick');
const entryId = ref(core.gewu.entryId);
const messages = ref<Bubble[]>([]);
const typing = ref(false);
const sortItems = ref<SortItem[]>([]);
const card = ref<GewuCardRecord | null>(null);
const draft = ref('');
const chatBox = ref<HTMLElement | null>(null);

/** 只统计真实数据 —— 旧版这里写死了「连续 3 天 / 7 张卡」，那是演示数据 */
const stats = computed(() => {
  const m = core.materials.get();
  const usage: Record<string, number> = {};
  for (const c of m.cards) usage[c.entry] = (usage[c.entry] ?? 0) + 1;
  const top = Object.keys(usage).sort((a, b) => usage[b] - usage[a])[0];
  return {
    cards: m.cards.length,
    debates: m.debates.length,
    top: top ?? '—',
  };
});

const history = computed(() => core.materials.get().cards.slice(0, 6));

const entryOptions = computed(() =>
  METHOD_ENTRIES.map((e) => ({ id: e.id, name: e.name, one: e.one })),
);

const currentEntry = computed(() => METHOD_ENTRIES.find((e) => e.id === entryId.value));

/**
 * 从方法论库跳进来时，core 里已经设好了条目 —— 挂载时接住它。
 * 视图是 v-if 挂载的，切走即卸载，所以这里读一次就够，不需要 watch。
 */
onMounted(() => {
  if (core.gewu.entryId !== entryId.value) {
    entryId.value = core.gewu.entryId;
  }
});

function pick(id: string): void {
  entryId.value = id;
  core.gewu.setEntry(id);
}

async function scrollChat(): Promise<void> {
  await nextTick();
  if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
}

function pushAi(b: Bubble): void {
  // 新消息进来时，把上一条的快捷选项收走，避免选项堆积
  const cleared: Bubble[] = messages.value.map((m) => ({ ...m, opts: undefined }));
  messages.value = [...cleared, b];
  void scrollChat();
}

/**
 * 开一次复盘。
 * 先决定这一轮用 AI 还是剧本，然后把第一句推上去。
 */
async function begin(): Promise<void> {
  core.gewu.setEntry(entryId.value);
  const step = core.gewu.begin();
  messages.value = [];
  card.value = null;
  phase.value = 'chat';

  if (!step) {
    nav.toast('这个条目还没有追问剧本');
    phase.value = 'pick';
    return;
  }

  const e = currentEntry.value;
  if (!e) return;

  if (core.ai.isLive()) {
    typing.value = true;
    const r = await core.ai.chat([
      { role: 'system', content: promptGewu(e) },
      { role: 'user', content: GEWU_OPENING_HINT },
    ]);
    typing.value = false;

    if (r.ok) {
      pushAi({ who: 'ai', text: r.reply.text, opts: ['我说不上来…', '换个角度问'] });
      return;
    }
    nav.toast(`模型没回应（${r.reason}），用预置剧本继续`);
  }

  pushAi({ who: 'ai', text: step.t, opts: step.opts, canned: true });
}

/** 用户答一句 */
async function say(text: string): Promise<void> {
  const t = text.trim();
  if (!t || typing.value) return;

  pushAi({ who: 'me', text: t });
  draft.value = '';

  const next = core.gewu.answer(t);

  if (!next) {
    // 剧本走完 → 进入二分归类
    await new Promise((r) => setTimeout(r, 400));
    goSort();
    return;
  }

  const e = currentEntry.value;
  if (!e) return;

  if (core.ai.isLive()) {
    typing.value = true;
    const r = await core.ai.chat([
      { role: 'system', content: promptGewu(e) },
      { role: 'user', content: gewuContinueHint(t) },
    ]);
    typing.value = false;

    if (r.ok) {
      const atEnd = core.gewu.stepIndex >= core.gewu.total - 1;
      pushAi({
        who: 'ai',
        text: r.reply.text,
        opts: atEnd ? undefined : ['我说不上来…', '换个角度问'],
      });
      if (atEnd) {
        await new Promise((res) => setTimeout(res, 500));
        goSort();
      }
      return;
    }
    nav.toast(`模型没回应（${r.reason}），用预置剧本继续`);
  }

  pushAi({ who: 'ai', text: next.t, opts: next.opts, canned: true });
  if (next.end) {
    await new Promise((r) => setTimeout(r, 500));
    goSort();
  }
}

function goSort(): void {
  sortItems.value = core.gewu.prepareSort().slice();
  phase.value = 'sort';
}

function toggle(key: string): void {
  sortItems.value = core.gewu.toggle(key).slice();
}

function makeCard(): void {
  const lit = core.gewu.newLights(core.progress.lit());
  card.value = core.gewu.buildCard(lit);
  phase.value = 'card';
}

/** 把没归位的条目留在原地 —— 空列也允许出卡，但提示一句 */
const emptySide = computed(() => {
  const c = sortItems.value.filter((i) => i.side === 'ctrl').length;
  const u = sortItems.value.filter((i) => i.side === 'un').length;
  if (c === 0 || u === 0) return '有一列还是空的——二分法至少要各有一条才成立';
  return '';
});

function saveCard(): void {
  if (!card.value) return;
  core.materials.add('cards', card.value);
  const lit = core.progress.light(card.value.lit);
  nav.toast(
    lit.length
      ? `已存入 · 星图点亮 ${lit.length} 个概念 · 已进「我的哲学」`
      : '已存入「我的哲学」',
  );
}

function saveAndGoBook(): void {
  saveCard();
  nav.go('book');
}

function again(): void {
  phase.value = 'pick';
  messages.value = [];
  card.value = null;
}
</script>

<template>
  <div class="gewu">
    <div class="hint">
      晚间复盘：<b>选条目</b> → 烦扰 → 追问 → 二分 → 格物卡 · 追问剧本随条目切换 · 卡片可回跳星图、可沉淀进「我的哲学」
    </div>

    <div class="wrap">
      <div class="main">
        <h2>{{ todayFull() }}</h2>

        <!-- ① 选条目 -->
        <template v-if="phase === 'pick'">
          <div class="sub">今晚用什么方法论过这一天？选一个——追问剧本会跟着它变。</div>

          <div class="picker">
            <button
              v-for="o in entryOptions"
              :key="o.id"
              type="button"
              class="pick-row"
              :class="{ on: o.id === entryId }"
              @click="pick(o.id)"
            >
              <span class="eid">{{ o.id }}</span>
              <span class="txt">
                <span class="nm">{{ o.name }}</span>
                <span class="one">{{ o.one }}</span>
              </span>
            </button>
          </div>

          <div class="start-row">
            <button type="button" class="btn ochre" @click="begin">开始今晚复盘 →</button>
            <span class="note">追问剧本随条目切换 · 三轮上限</span>
          </div>
        </template>

        <!-- ② 追问 -->
        <template v-else-if="phase === 'chat' || phase === 'sort' || phase === 'card'">
          <div class="loaded">
            <span class="chip entry">{{ entryId }} {{ currentEntry?.name }}</span>
            <span class="note">{{ phase === 'chat' ? '追问剧本已加载' : '追问结束' }}</span>
          </div>

          <div ref="chatBox" class="chat box">
            <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.who">
              <div v-if="m.who === 'ai'" class="who">
                致知 AI · 格物教练
                <span v-if="m.canned" class="canned">预置</span>
              </div>
              {{ m.text }}
              <div v-if="m.opts && m.opts.length && i === messages.length - 1" class="quick-opts">
                <button
                  v-for="o in m.opts"
                  :key="o"
                  type="button"
                  :disabled="typing"
                  @click="say(o)"
                >
                  {{ o }}
                </button>
              </div>
            </div>

            <div v-if="typing" class="msg ai typing">
              <div class="who">致知 AI · 格物教练</div>
              思索中…
            </div>
          </div>

          <div v-if="phase === 'chat'" class="chat-input">
            <input
              v-model="draft"
              placeholder="自己写，或点上面的快捷选项…"
              :disabled="typing"
              @keydown.enter.prevent="say(draft)"
            />
            <button type="button" class="btn sm" :disabled="typing || !draft.trim()" @click="say(draft)">
              回我
            </button>
          </div>
        </template>

        <!-- ③ 二分归类 -->
        <template v-if="phase === 'sort'">
          <h5 class="step">第二步 · 二分归类（点击切换归属）</h5>
          <div class="cols">
            <div class="col ctrl">
              <h5>可控 · 我的事</h5>
              <div
                v-for="i in sortItems.filter((x) => x.side === 'ctrl')"
                :key="i.key"
                class="sort-item"
                @click="toggle(i.key)"
              >
                <span>{{ i.text }}</span>
                <span class="tag">点击移至不可控</span>
              </div>
            </div>
            <div class="col un">
              <h5>不可控 · 不归我管</h5>
              <div
                v-for="i in sortItems.filter((x) => x.side === 'un')"
                :key="i.key"
                class="sort-item"
                @click="toggle(i.key)"
              >
                <span>{{ i.text }}</span>
                <span class="tag">点击移至可控</span>
              </div>
            </div>
          </div>

          <div class="card-actions">
            <button type="button" class="btn" @click="makeCard">生成格物卡 →</button>
            <span class="note">{{ emptySide }}</span>
          </div>
        </template>

        <!-- ④ 格物卡 -->
        <div v-if="phase === 'card' && card" class="gw-card">
          <h4>格物卡 · {{ todayFull() }} · {{ card.entry }} {{ currentEntry?.name }}</h4>

          <div class="row"><div class="lab">烦扰</div><div class="val">{{ card.bother }}</div></div>
          <div class="row">
            <div class="lab">可控 · 我的事</div>
            <div class="val">{{ card.ctrl.join(' · ') || '—' }}</div>
          </div>
          <div class="row">
            <div class="lab">不可控 · 不归我管</div>
            <div class="val">{{ card.un.join(' · ') || '—' }}</div>
          </div>
          <div class="row">
            <div class="lab">{{ core.gewu.practiceLabel }}</div>
            <div class="next serif">{{ card.practice }}</div>
          </div>
          <div class="row">
            <div class="lab">下一步最小行动</div>
            <div class="next">{{ card.next }}</div>
          </div>

          <div class="actions">
            <button type="button" class="btn sm" @click="saveCard">存入并推送明日晨间</button>
            <button type="button" class="btn teal sm" @click="saveAndGoBook">
              <Icon name="i-book" :size="14" /> 沉淀进我的哲学书
            </button>
            <button
              v-if="card.lit.length"
              type="button"
              class="btn ghost sm"
              @click="nav.gotoNode(card.lit[0]!)"
            >
              <Icon name="i-star" :size="14" /> 去星图看关联
            </button>
            <button type="button" class="btn ghost sm" @click="again">
              <Icon name="i-moon" :size="14" /> 再复盘一次
            </button>
          </div>
        </div>
      </div>

      <!-- 右栏 -->
      <div class="side">
        <div class="panel stat-panel">
          <h4>我的格物统计</h4>
          <div class="stat-row">
            <div class="stat"><b>{{ stats.cards }}</b><span>累计格物卡</span></div>
            <div class="stat"><b>{{ stats.debates }}</b><span>论道场次</span></div>
            <div class="stat"><b>{{ stats.top }}</b><span>常用条目</span></div>
          </div>
        </div>

        <div class="panel hist-panel">
          <h4>
            历史格物卡
            <!-- 窄屏专用开关：宽屏下这件按钮被 CSS 藏起来，列表始终展开 -->
            <button
              type="button"
              class="hist-toggle"
              :aria-expanded="narrow ? histOpen : true"
              @click="histOpen = !histOpen"
            >
              {{ narrow ? (histOpen ? '收起' : `${history.length} 张 · 展开`) : '' }}
              <Icon v-if="narrow" name="i-chevron" :size="12" :class="{ flip: histOpen }" />
            </button>
          </h4>
          <div v-if="!narrow || histOpen" class="hist-body">
            <div v-if="!history.length" class="empty">
              还没有格物卡。<br />今晚做一次复盘，这里就有第一张。
            </div>
            <div v-else class="hist">
              <button
                v-for="(h, i) in history"
                :key="i"
                type="button"
                class="mini"
                @click="h.lit.length && nav.gotoNode(h.lit[0]!)"
              >
                <div class="d">{{ h.date }} · {{ h.entry }}</div>
                <div class="t">{{ h.title }}</div>
                <div v-if="h.lit.length" class="lit">
                  <Icon name="i-star" :size="11" /> 点亮 {{ h.lit.length }}
                </div>
              </button>
            </div>
            <button type="button" class="btn ghost sm full" @click="nav.go('book')">
              <Icon name="i-pen" :size="14" /> 去我的哲学体系 →
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gewu {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.wrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 0;
}

.main {
  min-width: 0;
  overflow-y: auto;
  padding: 22px 26px 40px;
}

.main h2 {
  margin: 0 0 4px;
  font-family: var(--serif);
  font-size: 21px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.sub {
  margin-bottom: 18px;
  font-size: 12.5px;
  color: var(--ink3);
}

/* ---------- 选条目 ---------- */

.picker {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 18px;
}

.pick-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--card);
  text-align: left;
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}

.pick-row:hover {
  border-color: var(--line-hi);
  background: var(--card-hi);
}

.pick-row.on {
  border-color: var(--ochre);
  background: var(--ochre-soft);
}

.eid {
  flex: none;
  min-width: 30px;
  padding-top: 1px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ochre);
  letter-spacing: 0.04em;
}

.pick-row .txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pick-row .nm {
  font-size: 13.5px;
  color: var(--ink);
}

.pick-row .one {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink3);
}

.start-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.note {
  font-size: 12px;
  color: var(--ink3);
}

/* ---------- 对话 ---------- */

.loaded {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.box {
  max-height: 46vh;
  min-height: 120px;
  padding-right: 4px;
}

.canned {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--field-2);
  font-size: 10px;
  color: var(--ink3);
}

.typing {
  color: var(--ink3);
  animation: breathe 1.2s var(--ease) infinite;
}

@keyframes breathe {
  50% {
    opacity: 0.5;
  }
}

/* ---------- 二分 ---------- */

.step {
  margin: 22px 0 10px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ink2);
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.col {
  flex: 1;
  min-width: 240px;
  padding: 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--field);
}

.col h5 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.col.ctrl h5 {
  color: var(--jade);
}

.col.un h5 {
  color: var(--ink3);
}

.sort-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  margin-bottom: 7px;
  border-radius: var(--radius-xs);
  background: var(--card);
  border: 1px solid var(--line);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.16s var(--ease), transform 0.12s var(--ease);
}

.sort-item:hover {
  border-color: var(--accent);
  transform: translateX(2px);
}

.sort-item .tag {
  flex: none;
  font-size: 10.5px;
  color: var(--ink3);
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

/* ---------- 格物卡 ---------- */

.gw-card {
  margin-top: 20px;
  padding: 20px 22px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: linear-gradient(160deg, var(--card), var(--field));
  box-shadow: var(--sh-card);
}

.gw-card h4 {
  margin: 0 0 14px;
  font-size: 14px;
  font-weight: 500;
  color: var(--accent);
}

.row {
  display: flex;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px dashed var(--line);
}

.row:first-of-type {
  border-top: 0;
}

.lab {
  flex: none;
  width: 108px;
  font-size: 12px;
  color: var(--ink3);
}

.val,
.next {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.7;
}

.next {
  color: var(--ink);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

/* ---------- 右栏 ---------- */

.side {
  min-width: 0;
  overflow-y: auto;
  padding: 22px 20px 32px;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--bg2);
}

.empty {
  padding: 12px 0 14px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink3);
}

.hist {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 12px;
}

.mini {
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--field);
  text-align: left;
  transition: border-color 0.16s var(--ease);
}

.mini:hover {
  border-color: var(--accent);
}

.mini .d {
  font-size: 10.5px;
  color: var(--ink3);
}

.mini .t {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink2);
}

.mini .lit {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--accent);
}

.mini .lit svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

.full {
  width: 100%;
}
/* ============================================================
 * 窄屏（手机）
 *
 * 右栏历史卡挪到下面限高滚动；二分归类的两列在窄屏竖排，
 * 240px 的 min-width 会在 375px 屏上把两列都挤变形。
 * ============================================================ */

/* 历史格物卡标题行：窄屏时右边挂一个展开/收起开关 */
.hist-panel h4 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.hist-toggle {
  display: none;
}

@media (max-width: 760px) {
  /**
   * 手机端：一条滚动线，整页一篇滚到底。
   *
   * 旧版是「上面 main 自己滚、下面 side 固定 34vh 自己滚」——
   * 一块屏里两条滚动条，手指落在哪个区域滚哪个，上下两半还互相压，
   * 看起来就像被硬切开的两截。现在把滚动权收归 .wrap，
   * main / side 都不再各自滚。
   *
   * 但只是「顺着往下排」还不够：选条目这一屏有七条，统计卡会被推到
   * 两屏之外，等于把统计藏起来了。所以 .side 用 display: contents 化掉，
   * 让里面两块面板直接参与 .wrap 的排序 ——
   * 统计贴到日期下面（一眼能看到），历史卡沉到页尾（要看再展开）。
   */
  .wrap {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  .side {
    /* 化掉外层容器：两块面板上浮成 .wrap 的直接子项，好单独排序 */
    display: contents;
  }

  .main {
    order: 2;
    overflow: visible;
    padding: 14px 15px 16px;
  }

  .stat-panel {
    order: 1;
    margin: 12px 15px 0;
    /* 窄屏只留三个数字当仪表条，标题在这里是废话 */
    padding: 8px 10px;
  }

  .stat-panel h4 {
    display: none;
  }

  .hist-panel {
    order: 3;
    margin: 14px 15px calc(24px + env(safe-area-inset-bottom));
  }

  /* 统计三格在手机上一行放得下，压扁一点，别占掉半屏 */
  .stat-row {
    gap: 7px;
  }

  .stat {
    padding: 8px 6px;
  }

  .stat b {
    font-size: 16px;
  }

  .stat span {
    font-size: 10.5px;
  }

  .hist-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--field);
    font-size: 11.5px;
    color: var(--ink2);
  }

  .hist-toggle svg {
    transition: transform 0.2s var(--ease);
  }

  .hist-toggle .flip {
    transform: rotate(180deg);
  }

  .cols {
    flex-direction: column;
  }

  .col {
    min-width: 0;
  }
}
</style>
