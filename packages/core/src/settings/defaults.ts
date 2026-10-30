/**
 * 默认设置与脏数据归一化
 */

import type { Settings, ThemeMode, TtsEngine } from '../types';
import { PROVIDERS } from '../data/providers';
import { TTS_FORMATS, TTS_PROVIDERS } from '../tts/providers';

/** 首次启动用的服务商 */
const BOOT_PROVIDER = 'ollama';
const BOOT = PROVIDERS[BOOT_PROVIDER];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',

  provider: BOOT_PROVIDER,
  baseURL: BOOT ? BOOT.base : '',
  apiKey: '',
  model: BOOT ? BOOT.model : '',
  primary: BOOT_PROVIDER,
  fallback: 'deepseek',
  offlineDegrade: true,

  fontSize: 16,

  ttsEngine: 'browser',
  ttsVoice: '',
  ttsRate: 1,
  ttsContinuous: true,
  ttsBaseURL: 'http://127.0.0.1:8787/v1',
  ttsKey: '',
  ttsEdgeVoice: 'zh-CN-XiaoxiaoNeural',

  ttsProvider: 'siliconflow',
  ttsApiBase: '',
  ttsApiKey: '',
  ttsApiModel: '',
  ttsApiVoice: '',
  ttsApiFormat: 'mp3',
  ttsApiPath: '/audio/speech',
  ttsApiHeaders: '',
  ttsApiBody: '',
};

const THEMES: readonly ThemeMode[] = ['dark', 'light'];
const ENGINES: readonly TtsEngine[] = ['browser', 'edge', 'custom'];

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * 把磁盘上读到的任意形状数据整理成合法 Settings。
 *
 * 旧版只做了「服务商 key 是否存在于 PROVIDERS」这一层校验，
 * 其余字段（fontSize / ttsRate / theme）拿到什么就用什么 ——
 * 一旦存进过 NaN 或 'dark ' 这种带空格的串，字体就不对劲且没人知道原因。
 * 这里逐字段收口。
 */
export function normalizeSettings(raw: unknown): Settings {
  const src: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const d = DEFAULT_SETTINGS;

  const theme = THEMES.includes(src.theme as ThemeMode) ? (src.theme as ThemeMode) : d.theme;
  const ttsEngine = ENGINES.includes(src.ttsEngine as TtsEngine)
    ? (src.ttsEngine as TtsEngine)
    : d.ttsEngine;

  const primary = str(src.primary, d.primary);
  const fallback = str(src.fallback, d.fallback);
  const provider = str(src.provider, d.provider);

  return {
    theme,
    provider: PROVIDERS[provider] ? provider : d.provider,
    baseURL: str(src.baseURL, d.baseURL),
    apiKey: str(src.apiKey, d.apiKey),
    model: str(src.model, d.model),
    // 非法服务商 key 一律回落，否则整条调用链会在 PROVIDERS[key] 上拿到 undefined
    primary: PROVIDERS[primary] ? primary : d.primary,
    fallback: PROVIDERS[fallback] ? fallback : d.fallback,
    offlineDegrade: typeof src.offlineDegrade === 'boolean' ? src.offlineDegrade : d.offlineDegrade,
    fontSize: clampNumber(src.fontSize, 12, 28, d.fontSize),
    ttsEngine,
    ttsVoice: str(src.ttsVoice, d.ttsVoice),
    ttsRate: clampNumber(src.ttsRate, 0.5, 2, d.ttsRate),
    ttsContinuous:
      typeof src.ttsContinuous === 'boolean' ? src.ttsContinuous : d.ttsContinuous,
    ttsBaseURL: str(src.ttsBaseURL, d.ttsBaseURL),
    ttsKey: str(src.ttsKey, d.ttsKey),
    ttsEdgeVoice: str(src.ttsEdgeVoice, d.ttsEdgeVoice),
    ttsProvider: TTS_PROVIDERS[str(src.ttsProvider, d.ttsProvider)]
      ? str(src.ttsProvider, d.ttsProvider)
      : d.ttsProvider,
    ttsApiBase: str(src.ttsApiBase, d.ttsApiBase),
    ttsApiKey: str(src.ttsApiKey, d.ttsApiKey),
    ttsApiModel: str(src.ttsApiModel, d.ttsApiModel),
    ttsApiVoice: str(src.ttsApiVoice, d.ttsApiVoice),
    ttsApiFormat: TTS_FORMATS.includes(String(src.ttsApiFormat))
      ? String(src.ttsApiFormat)
      : d.ttsApiFormat,
    ttsApiPath: str(src.ttsApiPath, d.ttsApiPath),
    ttsApiHeaders: str(src.ttsApiHeaders, d.ttsApiHeaders),
    ttsApiBody: str(src.ttsApiBody, d.ttsApiBody),
  };
}
