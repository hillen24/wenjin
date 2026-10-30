/**
 * TTS 服务商定义表
 *
 * 和 AI 那边的 PROVIDERS 是同一个思路：把「某个服务商的默认地址 / 默认模型 /
 * 默认音色」固化成数据，UI 只需选一个预设再让用户微调，不用每次都手打一串 URL。
 *
 * 三条约束：
 * 1. 全部走 OpenAI 兼容的 `POST {base}/audio/speech`（业界事实标准）。
 *    不兼容的服务商（Azure 走 /cognitiveservices、讯飞走 WebSocket）不内置 ——
 *    它们要么改路径要么改认证，塞进「兼容」表只会给人假承诺。
 *    用户真要用，走「自定义」档填路径 + 附加请求头即可。
 * 2. 音色只列**公开且稳定**的那些。OpenAI 官方那六个（alloy/echo/…）多年未变；
 *    硅基流动的系统音色 id 形如 `模型名:anna`，跟着模型走，所以这里只写后缀，
 *    合成时再拼上模型前缀 —— 否则换模型就全失效。
 * 3. key: true 表示必须配 Key。本地 edge-tts 桥不需要 Key（它在 AI 那张表里）。
 */

import type { VoiceOption } from '../types';

export interface TtsProviderDef {
  readonly name: string;
  readonly base: string;
  readonly model: string;
  /** 默认音色 id。空串表示「用服务商的默认音色」，不显式传。 */
  readonly voice: string;
  readonly key: boolean;
  readonly note: string;
  /**
   * 音色后缀表。合成时拼成 `${model}:${suffix}`。
   * 直接给完整 id 的是 openai —— 它的音色 id 本来就是独立命名，不跟模型走。
   */
  readonly voices?: readonly VoiceOption[];
  /** 拼音色 id 的方式 */
  readonly voiceStyle?: 'plain' | 'model-prefixed';
  /** 该服务商推荐的音频格式 */
  readonly format: string;
}

export const TTS_PROVIDERS: Record<string, TtsProviderDef> = {
  openai: {
    name: 'OpenAI',
    base: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
    key: true,
    note: '官方 tts-1 / tts-1-hd，音质稳，按量计费',
    voices: [
      { id: 'alloy', name: 'Alloy · 中性平和' },
      { id: 'echo', name: 'Echo · 男声沉稳' },
      { id: 'fable', name: 'Fable · 讲story味' },
      { id: 'onyx', name: 'Onyx · 男声低沉' },
      { id: 'shimmer', name: 'Shimmer · 女声清亮' },
      { id: 'nova', name: 'Nova · 男声有力' },
    ],
    voiceStyle: 'plain',
    format: 'mp3',
  },
  siliconflow: {
    name: '硅基流动',
    base: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'anna',
    key: true,
    note: '国内聚合，CosyVoice2 支持方言与情感指令',
    voices: [
      { id: 'anna', name: 'Anna · 女声沉稳' },
      { id: 'alex', name: 'Alex · 男声低沉' },
      { id: 'benjamin', name: 'Benjamin · 男声浑厚' },
      { id: 'charles', name: 'Charles · 男声磁感' },
      { id: 'david', name: 'David · 男声欢快' },
      { id: 'bella', name: 'Bella · 女声热情' },
      { id: 'claire', name: 'Claire · 女声温柔' },
      { id: 'diana', name: 'Diana · 女声活泼' },
    ],
    voiceStyle: 'model-prefixed',
    format: 'mp3',
  },
  custom: {
    name: '自定义（OpenAI 兼容）',
    base: '',
    model: '',
    voice: '',
    key: true,
    note: '任何兼容 /audio/speech 的服务：本地部署、聚合站、ElevenLabs 兼容层…',
    voiceStyle: 'plain',
    format: 'mp3',
  },
};

/** 音频格式白名单。跟常见的 OpenAI 兼容实现对齐。 */
export const TTS_FORMATS: readonly string[] = ['mp3', 'wav', 'opus', 'pcm', 'aac'];

/**
 * 拼出这个服务商最终的音色 id。
 *
 * 硅基流动的音色 id 是「模型名:音色名」，模型一换前缀就得跟着换；
 * 所以那边存后缀、这里拼前缀。OpenAI 那边音色独立命名，原样用。
 *
 * effectiveModel 传的是**生效的**模型名（用户可能改过预设）。
 * 这里曾经错用了预设模型 —— 用户把模型换成别的，音色前缀还留在旧模型上，
 * 服务端直接报「音色不存在」，而用户完全看不出是哪错了。
 */
export function resolveVoiceId(
  p: TtsProviderDef,
  suffix: string,
  effectiveModel?: string,
): string {
  const v = (suffix || p.voice || '').trim();
  if (!v) return '';
  if (p.voiceStyle === 'model-prefixed') {
    if (v.includes(':')) return v; // 已经是完整 id
    const model = (effectiveModel ?? p.model ?? '').trim();
    return model ? `${model}:${v}` : v;
  }
  return v;
}
