/**
 * 设置仓库与数据归一化
 */

import { describe, expect, it } from 'vitest';
import { KeyValueStore, MemoryStorage, STORAGE_KEYS } from '../storage';
import { SettingsStore, isAiRelevant, type SettingsChange } from './store';
import { DEFAULT_SETTINGS, normalizeSettings } from './defaults';

function newStore(storage = new MemoryStorage()): SettingsStore {
  return new SettingsStore(new KeyValueStore(storage));
}

/** 收集某次操作触发的通知 */
function capture(store: SettingsStore, act: () => void): SettingsChange[] {
  const got: SettingsChange[] = [];
  const off = store.subscribe((_s, change) => got.push(change));
  act();
  off();
  return got;
}

describe('变更通知：AI 层靠它决定要不要重新验证', () => {
  it('只报告真正变了的字段', () => {
    const store = newStore();

    const changes = capture(store, () => store.patch({ fontSize: 20 }));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.changed).toEqual(['fontSize']);
    expect(changes[0]?.source).toBe('patch');
  });

  it('值没变就不发通知', () => {
    const store = newStore();
    const before = store.get().fontSize;

    const changes = capture(store, () => store.patch({ fontSize: before }));

    expect(changes).toHaveLength(0);
  });

  it('改字号不属于 AI 相关变更', () => {
    const store = newStore();
    const changes = capture(store, () => store.patch({ fontSize: 24 }));
    expect(isAiRelevant(changes[0]!)).toBe(false);
  });

  it('改主题不属于 AI 相关变更', () => {
    const store = newStore();
    const changes = capture(store, () => store.setTheme('light'));
    expect(changes[0]?.source).toBe('theme');
    expect(isAiRelevant(changes[0]!)).toBe(false);
  });

  it('改模型属于 AI 相关变更', () => {
    const store = newStore();
    const changes = capture(store, () => store.patch({ model: 'qwen2.5:3b' }));
    expect(isAiRelevant(changes[0]!)).toBe(true);
  });

  it('改 Key / BaseURL / 主力 都属于 AI 相关变更', () => {
    for (const patch of [{ apiKey: 'k' }, { baseURL: 'http://x/v1' }, { primary: 'deepseek' }]) {
      const store = newStore();
      const changes = capture(store, () => store.patch(patch));
      expect(isAiRelevant(changes[0]!), JSON.stringify(patch)).toBe(true);
    }
  });
});

describe('setProvider：provider 与 primary 永不分家', () => {
  it('切换后两者同时更新，且 base/model 跟随预设', () => {
    const store = newStore();

    store.setProvider('deepseek');

    const s = store.get();
    expect(s.provider).toBe('deepseek');
    expect(s.primary).toBe('deepseek');
    expect(s.baseURL).toBe('https://api.deepseek.com/v1');
    expect(s.model).toBe('deepseek-chat');
  });

  it('未知服务商被忽略，状态不动', () => {
    const store = newStore();
    const before = store.get().provider;

    store.setProvider('not-a-provider');

    expect(store.get().provider).toBe(before);
  });

  it('切到 custom 时保留手填的 base/model', () => {
    const store = newStore();
    store.patch({ baseURL: 'http://my-host/v1', model: 'my-model' });

    store.setProvider('custom');

    expect(store.get().provider).toBe('custom');
    expect(store.get().baseURL).toBe('http://my-host/v1');
    expect(store.get().model).toBe('my-model');
  });
});

describe('归一化：磁盘上的脏数据不该让应用行为诡异', () => {
  it('非法主题回落到默认', () => {
    expect(normalizeSettings({ theme: 'PURPLE' }).theme).toBe('dark');
    expect(normalizeSettings({ theme: 'light' }).theme).toBe('light');
  });

  it('字号被限制在 12–28 之间', () => {
    expect(normalizeSettings({ fontSize: 100 }).fontSize).toBe(28);
    expect(normalizeSettings({ fontSize: 2 }).fontSize).toBe(12);
    expect(normalizeSettings({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it('语音速率被限制在 0.5–2 之间', () => {
    expect(normalizeSettings({ ttsRate: 9 }).ttsRate).toBe(2);
    expect(normalizeSettings({ ttsRate: 0 }).ttsRate).toBe(0.5);
  });

  it('不存在的服务商回落，避免调用链拿到 undefined', () => {
    const s = normalizeSettings({ primary: 'ghost', fallback: 'ghost', provider: 'ghost' });
    expect(s.primary).toBe(DEFAULT_SETTINGS.primary);
    expect(s.fallback).toBe(DEFAULT_SETTINGS.fallback);
    expect(s.provider).toBe(DEFAULT_SETTINGS.provider);
  });

  it('类型不对的字段回落成字符串默认值', () => {
    const s = normalizeSettings({ baseURL: 123, model: null, apiKey: {} });
    expect(s.baseURL).toBe(DEFAULT_SETTINGS.baseURL);
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
    expect(s.apiKey).toBe(DEFAULT_SETTINGS.apiKey);
  });

  it('完全不是对象时用全套默认值', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('持久化', () => {
  it('改完立刻落盘，重建后读回同样的值', () => {
    const storage = new MemoryStorage();
    const first = newStore(storage);

    first.patch({ fontSize: 19, model: 'deepseek-reasoner' });
    first.setTheme('light');

    const second = newStore(storage);
    expect(second.get().fontSize).toBe(19);
    expect(second.get().model).toBe('deepseek-reasoner');
    expect(second.get().theme).toBe('light');
  });

  it('沿用旧版键名，升级后老设置能直接读出来', () => {
    const storage = new MemoryStorage();
    // 模拟 v2.1 写下的数据
    storage.setItem(
      STORAGE_KEYS.settings,
      JSON.stringify({ fontSize: 18, theme: 'light', provider: 'deepseek', primary: 'deepseek' }),
    );

    const store = newStore(storage);
    const s = store.get();

    expect(s.fontSize).toBe(18);
    expect(s.theme).toBe('light');
    expect(s.primary).toBe('deepseek');
    // 老数据里没有的字段由默认值补齐
    expect(s.ttsEdgeVoice).toBe(DEFAULT_SETTINGS.ttsEdgeVoice);
  });
});

/**
 * 逐字输入的持久化
 *
 * ===== 这组测试在钉什么 =====
 *
 * 2026-10-30 的 bug：设置页的文本框绑的是 `@change`（**失焦才触发**）。
 * 用户在「API Key」里敲完字就直接切页 / 关应用 → 输入框还没失焦 →
 * **change 不触发 → 值根本没写盘** → 下次打开是空的。
 *
 * 修法：文本框改绑 `@input`（每次按键都存）。这组测试断言「每个中间态
 * 都真的落盘了」—— 因为 UI 层的 @input 绑定在 node 环境里测不到，
 * 只能在 core 层保证「patch 一次 = 写一次盘」这个前提成立。
 */
describe('逐字输入：每个中间态都要落盘', () => {
  it('连续 patch 模拟逐字输入，最后的值和中间值都在盘上', () => {
    const storage = new MemoryStorage();
    const store = newStore(storage);

    // 模拟用户一个字符一个字符地敲 'sk-abc'
    for (const partial of ['s', 'sk', 'sk-', 'sk-a', 'sk-ab', 'sk-abc']) {
      store.patch({ ttsApiKey: partial });
    }

    // 重新建一个 store 读盘（等于重启应用）
    const reopened = newStore(storage);
    expect(reopened.get().ttsApiKey).toBe('sk-abc');
  });

  it('中途状态也能读回来（不是只存最后一次）', () => {
    const storage = new MemoryStorage();
    const store = newStore(storage);

    store.patch({ ttsApiKey: 'sk-a' });
    const midway = newStore(storage);
    expect(midway.get().ttsApiKey).toBe('sk-a');

    store.patch({ ttsApiKey: 'sk-abc' });
    const after = newStore(storage);
    expect(after.get().ttsApiKey).toBe('sk-abc');
  });

  it('TTS 全部自定义字段都参与持久化', () => {
    const storage = new MemoryStorage();
    const store = newStore(storage);

    store.patch({
      ttsEngine: 'custom',
      ttsProvider: 'siliconflow',
      ttsApiBase: 'https://api.siliconflow.cn/v1',
      ttsApiKey: 'sk-tts',
      ttsApiModel: 'FunAudioLLM/CosyVoice2-0.5B',
      ttsApiVoice: 'anna',
      ttsApiFormat: 'wav',
      ttsApiPath: '/audio/speech',
      ttsApiHeaders: '{"api-key":"x"}',
      ttsApiBody: '{"gain":-2}',
    });

    const reopened = newStore(storage).get();
    expect(reopened.ttsEngine).toBe('custom');
    expect(reopened.ttsProvider).toBe('siliconflow');
    expect(reopened.ttsApiBase).toBe('https://api.siliconflow.cn/v1');
    expect(reopened.ttsApiKey).toBe('sk-tts');
    expect(reopened.ttsApiModel).toBe('FunAudioLLM/CosyVoice2-0.5B');
    expect(reopened.ttsApiVoice).toBe('anna');
    expect(reopened.ttsApiFormat).toBe('wav');
    expect(reopened.ttsApiPath).toBe('/audio/speech');
    expect(reopened.ttsApiHeaders).toBe('{"api-key":"x"}');
    expect(reopened.ttsApiBody).toBe('{"gain":-2}');
  });

  it('AI 那边的地址 / Key / 模型同样逐字落盘', () => {
    const storage = new MemoryStorage();
    const store = newStore(storage);

    for (const partial of ['h', 'ht', 'htt', 'http://x/v1']) {
      store.patch({ baseURL: partial });
    }
    store.patch({ apiKey: 'sk-ai' });
    store.patch({ model: 'deepseek-chat' });

    const reopened = newStore(storage).get();
    expect(reopened.baseURL).toBe('http://x/v1');
    expect(reopened.apiKey).toBe('sk-ai');
    expect(reopened.model).toBe('deepseek-chat');
  });

  it('写盘失败时 lastError 有值，UI 拿得到', () => {
    // 模拟 localStorage 写不进去（配额满 / 隐私模式）
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const store = new SettingsStore(new KeyValueStore(broken));

    store.patch({ ttsApiKey: 'sk-x' });

    expect(store.persistError).toContain('保存');
    expect(store.persistError).toContain('QuotaExceededError');
  });

  it('写盘失败不影响内存里的值（用户这次输入不白费）', () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    const store = new SettingsStore(new KeyValueStore(broken));

    store.patch({ ttsApiKey: 'sk-x' });

    expect(store.get().ttsApiKey).toBe('sk-x');
  });
});
