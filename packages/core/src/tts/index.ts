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
import { buildSynthRequest, currentProvider } from './synth';
import type { VoiceOption } from '../types';

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

/** 「测试连接」的结果 */
export interface TtsProbeResult {
  ok: boolean;
  detail: string;
  ms: number;
}

/**
 * 从错误响应里挖出真正的原因。
 *
 * 服务端返回的多半是 JSON（`{"error":{"message":"..."}}`），
 * 但也有纯文本的，所以两种都试；挖不出来就返回空串，不硬编。
 */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const err = data.error as unknown;
      if (typeof err === 'string') return err;
      if (err && typeof err === 'object') {
        const m = (err as Record<string, unknown>).message;
        if (typeof m === 'string') return m;
      }
      const m2 = data.message ?? data.detail;
      if (typeof m2 === 'string') return m2;
    } catch {
      /* 不是 JSON，当纯文本 */
    }
    return text.slice(0, 160);
  } catch {
    return '';
  }
}

/**
 * 从各种形状的响应里挑出音色列表。
 *
 * 没见过的形状太多了（{voices:[…]} / [{id,name}] / {data:[…]} /
 * 硅基流动那种 [{uri, name}]…），所以这里宽松地捞：
 * 只要是「数组，且元素里能找出 id/uri/name 之类的东西」就认。
 */
function extractVoices(data: unknown): VoiceOption[] {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? ((data as Record<string, unknown>).voices as unknown[]) ??
        ((data as Record<string, unknown>).data as unknown[]) ??
        ((data as Record<string, unknown>).models as unknown[])
      : [];
  if (!Array.isArray(arr)) return [];

  const out: VoiceOption[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id =
      (typeof o.id === 'string' && o.id) ||
      (typeof o.uri === 'string' && o.uri) ||
      (typeof o.name === 'string' && o.name) ||
      (typeof o.model === 'string' && o.model) ||
      '';
    if (!id) continue;
    const name =
      (typeof o.name === 'string' && o.name) ||
      (typeof o.display_name === 'string' && (o.display_name as string)) ||
      id;
    out.push({ id, name });
    if (out.length >= 60) break; // 拉太多显示框塞不下
  }
  return out;
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
      const name =
        s.ttsEngine === 'edge'
          ? 'Edge-TTS'
          : `自定义 TTS（${currentProvider(s).name}）`;
      hooks.onNotice?.(`${name} 不可用（${msg}），已退回系统语音`);
      hooks.onEngineFallback?.('browser');
      // 降级后从同一段重来，用户不会听到半句话
      this.playBrowser(text, paras, index, hooks, my);
    }
  }

  private async synthRemote(text: string, s: Settings, fetchImpl: FetchLike): Promise<string> {
    const req = buildSynthRequest(s, text);
    if (!req) throw new Error('当前引擎不需要远端合成');
    if (req.error) throw new Error(req.error);
    if (!req.url) throw new Error('未配置 TTS 地址');

    const res = await fetchImpl(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      wjBinary: true,
    });
    if (!res.ok) {
      // 服务端往往在 body 里给出真原因（模型名错、音色不存在…），
      // 只报 HTTP 400 等于让用户瞎猜。
      const detail = await readErrorDetail(res);
      throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ''}`);
    }

    const blob = await res.blob();
    if (!blob.size) throw new Error('服务返回了空音频');
    return URL.createObjectURL(blob);
  }

  /* ---------- 自检：设置页的「测试连接」用 ---------- */

  /**
   * 发一句最短的文本试合成。
   *
   * 返回结构化结果而不是抛异常 —— 设置页要把它显示给用户看，
   * 抛异常的话错误信息得自己从 message 里抠。
   */
  async probe(): Promise<TtsProbeResult> {
    const s = this.env.getSettings();
    if (s.ttsEngine === 'browser') {
      return { ok: true, detail: '系统语音引擎无需测试', ms: 0 };
    }

    const req = buildSynthRequest(s, '测试');
    if (!req) return { ok: false, detail: '当前引擎不支持测试', ms: 0 };
    if (req.error) return { ok: false, detail: req.error, ms: 0 };
    if (!req.url) return { ok: false, detail: '未配置 TTS 地址', ms: 0 };

    const fetchImpl = this.env.fetchImpl ?? ((input, init) => fetch(input, init));
    const t0 = Date.now();
    try {
      const res = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        wjBinary: true,
      });
      const ms = Date.now() - t0;
      if (!res.ok) {
        const detail = await readErrorDetail(res);
        return { ok: false, detail: `HTTP ${res.status}${detail ? ` · ${detail}` : ''}`, ms };
      }
      const blob = await res.blob();
      if (!blob.size) return { ok: false, detail: '服务返回了空音频', ms };
      return { ok: true, detail: `合成成功 · ${(blob.size / 1024).toFixed(0)} KB · ${ms}ms`, ms };
    } catch (e) {
      const ms = Date.now() - t0;
      return { ok: false, detail: (e as Error).message || '连不上', ms };
    }
  }

  /**
   * 拉取服务端的音色列表。
   *
   * OpenAI 兼容规范里**没有**标准的音色列表接口，各家自说自话：
   * 硅基流动是 GET /audio/voice/list，OpenAI 官方压根没有。
   * 所以这里按顺序试几个已知路径，都不通就返回空数组让用户手填。
   */
  async listRemoteVoices(): Promise<{ ok: boolean; voices: VoiceOption[]; detail: string }> {
    const s = this.env.getSettings();
    if (s.ttsEngine !== 'custom') {
      return { ok: false, voices: [], detail: '只有自定义引擎支持拉取音色' };
    }
    const p = currentProvider(s);
    const base = (s.ttsApiBase || p.base || '').replace(/\/+$/, '');
    if (!base) return { ok: false, voices: [], detail: '未配置接口地址' };

    const fetchImpl = this.env.fetchImpl ?? ((input, init) => fetch(input, init));
    const headers: Record<string, string> = { Accept: 'application/json' };
    const key = (s.ttsApiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const paths = ['/audio/voice/list', '/voices', '/audio/voices', '/models'];
    for (const path of paths) {
      try {
        const res = await fetchImpl(`${base}${path}`, { method: 'GET', headers });
        if (!res.ok) continue;
        const data = (await res.json()) as unknown;
        const voices = extractVoices(data);
        if (voices.length) {
          return { ok: true, voices, detail: `从 ${path} 拉到 ${voices.length} 个音色` };
        }
      } catch {
        /* 这条路不通，试下一条 */
      }
    }
    return { ok: false, voices: [], detail: '该服务没有可发现的音色接口，请手动填写音色名' };
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
