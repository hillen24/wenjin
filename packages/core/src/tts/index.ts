/**
 * TTS 朗读控制器
 *
 * 三个引擎：browser（系统语音合成）/ edge（本地 edge-tts 服务）/ custom（自定义 OpenAI 兼容 TTS）。
 *
 * ===== 旧版这里有两个真 bug，都是「看不见的并发」 =====
 * 1. `ttsReading` 是全局布尔。连点两次「朗读全文」，两段音频会同时播，
 *    点「停止」只停得掉最后起的那条。现在用「代际序号」：每次 start 递增，
 *    所有异步回调先比对代际，过期的一律丢弃。
 * 2. Edge 合成是异步的（要等网络），合成回来时用户可能已经切了书。
 *    旧版没检查当前文档，于是把上一本书的段落念出来。现在代际变了就丢弃。
 *
 * 依赖全部可注入（synth / utterance / audio / fetch），所以能在 Node 里单测 ——
 * 「停止后不再触发下一段」这种事，靠手点是测不出来的。
 */

import type { Settings } from '../types';
import type { FetchLike } from '../ai/client';

/* ---------- 最小接口，便于注入假实现 ---------- */

export interface VoiceLike {
  name: string;
  lang: string;
}

export interface UtteranceLike {
  text: string;
  voice?: VoiceLike | null;
  lang: string;
  rate: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SynthLike {
  getVoices(): VoiceLike[];
  speak(u: UtteranceLike): void;
  cancel(): void;
}

export interface AudioLike {
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface TtsEnv {
  getSettings: () => Settings;
  synth?: SynthLike | null;
  createUtterance?: (text: string) => UtteranceLike;
  createAudio?: (url: string) => AudioLike;
  fetchImpl?: FetchLike;
  revokeUrl?: (url: string) => void;
}

export interface TtsHooks {
  /** 开始念第 index 段 */
  onParagraph?(index: number): void;
  /** 整篇读完（或被停止后清理） */
  onFinish?(): void;
  /** 需要告诉用户的事：引擎不可达、自动播放被拦、浏览器不支持 */
  onNotice?(message: string): void;
  /** 引擎失败并已自动降级，视图可据此刷新设置页 */
  onEngineFallback?(engine: 'browser'): void;
}

export class TtsController {
  private readonly env: TtsEnv;
  /** 代际：每次 start/stop 递增，用来作废过期的异步回调 */
  private gen = 0;
  private active = false;
  private currentAudio: AudioLike | null = null;

  /** 正在念第几段，-1 表示没在念。视图用它做段落高亮。 */
  index = -1;

  constructor(env: TtsEnv) {
    this.env = env;
  }

  get supported(): boolean {
    return !!this.env.synth;
  }

  get speaking(): boolean {
    return this.active;
  }

  voices(): VoiceLike[] {
    try {
      return this.env.synth?.getVoices() ?? [];
    } catch {
      return [];
    }
  }

  /** 挑音色：用户指定的 > 第一个中文 > 第一个可用 */
  pickVoice(): VoiceLike | null {
    const want = this.env.getSettings().ttsVoice;
    const vs = this.voices();
    return (
      vs.find((v) => v.name === want) ??
      vs.find((v) => v.lang.indexOf('zh') === 0) ??
      vs[0] ??
      null
    );
  }

  /** 立刻停一切。代际递增，所有在途回调作废。 */
  stop(): void {
    this.gen++;
    this.active = false;
    this.index = -1;
    this.quiet();
  }

  private quiet(): void {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
      } catch {
        /* 已经没了，忽略 */
      }
      this.currentAudio = null;
    }
    try {
      this.env.synth?.cancel();
    } catch {
      /* 同上 */
    }
  }

  /**
   * 从第 from 段开始念。
   * 连续模式（settings.ttsContinuous）下会自动接下一段，两端引擎行为一致。
   */
  start(paras: readonly string[], from: number, hooks: TtsHooks = {}): void {
    const my = ++this.gen;
    this.active = true;
    this.quiet();
    void this.playFrom(paras, from, hooks, my);
  }

  private async playFrom(
    paras: readonly string[],
    index: number,
    hooks: TtsHooks,
    my: number,
  ): Promise<void> {
    if (my !== this.gen) return;
    if (index < 0 || index >= paras.length) {
      this.finish(hooks);
      return;
    }

    const text = paras[index];
    if (!text) {
      this.finish(hooks);
      return;
    }

    this.index = index;
    hooks.onParagraph?.(index);

    const s = this.env.getSettings();
    if (s.ttsEngine === 'edge' || s.ttsEngine === 'custom') {
      await this.playRemote(text, paras, index, hooks, my);
      return;
    }
    this.playBrowser(text, paras, index, hooks, my);
  }

  /* ---------- 远端引擎（edge / custom） ---------- */

  private async playRemote(
    text: string,
    paras: readonly string[],
    index: number,
    hooks: TtsHooks,
    my: number,
  ): Promise<void> {
    const s = this.env.getSettings();
    const fetchImpl = this.env.fetchImpl ?? ((input, init) => fetch(input, init));

    let url = '';
    try {
      url = await this.synthRemote(text, s, fetchImpl);

      // 合成期间用户点了停止 / 换了书 / 换了段 —— 丢弃，别念出上一本的内容
      if (my !== this.gen) {
        this.env.revokeUrl?.(url);
        return;
      }
      if (!this.env.createAudio) throw new Error('当前环境不支持音频播放');

      const audio = this.env.createAudio(url);
      this.currentAudio = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('播放失败'));
        audio.play().catch(reject);
      });

      if (my !== this.gen) return;
      this.env.revokeUrl?.(url);
      this.currentAudio = null;
      this.next(paras, index, hooks, my);
    } catch (e) {
      if (my !== this.gen) return;
      if (url) this.env.revokeUrl?.(url);
      const msg = (e as Error).message || '合成失败';
      const name = s.ttsEngine === 'edge' ? 'Edge-TTS' : '自定义 TTS';
      hooks.onNotice?.(`${name} 不可用（${msg}），已退回系统语音`);
      hooks.onEngineFallback?.('browser');
      // 降级后从同一段重来，用户不会听到半句话
      this.playBrowser(text, paras, index, hooks, my);
    }
  }

  private async synthRemote(text: string, s: Settings, fetchImpl: FetchLike): Promise<string> {
    const isCustom = s.ttsEngine === 'custom';
    const base = (s.ttsBaseURL || (isCustom ? '' : 'http://127.0.0.1:8787/v1')).replace(/\/+$/, '');
    if (!base) throw new Error('未配置 TTS 地址');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (s.ttsKey) headers.Authorization = `Bearer ${s.ttsKey}`;

    const res = await fetchImpl(`${base}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: isCustom ? 'tts-1' : 'edge-tts',
        voice: s.ttsEdgeVoice || (isCustom ? 'alloy' : 'zh-CN-XiaoxiaoNeural'),
        input: text,
        speed: s.ttsRate || 1,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  /* ---------- 系统语音 ---------- */

  private playBrowser(
    text: string,
    paras: readonly string[],
    index: number,
    hooks: TtsHooks,
    my: number,
  ): void {
    if (!this.env.synth || !this.env.createUtterance) {
      hooks.onNotice?.('当前环境不支持语音合成，换 Chrome / Edge 试试');
      this.finish(hooks);
      return;
    }

    try {
      this.env.synth.cancel();
    } catch {
      /* 忽略 */
    }

    const u = this.env.createUtterance(text);
    const v = this.pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else {
      u.lang = 'zh-CN';
    }
    u.rate = this.env.getSettings().ttsRate;

    u.onend = () => {
      if (my !== this.gen) return;
      this.next(paras, index, hooks, my);
    };
    u.onerror = () => {
      if (my !== this.gen) return;
      hooks.onNotice?.('朗读出错，已停止');
      this.finish(hooks);
    };

    this.env.synth.speak(u);
  }

  /* ---------- 推进 ---------- */

  /** 一段念完：连续模式且还有下一段就继续，否则收工 */
  private next(paras: readonly string[], index: number, hooks: TtsHooks, my: number): void {
    if (my !== this.gen) return;

    const continuous = this.env.getSettings().ttsContinuous;
    if (continuous && index + 1 < paras.length) {
      void this.playFrom(paras, index + 1, hooks, my);
      return;
    }
    this.finish(hooks);
  }

  private finish(hooks: TtsHooks): void {
    this.active = false;
    this.index = -1;
    hooks.onFinish?.();
  }
}
