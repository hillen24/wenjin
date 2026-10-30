/**
 * AI 客户端：真正发请求的地方
 *
 * 相对旧版的三个结构性改动：
 * 1. fetch 可注入 —— 于是「发出去的请求体对不对」能被单元测试断言，
 *    而不是只能靠人肉点一次「测试连接」看运气。
 * 2. 不再直接读写全局 settings，改为构造时传入 getSettings()，
 *    调用链上不出现隐式全局状态。
 * 3. 错误自带 code（见 errors.ts），不再靠正则猜。
 *
 * 行为严格对齐 v2.1，包括那几个踩过的坑，改动处都有注释。
 */

import type { AiReply, ChatMessage, Settings } from '../types';
import { PROVIDERS } from '../data/providers';
import { AiError, toAiError } from './errors';

/**
 * 请求初始化。
 *
 * 多出来的 `wjBinary` 是给原生层用的：手机端走 CapacitorHttp，
 * 那边的二进制响应会被 base64 化后再传回来（见 apps/mobile/src/capFetch.ts），
 * 标准 fetch 则是原生 ArrayBuffer。core 里只有 TTS 合成用得上。
 */
export interface FetchInit extends RequestInit {
  /** 期望二进制响应（TTS 音频）。标准 fetch 忽略这个字段。 */
  wjBinary?: boolean;
}

export type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

export interface AiClientOptions {
  /** 每次调用时读一次最新设置，避免持有陈旧副本 */
  getSettings: () => Settings;
  fetchImpl?: FetchLike;
  /** 对话超时，旧版 45 秒 */
  timeoutMs?: number;
  /** 拉模型列表超时，旧版 12 秒 */
  listTimeoutMs?: number;
}

export interface CallOverrides {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface FallbackOptions extends CallOverrides {
  /** 只试指定服务商，不走兜底链 */
  only?: string;
  /** 遇到 401/403 时回调 —— 上层据此撤销「已接入」状态 */
  onAuthFailure?: (err: AiError) => void;
}

export interface ModelList {
  ids: string[];
  endpoint: string;
  ollama: boolean;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  stream: boolean;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface ModelEntry {
  id?: string;
  name?: string;
  /** Ollama 的 /api/tags 用这个字段而不是 id */
  model?: string;
}

interface ModelListResponse {
  data?: ModelEntry[];
  models?: ModelEntry[];
}

/** 解析出这次调用该用哪套 base/model/key */
interface Resolved {
  base: string;
  model: string;
  needsKey: boolean;
  apiKey: string;
}

export class AiClient {
  private readonly getSettings: () => Settings;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly listTimeoutMs: number;

  /** 上次失败的原始信息。空串表示上次成功。 */
  lastError = '';

  constructor(opts: AiClientOptions) {
    this.getSettings = opts.getSettings;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.listTimeoutMs = opts.listTimeoutMs ?? 12_000;
  }

  /**
   * v2.1 修：原来只要不是当前服务商就用 PROVIDERS 里的预设模型，
   * 导致用户在设置里「拉取」并选中的模型对主力服务不生效（选了也白选）。
   * 现在当前服务商一律优先用用户配置的 base/model。
   */
  private resolve(key: string): Resolved {
    const p = PROVIDERS[key];
    if (!p) throw new AiError('unknown-provider', '未知服务商');

    const s = this.getSettings();
    const isCurrent = key === s.provider;

    const rawBase = isCurrent && s.baseURL ? s.baseURL : p.base;
    const base = (rawBase || '').replace(/\/+$/, '');
    const model = isCurrent && s.model ? s.model : p.model || s.model || '';

    return { base, model, needsKey: p.key, apiKey: s.apiKey };
  }

  /** 这个服务商此刻是否具备被调用的条件 */
  isUsable(key: string): boolean {
    const p = PROVIDERS[key];
    if (!p) return false;
    const s = this.getSettings();
    return !(p.key && !s.apiKey);
  }

  /**
   * 单家调用。失败一律抛 AiError。
   * 对应旧版 aiCallRaw()。
   */
  async call(key: string, messages: ChatMessage[], overrides: CallOverrides = {}): Promise<string> {
    const r = this.resolve(key);

    if (!r.base) throw new AiError('no-base-url', '未配置 Base URL');
    if (!r.model) throw new AiError('no-model', '未选择模型');
    if (r.needsKey && !r.apiKey) throw new AiError('no-api-key', '缺少 API Key');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: ChatRequestBody = {
      model: overrides.model ?? r.model,
      messages,
      temperature: overrides.temperature ?? 0.75,
      stream: false,
    };
    if (overrides.maxTokens) body.max_tokens = overrides.maxTokens;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (r.needsKey && r.apiKey) headers.Authorization = `Bearer ${r.apiKey}`;

    try {
      const res = await this.fetchImpl(`${r.base}/chat/completions`, {
        method: 'POST',
        signal: overrides.signal ?? controller.signal,
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new AiError('http', `HTTP ${res.status}`, res.status);

      const data = (await res.json()) as ChatCompletionResponse;
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new AiError('empty', '空响应');

      return text.trim();
    } catch (e) {
      throw toAiError(e);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 带兜底的调用：先主力，失败换备用。
   * 对应旧版 aiCall()。
   */
  async callWithFallback(
    messages: ChatMessage[],
    opts: FallbackOptions = {},
  ): Promise<AiReply> {
    const s = this.getSettings();

    /* v2.1 修：原来会把「需要 Key 却没配 Key」的兜底服务也塞进链路，
       主力一挂就报「缺少 API Key」，把真实原因盖掉。现在先过滤不可用的。 */
    const keys = (opts.only ? [opts.only] : [s.primary, s.fallback])
      .filter((v, i, a): v is string => !!v && a.indexOf(v) === i)
      .filter((k) => this.isUsable(k));

    if (keys.length === 0) {
      throw new AiError(
        s.apiKey ? 'unknown-provider' : 'no-api-key',
        s.apiKey ? '无可用服务商' : '缺少 API Key',
      );
    }

    let lastErr: AiError | undefined;

    for (const k of keys) {
      try {
        const text = await this.call(k, messages, opts);
        this.lastError = '';
        return { text, provider: k, model: this.resolve(k).model };
      } catch (e) {
        const err = toAiError(e);
        lastErr = err;
        // 认证类失败说明配置真有问题 —— 立刻上报，别让状态点继续骗人
        if (err.isAuthFailure) opts.onAuthFailure?.(err);
      }
    }

    this.lastError = lastErr?.message ?? '';
    throw lastErr ?? new AiError('unknown-provider', '无可用服务');
  }

  /**
   * 拉模型列表。
   * 对应旧版 fetchModels() 的网络部分（不含 DOM 渲染）。
   *
   * Ollama 走 /api/tags（且要把 /v1 去掉），OpenAI 兼容服务走 /models。
   */
  async listModels(): Promise<ModelList> {
    const s = this.getSettings();
    const p = PROVIDERS[s.provider];
    if (!p) throw new AiError('unknown-provider', '未知服务商');

    const base = ((s.baseURL || p.base) || '').replace(/\/+$/, '');
    if (!base) throw new AiError('no-base-url', '未配置 Base URL');

    const ollama = s.provider === 'ollama';
    const endpoint = ollama ? `${base.replace(/\/v1\/?$/, '')}/api/tags` : `${base}/models`;

    const headers: Record<string, string> = {};
    if (p.key && s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.listTimeoutMs);

    try {
      const res = await this.fetchImpl(endpoint, { headers, signal: controller.signal });
      if (!res.ok) throw new AiError('http', `HTTP ${res.status}`, res.status);

      const j = (await res.json()) as ModelListResponse;
      const raw = ollama ? (j.models ?? []) : (j.data ?? j.models ?? []);
      const ids = raw
        .map((m) => m.id ?? m.model ?? m.name ?? '')
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      const unique = Array.from(new Set(ids));
      if (unique.length === 0) throw new AiError('empty', '列表为空');

      return { ids: unique, endpoint, ollama };
    } catch (e) {
      throw toAiError(e);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 真实对话探测。
   * 旧版 testConnection() 只 GET /models —— 模型列表拉得到 ≠ 能对话，
   * 于是出现过「显示连接成功、实际调用全挂」。这里真发一次最短对话。
   */
  async probe(key: string): Promise<string> {
    return this.call(
      key,
      [{ role: 'user', content: '连接测试，请只回复两个字：可用' }],
      { maxTokens: 24, temperature: 0 },
    );
  }
}
