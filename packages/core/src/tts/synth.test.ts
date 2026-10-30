import { describe, expect, it } from 'vitest';
import {
  buildCloudRequest,
  buildEdgeRequest,
  buildSynthRequest,
  parseJsonObject,
  currentProvider,
} from './synth';
import { TTS_PROVIDERS, resolveVoiceId } from './providers';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import type { Settings } from '../types';

function s(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe('附加 JSON 解析', () => {
  it('空串当成空对象', () => {
    const r = parseJsonObject('', '附加请求头');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({});
  });

  it('不是对象时报一句人话，而不是抛原始 JSON 报错', () => {
    const r = parseJsonObject('[1,2]', '附加请求头');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('JSON 对象');
  });

  it('语法错误也返回可读原因', () => {
    const r = parseJsonObject('{oops', '附加请求参数');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('格式有误');
  });

  it('合法对象正常解析', () => {
    const r = parseJsonObject('{"gain": -2}', '附加请求参数');
    expect(r.ok).toBe(true);
    expect(r.value.gain).toBe(-2);
  });
});

describe('音色 id 拼装', () => {
  it('OpenAI 的音色原样用（不跟模型走）', () => {
    expect(resolveVoiceId(TTS_PROVIDERS.openai!, 'alloy')).toBe('alloy');
  });

  it('硅基流动的音色要拼上模型前缀', () => {
    expect(resolveVoiceId(TTS_PROVIDERS.siliconflow!, 'anna')).toBe(
      'FunAudioLLM/CosyVoice2-0.5B:anna',
    );
  });

  it('用户改了模型后，前缀跟着改（不能留在旧模型上）', () => {
    expect(
      resolveVoiceId(TTS_PROVIDERS.siliconflow!, 'anna', 'my-other-model'),
    ).toBe('my-other-model:anna');
  });

  it('已经是完整 id 就不重复拼', () => {
    expect(resolveVoiceId(TTS_PROVIDERS.siliconflow!, 'FunAudioLLM/X:anna')).toBe(
      'FunAudioLLM/X:anna',
    );
  });

  it('空音色回落到服务商默认', () => {
    expect(resolveVoiceId(TTS_PROVIDERS.openai!, '')).toBe('alloy');
  });
});

describe('云端 TTS 请求构造', () => {
  it('默认走服务商的地址、模型和音色', () => {
    const req = buildCloudRequest(
      s({ ttsEngine: 'custom', ttsProvider: 'siliconflow' }),
      '要念的话',
    );
    expect(req.url).toBe('https://api.siliconflow.cn/v1/audio/speech');
    expect(req.body.model).toBe('FunAudioLLM/CosyVoice2-0.5B');
    expect(req.body.voice).toBe('FunAudioLLM/CosyVoice2-0.5B:anna');
    expect(req.body.input).toBe('要念的话');
    expect(req.body.response_format).toBe('mp3');
    expect(req.error).toBe('');
  });

  it('用户填的地址模型音色覆盖预设', () => {
    const req = buildCloudRequest(
      s({
        ttsEngine: 'custom',
        ttsProvider: 'siliconflow',
        ttsApiBase: 'https://my.tts.local/v1',
        ttsApiModel: 'my-model',
        ttsApiVoice: 'bob',
      }),
      'x',
    );
    expect(req.url).toBe('https://my.tts.local/v1/audio/speech');
    expect(req.body.model).toBe('my-model');
    expect(req.body.voice).toBe('my-model:bob');  });

  it('有 Key 时带 Bearer 头', () => {
    const req = buildCloudRequest(s({ ttsEngine: 'custom', ttsApiKey: 'sk-123' }), 'x');
    expect(req.headers.Authorization).toBe('Bearer sk-123');
  });

  it('附加请求头能覆盖认证方式', () => {
    const req = buildCloudRequest(
      s({
        ttsEngine: 'custom',
        ttsApiKey: 'sk-123',
        ttsApiHeaders: '{"api-key": "azure-style"}',
      }),
      'x',
    );
    expect(req.headers['api-key']).toBe('azure-style');
    expect(req.headers.Authorization).toBe('Bearer sk-123');
  });

  it('附加请求体并进 body', () => {
    const req = buildCloudRequest(
      s({ ttsEngine: 'custom', ttsApiBody: '{"gain": -3, "sample_rate": 32000}' }),
      'x',
    );
    expect(req.body.gain).toBe(-3);
    expect(req.body.sample_rate).toBe(32000);
  });

  it('附加请求头写坏了 → 报错但请求照样能发', () => {
    const req = buildCloudRequest(
      s({ ttsEngine: 'custom', ttsApiHeaders: '{坏掉的' }),
      'x',
    );
    expect(req.error).toContain('附加请求头');
    expect(req.body.input).toBe('x'); // body 没被污染
  });

  it('端点可以换路径', () => {
    const req = buildCloudRequest(
      s({ ttsEngine: 'custom', ttsApiPath: '/v1/tts' }),
      'x',
    );
    expect(req.url).toBe('https://api.siliconflow.cn/v1/v1/tts');
  });

  it('端点可以直接填完整 URL', () => {
    const req = buildCloudRequest(
      s({ ttsEngine: 'custom', ttsApiPath: 'https://other.host/speak' }),
      'x',
    );
    expect(req.url).toBe('https://other.host/speak');
  });

  it('地址末尾的斜杠不会拼出双斜杠', () => {
    const req = buildCloudRequest(
      s({ ttsEngine: 'custom', ttsApiBase: 'https://my.tts.local/v1/' }),
      'x',
    );
    expect(req.url).toBe('https://my.tts.local/v1/audio/speech');
  });

  it('未知服务商落到自定义', () => {
    expect(currentProvider(s({ ttsProvider: '不存在' })).name).toContain('自定义');
  });
});

describe('edge 桥请求构造', () => {
  it('model 固定 edge-tts，音色走 Edge 的神经网络 id', () => {
    const req = buildEdgeRequest(s({ ttsEngine: 'edge' }), '念我');
    expect(req.url).toBe('http://127.0.0.1:8787/v1/audio/speech');
    expect(req.body.model).toBe('edge-tts');
    expect(req.body.voice).toBe('zh-CN-XiaoxiaoNeural');
    expect(req.body.input).toBe('念我');
  });

  it('桥地址可以改成局域网 IP', () => {
    const req = buildEdgeRequest(
      s({ ttsEngine: 'edge', ttsBaseURL: 'http://192.168.1.5:8787/v1' }),
      'x',
    );
    expect(req.url).toBe('http://192.168.1.5:8787/v1/audio/speech');
  });
});

describe('按引擎分流', () => {
  it('browser 引擎没有远端请求', () => {
    expect(buildSynthRequest(s({ ttsEngine: 'browser' }), 'x')).toBeNull();
  });

  it('edge 走 edge 链路', () => {
    expect(buildSynthRequest(s({ ttsEngine: 'edge' }), 'x')?.body.model).toBe('edge-tts');
  });

  it('custom 走云端链路', () => {
    const req = buildSynthRequest(s({ ttsEngine: 'custom' }), 'x');
    expect(req?.body.model).toBe('FunAudioLLM/CosyVoice2-0.5B');
  });
});
