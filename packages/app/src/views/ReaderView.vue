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
  TTS_PROVIDERS,
  today,
  type ShelfDoc,
} from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';
import { useNarrow } from '../useNarrow';

const core = useCore();
const nav = useNav();
const narrow = useNarrow();

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
  currentPara.value = para;
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
  // 换书回到开头，并按已读进度把「当前段」对齐到上次读的地方
  currentPara.value = 0;
  void nextTick(() => {
    const d = docMain.value;
    if (d) d.scrollTop = 0;
    const read = readSet.value;
    currentPara.value = read.length ? Math.min(Math.max(...read) + 1, Math.max(0, paras.value.length - 1)) : 0;
  });
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

/* ============================================================
 * 翻页
 *
 * 旧版没有翻页，只能靠鼠标滚。手机上一滚几千字就找不着北，
 * 桌面上一本 98 段的《庄子》更是读不到一半。
 *
 * 现在三条路都能走：
 *   · 工具条上的「上一段 / 下一段」——点一下翻一段；
 *   · 键盘 ↑↓ / PageUp / PageDown / Home / End；
 *   · 底部进度条告诉你读到第几段、还剩多少。
 *
 * 当前位置的判定：视口顶部压着的那一段。滚动时用 rAF 节流重算，
 * 不做 IntersectionObserver——段落可能上百个，直接按几何位置算更省事。
 * ============================================================ */

const currentPara = ref(0);

function paraEls(): HTMLElement[] {
  if (!docMain.value) return [];
  return Array.from(docMain.value.querySelectorAll<HTMLElement>('.para'));
}

function updateCurrentPara(): void {
  const els = paraEls();
  if (!els.length) return;
  const box = docMain.value;
  const top = box?.getBoundingClientRect().top ?? 0;
  // 滚到底时，视口顶部那一段并不是「你正在读的」——最后一段才是
  if (box && box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
    currentPara.value = els.length - 1;
    return;
  }
  let idx = 0;
  for (let i = 0; i < els.length; i += 1) {
    const r = els[i]!.getBoundingClientRect();
    if (r.bottom <= top + 8) {
      idx = i;
      continue;
    }
    // 第一段已经滚到视口顶以上（读过的部分）时，指针落到下一段
    idx = i;
    break;
  }
  currentPara.value = idx;
}

let scrollPending = false;
function onDocScroll(): void {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    updateCurrentPara();
  });
}

function gotoPara(i: number): void {
  const els = paraEls();
  if (!els.length) return;
  const t = Math.max(0, Math.min(els.length - 1, i));
  const el = els[t]!;
  // 跨度大就别用平滑动画：一次滚两万像素的 smooth 会又慢又卡，
  // 读起来像卡死。跨几屏以内才值得有那段滑行。
  const scroller = docMain.value;
  const distance = scroller ? Math.abs(el.offsetTop - scroller.scrollTop) : 0;
  const smooth = distance < 2400;
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  currentPara.value = t;
}

function nextPara(): void {
  gotoPara(currentPara.value + 1);
}

function prevPara(): void {
  gotoPara(currentPara.value - 1);
}

function goTop(): void {
  gotoPara(0);
}

function goEnd(): void {
  gotoPara(paras.value.length - 1);
}

/** 继续上次读：跳到第一段还没读过的（没读过就从头） */
function resumeRead(): void {
  const read = readSet.value;
  const next = read.length ? Math.max(...read) + 1 : 0;
  gotoPara(Math.min(next, Math.max(0, paras.value.length - 1)));
}

const progressPct = computed(() => {
  const n = paras.value.length;
  if (!n) return 0;
  return Math.round(((currentPara.value + 1) / n) * 100);
});

const readPct = computed(() => {
  const n = paras.value.length;
  if (!n) return 0;
  return Math.round((readSet.value.length / n) * 100);
});

/** 键盘翻页。输入框里打字时不抢键。 */
function onKeydown(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!paras.value.length) return;

  switch (e.key) {
    case 'ArrowDown':
    case 'PageDown':
      e.preventDefault();
      nextPara();
      break;
    case 'ArrowUp':
    case 'PageUp':
      e.preventDefault();
      prevPara();
      break;
    case 'Home':
      e.preventDefault();
      goTop();
      break;
    case 'End':
      e.preventDefault();
      goEnd();
      break;
    default:
      break;
  }
}

function toggleRead(i: number): void {
  core.reader.markRead(curId.value, i);
  readSet.value = core.reader.progress(curId.value);
  refreshShelf();
}

/* ---------------- 划词与三问 ---------------- */

const quote = ref('');
/**
 * 浮条的显隐条件除了「有选中文本」，还要「还没开始问答」——
 * 否则提问后 quote 保留着（面板顶部要显示引文、存书也要用），
 * 浮条就会一直压在答案上面不下去。
 */
const askbarOpen = computed(() => quote.value.length > 0 && panel.value.asked === null);

/**
 * 读当前选区。电脑端 mouseup / 手机端 selectionchange 共用这一份逻辑。
 */
function readSelection(): void {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || !sel) return;

  // 只有在正文里划的词才算，避免侧栏里随便一拖就弹三问
  const anchor = sel.anchorNode;
  if (docMain.value && anchor && docMain.value.contains(anchor)) {
    const next = text.slice(0, 240);
    // 换了新选区（或上一轮问答已结束又重新划句）：收掉上一轮，浮条才能再次出现
    if (next !== quote.value || panel.value.asked !== null) {
      resetPanel();
      quote.value = next;
    }
  }
}

function onMouseUp(): void {
  readSelection();
}

/**
 * 3.3.2 修：手机上长按选词是触摸手势，浏览器根本不合成 mouseup，
 * 上一版只听 mouseup，导致手机端三问浮条永远弹不出来、导读 AI 整条链路进不去。
 * selectionchange 是触摸屏上唯一可靠的选区事件（长按、拖手柄都会触发）。
 * 电脑端也会触发，但只是幂等地写同一个 ref，没有副作用。
 */
function onSelectionChange(): void {
  readSelection();
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

  /* 3.3.2 修：resetPanel() 会把 quote 清掉，原先那句自赋值救不回来——
     结果面板顶部引文空白、存进哲学书的记录也丢了划的是哪句。
     先把选中文本存下来，清完再放回去。 */
  const selected = quote.value;
  resetPanel();
  quote.value = selected;
  panel.value.asked = kind;

  // 手机上三栏一次只显示一栏：提问后自动跳到伴读栏，
  // 否则答案渲染在一个看不见的栏里，用户点了按钮毫无反应
  if (narrow.value) mobilePane.value = 'ask';

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
        '我这边的预置脚本只覆盖内置的十四部原著，对你自己载入的书给不出内容级的讲解 —— ' +
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

  /* ---------- 3.4.0 新书覆盖：《道德经》《论语》《逍遥游》《大学》 ---------- */

  if (/上善若水|水善利|不争/.test(q)) {
    return {
      text:
        '水是《道德经》里「道」的头号形象：它往低处走（人人嫌的地方）、滋养万物（不抢功劳）、形态随器皿而变（从不硬顶）。\n\n' +
        '「不争」不是退缩，是不把自己卡在争的通道里——争，意味着你的价值由对手定义；不争，价值才回到事情本身。\n\n' +
        '跟斯多葛对照着看：控制二分法管「能力之外的事不操心」，老子管「赢了也不值得争」——一个划界，一个超脱。',
      lit: ['laotzi', 'zhuangzi'],
      act: '落到今天：你最近在「争」的那件事，赢了之后你真正得到什么？答不出来，就是水该拐弯的地方。',
    };
  }

  if (/自知者明|自胜|知人者智|知足/.test(q)) {
    return {
      text:
        '这一段是一个双阶梯：知人→自知，胜人→自胜。前者对外，后者对内，而老子把「明」和「强」都判给了内侧。\n\n' +
        '「胜人者有力」——赢别人只说明你有力量；「自胜者强」——管住自己的惰性、欲望、情绪，才是真正的强。考试排名是前者，自律是后者。\n\n' +
        '注意最后一句「死而不亡者寿」：肉身会倒，影响不灭。这几乎是所有哲人的共同追求——留在后世的不是寿命，是活法。',
      lit: ['laotzi', 'dichotomy'],
      act: '落到今天：写下一个你「知人易、自知难」的点——你身上哪个毛病，看别人时看得最清楚？',
    };
  }

  if (/千里之行|九层之台|合抱之木|毫末|慎终如始/.test(q)) {
    return {
      text:
        '这是老子版「最小行动」：合抱的树从芽开始，九层的高台从第一筐土开始——大工程没有起点，只有无数个「毫末」。\n\n' +
        '后半句更狠：「为者败之，执者失之」。硬来、攥太紧，反而坏事。所以「慎终如始」——越接近终点越要像刚起步那样谨慎，因为人在几成的时候最容易松手。\n\n' +
        '跟方法论 A11（知行合一）打通：别问「我什么时候能做成」，问「今天的毫末是什么」。',
      lit: ['laotzi', 'zhixing'],
      act: '落到今天：把你拖着没做的那件事，缩到 10 分钟内能完成的「毫末版」，现在就做。',
    };
  }

  if (/知不知|不知知/.test(q)) {
    return {
      text:
        '「知道自己不知道」是高级，装作知道是毛病。七十一章短短二十几个字，把认知的诚实讲透了。\n\n' +
        '关键在后半：「圣人不病，以其病病」——把「不知道」当成病来看，才不会得这个病。承认无知不是谦虚的姿态，是修正的入口。\n\n' +
        '这与苏格拉底「我唯一知道的是我一无所知」遥遥相对：东西方在认知诚实上握了手。',
      lit: ['laotzi', 'socrates', 'midwife'],
      act: '落到今天：说一个你一直在「不懂装懂」的概念——现在去把它弄懂，或大方承认不懂。',
    };
  }

  if (/学而时习|不亦说乎|不亦乐乎/.test(q)) {
    return {
      text:
        '《论语》第一句就是方法论的浓缩：「学」是输入，「习」是反复练习（繁体的「習」是鸟 repeatedly 振翅），「说（悦）」是从心里冒出来的高兴。\n\n' +
        '注意排序：自己的练习之乐 → 朋友远来之乐 → 「人不知而不愠」。从独处到社交到不被理解的委屈，一层比一层难。\n\n' +
        '最后一句是斯多葛式的：别人知不知道你，归别人管；你学不学，归你管。',
      lit: ['confucius', 'dichotomy'],
      act: '落到今天：挑一个「学了但没习」的东西，今天就练一遍——「时习」的乐，练过才知道。',
    };
  }

  if (/三省吾身|为人谋|传不习/.test(q)) {
    return {
      text:
        '曾子的日课只有三问，但方向值得看：替人办事尽没尽心（做事）、跟人交往守没守信（关系）、老师教的东西练没练（成长）。\n\n' +
        '没有一条是问「别人对我怎么样」——反省全落在自己可控行为上。这和爱比克泰德的控制二分法是同一套底层逻辑：只审自己名下的账。\n\n' +
        '三省是「日日新」的日常版：不指望一次大彻悟，指望每天对一次账。',
      lit: ['confucius', 'dichotomy', 'daxue'],
      act: '落到今天：睡前按曾子三问过一遍今天——哪一问最难答？那就是明天该用力的地方。',
    };
  }

  if (/知之者不如好之|好之者不如乐之/.test(q)) {
    return {
      text:
        '这一句给学习分了三层境界：知道它有用（知）→ 对它有兴趣（好）→ 做它本身就是享受（乐）。\n\n' +
        '大多数人卡在「知」这一层靠意志硬撑，所以撑不久。孔子的解法不是加码自律，而是升级动力来源——从「应该做」走向「想做」。\n\n' +
        '这也是尼采「成为自己」的中国版：找到那件让你「乐之」的事，坚持就不再是问题，因为坚持这个词已经不适用了。',
      lit: ['confucius', 'nietzsche'],
      act: '落到今天：写下你正在「知而不乐」地做的一件事——它的哪部分有可能变出味道来？',
    };
  }

  if (/和而不同/.test(q)) {
    return {
      text:
        '「和」与「同」的区别是这一句的全部：「同」是消灭差异后的整齐（你说什么我说什么），「和」是保留差异后的协调（各声部合成一首曲子）。\n\n' +
        '孔子反对的是「同而不和」——表面迎合、底下较劲。真正的关系是各自站稳，还能合奏。\n\n' +
        '这给友谊一个很高的标准：好朋友不是复制你的观点，是能跟你观点不同、还能好好说话的人。',
      lit: ['confucius', 'stoic'],
      act: '落到今天：找一个和你观点不同的朋友，认真听完他的理由——练一次「和」。',
    };
  }

  if (/松柏|岁寒/.test(q)) {
    return {
      text:
        '岁寒，然后知松柏之后凋——天冷了，才知道松柏是最后凋零的。顺境里人人都像君子，考验来时才见分晓。\n\n' +
        '注意孔子的意思不是「去当松柏」，而是：低谷有认识功能。它揭示底子，也铸造底子——你撑过这次岁寒，下次就多一分从容。\n\n' +
        '跟尼采「凡不能杀死我的」对读：两位都把苦难看成力量的检验场，只是孔子更平静，尼采更炽烈。',
      lit: ['confucius', 'nietzsche', 'amorfati'],
      act: '落到今天：回想你熬过的一次「岁寒」——那次撑住你的，是什么？那个东西现在还在吗？',
    };
  }

  if (/鲲|鹏|扶摇|九万里|北冥/.test(q)) {
    return {
      text:
        '鲲鹏是《逍遥游》的开场：几千里的大鱼变成大鸟，水击三千里、直上九万里才往南飞。\n\n' +
        '为什么非飞那么高？下文蜩与学鸠给了答案的反面：小鸟笑大鹏「我们蹦一下就到树梢，你飞九万里干嘛」。庄子替大鹏答了——适千里者，三月聚粮。去多远的地方，需要多大的准备，格局决定航程。\n\n' +
        '别急着嘲笑蜩与学鸠，也别急着羡慕大鹏：先问你想去的是南冥还是榆枋，再决定要不要聚三个月的粮。',
      lit: ['xiaoyao', 'zhuangzi'],
      act: '落到今天：你想去「南冥」还是「榆枋」？写下你的南冥，再写下今天的「宿舂粮」。',
    };
  }

  if (/恶乎待|无己|无功|无名/.test(q)) {
    return {
      text:
        '这是《逍遥游》的题眼：「恶乎待哉」——不依赖任何东西，才叫逍遥。\n\n' +
        '前面的鲲鹏虽大，仍「有所待」（靠风、靠水）；列子御风也「有所待」。真正的自由分三级：无己（不困在自我设定）、无功（不困在成果账本）、无名（不困在他人评价）。\n\n' +
        '跟爱比克泰德对读：斯多葛把自由锚在「能力之内」，庄子把自由锚在「无所待」——一个向内划界，一个向外松绑。',
      lit: ['xiaoyao', 'epictetus', 'dichotomy'],
      act: '落到今天：你现在最「待」的东西是什么（某个人的认可、某个结果）？试着今天不为它活一小时。',
    };
  }

  if (/樗|大树|大本臃肿|无何有之乡/.test(q)) {
    return {
      text:
        '惠子拿一棵不成材的大树笑话庄子「大而无用」，庄子的回答是全书的招牌之一：正因为你嫌它无用、木匠都不看它一眼，它才能长在旷野里，让你躺底下乘凉——「不夭斤斧」，没人砍它，它活得最久。\n\n' +
        '「无用之用」的锋芒在：有用，是被别人使用的另一个说法。你急着变有用，是急着进谁的工序？\n\n' +
        '当然别矫枉过正：庄子不反对努力，他反对的是把「被使用」当成价值的唯一来源。',
      lit: ['xiaoyao', 'zhuangzi'],
      act: '落到今天：你身上哪个「没用」的部分（爱好、胡思乱想），其实一直在给你遮阴？',
    };
  }

  if (/明明德|止于至善|亲民/.test(q)) {
    return {
      text:
        '《大学》开篇三纲领：彰明自己的德性（明明德）、推己及人（亲民）、并止于两者最好的状态（止于至善）——修身与利他是一条线上的三站。\n\n' +
        '最值得注意的是「知止而后有定」：知道要去哪，心才能定；定了才能静、安、虑、得。**次序不能乱**——多数人的焦虑，是把「虑」放在了「定」前面。\n\n' +
        '这跟星图里的「控制二分法」能对上：先划界（知止），才谈得上从容。',
      lit: ['daxue', 'dichotomy', 'confucius'],
      act: '落到今天：为你手头的事写下一个「止」（做到什么程度算到位）——然后允许自己停在那。',
    };
  }

  if (/格物|致知|正心|诚意|修身|齐家/.test(q)) {
    return {
      text:
        '八条目是儒家给出的完整成长路径：格物→致知→诚意→正心→修身→齐家→治国→平天下。前四步向内（认知与心理），后四步向外（家庭与社会），枢纽在「修身」。\n\n' +
        '「格物致知」两千年聚讼纷纭——朱熹解作穷究事物之理，王阳明对着竹子格了七天格出病来，转而主张「格」是端正心意。你在星图里点亮的「知行合一」，就是从这场争论里长出来的。\n\n' +
        '「壹是皆以修身为本」：一切事的本钱是你这个人——本乱而末治，是不存在的。',
      lit: ['daxue', 'wangym', 'zhixing'],
      act: '落到今天：八条目里，你现在卡在哪一条？写下它，配一个 48 小时内可做的最小验证。',
    };
  }

  if (/苟日新|日日新/.test(q)) {
    return {
      text:
        '商汤在洗澡盆上刻了九个字：苟日新，日日新，又日新。洗澡是洗去身上的旧，这句是提醒洗去昨天的自己。\n\n' +
        '妙在器物选择：刻在盘铭上，意味着**每天用、每天见**——自我更新不是年度计划，是日课。\n\n' +
        '跟「三省吾身」配对使用：三省是查账，日新是改账。只查不改，越查越焦虑；只改不查，改了也不知道。',
      lit: ['daxue', 'confucius', 'zhixing'],
      act: '落到今天：给今天定一件「与昨天不同」的小事——哪怕只是换一条路回家，练一次「日新」。',
    };
  }

  /* ---------- 3.7.0 新书覆盖：人本主义五部 ---------- */

  if (/世界的中心|固定的位置|独特的禀赋|自我规定/.test(q)) {
    return {
      text:
        '这是人本主义的宣言书段落。注意皮科的讲法：人的尊贵不在于「被造得完美」，而在于「没被规定」——\n\n' +
        '飞鸟有飞鸟的本能，走兽有走兽的宿命，都被造物主写死了程序。唯独人拿到一张白纸：你渴望什么、判断什么，就长成什么。\n\n' +
        '这是巨大的礼物，也是巨大的负担——没有「我本来如此」可以推诿，你的每一笔都是自己签的名。后来萨特说「存在先于本质」，是这句话的三百年后回响。',
      lit: ['dignity', 'freewill', 'sartre'],
      act: '落到今天：写下一个你常说「我本来就是这样的人」——哪一部分是事实，哪一部分是你懒得改的？',
    };
  }

  if (/堕落成野兽|升华|重新成为神/.test(q)) {
    return {
      text:
        '皮科给自由画了一条竖直的斜坡：向下是兽，向上是神，人悬在中间，位置由意志决定。\n\n' +
        '妙在他不说「堕落是罪」——堕落只是「意志往下走」的结果，跟物理上的滑落一样自然。所以关键不是批判往下，是看清：每一刻你都在选方向。\n\n' +
        '跟尼采对读：尼采的「成为自己」是把斜坡变成攀登；跟斯多葛对读：控制二分法管的是「别在不可控处使劲」——方向恰恰是最可控的那个变量。',
      lit: ['freewill', 'nietzsche', 'dichotomy'],
      act: '落到今天：回忆今天的一次「往下滑」（一句怨话、一次拖延）——当时那个向上的选项是什么？',
    };
  }

  if (/旺图山|想看|山的高度|云海/.test(q)) {
    return {
      text:
        '彼特拉克是第一个「为了登山而登山」的欧洲人。他明说了：不为朝圣，不为牧歌，只为亲眼看看这座名山有多高。\n\n' +
        '这种「无用之看」在思想史上是个大事件：它意味着观看本身就可以成为目的——不必换算成信仰、利益或道德。近代科学、地理大发现、博物学，都是从这种「就是想看看」里长出来的。\n\n' +
        '想想你多久没有「不为用处」地看过一样东西了？看云、看虫、看星空——不拍照，不发朋友圈。',
      lit: ['curiosity', 'humanism'],
      act: '落到今天：今晚出门看十分钟天空，不带任何目的——练一次「无用之看」。',
    };
  }

  if (/忏悔录|内心的风暴|毫不惊奇/.test(q)) {
    return {
      text:
        '全文的转折在一页《忏悔录》。山顶风光正盛，彼特拉克随手翻开奥古斯丁，落在眼里的是这样几句：人们惊叹于山高海阔，却对自己内心的风暴毫不惊奇。\n\n' +
        '他当场沉默了——这句话把整趟登顶从「看世界」翻转成「看自己」。人文主义的外向（看山）与内向（看心）在这一页合流。\n\n' +
        '后来五百年，心理学干的都是这件事：向外走得再远，最后都要回来处理「内心的风暴」。',
      lit: ['humanism', 'dignity'],
      act: '落到今天：今天让你心里起风的那件事——如果当成「内心的风暴」来观察，它和昨天的风有什么不同？',
    };
  }

  if (/想象|相信什么|女主人/.test(q)) {
    return {
      text:
        '蒙田在三百多年前就讲清了「身心不是两户人家」：想象是住在身体里的女主人，她皱眉，血液就换流向。\n\n' +
        '他见过没被刀碰的地方疼得打滚的病人——药没变，变的是「相信什么」。这不是唯心，是古人对安慰剂效应、心身疾病的朴素观察。\n\n' +
        '实用版的用法：当你身体不舒服又查不出原因时，除了查身体，也问问「我最近在相信什么」。恐惧本身就会制造症状。',
      lit: ['montaigne', 'unconditional'],
      act: '落到今天：写下最近一个身体小毛病（失眠、胃紧、头疼）——它出现前，你正在「相信」什么？',
    };
  }

  if (/我知道什么|问号/.test(q)) {
    return {
      text:
        '「我知道什么？」（Que sais-je?）——蒙田刻在书房里的话，也是他全部学问的总纲。\n\n' +
        '注意这不是自卑式的「我啥都不懂」，而是一种方法论：把确定的东西先放一放，让经验和对话自己浮上来。随笔这种文体就是他这个态度的产物——不写定论，写探索。\n\n' +
        '跟苏格拉底遥遥相对：一个用追问，一个用书写，做的都是同一件事——在确定性的海洋里，给人一间「承认无知」的安全屋。',
      lit: ['montaigne', 'socrates', 'midwife'],
      act: '落到今天：挑一个你「很确定」的观点，用蒙田的方式写三句：我凭什么确定？反对者会说什么？',
    };
  }

  if (/泰山|鸿毛|用之所趋/.test(q)) {
    return {
      text:
        '司马迁这一句，给「人怎么活」装上了秤：死有轻重，差别不在死法，在「用之所趋」——你把命用在什么上面。\n\n' +
        '写这句话的时候，他刚受了宫刑，忍的不是命，是未完成的《史记》。同一段话里藏着等式：书 > 命。这不是轻生，是他找到了比个体存活更重的东西。\n\n' +
        '别急着宏大叙事——「用之所趋」问的是日常：你的时间和力气，正在为什么东西充值？那个东西，值得吗？',
      lit: ['taishan', 'zhangfa'],
      act: '落到今天：算一笔账——过去一周，你的时间充值最多的一件事是什么？它「重」吗？',
    };
  }

  if (/究天人之际|藏之名山|发愤|一百三十篇|极刑/.test(q)) {
    return {
      text:
        '「就极刑而无愠色」——不是不痛，是痛的时候手还在写。蒙田后来造了个词叫「相熟」，司马迁演示的是升级版：把苦难转写成作品。\n\n' +
        '注意他的方法不是「想开点」，是「转写」：把个人的屈辱，转成究天人之际、通古今之变的格局工程。格局一大，伤口就有了位置——它不再是全部，只是燃料。\n\n' +
        '这就是「发愤著书」四个字：不感谢苦难，但不让苦难白白发生。后来韩愈、欧阳修都把这条线接了下去。',
      lit: ['zhangfa', 'taishan', 'simaqian'],
      act: '落到今天：选一次你受过委屈的经历，写三百字——不是诉苦，是写出「它教会你什么别人学不到的」。',
    };
  }

  if (/天地有正气|杂然赋流形|河岳|日星/.test(q)) {
    return {
      text:
        '文天祥把「正气」讲成了宇宙事实：下是山河，上是日月——你每天看见的天地运行，就是正气的显形。\n\n' +
        '这个讲法很硬核：道德不是社会约定的软规则，是跟物理世界一样硬的实在。于人身上的那一份，叫「浩然」——充盈于天地之间的那个东西。\n\n' +
        '跟孟子的「吾善养吾浩然之气」接上：气可养。养的方式不在深山，在日常的取舍里。',
      lit: ['zhengqi', 'wenrtxiang'],
      act: '落到今天：回想今天一次「硬气」或「泄气」的瞬间——当时你感到的那口气，是从哪来的？',
    };
  }

  if (/时穷节乃见|丹青|太史简|董狐笔|苏武节/.test(q)) {
    return {
      text:
        '「时穷节乃见」——太平年月，人人含和明庭；路走到尽头，才见谁把气节真的穿在了身上。\n\n' +
        '文天祥不空谈，他报人名：太史的简、董狐的笔、张良的椎、苏武的节……气节被写成了一条可以追认的谱系，每个人都是它的一个坐标。\n\n' +
        '积极读法：这些名字说明「节」不是天生的，是在一个个「时穷」的关口选出来的——平时养的气，就是为那一刻准备的。你也在养你的气。',
      lit: ['zhengqi', 'dignity', 'taishan'],
      act: '落到今天：写下你的「丹青名单」里想加上的第一个名字——可以是你认识的普通人。',
    };
  }

  /* ---------- 3.9.0 完整公版书覆盖：《庄子》内篇全 / 《道德经》全文 / 皮科编译本 ---------- */

  if (/天籁|地籁|人籁|吾丧我|成心/.test(q)) {
    return {
      text:
        '《齐物论》是庄子对「争论为什么永远吵不完」的回答：人籁是笛子，地籁是风吹万窍，天籁是让万窍自鸣的那个「自己响」。\n\n' +
        '「吾丧我」三个字是钥匙：先去掉那个端着立场、急着赢的「我」，才听得见别的声音。\n\n' +
        '所谓「成心」就是已经成形的偏见——人人拿着自己的尺子量世界，量出来的当然全是「你对的我错的」。庄子的方案不是换一把更准的尺子，是先把尺子本身放一放。',
      lit: ['zhuangzi', 'xiaoyao'],
      act: '落到今天：找一次你最近跟人争的事，用「吾丧我」重写三行：去掉「我要赢」之后，对方在说什么？',
    };
  }

  if (/相濡以沫|相忘于江湖|泉涸|鱼相与处于陆/.test(q)) {
    return {
      text:
        '这是《大宗师》里最狠的一段：泉水干了，两条鱼互相吐沫湿润——很感人，但庄子说，不如相忘于江湖。\n\n' +
        '他不是否定相濡以沫，是否定把「困境」当成关系的常态。真正的深情不是一起熬干，是各自回到水里，再也想不起对方。\n\n' +
        '对照着看：患难之交可贵，但别把「只能患难」当成感情深的证明。能让彼此自由的，才是江湖。',
      lit: ['zhuangzi', 'xiaoyao'],
      act: '落到今天：想一段你现在的关系——它是「泉涸」还是「江湖」？如果需要吐沫，是什么把水弄干的？',
    };
  }

  if (/井蛙|夏虫|曲士不可以语/.test(q)) {
    return {
      text:
        '北海若教训河伯：井蛙不可以语海，因为它的世界只有井口大；夏虫不可以语冰，因为它活不到冬天。\n\n' +
        '庄子不是在骂人见识短，是在划一条边界：有些道理超出对方的生存处境，讲不通不是对方笨，是处境没到。\n\n' +
        '「今尔出于崖涘，观于大海，乃知尔丑」——河伯原来以为自己很大，见了海才知道自己小。人变得谦逊，往往不是因为被说服，而是因为终于见到了更大的东西。',
      lit: ['zhuangzi', 'curiosity'],
      act: '落到今天：写下你身上那只「井蛙」——你曾在多小的世界里，以为自己看见的就是全部？',
    };
  }

  if (/安时而处顺|鼓盆|大块载之|哀乐不能入/.test(q)) {
    return {
      text:
        '庄子妻死，他鼓盆而歌。不是不爱，是他把生死看成了四季运行的一部分：这个大块（身体）来的时候不是我请的，走的时候也不是我留的。\n\n' +
        '「安时而处顺」——按时而来、顺势而去。哀乐不能入，不是说没有情绪，是不让情绪住进心里当常客。\n\n' +
        '注意这跟斯多葛的距离：斯多葛管的是「怎么对待不可控」，庄子连「可控不可控」这道线都化了——生死本来就不在账本上，何必记一笔？',
      lit: ['zhuangzi', 'dichotomy'],
      act: '落到今天：想一次你经历或旁观过的失去——当时卡住你的，是「失去」本身，还是「它不该发生」这个执念？',
    };
  }

  if (/心斋|无用之用|支离|乘物以游心/.test(q)) {
    return {
      text:
        '《人间世》教人在烂摊子里活命：颜回要去劝暴君，孔子教他的不是话术，是「心斋」——把心空出来听。\n\n' +
        '「无用之用」在这里长出来：支离疏那种残障人，征兵征不到、征粮征不着，反而在乱世里养大了天年。有用，是把自己送进别人的工序；无用，是把命留在自己手里。\n\n' +
        '当然别矫枉过正：庄子不是教人躺平，是教人在「不得不入世」的时候，留一块不交出去的地方。',
      lit: ['zhuangzi', 'xiaoyao'],
      act: '落到今天：你手里哪件事正在「被有用」绑架？给它划出一小块「无用」的保留地。',
    };
  }

  if (/大器晚成|大音希声|大成若缺|大方无隅|大象无形/.test(q)) {
    return {
      text:
        '第四十一章一整章都是「反命题」：最大的器物最后完成，最大的声音听不见，最大的方正没有棱角。\n\n' +
        '老子不是在玩文字游戏，是在拆我们「越大越显眼」的直觉：真正大的东西不张扬——声音大到一定程度，耳朵就聋了（你听不见空气）；器物大到一定程度，反而看不出形状。\n\n' +
        '「明道若昧，进道若退」——求道的样子常常像在倒退。这给所有「看起来没进展」的深耕期正了名。',
      lit: ['laotzi', 'dichotomy'],
      act: '落到今天：你正在做哪件「大音希声」的事——没人看见、进度慢，但你确信它大？写下来，给自己作证。',
    };
  }

  if (/天网恢恢|疏而不失/.test(q)) {
    return {
      text:
        '天网恢恢，疏而不失——八个字把「因果」讲成了天象：网眼很稀，但不漏。\n\n' +
        '妙在「疏」：不是密不透风的监控，是看似什么都没管，其实一笔不少。老子对秩序的信心，跟「严刑峻法」是两条路——他不主张抓，主张让规律自己显形。\n\n' +
        '落回来：你每一次侥幸「没人看见」的小选择，都在往那张疏网里落一颗子。不是不报，是时候没到。',
      lit: ['laotzi', 'zhangfa'],
      act: '落到今天：回想一个你做过、觉得「没人知道」的小选择——如果它明天被公开，你怕不怕？怕，就是网眼。',
    };
  }

  if (/信言不美|美言不信|为而不争|圣人不积/.test(q)) {
    return {
      text:
        '全书最后四句，是老子留给读者的验收标准：真话不好听，好听的话不真；圣人不攒（给出去的越多，自己越有）；天之道，利而不害；圣人之道，为而不争。\n\n' +
        '「既以为人己愈有，既以与人己愈多」——这句和整本书的结构对称：开头讲道不可言，结尾讲话不可信；中间讲无为，这里讲不争。绕了一圈，回到一个「给」字。\n\n' +
        '五千言的终点不是智慧，是一个姿势：利而不害。',
      lit: ['laotzi', 'xiaoyao'],
      act: '落到今天：做一件「以为人」的小事——不求回报、不署名，试试「愈有」是什么感觉。',
    };
  }

  if (/联结者|中间者|九百论|卡巴拉|使节/.test(q)) {
    return {
      text:
        '编译本的收尾把人的位置抬到了整座世界的联结者上：因为感官的知觉，人是兽；因为理性的洞察，人是星；因为智，人是神；因为爱，人与神合一。\n\n' +
        '注意这不是说人「等于」神，而是说人横跨全部层级——人的特殊性恰恰在于他没有被固定在哪一层，他是层与层之间的通道。\n\n' +
        '皮科写这篇开幕词时才二十三岁，后来真的去罗马摆了九百论的擂台。人本主义从第一天起就不是书斋里的学问，是年轻人对全欧洲的公开宣战。',
      lit: ['humanism', 'dignity', 'freewill'],
      act: '落到今天：用一句话回答「人凭什么有尊严」——不许引用皮科，用你自己的话。',
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
  const s = core.settings.get();
  if (s.ttsEngine === 'edge') return 'Edge 音色';
  if (s.ttsEngine === 'custom') {
    const p = TTS_PROVIDERS[s.ttsProvider];
    return p ? `${p.name} TTS` : '自定义 TTS';
  }
  return '系统语音';
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
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('keydown', onKeydown);
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
  document.removeEventListener('selectionchange', onSelectionChange);
  window.removeEventListener('keydown', onKeydown);
  core.tts.stop();
});
</script>

<template>
  <div class="reader">
    <div class="hint">
      {{ narrow ? '长按选中一句 → 弹出三问' : '选中原文任何一句 → 弹出三问' }}
      · 回答里的概念可一键跳回星图 · 可存入我的哲学书 · 支持载入自己的 .txt / .md
      · {{ narrow ? '点段尾喇叭朗读' : '悬停段落可朗读' }}
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
          <div class="group pager">
            <button type="button" :disabled="currentPara <= 0" @click="prevPara">上一段</button>
            <span class="val">{{ currentPara + 1 }} / {{ paras.length }}</span>
            <button type="button" :disabled="currentPara >= paras.length - 1" @click="nextPara">下一段</button>
            <button type="button" @click="resumeRead">继续读</button>
          </div>
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

        <!-- 阅读进度：细条贴在正文顶端，兼作「读到哪了」的坐标 -->
        <div class="doc-progress" :title="`已读 ${readPct}%`">
          <i :style="{ width: `${progressPct}%` }" />
        </div>

        <div
          ref="docMain"
          class="doc"
          :style="{ '--reading-size': `${fontSize}px` }"
          @mouseup="onMouseUp"
          @scroll="onDocScroll"
        >
          <template v-if="doc">
            <h2 class="serif">{{ doc.title }}</h2>
            <div class="meta">{{ doc.meta }}</div>

            <div class="doc-chips">
              <template v-if="doc.custom">
                <Icon name="i-file" :size="13" /> 我的书库 · 点段落标记已读 · {{ narrow ? '点喇叭朗读' : '悬停段落可朗读' }}
              </template>
              <template v-else>
                点段落标记已读 · {{ narrow ? '长按选一句' : '选中一句话' }}问 AI · {{ narrow ? '点喇叭' : '悬停右侧喇叭' }}可单段朗读
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

        <!-- 手机端常驻翻页条：手指在屏幕上时，翻页比滚动更好使 -->
        <div class="m-pager">
          <button type="button" :disabled="currentPara <= 0" @click="prevPara">上一段</button>
          <span class="mp-val">
            <b>{{ currentPara + 1 }}</b> / {{ paras.length }}
            <em>已读 {{ readPct }}%</em>
          </span>
          <button type="button" :disabled="currentPara >= paras.length - 1" @click="nextPara">
            下一段
          </button>
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
            致知 AI · {{ panel.asked === 'explain' ? '讲解' : panel.asked === 'connect' ? '格义' : '追问' }}
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

/*
 * 关键修复（3.9.1）：grid 子项的自动最小尺寸是「内容高度」。
 * 不写 min-height: 0，三栏都会被正文撑开——.doc 的 overflow-y: auto
 * 永远不触发，整本书撑到 25365px，外层 .stage 是 overflow: hidden，
 * 于是第 4 段之后全部被裁掉且滚不到（老 bug：只能读前几段）。
 */
.wrap > * {
  min-height: 0;
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
  /* 工具条塞了四组控件，正文栏一窄就挤成竖排——允许换行，别让字断行 */
  flex-wrap: wrap;
  row-gap: 8px;
  padding: 10px 22px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  color: var(--ink2);
}

.toolbar .lab,
.toolbar .val,
.toolbar button,
.toolbar .engine {
  white-space: nowrap;
}

/* 引擎名推到最右，右边留白归它 */
.toolbar .engine {
  margin-left: auto;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 翻页组：夹在工具条最左边，是这一栏最常用的动作 */
.group.pager {
  gap: 4px;
  padding-right: 10px;
  border-right: 1px solid var(--line);
}

.group.pager .val {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink2);
  min-width: 58px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* 阅读进度条：贴在正文顶端，像书页上的一道书签 */
.doc-progress {
  flex: none;
  height: 2px;
  background: var(--line);
  overflow: hidden;
}

.doc-progress i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.2s var(--ease);
}

/* 手机端常驻翻页条 */
.m-pager {
  display: none;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px calc(env(safe-area-inset-bottom, 0px) + 8px);
  border-top: 1px solid var(--line);
  background: var(--bg2);
  font-size: 12px;
}

.m-pager button {
  flex: none;
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-hi);
  background: var(--card);
  color: var(--ink2);
  font-size: 13px;
}

.m-pager button:disabled {
  opacity: 0.4;
}

.m-pager .mp-val {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.35;
  color: var(--ink3);
  font-family: var(--mono);
  font-size: 11.5px;
}

.m-pager .mp-val b {
  font-size: 14px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.m-pager .mp-val em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--ink3);
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
    /* 右侧留出 46px：单段朗读按钮在手机上常显（触摸屏没有 hover），
       得给它腾个位置，否则会顶出屏幕 */
    padding: 18px 46px 64px 16px;
    max-width: none;
  }

  /* 手机上没有悬停：原来 hover 才出现的朗读按钮改为常显，轻点即可朗读本段 */
  .para-tts {
    opacity: 1;
    /* 24px 太小，手指头点不准 → 34px 的正方形可点区 */
    width: 34px;
    height: 34px;
    right: -8px;
    top: 0.2em;
  }

  .toolbar {
    flex-wrap: wrap;
    gap: 10px;
    padding: 8px 12px;
  }

  /* 手机上把翻页条亮出来，工具条里的翻页组让位（重复了） */
  .group.pager {
    display: none;
  }

  .m-pager {
    display: flex;
  }
}
</style>
