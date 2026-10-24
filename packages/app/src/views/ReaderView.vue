<script setup lang="ts">
/**
 * 精读伴读
 *
 * 三块：书架 / 正文 / AI 侧栏。
 *
 * 交互的骨架是「选一句 → 问 → 得到回答」。
 * 这一版把「选中」做成了真正的浏览器选区（旧版也是），而不是靠点击整段猜 ——
 * 用户可以精确划到半句。
 *
 * 朗读用 core 的 TtsController：高亮跟着音频走，停止会作废在途的合成请求。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  PROMPT_CONNECT,
  PROMPT_EXPLAIN,
  STAR_NODES,
  today,
  type ShelfDoc,
} from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';

const core = useCore();
const nav = useNav();

/** 外部（方法论库的「读相关原著」）指定的定位目标 */
const props = defineProps<{ jump?: { id: string; para: number } | null }>();

/**
 * 窄屏（手机）上一次只显示一栏。
 *
 * 三栏并排在 375px 屏上会各自挤成一条缝，读不下去。
 * 这里不重新排版，而是切「当前看哪一栏」——
 * 宽屏上这个状态完全无效（切换条被 CSS 藏起来，三栏照旧并排）。
 */
const mobilePane = ref<'doc' | 'shelf' | 'ask'>('doc');

/** 滚到某段并闪一下，让人知道「跳到了这里」 */
const flashIndex = ref(-1);

async function goTo(id: string, para: number): Promise<void> {
  if (!shelf.value.some((d) => d.id === id)) refreshShelf();
  selectDoc(id);
  await nextTick();
  const el = docMain.value?.querySelector<HTMLElement>(`[data-para="${para}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashIndex.value = para;
  window.setTimeout(() => {
    flashIndex.value = -1;
  }, 1600);
}

/* ---------------- 书架 ---------------- */

const shelf = ref<ShelfDoc[]>([]);
const curId = ref(core.reader.shelf()[0]?.id ?? '');
const progressMap = ref<Record<string, { read: number; total: number }>>({});

function refreshShelf(): void {
  shelf.value = core.reader.shelf();
  const map: Record<string, { read: number; total: number }> = {};
  for (const d of shelf.value) map[d.id] = core.reader.readCount(d.id);
  progressMap.value = map;
}

const doc = computed(() => shelf.value.find((d) => d.id === curId.value));

const readSet = ref<number[]>([]);
function refreshProgress(): void {
  readSet.value = curId.value ? core.reader.progress(curId.value) : [];
}

function selectDoc(id: string): void {
  stopAll();
  curId.value = id;
  refreshProgress();
  resetPanel();
}

/* ---------------- 字号 ---------------- */

const fontSize = ref(core.settings.read('fontSize'));

function bumpFont(delta: number): void {
  const next = Math.min(28, Math.max(12, fontSize.value + delta));
  if (next === fontSize.value) return;
  fontSize.value = next;
  core.settings.patch({ fontSize: next });
}

/* ---------------- 正文 ---------------- */

const docMain = ref<HTMLElement | null>(null);

const paras = computed<readonly string[]>(() => doc.value?.paras ?? []);

function toggleRead(i: number): void {
  core.reader.markRead(curId.value, i);
  readSet.value = core.reader.progress(curId.value);
  refreshShelf();
}

/* ---------------- 划词与三问 ---------------- */

const quote = ref('');
const askbarOpen = computed(() => quote.value.length > 0);

function onMouseUp(): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !sel) return;

  // 只有在正文里划的词才算，避免侧栏里随便一拖就弹三问
  const anchor = sel.anchorNode;
  if (docMain.value && anchor && docMain.value.contains(anchor)) {
    quote.value = text.slice(0, 240);
  }
}

/* ---------------- AI 面板 ---------------- */

type Skill = 'explain' | 'question' | 'connect';

interface PanelState {
  asked: Skill | null;
  /** 正在等模型（还没开始吐字） */
  waiting: boolean;
  /** 打字机中的文本 */
  typing: string;
  /** 完整回答，存书用 */
  full: string;
  /** 关联概念 id */
  lit: string[];
  /** 落到今天那一句 */
  act: string;
  /** 这条来自预置脚本 */
  canned: boolean;
}

const panel = ref<PanelState>({
  asked: null,
  waiting: false,
  typing: '',
  full: '',
  lit: [],
  act: '',
  canned: false,
});

let typeTimer: number | null = null;

function stopTyping(): void {
  if (typeTimer !== null) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
}

function resetPanel(): void {
  stopTyping();
  quote.value = '';
  panel.value = {
    asked: null,
    waiting: false,
    typing: '',
    full: '',
    lit: [],
    act: '',
    canned: false,
  };
}

/** 打字机。旧版逐字 2 个字符/28ms，手感刚好，照搬。 */
function typeOut(full: string, done?: () => void): void {
  stopTyping();
  panel.value.typing = '';
  let i = 0;
  typeTimer = window.setInterval(() => {
    i += 2;
    panel.value.typing = full.slice(0, i);
    if (i >= full.length) {
      stopTyping();
      panel.value.typing = full;
      done?.();
    }
  }, 28);
}

const litNames = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  for (const n of STAR_NODES) m[n.id] = n.name;
  return m;
});

/**
 * 三个技能。
 *
 * 「引导我」走固定剧本，不消耗模型调用 —— 这是设计上的取舍：
 * 苏格拉底式追问的价值在节奏，不在聪明。
 */
async function ask(kind: Skill): Promise<void> {
  if (!quote.value) return;

  resetPanel();
  quote.value = quote.value; // 保留选中文本
  panel.value.asked = kind;

  const d = doc.value;

  if (kind === 'question') {
    // 固定三步追问
    panel.value.canned = true;
    panel.value.lit = ['dichotomy', 'midwife'];
    panel.value.full =
      '先别急着要解释。三个问题，你自己回答，答完往往就通了：\n\n' +
      '① 这段话里，哪个词你最没把握？把它单独拎出来。\n' +
      '② 如果作者是在反驳某个人，那个人会怎么回嘴？\n' +
      '③ 把这段话套到你最近的一件真事上——套不进去的地方，就是你没懂的地方。';
    typeOut(panel.value.full);
    return;
  }

  if (core.ai.isLive() && d) {
    panel.value.waiting = true;

    const sys = kind === 'explain' ? PROMPT_EXPLAIN : PROMPT_CONNECT;
    const user = `【原文全文】\n${d.paras.join('\n')}\n\n【用户选中】\n${quote.value}`;

    const r = await core.ai.chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);
    panel.value.waiting = false;

    if (r.ok) {
      panel.value.full = r.reply.text;
      panel.value.lit =
        kind === 'explain' ? ['midwife', 'dichotomy'] : ['paoding', 'zhixing', 'midwife'];
      panel.value.act =
        kind === 'explain'
          ? '落到今天：把这段讲给一个不懂哲学的朋友听——讲得出口，才算真懂。'
          : '落到今天：你最近在哪个观点上「站队」了？它反对的立场，你真的读过吗？';
      typeOut(r.reply.text);
      return;
    }
    nav.toast(`模型没回应（${r.reason}），已切预置脚本`);
  }

  // 离线兜底
  panel.value.canned = true;
  const canned = mockAnswer(kind, quote.value, d?.custom ?? false);
  panel.value.full = canned.text;
  panel.value.lit = canned.lit;
  panel.value.act = canned.act;
  typeOut(canned.text);
}

/**
 * 预置回答。
 *
 * 旧版这里是一长串 `if (q.includes('天理'))`，散在函数里将近 40 行。
 * 收成一张表之后，加新原文只需要加一条，不用再动逻辑。
 */
function mockAnswer(
  kind: Skill,
  q: string,
  custom: boolean,
): { text: string; lit: string[]; act: string } {
  if (custom) {
    return {
      text:
        `你选中了：「${q.length > 30 ? `${q.slice(0, 30)}…` : q}」。\n\n` +
        '我这边的预置脚本只覆盖内置的两篇原著，对你自己载入的书给不出内容级的讲解 —— ' +
        '真模型接上之后，这里会把整本书当上下文逐层讲：先人话版，再学术版，再给你一个生活类比。\n\n' +
        '现在可以先点「我没懂，引导我」：三个问题不需要模型也能问，答完往往就通了。',
      lit: ['midwife', 'dichotomy'],
      act: '落到今天：这段话让你联想到自己经历的哪件事？',
    };
  }

  if (kind === 'connect') {
    if (/天理|庖丁|神遇|官知止/.test(q)) {
      return {
        text:
          '庖丁解牛是「方法论」的中国式表达，对位的是西方的实践智慧（phronesis）：\n\n' +
          '· 亚里士多德：实践理性是在具体处境中见出「中道」的能力——庖丁见的正是牛的中道\n' +
          '· 与产婆术互为表里：苏格拉底追问「你真的懂吗」，庄子演示「懂了就不用眼看」\n' +
          '· 王阳明的「知行合一」是它的注脚：解牛之道不在书里，在刀锋上',
        lit: ['paoding', 'zhixing', 'midwife'],
        act: '落到今天：你最近在哪个观点上「站队」了？它反对的立场，你真的读过吗？',
      };
    }
    return {
      text:
        '这段表面在立论，其实在跟整个古代伦理学传统对线：\n\n' +
        '· 对柏拉图：善不在理念王国里，在「你能力之内」的意图里\n' +
        '· 对亚里士多德：幸福不靠外在善（财富、名誉、健康），靠德性运用\n' +
        '· 后世回声：康德的「意志自律」只认动机不认后果，是这条线的德国版翻版\n\n' +
        '而庄子会怎么接这一刀？——「知其不可奈何而安之若命」，接受不可控这块，中西在顶峰握了手。',
      lit: ['dichotomy', 'kant', 'stoic'],
      act: '落到今天：你最近在哪个观点上「站队」了？它反对的立场，你真的读过吗？',
    };
  }

  if (/能力之内|不在我们能力之内/.test(q)) {
    return {
      text:
        '这一刀是整部《论说集》的总纲。\n\n' +
        '爱比克泰德把世界切成两半：能力之内的是判断、倾向、欲望、厌恶——注意，全是「心智活动」；' +
        '能力之外的是身体、财产、名声、职位——全是「身外之物」。\n\n' +
        '妙处在后半句：连身体都被归到能力之外。这不是悲观，是解放——' +
        '考试成绩、别人议论、排名数字，从始至终就不归你管，你管的是「怎么对待它们」。',
      lit: ['dichotomy', 'epictetus'],
      act: '落到今天：昨晚让你睡不着的那个消息，属于哪一边？',
    };
  }

  if (/真正的损害|判断/.test(q)) {
    return {
      text:
        '这句话是控制二分法的「升级版」：斯多葛不说「看开点」，他们说——\n\n' +
        '让你痛苦的不是事件，是你对事件的「判断」。同样是被否定，' +
        '「这说明我差劲」是判断，「这说明这次不匹配」也是判断。前者制造痛苦，后者制造下一步行动。\n\n' +
        '后来的认知行为疗法（CBT）几乎原样继承了这条思路。',
      lit: ['dichotomy', 'stoic'],
      act: '落到今天：给最近一件烦扰事，换个「斯多葛版判断」写下来。',
    };
  }

  if (/天理/.test(q)) {
    return {
      text:
        '「天理」不是道德法则，是牛本身的自然结构——骨节之间本就有的空隙。\n\n' +
        '庖丁的刀十九年若新发于硎，因为他「以无厚入有间」：不切割，只游走。' +
        '你做事硬碰、内耗、卡住，往往是在跟「全牛」较劲，而没找到那道缝。\n\n' +
        '注意他说的前提：「三年之后，未尝见全牛」——先看见结构，才谈得上顺应。',
      lit: ['paoding', 'zhuangzi'],
      act: '落到今天：手头最卡的那件事，「骨节之间的缝」在哪里？',
    };
  }

  if (/神遇|官知止/.test(q)) {
    return {
      text:
        '「官知止而神欲行」——眼睛耳朵这些感官停下，手自己知道往哪走。\n\n' +
        '这就是熟练的终点：从「想着做」变成「做着想」。王阳明说「知行合一」，庖丁说「神遇」，说的是同一件事的两端。\n\n' +
        '但它有代价：庖丁练了十九年。所有看似玄妙的「游刃有余」，都是大量枯燥练习之后，结构长进了身体里。',
      lit: ['paoding', 'zhixing'],
      act: '落到今天：你手上哪件事已经到了「官知止」的阶段？哪件还在「所见无非牛」？',
    };
  }

  return {
    text:
      '这段讲的是控制二分法的直接应用：把「属于别人的东西」认成自己的，是烦恼的总根源。\n\n' +
      '名声、职位、他人的评价——你把它们请进自己的领地，就等于把钥匙交给别人，别人一不高兴你就断电。\n\n' +
      '斯多葛不说这些不重要，说的是：它们重要，但不归你。',
    lit: ['dichotomy', 'stoic'],
    act: '落到今天：列一件「别人的事」，今晚开始不替它操心。',
  };
}

/* ---------------- 存进哲学书 ---------------- */

function saveReading(): void {
  if (!panel.value.full) {
    nav.toast('等回答出来再存');
    return;
  }
  core.materials.add('readings', {
    date: today(),
    doc: doc.value?.short ?? '未命名',
    quote: quote.value.slice(0, 120),
    skill: panel.value.asked === 'explain' ? '讲解' : panel.value.asked === 'connect' ? '格义' : '追问',
    reply: panel.value.full,
  });
  nav.toast('已存入「我的哲学书」');
}

/* ---------------- 朗读 ---------------- */

const readingIndex = ref(-1);
const speaking = ref(false);

const ttsEngineName = computed(() => {
  const e = core.settings.read('ttsEngine');
  return e === 'edge' ? 'Edge 音色' : e === 'custom' ? '自定义 TTS' : '系统语音';
});

function speak(from: number): void {
  if (!paras.value.length) return;

  speaking.value = true;
  core.tts.start(paras.value, from, {
    onParagraph: (i) => {
      readingIndex.value = i;
      const el = docMain.value?.querySelector(`[data-para="${i}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 念到哪就算读到哪，进度跟阅读同步
      core.reader.markRead(curId.value, i);
      readSet.value = core.reader.progress(curId.value);
    },
    onFinish: () => {
      speaking.value = false;
      readingIndex.value = -1;
      refreshShelf();
    },
    onNotice: (msg) => nav.toast(msg),
    onEngineFallback: () => {
      core.settings.patch({ ttsEngine: 'browser' });
      nav.toast('已切到系统语音');
    },
  });
}

function stopAll(): void {
  core.tts.stop();
  speaking.value = false;
  readingIndex.value = -1;
}

/* ---------------- 载入书籍 ---------------- */

const fileInput = ref<HTMLInputElement | null>(null);

function onFile(ev: Event): void {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const r = core.reader.addUserBook(file.name, String(reader.result ?? ''));
    if (!r.ok) {
      nav.toast(r.reason);
      return;
    }
    refreshShelf();
    selectDoc(r.id);
    nav.toast(`《${r.title}》已加入书架 · ${r.paras} 段`);
  };
  reader.readAsText(file, 'UTF-8');
  input.value = '';
}

/* ---------------- 生命周期 ---------------- */

function removeBook(id: string, ev: Event): void {
  ev.stopPropagation();
  core.reader.removeUserBook(id);
  if (curId.value === id) {
    curId.value = core.reader.shelf()[0]?.id ?? '';
    refreshProgress();
    resetPanel();
  }
  refreshShelf();
  nav.toast('已从书库移除');
}

onMounted(() => {
  refreshShelf();
  refreshProgress();
  if (props.jump) void goTo(props.jump.id, props.jump.para);
});

/* 已经在本视图时，外部又指定了位置 */
watch(
  () => props.jump,
  (j) => {
    if (j) void goTo(j.id, j.para);
  },
);

onBeforeUnmount(() => {
  stopTyping();
  core.tts.stop();
});
</script>

<template>
  <div class="reader">
    <div class="hint">
      选中原文任何一句 → 弹出三问 · 回答里的概念可一键跳回星图 · 可存入我的哲学书 · 支持载入自己的 .txt / .md · 悬停段落可朗读
    </div>

    <!-- 窄屏专用：三栏切换。宽屏下被 CSS 隐藏，不影响任何布局 -->
    <div class="m-panes">
      <button
        v-for="p in [
          { key: 'shelf', label: '书架' },
          { key: 'doc', label: '正文' },
          { key: 'ask', label: '伴读' },
        ]"
        :key="p.key"
        type="button"
        :class="{ on: mobilePane === p.key }"
        @click="mobilePane = p.key as typeof mobilePane"
      >
        {{ p.label }}
      </button>
    </div>

    <div class="wrap" :class="`pane-${mobilePane}`">
      <!-- 书架 -->
      <div class="shelf">
        <div class="shelf-head">
          <span>书架</span>
          <button type="button" class="add" @click="fileInput?.click()">
            <Icon name="i-plus" :size="13" /> 载入书籍
          </button>
          <input
            ref="fileInput"
            type="file"
            accept=".txt,.md"
            style="display: none"
            @change="onFile"
          />
        </div>

        <button
          v-for="d in shelf"
          :key="d.id"
          type="button"
          class="book-btn"
          :class="{ on: d.id === curId }"
          @click="selectDoc(d.id)"
        >
          <span class="t">{{ d.short }}</span>
          <span class="p">
            {{ progressMap[d.id]?.read ? `已读 ${progressMap[d.id]!.read}/${progressMap[d.id]!.total} 段` : '未开始' }}
            <span v-if="d.custom" class="del" @click="removeBook(d.id, $event)">移除</span>
          </span>
        </button>
      </div>

      <!-- 正文 -->
      <div class="doc-col">
        <div class="toolbar">
          <div class="group">
            <span class="lab">字号</span>
            <button type="button" @click="bumpFont(-1)">A－</button>
            <span class="val">{{ fontSize }}px</span>
            <button type="button" @click="bumpFont(1)">A＋</button>
          </div>
          <div class="group">
            <button type="button" @click="speak(0)">
              <Icon name="i-volume" :size="14" /> 朗读全文
            </button>
            <button type="button" :disabled="!speaking" @click="stopAll">
              <Icon name="i-stop" :size="14" /> 停止
            </button>
          </div>
          <span class="engine">{{ ttsEngineName }}</span>
        </div>

        <div ref="docMain" class="doc" :style="{ '--reading-size': `${fontSize}px` }" @mouseup="onMouseUp">
          <template v-if="doc">
            <h2 class="serif">{{ doc.title }}</h2>
            <div class="meta">{{ doc.meta }}</div>

            <div class="doc-chips">
              <template v-if="doc.custom">
                <Icon name="i-file" :size="13" /> 我的书库 · 点段落标记已读 · 悬停段落可朗读
              </template>
              <template v-else>
                点段落标记已读 · 选中一句话问 AI · 悬停右侧喇叭可单段朗读
              </template>
            </div>

            <p
              v-for="(p, i) in paras"
              :key="i"
              class="para serif"
              :class="{ read: readSet.includes(i), reading: readingIndex === i, flash: flashIndex === i }"
              :data-para="i"
              @click="toggleRead(i)"
            >
              {{ p }}
              <button
                type="button"
                class="para-tts"
                title="朗读本段"
                @click.stop="speak(i)"
              >
                <Icon name="i-volume" :size="13" />
              </button>
            </p>
          </template>
          <div v-else class="none">书架上还没有这本书。</div>
        </div>
      </div>

      <!-- AI 侧栏 -->
      <div class="ai-panel">
        <div v-if="!panel.asked" class="tip">
          ← 选中原文一句话，问我「讲讲 / 引导我 / 在反驳谁」
        </div>

        <template v-else>
          <div class="quote serif">「{{ quote }}」</div>

          <div class="who">
            问津 AI · {{ panel.asked === 'explain' ? '讲解' : panel.asked === 'connect' ? '格义' : '追问' }}
            <span v-if="panel.canned" class="canned">预置</span>
          </div>

          <div v-if="panel.waiting" class="wait">正在读这段…</div>
          <div v-else class="answer">{{ panel.typing }}</div>

          <template v-if="panel.full && !panel.waiting">
            <div class="lit-line">
              点亮关联概念：
              <span v-for="id in panel.lit" :key="id" class="chip" @click="nav.gotoNode(id)">
                {{ litNames[id] ?? id }}
              </span>
            </div>
            <div class="act">{{ panel.act }}</div>
            <button type="button" class="btn ghost sm" @click="saveReading">
              <Icon name="i-book" :size="14" /> 把这段问答存入我的哲学书
            </button>
          </template>
        </template>
      </div>
    </div>

    <!-- 划词后浮出的三问 -->
    <div class="askbar" :class="{ on: askbarOpen }">
      <button type="button" class="primary" @click="ask('explain')">讲讲这段</button>
      <button type="button" @click="ask('question')">我没懂，引导我</button>
      <button type="button" @click="ask('connect')">这在反驳谁</button>
    </div>
  </div>
</template>

<style scoped>
.reader {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
}

.wrap {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) 320px;
}

/* ---------- 书架 ---------- */

.shelf {
  overflow-y: auto;
  padding: 16px 12px 24px;
  border-right: 1px solid var(--line);
  background: var(--bg2);
}

.shelf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 12px;
  font-size: 12px;
  color: var(--ink3);
}

.add {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  font-size: 11.5px;
  color: var(--accent);
}

.add:hover {
  background: var(--accent-soft);
}

.add svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
}

.book-btn {
  display: block;
  width: 100%;
  padding: 9px 11px;
  margin-bottom: 5px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  text-align: left;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease);
}

.book-btn:hover {
  background: var(--card-hi);
}

.book-btn.on {
  background: var(--card);
  border-color: var(--accent);
}

.book-btn .t {
  display: block;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink2);
}

.book-btn.on .t {
  color: var(--ink);
}

.book-btn .p {
  display: block;
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--ink3);
}

.del {
  margin-left: 6px;
  color: var(--rose);
}

.del:hover {
  text-decoration: underline;
}

/* ---------- 正文 ---------- */

.doc-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 22px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  color: var(--ink2);
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.group .lab {
  color: var(--ink3);
}

.group button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--ink2);
}

.group button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.group button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.group button svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.val {
  min-width: 38px;
  text-align: center;
  color: var(--ink3);
  font-variant-numeric: tabular-nums;
}

.engine {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink3);
}

.doc {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 30px 40px 80px;
  max-width: 780px;
}

.doc h2 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.meta {
  margin-bottom: 14px;
  font-size: 12px;
  color: var(--ink3);
}

.doc-chips {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 10px 14px;
  margin-bottom: 22px;
  border-radius: var(--radius-sm);
  background: var(--field);
  font-size: 12px;
  color: var(--ink3);
}

.doc-chips svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
}

.para {
  position: relative;
  margin: 0 0 1.35em;
  font-size: var(--reading-size, 16px);
  line-height: 1.95;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: color 0.18s var(--ease), background 0.18s var(--ease);
  scroll-margin: 40% 0;
  padding: 2px 4px;
  border-radius: 4px;
  margin-left: -4px;
}

.para:hover {
  background: var(--card-hi);
}

/* 已读：降一档对比度，让「读到哪」一眼可见 */
.para.read {
  color: var(--ink3);
}

/* 正在朗读：左侧一道高亮条 + 轻微底色 */
.para.reading {
  color: var(--ink);
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

/* 从别处跳过来时闪一下，否则用户不知道落在了哪 */
.para.flash {
  animation: flash 1.6s var(--ease);
}

@keyframes flash {
  0%,
  100% {
    background: transparent;
  }
  25% {
    background: var(--accent-soft);
    box-shadow: inset 2px 0 0 var(--accent);
  }
}

.para-tts {
  position: absolute;
  top: 0.35em;
  right: -30px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--ink3);
  opacity: 0;
  transition: opacity 0.16s var(--ease);
}

.para:hover .para-tts {
  opacity: 1;
}

.para-tts:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.para-tts svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
}

.none {
  padding: 40px 0;
  color: var(--ink3);
  font-size: 13px;
}

/* ---------- AI 侧栏 ---------- */

.ai-panel {
  min-width: 0;
  overflow-y: auto;
  padding: 22px 20px 40px;
  border-left: 1px solid var(--line);
  background: var(--bg2);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tip {
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink3);
}

.quote {
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--accent);
  background: var(--field);
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink2);
}

.who {
  font-size: 11.5px;
  color: var(--accent);
}

.canned {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--field-2);
  font-size: 10px;
  color: var(--ink3);
}

.wait {
  font-size: 12.5px;
  color: var(--ink3);
}

.answer {
  font-size: 13px;
  line-height: 1.85;
  color: var(--ink2);
  white-space: pre-wrap;
}

.lit-line {
  font-size: 12px;
  color: var(--ink3);
}

.act {
  padding: 10px 13px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--accent);
}

/* ---------- 三问浮条 ---------- */

.askbar {
  position: absolute;
  left: 50%;
  bottom: 26px;
  z-index: 20;
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 999px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--sh-pop);
  transform: translate(-50%, 16px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}

.askbar.on {
  opacity: 1;
  transform: translate(-50%, 0);
  pointer-events: auto;
}

.askbar button {
  padding: 7px 15px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--ink2);
  white-space: nowrap;
}

.askbar button:hover {
  background: var(--card-hi);
  color: var(--ink);
}

.askbar button.primary {
  background: var(--accent);
  color: var(--accent-ink);
}

.askbar button.primary:hover {
  filter: brightness(1.08);
}

/* ============================================================
 * 窄屏（手机）
 *
 * 三栏并排在 375px 屏上每栏只剩窄缝，没法读。
 * 这里改成「一次一栏」：书架 / 正文 / 伴读 切换。
 * 宽屏完全不受影响 —— 切换条默认不显示，三栏照旧并排。
 * ============================================================ */

.m-panes {
  display: none;
}

@media (max-width: 760px) {
  .m-panes {
    display: flex;
    gap: 2px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }

  .m-panes button {
    flex: 1;
    padding: 8px 0;
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--ink2);
  }

  .m-panes button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .wrap {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }

  /* 三栏先全部按下去，再由 pane-* 放行当前那一栏 */
  .shelf,
  .doc-col,
  .ai-panel {
    display: none;
    border-left: 0;
  }

  .pane-shelf .shelf {
    display: block;
  }

  .pane-doc .doc-col {
    display: flex;
  }

  .pane-ask .ai-panel {
    display: flex;
  }

  .doc {
    padding: 18px 16px 64px;
    max-width: none;
  }

  .toolbar {
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 12px;
  }
}
</style>
