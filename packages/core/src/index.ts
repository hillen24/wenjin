/**
 * 致知核心库 · 统一出口
 *
 * 设计约定：这个包不认识 Vue、不认识 DOM（只有 theme 和 tts 的浏览器探测碰 window），
 * 也不认识 Electron 或 Capacitor。换 UI 框架、换运行壳，这一层不用改。
 *
 * 用法：
 *   const core = createCore();
 *   core.ai.status        // 现在到底走真模型还是走预置剧本
 *   core.settings.patch({ fontSize: 18 });
 *   core.theme.toggle();
 *   core.materials.add('cards', record);
 *   core.reader.shelf();
 */

import type { ThemeMode } from './types';
import { KeyValueStore, type StorageAdapter } from './storage';
import { SettingsStore } from './settings/store';
import { AiClient, type FetchLike } from './ai/client';
import { AiGate } from './ai/verify';
import { MaterialsStore } from './materials/store';
import { ReaderStore } from './reader';
import { ProgressStore } from './progress';
import { StarGraphStore } from './star/custom';
import { TtsController, type TtsEnv } from './tts';
import { DebateSession } from './debate';
import { GewuSession } from './gewu';
import { PHILOSOPHERS } from './data/philosophers';
import { MethodLibraryStore, GewuTopicStore, DebateTopicStore, IngestStageStore } from './ingest/stores';
import {
  applyTheme,
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  systemPrefersDark,
} from './theme';

/* --- 类型 --- */
export type * from './types';

/* --- 数据 --- */
export * from './data';

/* --- 提示词 --- */
export * from './prompts';

/* --- 星图引擎（纯函数，可单测） --- */
export * from './star/engine';
export {
  StarGraphStore,
  buildAiPrompt,
  nameToId,
  parseAiGraph,
  validateIncoming,
  CUSTOM_SCHOOL,
  EMPTY_GRAPH,
  MAX_CUSTOM_EDGES,
  MAX_CUSTOM_NODES,
  type CustomGraph,
  type GraphFragment,
  type ParseAiResult,
  type ValidateResult,
} from './star/custom';

/* --- 存储 --- */
export * from './storage';

/* --- 设置 --- */
export { DEFAULT_SETTINGS, normalizeSettings } from './settings/defaults';
export * from './settings/store';

/* --- AI --- */
export * from './ai/client';
export * from './ai/errors';
export * from './ai/verify';

/* --- 主题 --- */
export * from './theme';

/* --- 沉淀与成书 --- */
export * from './materials/store';
export * from './materials/book';

/* --- 阅读 --- */
export * from './reader';

/* --- 朗读 --- */
export * from './tts';

/* --- 格物与论道（会话对象） --- */
export * from './gewu';
export * from './debate';

/* --- 点亮进度 --- */
export * from './progress';

/* --- 文献 Agent（3.8.0）：分段提取 / 容灾运行 / 质检漏斗 / 四处入库 --- */
export * from './ingest/chunk';
export * from './ingest/prompt';
export * from './ingest/parse';
export * from './ingest/job';
export * from './ingest/stores';
export * from './ingest/commit';

/* --- 导出 --- */
export * from './io/download';

/* --- 局域网同步（整机快照） --- */
export * from './sync';

export interface CoreOptions {
  /** 注入存储实现。单测传 MemoryStorage，就不需要 jsdom。 */
  storage?: StorageAdapter;
  /** 注入 fetch。单测用它拦请求，断言请求体。 */
  fetchImpl?: FetchLike;
  /** 对话超时（毫秒） */
  timeoutMs?: number;
  /** 注入朗读环境。单测传假的 synth / audio。 */
  tts?: Partial<TtsEnv>;
}

export interface ThemeController {
  current: ThemeMode;
  /** 应用到 DOM 并持久化 */
  apply(theme?: ThemeMode): void;
  /** 明暗互换，返回切换后的主题 */
  toggle(): ThemeMode;
}

export interface WenjinCore {
  kv: KeyValueStore;
  settings: SettingsStore;
  client: AiClient;
  ai: AiGate;
  theme: ThemeController;
  materials: MaterialsStore;
  reader: ReaderStore;
  progress: ProgressStore;
  /** 星图共建：用户自定义节点/边的存取与合并 */
  star: StarGraphStore;
  /** 文献 Agent：方法论库自建条目（内置 11 条之外） */
  methods: MethodLibraryStore;
  /** 文献 Agent：文献格物题（GewuSession 的剧本解析器指向它） */
  gewuTopics: GewuTopicStore;
  /** 文献 Agent：文献论题 */
  debateTopics: DebateTopicStore;
  /** 文献 Agent：暂存区，提取完成、用户确认前的停机坪 */
  ingestStage: IngestStageStore;
  tts: TtsController;
  debate: DebateSession;
  gewu: GewuSession;
}

/**
 * 组装所有部件。
 *
 * theme 的取值优先级：wj_theme（旧版遗留键）> settings.theme > 系统偏好。
 * 写入时两处都写 —— 这样万一回退到 v2.x，用户看到还是同一个主题。
 */
function createThemeController(kv: KeyValueStore, settings: SettingsStore): ThemeController {
  const stored = readStoredTheme(kv);
  const initial = resolveInitialTheme(stored ?? settings.get().theme, systemPrefersDark());

  if (settings.get().theme !== initial) settings.patch({ theme: initial });
  applyTheme(initial);
  storeTheme(kv, initial);

  return {
    get current(): ThemeMode {
      return settings.get().theme;
    },
    apply(theme?: ThemeMode): void {
      const t = theme ?? settings.get().theme;
      settings.setTheme(t);
      applyTheme(t);
      storeTheme(kv, t);
    },
    toggle(): ThemeMode {
      const next: ThemeMode = settings.get().theme === 'dark' ? 'light' : 'dark';
      settings.setTheme(next);
      applyTheme(next);
      storeTheme(kv, next);
      return next;
    },
  };
}

/**
 * 浏览器环境的朗读适配。
 *
 * 抽成函数而不是内联在 createCore 里，是为了让 Node 单测传 tts 覆盖时
 * 完全绕开 window —— 否则 import 这个包就得有 jsdom。
 */
function browserTtsEnv(): Partial<TtsEnv> {
  if (typeof window === 'undefined') return {};
  const w = window as unknown as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
    Audio?: typeof Audio;
  };
  if (!w.speechSynthesis || !w.SpeechSynthesisUtterance) return {};

  const Utter = w.SpeechSynthesisUtterance;
  return {
    synth: {
      getVoices: () => w.speechSynthesis!.getVoices(),
      speak: (u) => w.speechSynthesis!.speak(u as SpeechSynthesisUtterance),
      cancel: () => w.speechSynthesis!.cancel(),
    },
    createUtterance: (text) =>
      new Utter(text) as unknown as ReturnType<NonNullable<TtsEnv['createUtterance']>>,
    ...(w.Audio
      ? { createAudio: (url: string) => new w.Audio!(url) as unknown as never }
      : {}),
    revokeUrl: (url: string) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* 已经回收了 */
      }
    },
  };
}

export function createCore(opts: CoreOptions = {}): WenjinCore {
  const kv = new KeyValueStore(opts.storage);
  const settings = new SettingsStore(kv);

  const client = new AiClient({
    getSettings: () => settings.get(),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const ai = new AiGate({ kv, settings, client });
  const theme = createThemeController(kv, settings);

  const tts = new TtsController({
    getSettings: () => settings.get(),
    ...browserTtsEnv(),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...opts.tts,
  });

  const methodLibrary = new MethodLibraryStore(kv);
  const gewuTopics = new GewuTopicStore(kv);
  const debateTopics = new DebateTopicStore(kv);
  const ingestStage = new IngestStageStore(kv);

  return {
    kv,
    settings,
    client,
    ai,
    theme,
    materials: new MaterialsStore(kv),
    reader: new ReaderStore(kv),
    progress: new ProgressStore(kv),
    star: new StarGraphStore(kv),
    methods: methodLibrary,
    gewuTopics,
    debateTopics,
    ingestStage,
    tts,
    debate: new DebateSession(PHILOSOPHERS),
    // 文献格物题走自己的剧本，文献方法用 SOP 现场兜底，内置条目不受影响
    gewu: new GewuSession((id) => gewuTopics.scriptFor(id) ?? methodLibrary.scriptFor(id)),
  };
}
