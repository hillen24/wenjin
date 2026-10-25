<script setup lang="ts">
/**
 * 方法论库
 *
 * 内置 11 条 + 文献研读提取的自建条目，每条都是一个可操作的程序（SOP + 常见误用）。
 * 卡片上标出它能接通的三个地方：星图 / 原文 / 格物 —— 这是这张卡最有价值的部分，
 * 光有一条方法论的定义，用户读完还是不知道拿它干什么。
 *
 * 自建条目（m_ 前缀）来自文献 Agent：模型提议、暂存区预览、用户确认后才到这里，
 * 所以可以整条删除——删错了重新导入文献还能再提炼出来。
 */

import { computed, onBeforeUnmount, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import { METHOD_ENTRIES, STAR_NODES, type MethodEntry } from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';

const core = useCore();
const nav = useNav();

/** 概念 id → 名字。星图上显示的是名字，弹层里也不该露 id */
const NODE_NAME: Record<string, string> = Object.fromEntries(
  STAR_NODES.map((n) => [n.id, n.name]),
);
const nodeName = (id: string): string => NODE_NAME[id] ?? id;

/** 当前展开详情的条目 */
const opened = ref<MethodEntry | null>(null);

/** 删除自建条目的二次确认：按过一次之后按钮进入 armed 态，3 秒内再按才真删 */
const delArmed = ref(false);
let delTimer = 0;

/** 文献提取的自建方法（m_ 前缀 id），跟着 store 订阅实时刷新 */
const custom = ref<readonly MethodEntry[]>(core.methods.load());
const offCustom = core.methods.subscribe((m) => {
  custom.value = m;
});
onBeforeUnmount(offCustom);

const isCustom = (e: MethodEntry): boolean => e.id.startsWith('m_');

const catClass = (e: MethodEntry): string =>
  e.cat === '生活指导' ? 'life' : e.cat === '思维工具' ? 'think' : 'argue';

/** 卡片底部的三个去处，有几个就写几个 */
const links = (e: MethodEntry): Array<{ icon: string; text: string }> => {
  const out: Array<{ icon: string; text: string }> = [];
  if (e.lit.length) out.push({ icon: 'i-star', text: `星图 ${e.lit.length}` });
  if (e.docs.length) out.push({ icon: 'i-book', text: `原文 ${e.docs.length}` });
  out.push({ icon: 'i-moon', text: '可格物' });
  return out;
};

const entries = computed(() => [...METHOD_ENTRIES, ...custom.value]);

function open(e: MethodEntry): void {
  opened.value = e;
  delArmed.value = false;
}

function close(): void {
  opened.value = null;
  delArmed.value = false;
}

/** 弹层里「用这条目开始格物」 */
function startGewu(e: MethodEntry): void {
  close();
  nav.startGewu(e.id);
}

/** 弹层里「读相关原著」：跳到第一篇的对应段落 */
function readDoc(e: MethodEntry): void {
  const first = e.docs[0];
  if (!first) return;
  close();
  nav.openDoc(first.d, first.p);
}

/** 删除一条自建方法。第一次按只是把按钮 armed 起来 */
function removeCustom(): void {
  const e = opened.value;
  if (!e || !isCustom(e)) return;
  if (!delArmed.value) {
    delArmed.value = true;
    window.clearTimeout(delTimer);
    delTimer = window.setTimeout(() => {
      delArmed.value = false;
    }, 3000);
    return;
  }
  window.clearTimeout(delTimer);
  delArmed.value = false;
  core.methods.remove(e.id);
  close();
  nav.toast(`已删除「${e.name}」`);
}
</script>

<template>
  <div class="methods">
    <div class="hint">
      {{ entries.length }} 条（内置 {{ METHOD_ENTRIES.length }} + 文献 {{ custom.length }}）· 每条都是可操作的<b>程序</b>，不是概念解释 · 卡片底部标注接通哪里：<b>星图 / 原文 / 格物</b>
    </div>

    <div class="grid">
      <button
        v-for="e in entries"
        :key="e.id"
        type="button"
        class="m-card"
        :class="[catClass(e), { lit: isCustom(e) }]"
        @click="open(e)"
      >
        <div class="cat">{{ isCustom(e) ? `文献 · ${e.cat}` : `${e.id} · ${e.cat}` }}</div>
        <h4>{{ e.name }}</h4>
        <p>{{ e.one }}</p>
        <div class="links">
          <span v-for="l in links(e)" :key="l.text">
            <Icon :name="l.icon" :size="13" />
            {{ l.text }}
          </span>
        </div>
      </button>
    </div>

    <!-- 详情 -->
    <div v-if="opened" class="mask" @click.self="close">
      <div class="modal">
        <button type="button" class="close" title="关闭" @click="close">
          <Icon name="i-close" :size="16" />
        </button>

        <h3>{{ opened.id }} {{ opened.name }}</h3>
        <div class="sub">{{ opened.cat }}</div>

        <h5>一句话</h5>
        <div class="one">{{ opened.one }}</div>

        <h5>操作步骤 SOP</h5>
        <ol>
          <li v-for="(s, i) in opened.sop" :key="i">{{ s }}</li>
        </ol>

        <h5>常见误用</h5>
        <div class="misuse">{{ opened.misuse }}</div>

        <h5>关联概念</h5>
        <div>
          <span
            v-for="id in opened.lit"
            :key="id"
            class="chip"
            @click="nav.gotoNode(id)"
          >
            {{ nodeName(id) }}
          </span>
        </div>

        <div class="src">出处：{{ opened.src }}</div>

        <div v-if="isCustom(opened)" class="del-row">
          <span class="note">这条来自文献研读的提取，删除后重新导入文献还能再提炼</span>
          <button type="button" class="btn ghost sm" :class="{ armed: delArmed }" @click="removeCustom">
            {{ delArmed ? '再点一次确认删除' : '删除这条' }}
          </button>
        </div>

        <div class="jump-row">
          <button type="button" class="jump-btn hot" @click="startGewu(opened)">
            <Icon name="i-moon" :size="16" />
            <span>用这条目开始格物<small>追问剧本切换到 {{ opened.id }}</small></span>
          </button>

          <button v-if="opened.docs.length" type="button" class="jump-btn" @click="readDoc(opened)">
            <Icon name="i-book" :size="16" />
            <span>读相关原著<small>第 {{ opened.docs[0]!.p + 1 }} 段</small></span>
          </button>
          <button v-else type="button" class="jump-btn off" disabled>
            <Icon name="i-book" :size="16" />
            <span>读相关原著<small>原著库扩充中</small></span>
          </button>

          <button
            v-if="opened.lit.length"
            type="button"
            class="jump-btn"
            @click="nav.gotoNode(opened.lit[0]!)"
          >
            <Icon name="i-star" :size="16" />
            <span>去星图看关联<small>{{ opened.lit[0] }}</small></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.methods {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  /**
   * 必须显式写 max-content。
   *
   * .m-card 是 overflow: hidden 的，而 overflow 非 visible 的 grid item
   * 自动最小尺寸会被解析成 0 —— 于是行数一多、总高超过容器时，
   * 浏览器就把这些行压扁，卡片内容被裁掉一截。
   * 宽屏三行放得下所以看不出来，手机单列十行就必然翻车。
   */
  grid-auto-rows: max-content;
  gap: 12px;
  padding: 18px 26px 32px;
  align-content: start;
}

.m-card {
  position: relative;
  padding: 16px 17px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--card);
  text-align: left;
  overflow: hidden;
  transition: border-color 0.18s var(--ease), transform 0.18s var(--ease),
    box-shadow 0.18s var(--ease);
}

/* 左侧一道色条，用颜色区分三类方法论 */
.m-card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent);
}

.m-card.life::before {
  background: var(--jade);
}

.m-card.think::before {
  background: var(--steel);
}

.m-card.argue::before {
  background: var(--ochre);
}

.m-card:hover {
  border-color: var(--line-hi);
  transform: translateY(-2px);
  box-shadow: var(--sh-card);
}

.cat {
  margin-bottom: 7px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--ink3);
}

.m-card h4 {
  margin: 0 0 7px;
  font-size: 14.5px;
  font-weight: 550;
  color: var(--ink);
}

.m-card p {
  margin: 0 0 12px;
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--ink2);
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
  font-size: 11.5px;
  color: var(--ink3);
}

.links span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.links svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* ---------- 弹层内部 ---------- */

.one {
  font-size: 14px;
  line-height: 1.75;
}

.modal .chip {
  cursor: pointer;
}

/* 文献条目：右上角一枚小角标，和内置条目一眼分清 */
.m-card.lit::after {
  content: '文献';
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--jade-soft);
  color: var(--jade);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.del-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}

.del-row .note {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
}

.btn.armed {
  border-color: var(--ochre);
  color: var(--ochre);
}
/* ============================================================
 * 窄屏（手机）
 *
 * auto-fill + minmax(268px) 在 375px 屏上会退化成单列，
 * 这一步本来就不用改；只需要把页边距收窄，别把卡片挤成窄条。
 * ============================================================ */

@media (max-width: 760px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    padding: 12px 14px 28px;
  }
}
</style>
