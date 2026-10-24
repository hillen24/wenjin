<script setup lang="ts">
/**
 * 论道
 *
 * 六位哲学家，人格由 persona 驱动。苏格拉底那条铁律最要紧：只问不答 ——
 * 所以他的 system prompt 里写着「每次回复以一个问题收尾」，而这一版没有替模型兜底，
 * 是真让它自己守。
 *
 * 离线时用预置问答（关键词命中），界面上会标「预置」，不假装是真模型。
 */

import { computed, nextTick, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import { PHIL_GRADIENTS, PHILOSOPHERS, promptPhilosopher } from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';

const core = useCore();
const nav = useNav();

const session = core.debate;

const philId = ref(session.philId);
const draft = ref('');
const thinking = ref(false);
/** 每次追加消息后自增，用来触发 computed 重新读 session */
const rev = ref(0);
const chatBox = ref<HTMLElement | null>(null);

const phil = computed(() => {
  rev.value;
  return PHILOSOPHERS.find((p) => p.id === philId.value) ?? PHILOSOPHERS[0]!;
});

const lines = computed(() => {
  rev.value;
  return session.lines();
});

const canSave = computed(() => {
  rev.value;
  return session.canSave;
});

async function scrollChat(): Promise<void> {
  await nextTick();
  if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
}

function open(id: string): void {
  philId.value = id;
  session.open(id);
  rev.value++;
  void scrollChat();
}

async function scrollChatSoon(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
  await scrollChat();
}

async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t || thinking.value) return;
  draft.value = '';

  session.push({ who: 'me', text: t });
  rev.value++;
  void scrollChat();

  const p = phil.value;

  if (core.ai.isLive()) {
    thinking.value = true;
    const history = session.lines().map((m) => ({
      role: (m.who === 'me' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.text,
    }));

    const r = await core.ai.chat([
      { role: 'system', content: promptPhilosopher(p) },
      ...history,
    ]);
    thinking.value = false;

    if (r.ok) {
      session.push({ who: 'ai', text: r.reply.text });
      rev.value++;
      void scrollChatSoon();
      return;
    }
    nav.toast(`${p.name} 掉线了（${r.reason}），切预置剧本`);
  }

  // 预置：给一点延迟，否则回答瞬间出现，像假的
  thinking.value = true;
  await new Promise((r) => setTimeout(r, 700));
  session.push({ who: 'ai', text: session.mockReply(t) });
  thinking.value = false;
  rev.value++;
  void scrollChatSoon();
}

function save(): void {
  const rec = session.toRecord();
  if (!rec) {
    nav.toast('至少聊两个回合再存');
    return;
  }
  core.materials.add('debates', rec);
  nav.toast(`已存入「我的哲学」· 与${rec.phil}的这一场`);
}
</script>

<template>
  <div class="debate">
    <div class="hint">
      选一位哲学家直接开聊 · <b>人格由 AI 扮演</b>，苏格拉底依旧只问不答 · 聊两个回合以上可整场存入「我的哲学书」
    </div>

    <div class="wrap">
      <div class="main">
        <div class="head">
          <div class="who">
            <h3 class="serif">{{ phil.name }}</h3>
            <span class="era">{{ phil.era }}</span>
          </div>
          <span class="style">{{ phil.style }}</span>
          <button v-if="canSave" type="button" class="btn ghost sm save" @click="save">
            <Icon name="i-book" :size="14" /> 存入我的哲学书
          </button>
        </div>

        <div ref="chatBox" class="chat box">
          <template v-if="lines.length === 0">
            <div class="msg ai">
              <div class="who">{{ phil.name }}</div>
              {{ phil.greet }}
            </div>
          </template>
          <div v-for="(m, i) in lines" :key="i" class="msg" :class="m.who">
            <div v-if="m.who === 'ai'" class="who">{{ phil.name }}</div>
            {{ m.text }}
          </div>

          <div v-if="thinking" class="msg ai typing">
            <div class="who">{{ phil.name }}</div>
            思索中…
          </div>
        </div>

        <div class="quick">
          <button
            v-for="q in phil.qs"
            :key="q"
            type="button"
            :disabled="thinking"
            @click="send(q)"
          >
            {{ q }}
          </button>
        </div>

        <div class="chat-input">
          <input
            v-model="draft"
            :placeholder="`直接问 ${phil.name}…`"
            :disabled="thinking"
            @keydown.enter.prevent="send(draft)"
          />
          <button type="button" class="btn sm" :disabled="thinking || !draft.trim()" @click="send(draft)">
            问
          </button>
        </div>
      </div>

      <div class="phil-list">
        <button
          v-for="p in PHILOSOPHERS"
          :key="p.id"
          type="button"
          class="phil-btn"
          :class="{ on: p.id === philId }"
          @click="open(p.id)"
        >
          <span
            class="av"
            :style="{
              background: `linear-gradient(135deg, ${PHIL_GRADIENTS[p.id]?.from ?? '#4FD1C5'}, ${
                PHIL_GRADIENTS[p.id]?.to ?? '#1E7A8C'
              })`,
            }"
          >
            <svg aria-hidden="true"><use :href="`#i-ph-${p.id}`" /></svg>
          </span>
          <span class="meta">
            <span class="nm">{{ p.name }}</span>
            <span class="era2">{{ p.era }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debate {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.wrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 244px;
}

.main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 26px 22px;
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}

.head .who {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.head h3 {
  margin: 0;
  font-size: 19px;
  font-weight: 500;
}

.era {
  font-size: 11.5px;
  color: var(--ink3);
  font-weight: 400;
}

.style {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
}

.save {
  margin-left: auto;
}

.box {
  flex: 1;
  min-height: 0;
  margin: 16px 0 12px;
  padding-right: 4px;
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

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 4px;
}

.quick button {
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--ink3);
  font-size: 12px;
  transition: border-color 0.16s var(--ease), color 0.16s var(--ease);
}

.quick button:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* ---------- 哲人列表 ---------- */

.phil-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 20px 16px 24px;
  overflow-y: auto;
  border-left: 1px solid var(--line);
  background: var(--bg2);
}

.phil-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-align: left;
  transition: background 0.16s var(--ease);
}

.phil-btn:hover {
  background: var(--card-hi);
}

.phil-btn.on {
  background: var(--accent-soft);
}

.av {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  overflow: hidden;
  color: #fff;
}

/* 实心剪影：纯 fill，无描边，靠轮廓辨身份 */
.av svg {
  width: 84%;
  height: 84%;
  fill: currentColor;
  stroke: none;
}

.meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}

.nm {
  font-size: 13px;
  color: var(--ink);
}

.era2 {
  font-size: 10.5px;
  color: var(--ink3);
}

.phil-btn.on .nm {
  color: var(--accent);
}
/* ============================================================
 * 窄屏（手机）
 *
 * 右栏哲人列表改成顶部横向滑动条 —— 论道要先选人再聊天，
 * 竖排列表占掉半屏之后聊天区就没地方了。
 * ============================================================ */

@media (max-width: 760px) {
  .wrap {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .main {
    padding: 14px 14px 16px;
  }

  .phil-list {
    order: -1;
    flex-direction: row;
    gap: 8px;
    padding: 10px 12px;
    overflow-x: auto;
    overflow-y: hidden;
    border-left: 0;
    border-bottom: 1px solid var(--line);
  }

  .phil-btn {
    flex: none;
    width: 148px;
  }
}
</style>
