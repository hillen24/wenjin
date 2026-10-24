/**
 * 致知 · 领域模型
 *
 * 这里的类型是「应用的语言」：数据层、AI 层、UI 层都用同一套词说话。
 * 旧版单文件 HTML 里这些结构全是隐式的（靠对象字面量裸奔），
 * 一个字段名拼错只有运行时才炸。现在交给编译器。
 */

/* ============================================================
 * 一、主题
 * ============================================================ */

export type ThemeMode = 'dark' | 'light';

/* ============================================================
 * 二、哲人（AI 对话角色）
 * ============================================================ */

/**
 * 一条预置问答。k 是触发关键词（任一命中即匹配），a 是回答。
 * 属于离线降级路径：没有配置 AI 时才走这里。
 */
export interface PhilosopherAnswer {
  readonly k: readonly string[];
  readonly a: string;
}

/**
 * 一位哲人。persona 是核心资产——接真 LLM 时它被当作 system prompt。
 * 注意：persona 的质量直接决定角色扮演像不像，删改前先想清楚。
 */
export interface Philosopher {
  readonly id: string;
  readonly name: string;
  /** 生卒年，展示用，如「前 469–399」 */
  readonly era: string;
  /** 单字缩写，仅在 SVG 头像无法渲染时降级显示 */
  readonly av: string;
  /** 一句话人设标签，如「雅典牛虻 · 只问不答」 */
  readonly style: string;
  /** 开场白 */
  readonly greet: string;
  /** 推荐提问（首屏三个气泡） */
  readonly qs: readonly string[];
  /** 预置问答，离线时按 k 关键词匹配 */
  readonly qa: readonly PhilosopherAnswer[];
  /** 兜底回答：没有任何关键词命中时用 */
  readonly fb: string;
  /** 系统提示词 */
  readonly persona: string;
}

/* ============================================================
 * 三、星图
 * ============================================================ */

export type NodeKind = 'school' | 'figure' | 'method' | 'concept';

/** 指向阅读材料的引用：d 是文档 id，p 是段落序号 */
export interface DocRef {
  readonly d: string;
  readonly p: number;
}

export interface StarNode {
  readonly id: string;
  readonly name: string;
  readonly kind: NodeKind;
  /** 所属脉络，如「希腊化罗马」「先秦中国」 */
  readonly school: string;
  /** 一句话释义 */
  readonly brief: string;
  /** 出处 */
  readonly src: string;
  /** 可跳转的精读材料，null 表示无 */
  readonly doc: DocRef | null;
  /** 关联的方法论条目 id（A1 / B2…） */
  readonly entries?: readonly string[];
}

export type EdgeRelation = 'proposes' | 'refines' | 'inherits' | 'opposes';

/** [起点节点 id, 终点节点 id, 关系, 边上的说明] */
export type StarEdge = readonly [
  from: string,
  to: string,
  rel: EdgeRelation,
  label: string,
];

/* ============================================================
 * 四、方法论仓库（日常格物）
 * ============================================================ */

export type MethodCategory = '生活指导' | '思维工具' | '论辩表达';

export interface MethodEntry {
  readonly id: string;
  readonly name: string;
  readonly cat: MethodCategory;
  /** 一句话说明 */
  readonly one: string;
  /** 操作步骤 */
  readonly sop: readonly string[];
  /** 误用提醒——这条最容易被删掉，但它是这套方法论的安全带 */
  readonly misuse: string;
  readonly src: string;
  /** 关联的星图节点 id */
  readonly lit: readonly string[];
  readonly docs: readonly DocRef[];
}

/* ============================================================
 * 五、精读材料
 * ============================================================ */

export interface ReadingDoc {
  readonly short: string;
  readonly title: string;
  readonly meta: string;
  readonly paras: readonly string[];
}

/* ============================================================
 * 六、格物剧本（离线降级）
 * ============================================================ */

export interface GewuStep {
  readonly t: string;
  /** 选项。最后一步没有可选项（只有一个「生成格物卡」按钮），所以是可选的。 */
  readonly opts?: readonly string[];
  /** true 表示这是最后一步，选完即出卡 */
  readonly end?: boolean;
}

export type GewuScript = readonly GewuStep[];

/** 格物卡的预填文案 */
export interface CardText {
  readonly bother: string;
  readonly ctrl: readonly string[];
  readonly un: readonly string[];
  readonly practice: string;
  readonly next: string;
}

/* ============================================================
 * 七、论道（苏格拉底式追问）
 * ============================================================ */

export interface DebateStep {
  readonly q: string;
  readonly opts: readonly string[];
}

/* ============================================================
 * 八、AI 服务商
 * ============================================================ */

export interface ProviderDef {
  readonly name: string;
  readonly base: string;
  readonly model: string;
  /** 是否需要 API Key。本地 Ollama 为 false */
  readonly key: boolean;
  readonly note: string;
}

/* ============================================================
 * 九、设置
 * ============================================================ */

export type TtsEngine = 'browser' | 'edge' | 'custom';

/** Edge TTS 的一个音色选项 */
export interface VoiceOption {
  readonly id: string;
  readonly name: string;
}

export interface Settings {
  theme: ThemeMode;

  /* --- AI --- */
  /** 设置页当前选中的服务商 */
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * 实际调用时优先使用的服务商。
   * 旧版这里是最大的坑：设置页写 provider，调用链读 primary，两者从不联动。
   * 新版由 setProvider() 强制同步，primary 只作为内部真值。
   */
  primary: string;
  /** 主力失败时的兜底 */
  fallback: string;
  /** 全链路失败时是否降级到离线剧本 */
  offlineDegrade: boolean;

  /* --- 阅读 --- */
  fontSize: number;

  /* --- TTS --- */
  ttsEngine: TtsEngine;
  ttsVoice: string;
  ttsRate: number;
  ttsContinuous: boolean;
  ttsBaseURL: string;
  ttsKey: string;
  ttsEdgeVoice: string;
}

/** 设置里允许部分更新的形状 */
export type SettingsPatch = Partial<Settings>;

/* ============================================================
 * 十、AI 调用
 * ============================================================ */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AiCallOptions {
  messages: ChatMessage[];
  /** 覆盖默认模型 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiReply {
  text: string;
  /** 实际应答的服务商 key */
  provider: string;
  model: string;
}

/** 接入状态。UI 上那条状态带就是它渲染出来的。 */
export type AiStatus =
  | { state: 'unconfigured' }
  | { state: 'unverified' }
  | { state: 'verifying' }
  | { state: 'verified'; provider: string; model: string }
  | { state: 'failed'; reason: string };

/* ============================================================
 * 十一、沉淀（格物卡 / 论道 / 伴读问答）
 *
 * 这三类东西是「我的哲学书」的原料。旧版它们以裸对象的形式
 * 在 localStorage 里裸奔，字段靠 memory。这里固定形状，
 * 以后加字段（比如标签、心情）时至少有编译期提醒。
 * ============================================================ */

export interface GewuCardRecord {
  /** MM-DD */
  readonly date: string;
  /** 方法论条目 id，如 A1 */
  readonly entry: string;
  readonly title: string;
  readonly bother: string;
  readonly ctrl: readonly string[];
  readonly un: readonly string[];
  readonly practice: string;
  readonly next: string;
  /** 本次新点亮的概念 id */
  readonly lit: readonly string[];
}

export interface DebateLine {
  readonly who: 'me' | 'ai';
  readonly text: string;
}

export interface DebateRecord {
  readonly date: string;
  /** 哲学家名字，如「尼采」 */
  readonly phil: string;
  readonly title: string;
  readonly lines: readonly DebateLine[];
}

export interface ReadingRecord {
  readonly date: string;
  /** 文档短名 */
  readonly doc: string;
  readonly quote: string;
  /** 讲解 / 追问 / 格义 */
  readonly skill: string;
  readonly reply: string;
}

export interface Materials {
  cards: GewuCardRecord[];
  debates: DebateRecord[];
  readings: ReadingRecord[];
}

export type MaterialType = keyof Materials;

/* ============================================================
 * 十二、我的哲学书
 * ============================================================ */

/** 成书进度档位 */
export type BookStage = '萌芽' | '小册' | '逼近成稿' | '成书';

export interface BookChapter {
  readonly title: string;
  /** 章节正文的条目 */
  readonly items: readonly BookItem[];
  /** 空章节时的提示语 */
  readonly hint: string;
}

export interface BookItem {
  /** 左侧的小标签：日期、次数 */
  readonly tag: string;
  /** 正文 */
  readonly text: string;
  /** 是否用衬线体（命题类条目用衬线，读起来像格言） */
  readonly serif?: boolean;
}

export interface BookDraft {
  readonly preface: string;
  readonly coda: string;
  readonly chapters: readonly BookChapter[];
  /** 0-100 */
  readonly pct: number;
  readonly stage: BookStage;
  readonly counts: { cards: number; debates: number; readings: number };
}

/** AI 润色过的序言/叮嘱。空对象表示还没润色过，用本地版。 */
export interface BookSynth {
  preface?: string;
  coda?: string;
}

/* ============================================================
 * 十三、我的书库
 * ============================================================ */

export interface UserBook {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  /** 恒为 true，用来和内置原著区分渲染 */
  readonly custom: true;
  readonly paras: readonly string[];
}
