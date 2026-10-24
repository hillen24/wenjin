/**
 * AiGate 回归测试
 *
 * 每一条都对应一个真实踩过的坑，注释里写了「旧版为什么错」。
 * 这些断言就是重构的意义所在：以前只能人肉点界面确认，现在一条命令跑完。
 */

import { describe, expect, it } from 'vitest';
import { createCore, type WenjinCore } from '../index';
import { MemoryStorage } from '../storage';
import { chatOk, headerOf, jsonResponse, makeFetch, type FetchHarness } from '../testing';

const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

function newCore(harness?: FetchHarness): { core: WenjinCore; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const core = createCore({
    storage,
    ...(harness ? { fetchImpl: harness.impl } : {}),
  });
  return { core, storage };
}

/** 探针成功的假 fetch */
function probingOk(): FetchHarness {
  return makeFetch(() => chatOk('可用'));
}

describe('接入状态：默认与探测', () => {
  it('默认配置未验证时是 unverified，不会假装已接入', () => {
    const { core } = newCore(probingOk());
    expect(core.ai.status.state).toBe('unverified');
    expect(core.ai.isLive()).toBe(false);
  });

  it('测试连接发的是真实对话，成功后进入 verified', async () => {
    const h = probingOk();
    const { core } = newCore(h);

    const r = await core.ai.testConnection();

    expect(r.status.state).toBe('verified');
    expect(r.brief).toBe('可用');
    expect(core.ai.isLive()).toBe(true);
  });

  it('测试连接打的是 POST /chat/completions，而不是只 GET /models', async () => {
    const h = probingOk();
    const { core } = newCore(h);

    await core.ai.testConnection();

    // 旧版只 GET /models：模型列表拉得到 ≠ 能对话，于是出现过「显示成功、实际全挂」
    expect(h.call(1).url).toBe(`${OLLAMA_BASE}/chat/completions`);
    expect(h.call(1).init?.method).toBe('POST');
  });

  it('探针请求体：带 model、stream:false、温度 0、只留 24 token', async () => {
    const h = probingOk();
    const { core } = newCore(h);

    await core.ai.testConnection();
    const body = h.body(1);

    expect(body.model).toBe('qwen2.5:7b');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(24);
  });

  it('本地服务不发 Authorization 头，避免把云端 Key 泄给本机端口', async () => {
    const h = probingOk();
    const { core } = newCore(h);

    await core.ai.testConnection();

    expect(headerOf(h.call(1), 'authorization')).toBeUndefined();
  });

  it('云端服务带 Bearer 头', async () => {
    const h = probingOk();
    const { core } = newCore(h);

    core.settings.setProvider('deepseek');
    core.settings.patch({ apiKey: 'sk-test-123' });
    await core.ai.testConnection();

    expect(h.call(1).url).toBe(`${DEEPSEEK_BASE}/chat/completions`);
    expect(headerOf(h.call(1), 'authorization')).toBe('Bearer sk-test-123');
  });
});

describe('接入状态：抗误伤（旧版四个 bug 的回归）', () => {
  it('回归 ①：重建实例后仍是已接入（旧版是内存布尔，重启即丢）', async () => {
    const storage = new MemoryStorage();
    const h = probingOk();

    const first = createCore({ storage, fetchImpl: h.impl });
    await first.ai.testConnection();
    expect(first.ai.isLive()).toBe(true);

    // 模拟「关掉应用再打开」：同一份存储，全新实例
    const second = createCore({ storage, fetchImpl: h.impl });
    expect(second.ai.isLive()).toBe(true);
    expect(second.ai.status.state).toBe('verified');
  });

  it('回归 ②：改字号不会把接入状态清零（旧版 saveSettings 无条件清零）', async () => {
    const { core } = newCore(probingOk());
    await core.ai.testConnection();
    expect(core.ai.isLive()).toBe(true);

    core.settings.patch({ fontSize: 22 });

    expect(core.ai.isLive()).toBe(true);
  });

  it('回归 ②：切主题不会把接入状态清零', async () => {
    const { core } = newCore(probingOk());
    await core.ai.testConnection();

    core.settings.setTheme('light');

    expect(core.ai.isLive()).toBe(true);
    expect(core.settings.get().theme).toBe('light');
  });

  it('回归 ②：改 TTS 音色不会把接入状态清零', async () => {
    const { core } = newCore(probingOk());
    await core.ai.testConnection();

    core.settings.patch({ ttsEdgeVoice: 'zh-CN-YunxiNeural', ttsRate: 1.2 });

    expect(core.ai.isLive()).toBe(true);
  });

  it('回归 ④：setProvider 强制同步 primary（旧版两字段永不联动）', () => {
    const { core } = newCore(probingOk());

    core.settings.setProvider('deepseek');

    const s = core.settings.get();
    expect(s.provider).toBe('deepseek');
    // 这一条是那次修复的核心：上面选谁，真正被调用的主力就得是谁
    expect(s.primary).toBe('deepseek');
    expect(s.baseURL).toBe(DEEPSEEK_BASE);
    expect(s.model).toBe('deepseek-chat');
  });

  it('切回本地服务时清掉 Key，不把云端密钥带给本机', () => {
    const { core } = newCore(probingOk());

    core.settings.setProvider('deepseek');
    core.settings.patch({ apiKey: 'sk-secret' });
    core.settings.setProvider('ollama');

    expect(core.settings.get().apiKey).toBe('');
  });

  it('换模型后自动失效，不会假报已接入', async () => {
    const { core } = newCore(probingOk());
    await core.ai.testConnection();
    expect(core.ai.isLive()).toBe(true);

    core.settings.patch({ model: 'qwen2.5:3b' });

    expect(core.ai.isLive()).toBe(false);
    expect(core.ai.status.state).toBe('unverified');
  });

  it('换 Key 后自动失效', async () => {
    const { core } = newCore(probingOk());
    core.settings.setProvider('deepseek');
    core.settings.patch({ apiKey: 'sk-a' });
    await core.ai.testConnection();
    expect(core.ai.isLive()).toBe(true);

    core.settings.patch({ apiKey: 'sk-b' });

    expect(core.ai.isLive()).toBe(false);
  });

  it('指纹只由主力/BaseURL/Key/模型四项决定', async () => {
    const { core } = newCore(probingOk());
    await core.ai.testConnection();

    const sig = core.ai.signature();

    core.settings.patch({ fontSize: 20, ttsRate: 1.5 });
    expect(core.ai.signature()).toBe(sig);

    core.settings.patch({ model: 'other-model' });
    expect(core.ai.signature()).not.toBe(sig);
  });
});

describe('接入状态：失败与撤销', () => {
  it('测试连接失败时进入 failed，并带上人能看懂的原因', async () => {
    const h = makeFetch(() => jsonResponse({ error: 'invalid key' }, 401));
    const { core } = newCore(h);

    const r = await core.ai.testConnection();

    expect(r.status.state).toBe('failed');
    expect(core.ai.isLive()).toBe(false);
    // 401 必须翻成「Key 无效」，而不是甩一个 HTTP 401 给用户
    expect(core.ai.failureReason).toContain('Key 无效');
  });

  it('运行中遇 401 会立刻撤销接入状态', async () => {
    const h = makeFetch((_c, n) =>
      n === 1 ? chatOk('可用') : jsonResponse({ error: 'expired' }, 401),
    );
    const { core } = newCore(h);

    await core.ai.testConnection();
    expect(core.ai.isLive()).toBe(true);

    await expect(
      core.client.callWithFallback(
        [{ role: 'user', content: 'hi' }],
        { onAuthFailure: (e) => core.ai.clear(`认证失败 HTTP ${e.status}`) },
      ),
    ).rejects.toThrow();

    expect(core.ai.isLive()).toBe(false);
    expect(core.ai.status.state).toBe('failed');
  });

  it('缺 Key 时明确报缺少 API Key，而不是「无可用服务商」', async () => {
    const h = makeFetch(() => chatOk('x'));
    const { core } = newCore(h);

    core.settings.setProvider('deepseek');
    core.settings.patch({ apiKey: '' });

    await expect(
      core.client.callWithFallback([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/缺少 API Key/);
    // 一个请求都不该发出去
    expect(h.calls.length).toBe(0);
  });

  it('状态未配置时不发任何请求', async () => {
    const h = probingOk();
    const { core } = newCore(h);

    core.settings.setProvider('deepseek');
    core.settings.patch({ apiKey: '' });

    expect(core.ai.status.state).toBe('unconfigured');

    await core.ai.autoVerify();
    expect(h.calls.length).toBe(0);
  });
});

describe('调用链：兜底与模型列表', () => {
  it('主力挂掉自动走兜底，并报出实际应答的服务商', async () => {
    const h = makeFetch((_c, n) => {
      if (n === 1) throw new TypeError('Failed to fetch');
      return chatOk('兜底回答');
    });
    const { core } = newCore(h);

    // 配了 Key 让 deepseek（fallback）可用；ollama 是主力且不需要 Key
    core.settings.patch({ apiKey: 'sk-x' });

    const r = await core.client.callWithFallback([{ role: 'user', content: 'hi' }]);

    expect(r.text).toBe('兜底回答');
    expect(r.provider).toBe('deepseek');
    expect(h.calls.length).toBe(2);
  });

  it('缺 Key 的兜底服务不参与链路，不会把真实错误盖成 Key 问题', async () => {
    const h = makeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const { core } = newCore(h);

    // 主力 ollama 不需要 Key，兜底 deepseek 需要但没配 → 应被过滤掉
    await expect(
      core.client.callWithFallback([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/Failed to fetch/);

    expect(h.calls.length).toBe(1);
  });

  it('拉模型列表：OpenAI 兼容服务走 /models', async () => {
    const h = makeFetch(() =>
      jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
    );
    const { core } = newCore(h);

    core.settings.setProvider('deepseek');
    core.settings.patch({ apiKey: 'sk-x' });

    const r = await core.ai.fetchModels();

    expect(r).toEqual({ ok: true, ids: ['deepseek-chat', 'deepseek-reasoner'] });
    expect(h.call(1).url).toBe(`${DEEPSEEK_BASE}/models`);
  });

  it('拉模型列表：Ollama 走 /api/tags 且去掉 /v1', async () => {
    const h = makeFetch(() =>
      jsonResponse({ models: [{ model: 'qwen2.5:7b' }, { name: 'llama3:8b' }] }),
    );
    const { core } = newCore(h);

    const r = await core.ai.fetchModels();

    expect(r).toEqual({ ok: true, ids: ['qwen2.5:7b', 'llama3:8b'] });
    expect(h.call(1).url).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('拉模型列表失败时返回原因，不抛异常给界面', async () => {
    const h = makeFetch(() => jsonResponse({ error: 'nope' }, 500));
    const { core } = newCore(h);

    const r = await core.ai.fetchModels();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('服务端出错');
  });
});
