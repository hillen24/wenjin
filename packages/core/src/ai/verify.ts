/**
 * AI 接入门禁（AiGate）
 *
 * ===== 它解决什么 =====
 * 旧版用一个内存布尔 `aiVerified` 表示「能不能走真模型」，由此引出四个 bug：
 *   ① 纯内存，重启即丢；
 *   ② saveSettings() 里无条件清零，改字号、切主题都会把接入状态抹掉；
 *   ③ 只有手动点「测试连接」才置真，不点就永远是假的；
 *   ④ 设置页写 provider、调用链读 primary，两者从不联动。
 *
 * 现在的解法：
 *   · 用「配置指纹」代替布尔 —— 指纹 = 主力 + BaseURL + Key + 模型，
 *     这四项没变就等于配置没变，重启后从磁盘读回来仍然有效；
 *   · 指纹天然抗误伤：只有 AI 相关字段变了，指纹才会失配；
 *   · 启动补验 + 输入框失焦补验，不指望用户记得点按钮；
 *   · provider / primary 的同步由 SettingsStore.setProvider() 强制保证。
 *
 * 这一个类就是「现在到底走真模型还是走预置剧本」的唯一真值源，
 * 侧栏状态点、设置页状态带、输入框占位文案全部从这里读。
 */

import type { AiReply, AiStatus, ChatMessage, ProviderDef, Settings } from '../types';
import { PROVIDERS } from '../data/providers';
import { KeyValueStore, STORAGE_KEYS } from '../storage';
import { SettingsStore, isAiRelevant } from '../settings/store';
import { AiClient, type CallOverrides } from './client';
import { describeAiFailure, toAiError } from './errors';

export type AiStatusListener = (status: AiStatus) => void;

export interface AiGateDeps {
  kv: KeyValueStore;
  settings: SettingsStore;
  client: AiClient;
}

function providerOf(key: string): ProviderDef | undefined {
  return PROVIDERS[key];
}

export class AiGate {
  private readonly kv: KeyValueStore;
  private readonly settings: SettingsStore;
  private readonly client: AiClient;
  private readonly listeners = new Set<AiStatusListener>();

  /** 已通过的配置指纹。空串表示没验证过。 */
  private verifiedSignature: string;
  /** 上次失败原因，用于状态条展示 */
  private lastError = '';
  /** 正在探测中 */
  private probing = false;

  constructor(deps: AiGateDeps) {
    this.kv = deps.kv;
    this.settings = deps.settings;
    this.client = deps.client;

    // 与 v2.x 一致：存的是裸字符串，不是 JSON
    this.verifiedSignature = this.kv.readRaw(STORAGE_KEYS.aiSignature, '');

    // 设置一变，指纹可能失配 —— 让 UI 立刻重算状态，不用等下次调用
    this.settings.subscribe((_next: Settings, change) => {
      if (isAiRelevant(change)) this.emit();
    });
  }

  /* ============================================================
   * 指纹
   * ============================================================ */

  /** 当前配置的指纹。分隔符用 \u0001，避免和用户输入的内容撞车。 */
  signature(): string {
    const s = this.settings.get();
    return [s.primary, s.baseURL || '', s.apiKey || '', s.model || ''].join('\u0001');
  }

  /** 配置项本身没变，且这个配置曾经验证通过 */
  isVerified(): boolean {
    return this.verifiedSignature !== '' && this.verifiedSignature === this.signature();
  }

  /**
   * 真正可以走真模型。
   * 指纹通过还不够 —— 本地 Ollama 不需要 Key，但 baseURL 是必需的；
   * 云端服务则必须配 Key。这里把「配置齐全」也一并算进去。
   */
  isLive(): boolean {
    if (!this.isVerified()) return false;
    const s = this.settings.get();
    const p = providerOf(s.primary);
    if (!p || !s.baseURL) return false;
    if (p.key && !s.apiKey) return false;
    return true;
  }

  /* ============================================================
   * 状态
   * ============================================================ */

  get status(): AiStatus {
    const s = this.settings.get();
    const p = providerOf(s.primary);

    if (this.isLive()) {
      return { state: 'verified', provider: p?.name ?? s.primary, model: s.model };
    }

    // 配置本身就不齐 —— 不是「连不上」，是「还没配」
    if (!s.baseURL || (p?.key && !s.apiKey)) {
      return { state: 'unconfigured' };
    }

    if (this.probing) return { state: 'verifying' };
    if (this.lastError) return { state: 'failed', reason: this.lastError };

    return { state: 'unverified' };
  }

  /** 最近的失败原因，空串表示没有 */
  get failureReason(): string {
    return this.lastError;
  }

  subscribe(fn: AiStatusListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /* ============================================================
   * 状态变更
   * ============================================================ */

  markVerified(): void {
    this.verifiedSignature = this.signature();
    this.lastError = '';
    this.kv.writeRaw(STORAGE_KEYS.aiSignature, this.verifiedSignature);
    this.emit();
  }

  /** 撤销接入状态。reason 会显示在状态条上。 */
  clear(reason = ''): void {
    this.verifiedSignature = '';
    this.lastError = reason;
    this.kv.remove(STORAGE_KEYS.aiSignature);
    this.emit();
  }

  /* ============================================================
   * 探测
   * ============================================================ */

  /**
   * 启动补验 / 失焦补验。
   * 对应旧版 aiAutoVerify()：配置看起来齐全但没验证过时，静默试一次。
   * 失败不弹窗——用户在打字，别打断。
   */
  async autoVerify(): Promise<AiStatus> {
    if (this.isLive() || this.probing) return this.status;

    const s = this.settings.get();
    const p = providerOf(s.primary);
    if (!p || !s.baseURL || !s.model) return this.status;
    if (p.key && !s.apiKey) return this.status;

    this.probing = true;
    this.emit();

    try {
      await this.client.call(
        s.primary,
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 8, temperature: 0 },
      );
      this.markVerified();
    } catch (e) {
      this.lastError = describeAiFailure(e);
    } finally {
      this.probing = false;
      this.emit();
    }

    return this.status;
  }

  /**
   * 用户主动点「测试连接」。
   *
   * 测的是 primary 而不是 provider：provider 只是设置页上半部的选择器，
   * 真正决定调用走哪家的是 primary。测别的东西会给出误导性的「成功」。
   *
   * 成功返回 { ok: true, brief }：brief 是模型的回声，让人确认对面真活着。
   */
  async testConnection(): Promise<{ status: AiStatus; brief: string }> {
    const s = this.settings.get();
    const p = providerOf(s.primary);

    if (!p) {
      this.clear('服务商配置丢失');
      return { status: this.status, brief: '' };
    }
    if (p.key && !s.apiKey) {
      this.lastError = '还没填 API Key';
      this.emit();
      return { status: this.status, brief: '' };
    }
    if (!s.baseURL) {
      this.lastError = '还没填 Base URL（如 https://api.deepseek.com/v1）';
      this.emit();
      return { status: this.status, brief: '' };
    }
    if (!s.model) {
      this.lastError = '还没选模型 —— 先点上面的「拉取」或手填';
      this.emit();
      return { status: this.status, brief: '' };
    }

    this.probing = true;
    this.emit();

    try {
      const text = await this.client.probe(s.primary);
      this.probing = false;
      this.markVerified();
      return {
        status: this.status,
        brief: text.replace(/\s+/g, ' ').slice(0, 30),
      };
    } catch (e) {
      this.probing = false;
      const err = toAiError(e);
      this.clear(describeAiFailure(err));
      return { status: this.status, brief: '' };
    }
  }

  /**
   * 拉模型列表（供设置页下拉使用）。
   * 这里只做网络与错误处理，渲染交给 UI。
   */
  async fetchModels(): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
    try {
      const list = await this.client.listModels();
      return { ok: true, ids: list.ids };
    } catch (e) {
      return { ok: false, reason: describeAiFailure(e) };
    }
  }

  /**
   * 业务层对话入口。
   *
   * 各视图（伴读 / 格物 / 论道 / 成书）都需要同一件事：
   * 「如果现在能走真模型就走，走不了就算了，我这边有预置剧本兜着」。
   * 旧版把这个判断（aiLive()）散在每个调用点，还在每处各自写一遍 catch → toast。
   * 收在这里之后，视图只需要看返回值：ok=false 就画剧本，reason 决定要不要提示用户。
   */
  async chat(
    messages: ChatMessage[],
    opts: CallOverrides = {},
  ): Promise<{ ok: true; reply: AiReply } | { ok: false; reason: string }> {
    if (!this.isLive()) return { ok: false, reason: 'not-live' };

    try {
      const reply = await this.client.callWithFallback(messages, {
        ...opts,
        onAuthFailure: (err) => this.clear(describeAiFailure(err)),
      });
      return { ok: true, reply };
    } catch (e) {
      const msg = describeAiFailure(e);
      this.lastError = msg;
      this.emit();
      return { ok: false, reason: msg };
    }
  }

  private emit(): void {
    const st = this.status;
    for (const fn of this.listeners) {
      try {
        fn(st);
      } catch (e) {
        console.error('[ai-gate] 状态监听器异常', e);
      }
    }
  }
}
