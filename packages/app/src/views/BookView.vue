<script setup lang="ts">
/**
 * 我的哲学书
 *
 * 这不是一个「笔记列表」，是把三类沉淀（格物卡 / 论道 / 伴读问答）
 * 编成一本有章节、有序言、有尾声的书。
 *
 * 书的结构由 core 的 buildBook() 算，这里只画。
 * 好处是：以后想加第五章，改 core 一处，界面自动跟上 ——
 * 旧版这段逻辑是 innerHTML 字符串拼接，加一章要动十几行转义。
 */

import { computed, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  METHOD_ENTRIES,
  PROMPT_BOOK_EDITOR,
  bookToMarkdown,
  buildBook,
  digestForEditor,
  downloadText,
  parseEditorReply,
  todayFull,
  type BookDraft,
  type BookSynth,
} from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';

const core = useCore();
const nav = useNav();

const synth = ref<BookSynth>({});
const busy = ref(false);
/** 每次操作后自增，用来让 computed 重新读 store */
const rev = ref(0);

const draft = computed<BookDraft>(() => {
  rev.value;
  return buildBook(core.materials.get(), METHOD_ENTRIES, synth.value);
});

const isEmpty = computed(() => {
  const c = draft.value.counts;
  return c.cards === 0 && c.debates === 0 && c.readings === 0;
});

async function synthesize(): Promise<void> {
  if (busy.value || isEmpty.value) return;

  const m = core.materials.get();

  if (!core.ai.isLive()) {
    busy.value = true;
    await new Promise((r) => setTimeout(r, 900));
    busy.value = false;
    rev.value++;
    nav.toast('梳理完成 · 用的是本地结构（没接模型）');
    return;
  }

  busy.value = true;
  const r = await core.ai.chat([
    { role: 'system', content: PROMPT_BOOK_EDITOR },
    { role: 'user', content: digestForEditor(m) },
  ]);
  busy.value = false;

  if (r.ok) {
    synth.value = parseEditorReply(r.reply.text);
    rev.value++;
    nav.toast('梳理完成 · AI 执笔的序言已就位');
    return;
  }

  rev.value++;
  nav.toast(`模型没回应（${r.reason}），用本地版`);
}

function exportMd(): void {
  const md = bookToMarkdown(draft.value, todayFull());
  const ok = downloadText(`我的哲学书-${todayFull()}.md`, md);
  nav.toast(ok ? '哲学书已导出 .md' : '当前环境不支持导出');
}

/** 测试/调试用：清空沉淀。需要二次确认，免得误删 */
function clearAll(): void {
  if (!window.confirm('清空所有格物卡、论道记录与伴读问答？此操作不可撤销。')) return;
  core.materials.clear();
  synth.value = {};
  rev.value++;
  nav.toast('已清空沉淀');
}
</script>

<template>
  <div class="book">
    <div class="hint">
      格物卡、论道记录、伴读问答——AI 帮你梳理成一本<b>专属于你的哲学书</b> · 记录越多书越厚 · 可导出 .md
    </div>

    <div class="wrap">
      <div class="main">
        <!-- 空态 -->
        <div v-if="isEmpty" class="empty">
          <Icon name="i-book" :size="40" />
          <p class="big">书还是空的。</p>
          <p class="small">
            去日常格物复盘今晚，或去论道找位哲学家聊聊——<br />
            每一笔都会沉淀到这里，慢慢长成你的书。
          </p>
          <div class="empty-actions">
            <button type="button" class="btn sm" @click="nav.go('gewu')">
              <Icon name="i-moon" :size="14" /> 去格物
            </button>
            <button type="button" class="btn ghost sm" @click="nav.go('debate')">
              <Icon name="i-scale" :size="14" /> 去论道
            </button>
          </div>
        </div>

        <!-- 成书 -->
        <template v-else>
          <div class="cover">
            <div class="kicker">WENJIN PRESS · 我的哲学书</div>
            <h1 class="serif">一个正在成为自己的人</h1>
            <div class="cmeta">
              第 {{ draft.counts.cards + 1 }} 次梳理 · 收录 {{ draft.counts.cards }} 条格物 ·
              {{ draft.counts.debates }} 场论道 · {{ draft.counts.readings }} 次伴读问答 ·
              成书进度 {{ draft.pct }}%
            </div>
          </div>

          <section class="chapter">
            <h3 class="serif">序言 · 这本书怎么来的</h3>
            <p>{{ draft.preface }}</p>
          </section>

          <section v-for="(ch, ci) in draft.chapters" :key="ci" class="chapter">
            <h3 class="serif">{{ ch.title }}</h3>
            <p v-if="ch.items.length === 0" class="phint">{{ ch.hint }}</p>
            <ol v-else-if="ci === 2" class="props">
              <li v-for="(it, i) in ch.items" :key="i" class="serif">{{ it.text }}</li>
            </ol>
            <div v-else class="items">
              <div v-for="(it, i) in ch.items" :key="i" class="item">
                <span class="tag">{{ it.tag }}</span>
                <span class="text" :class="{ serif: it.serif }">{{ it.text }}</span>
              </div>
            </div>
          </section>

          <section class="chapter">
            <h3 class="serif">尾声 · 叮嘱</h3>
            <p>{{ draft.coda }}</p>
          </section>
        </template>
      </div>

      <div class="side">
        <div class="panel">
          <h4>我的沉淀</h4>
          <div class="stat-row">
            <div class="stat"><b>{{ draft.counts.cards }}</b><span>格物卡</span></div>
            <div class="stat"><b>{{ draft.counts.debates }}</b><span>论道</span></div>
            <div class="stat"><b>{{ draft.counts.readings }}</b><span>伴读问答</span></div>
          </div>
        </div>

        <div class="panel">
          <h4>成书进度 · {{ draft.stage }}</h4>
          <div class="bar"><i :style="{ width: `${Math.max(draft.pct, 2)}%` }" /></div>
          <div class="pmeta">
            {{ draft.pct }}% · 素材权重：格物卡 ×2 · 再沉淀
            {{ Math.max(0, 40 - draft.counts.cards * 2 - draft.counts.debates - draft.counts.readings) }}
            点就成书
          </div>
          <div class="pactions">
            <button type="button" class="btn sm" :disabled="busy || isEmpty" @click="synthesize">
              <Icon name="i-sparkle" :size="14" />
              {{ busy ? '梳理中…' : '让 AI 梳理成书' }}
            </button>
            <button type="button" class="btn ghost sm" :disabled="isEmpty" @click="exportMd">
              <Icon name="i-download" :size="14" /> 导出 .md
            </button>
          </div>
        </div>

        <div class="panel">
          <h4>沉淀从哪来</h4>
          <div class="sources">
            <span><Icon name="i-moon" :size="13" /> 格物卡 · 每晚复盘产出</span>
            <span><Icon name="i-scale" :size="13" /> 论道 · 与哲学家的对话</span>
            <span><Icon name="i-book" :size="13" /> 伴读 · 划句问答的记录</span>
          </div>
          <div class="jump-row">
            <button type="button" class="jump-btn" @click="nav.go('gewu')">
              <Icon name="i-moon" :size="15" />
              <span>去格物<small>今晚复盘一次</small></span>
            </button>
            <button type="button" class="jump-btn" @click="nav.go('debate')">
              <Icon name="i-scale" :size="15" />
              <span>去论道<small>找位哲学家聊聊</small></span>
            </button>
          </div>
        </div>

        <button v-if="!isEmpty" type="button" class="clear" @click="clearAll">清空所有沉淀</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.book {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.wrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
}

.main {
  min-width: 0;
  overflow-y: auto;
  padding: 28px 40px 60px;
}

/* ---------- 空态 ---------- */

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--ink3);
}

.empty svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  opacity: 0.45;
}

.empty .big {
  margin: 18px 0 6px;
  font-size: 15px;
  color: var(--ink2);
}

.empty .small {
  margin: 0;
  font-size: 13px;
  line-height: 1.9;
}

.empty-actions {
  display: flex;
  gap: 10px;
  margin-top: 22px;
}

/* ---------- 封面 ---------- */

.cover {
  padding: 28px 0 26px;
  border-bottom: 2px solid var(--line-hi);
  text-align: center;
}

.kicker {
  font-size: 10.5px;
  letter-spacing: 0.22em;
  color: var(--ink3);
}

.cover h1 {
  margin: 12px 0 10px;
  font-size: 27px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.cmeta {
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--ink3);
}

/* ---------- 章节 ---------- */

.chapter {
  padding: 26px 0 6px;
}

.chapter h3 {
  margin: 0 0 14px;
  font-size: 16.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.chapter > p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.95;
  color: var(--ink2);
}

.phint {
  color: var(--ink3) !important;
  font-size: 12.5px !important;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink2);
  border-bottom: 1px dashed var(--line);
}

.item:last-child {
  border-bottom: 0;
}

.item .tag {
  flex: none;
  width: 52px;
  padding-top: 2px;
  font-size: 11px;
  color: var(--ink3);
  font-variant-numeric: tabular-nums;
}

.item .text {
  flex: 1;
  min-width: 0;
}

.props {
  margin: 0;
  padding-left: 22px;
}

.props li {
  margin-bottom: 10px;
  font-size: 14px;
  line-height: 1.9;
  color: var(--ink);
}

/* ---------- 右栏 ---------- */

.side {
  overflow-y: auto;
  padding: 22px 20px 32px;
  border-left: 1px solid var(--line);
  background: var(--bg2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bar {
  height: 8px;
  margin-bottom: 8px;
  border-radius: 4px;
  background: var(--line);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.5s var(--ease);
}

.pmeta {
  margin-bottom: 14px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink3);
}

.pactions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sources {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12.5px;
  color: var(--ink2);
}

.sources span {
  display: flex;
  align-items: center;
  gap: 7px;
}

.sources svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--ink3);
}

.clear {
  margin-top: 4px;
  padding: 8px;
  font-size: 11.5px;
  color: var(--ink3);
  border-radius: var(--radius-sm);
}

.clear:hover {
  color: var(--rose);
  background: var(--card-hi);
}
/* ============================================================
 * 窄屏（手机）
 *
 * 右栏（成书目录与属性）挪到正文下面，限高滚动，
 * 这样「正文」始终是这一页的主角。
 * ============================================================ */

@media (max-width: 760px) {
  .wrap {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .main {
    padding: 16px 16px 28px;
    /* 同格物：右栏固定占位后，正文区必须自己滚 */
    overflow-y: auto;
  }

  .side {
    border-left: 0;
    border-top: 1px solid var(--line);
    max-height: 38vh;
    padding: 14px 16px 20px;
  }
}
</style>
