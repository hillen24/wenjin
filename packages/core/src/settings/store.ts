/**
 * 设置仓库
 *
 * ===== 这个类存在的唯一理由 =====
 * 旧版所有改动都走同一个 saveSettings()，它分不清「改了字号」和「换了服务商」，
 * 于是只能一刀切：任何设置变动都把 aiVerified 清零 —— 改个字号，AI 接入状态就没了，
 * 下次调用静默退回预置剧本。这就是「配了 API 还在跑简单反射」的根因之一。
 *
 * 新版把「改了哪些字段」作为一等公民传出去：
 * 只有 AI 相关字段变了，AI 层才需要重新验证；字号、TTS 音色变了不动接入状态。
 */

import type { Settings, SettingsPatch, ThemeMode } from '../types';
import { KeyValueStore, STORAGE_KEYS } from '../storage';
import { PROVIDERS } from '../data/providers';
import { normalizeSettings } from './defaults';

/** 哪部分设置变了。AI 层靠它决定要不要重新验证。 */
export type SettingsChangeSource = 'patch' | 'provider' | 'theme' | 'reset';

export interface SettingsChange {
  source: SettingsChangeSource;
  changed: readonly (keyof Settings)[];
}

export type SettingsListener = (next: Settings, change: SettingsChange) => void;

/** 影响 AI 接入状态的字段。只有这些变了才需要重新探测。 */
export const AI_RELEVANT_KEYS: readonly (keyof Settings)[] = [
  'primary',
  'baseURL',
  'apiKey',
  'model',
];

export function isAiRelevant(change: SettingsChange): boolean {
  return change.source === 'reset' || change.changed.some((k) => AI_RELEVANT_KEYS.includes(k));
}

export class SettingsStore {
  private readonly kv: KeyValueStore;
  private readonly listeners = new Set<SettingsListener>();
  private state: Settings;

  constructor(kv: KeyValueStore) {
    this.kv = kv;
    const saved = kv.readJSON<unknown>(STORAGE_KEYS.settings, {});
    this.state = normalizeSettings(saved);
  }

  /** 当前设置快照。不可直接改 —— 走 patch()。 */
  get(): Settings {
    return this.state;
  }

  read<K extends keyof Settings>(key: K): Settings[K] {
    return this.state[key];
  }

  /** 上次落盘是否失败。UI 可据此提示「设置没存住」。 */
  get persistError(): string {
    return this.kv.lastError;
  }

  patch(partial: SettingsPatch): Settings {
    const changed: (keyof Settings)[] = [];
    for (const k of Object.keys(partial) as (keyof Settings)[]) {
      const v = partial[k];
      if (v === undefined) continue;
      if (this.state[k] !== v) changed.push(k);
    }
    if (changed.length === 0) return this.state;

    this.state = normalizeSettings({ ...this.state, ...partial });
    this.persist();
    this.emit({ source: 'patch', changed });
    return this.state;
  }

  /**
   * 切换服务商。
   *
   * v2.1 的血泪修复，现在固化在这里：
   * 设置页上半部改的是 provider，而 aiCall() 读的是 primary。两处不联动时，
   * 用户把服务商调成 DeepSeek 并填好 Key、测试也通过，主力却还是没启动的 Ollama，
   * 每次调用都失败、静默退回预置脚本 —— 用户看到的就是「配了 API 还是在跑简单反射」。
   *
   * 所以这里 provider 与 primary 永远同步设置，不给它们分家的机会。
   */
  setProvider(key: string): Settings {
    const p = PROVIDERS[key];
    if (!p) return this.state;

    const next: Settings = {
      ...this.state,
      provider: key,
      primary: key,
    };

    // 预设服务商直接用它的 base/model；custom 保留用户手填的值
    if (key !== 'custom') {
      next.baseURL = p.base;
      next.model = p.model;
      // 本地服务不需要 Key，切换过去时清掉，免得把云端 Key 发给本机端口
      if (!p.key) next.apiKey = '';
    }

    const changed = (['provider', 'primary', 'baseURL', 'model', 'apiKey'] as const).filter(
      (k) => this.state[k] !== next[k],
    );

    this.state = normalizeSettings(next);
    this.persist();
    if (changed.length > 0) this.emit({ source: 'provider', changed });
    return this.state;
  }

  setTheme(theme: ThemeMode): Settings {
    return this.patchWithSource({ theme }, 'theme');
  }

  reset(): Settings {
    this.state = normalizeSettings({});
    this.persist();
    this.emit({ source: 'reset', changed: Object.keys(this.state) as (keyof Settings)[] });
    return this.state;
  }

  /** 订阅变更，返回退订函数 */
  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private patchWithSource(partial: SettingsPatch, source: SettingsChangeSource): Settings {
    const changed: (keyof Settings)[] = [];
    for (const k of Object.keys(partial) as (keyof Settings)[]) {
      const v = partial[k];
      if (v !== undefined && this.state[k] !== v) changed.push(k);
    }
    if (changed.length === 0) return this.state;
    this.state = normalizeSettings({ ...this.state, ...partial });
    this.persist();
    this.emit({ source, changed });
    return this.state;
  }

  private persist(): void {
    // 写盘失败不打断用户操作，但失败原因会挂在 kv.lastError 上
    this.kv.writeJSON(STORAGE_KEYS.settings, this.state);
  }

  private emit(change: SettingsChange): void {
    for (const fn of this.listeners) {
      try {
        fn(this.state, change);
      } catch (e) {
        // 一个监听器炸了不该连累其它监听器，更不该把设置写入搞失败
        console.error('[settings] 监听器异常', e);
      }
    }
  }
}
