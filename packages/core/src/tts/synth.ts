/**
 * 合成请求的构造 —— 纯函数，不碰网络。
 *
 * 为什么单独抽出来：请求体拼装是最容易出错也最难手测的地方
 * （字段名错一个，服务端 400，用户只看到「朗读失败」四个字）。
 * 抽成纯函数后，字段对不对可以写断言直接验。
 *
 * 两条链路：
 * - edge：本地/局域网的 edge-tts 桥，字段是它自己定的（model=edge-tts）
 * - cloud：OpenAI 兼容的云端 TTS，字段是业界事实标准
 *
 * 「OpenAI 兼容」是本模块的核心假设：POST {base}/audio/speech，
 * body { model, input, voice, speed, response_format }，返回二进制音频。
 * 不兼容的服务商靠 ttsApiPath / ttsApiHeaders / ttsApiBody 三件套自己接。
 */

import type { Settings } from '../types';
import { TTS_PROVIDERS, resolveVoiceId, type TtsProviderDef } from './providers';

export interface SynthRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 附加字段配错时的说明。空串表示一切正常。 */
  error: string;
}

export interface JsonParseResult {
  ok: boolean;
  value: Record<string, unknown>;
  error: string;
}

/** 解析用户填的 JSON 文本。失败时给一句人话，而不是抛 JSON.parse 的原始报错。 */
export function parseJsonObject(raw: string, label: string): JsonParseResult {
  const text = (raw || '').trim();
  if (!text) return { ok: true, value: {}, error: '' };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, value: {}, error: `${label}要写成 JSON 对象，比如 {"key": "value"}` };
    }
    return { ok: true, value: v as Record<string, unknown>, error: '' };
  } catch (e) {
    return { ok: false, value: {}, error: `${label}格式有误：${(e as Error).message}` };
  }
}

function joinUrl(base: string, path: string): string {
  const b = (base || '').replace(/\/+$/, '');
  const p = (path || '').replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

/** 拿到当前选中的服务商定义。未知 key 落到 custom（用户自己填）。 */
export function currentProvider(s: Settings): TtsProviderDef {
  return TTS_PROVIDERS[s.ttsProvider] ?? TTS_PROVIDERS.custom!;
}

/**
 * edge 桥的请求。
 *
 * 字段和云端不一样：model 固定 edge-tts，音色走 Edge 的神经网络 id。
 * 桥是自家脚本，字段可以写死 —— 但地址仍可改（本机 127.0.0.1 或手机填局域网 IP）。
 */
export function buildEdgeRequest(s: Settings, text: string): SynthRequest {
  const base = (s.ttsBaseURL || 'http://127.0.0.1:8787/v1').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.ttsKey) headers.Authorization = `Bearer ${s.ttsKey}`;

  return {
    url: `${base}/audio/speech`,
    headers,
    body: {
      model: 'edge-tts',
      voice: s.ttsEdgeVoice || 'zh-CN-XiaoxiaoNeural',
      input: text,
      speed: s.ttsRate || 1,
      response_format: 'mp3',
    },
    error: '',
  };
}

/**
 * 云端（自定义 / OpenAI 兼容）的请求。
 *
 * 三处可自定义：
 * - ttsApiPath：换端点（Azure 的 /cognitiveservices/v1、某家自研的 /v1/tts）
 * - ttsApiHeaders：加认证头（api-key、X-Access-Token 之类）
 * - ttsApiBody：加请求体字段（gain、sample_rate、references…）
 */
export function buildCloudRequest(s: Settings, text: string): SynthRequest {
  const p = currentProvider(s);

  const base = (s.ttsApiBase || p.base || '').trim();
  const path = (s.ttsApiPath || '/audio/speech').trim();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = (s.ttsApiKey || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  // 用户自己填的附加头（JSON）。填坏了不该让整次朗读失败，
  // 但也不能默默丢掉 —— 那会让用户以为是服务端的问题。
  const extra = parseJsonObject(s.ttsApiHeaders, '附加请求头');
  if (extra.ok) Object.assign(headers, extra.value);

  const effectiveModel = (s.ttsApiModel || p.model || '').trim();
  const voice = resolveVoiceId(p, s.ttsApiVoice, effectiveModel);
  const body: Record<string, unknown> = {
    model: effectiveModel,
    input: text,
    speed: s.ttsRate || 1,
    response_format: (s.ttsApiFormat || p.format || 'mp3').trim(),
  };
  if (voice) body.voice = voice;

  // 附加请求体。同上：坏了就在 error 里说明，不动 body。
  const extraBody = parseJsonObject(s.ttsApiBody, '附加请求参数');
  if (extraBody.ok) Object.assign(body, extraBody.value);

  const errors = [extra.error, extraBody.error].filter(Boolean).join('；');

  // 地址没配就早点说人话。
  // 不拦的话 URL 会变成裸路径 "/audio/speech"，
  // 真正发出去时 fetch 报的是英文的 "Failed to parse URL from /audio/speech" ——
  // 用户完全看不懂是自己没填地址。
  const fullUrl = /^https?:\/\//i.test(path) ? path : joinUrl(base, path);
  const addrMissing = !base && !/^https?:\/\//i.test(path);
  const allErrors = [errors, addrMissing ? '未配置接口地址' : ''].filter(Boolean).join('；');

  return {
    url: fullUrl,
    headers,
    body,
    error: allErrors,
  };
}

/** 按引擎选链路。browser 引擎没有远端请求，返回 null。 */
export function buildSynthRequest(s: Settings, text: string): SynthRequest | null {
  if (s.ttsEngine === 'edge') return buildEdgeRequest(s, text);
  if (s.ttsEngine === 'custom') return buildCloudRequest(s, text);
  return null;
}
