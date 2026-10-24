import { describe, expect, it, vi } from 'vitest';
import { TtsController, type AudioLike, type SynthLike, type UtteranceLike } from './index';
import { DEFAULT_SETTINGS } from '../settings/defaults';
import type { Settings } from '../types';
import type { FetchLike } from '../ai/client';

/** 假语音合成：记下说了什么，暴露一个手动触发 onend 的口子 */
function fakeSynth() {
  const spoken: UtteranceLike[] = [];
  const synth: SynthLike = {
    getVoices: () => [
      { name: 'English Voice', lang: 'en-US' },
      { name: '晓晓', lang: 'zh-CN' },
    ],
    speak: (u) => {
      spoken.push(u);
    },
    cancel: vi.fn(),
  };
  return { synth, spoken };
}

function makeUtterance(text: string): UtteranceLike {
  return { text, lang: '', rate: 1, onend: null, onerror: null };
}

function makeAudio(behaviour: 'end' | 'hang' = 'end') {
  const created: Array<AudioLike & { url: string }> = [];
  const createAudio = (url: string): AudioLike => {
    const a: AudioLike & { url: string } = {
      url,
      onended: null,
      onerror: null,
      pause: vi.fn(),
      play: () => {
        if (behaviour === 'end') setTimeout(() => a.onended?.(), 0);
        return Promise.resolve();
      },
    };
    created.push(a);
    return a;
  };
  return { created, createAudio };
}

function settings(patch: Partial<Settings> = {}): () => Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...patch };
  return () => s;
}

describe('系统语音引擎', () => {
  it('念第一段，然后连续念下一段', async () => {
    const { synth, spoken } = fakeSynth();
    const tts = new TtsController({
      getSettings: settings({ ttsEngine: 'browser', ttsContinuous: true }),
      synth,
      createUtterance: makeUtterance,
    });

    const seen: number[] = [];
    let finished = 0;
    tts.start(['第一段', '第二段'], 0, {
      onParagraph: (i) => seen.push(i),
      onFinish: () => (finished += 1),
    });

    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe('第一段');

    spoken[0]!.onend?.(); // 第一段念完 → 自动接第二段
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken[1]!.text).toBe('第二段');

    spoken[1]!.onend?.(); // 最后一段念完 → 收工
    await vi.waitFor(() => expect(finished).toBe(1));
    expect(seen).toEqual([0, 1]);
    expect(tts.speaking).toBe(false);
  });

  it('关闭连续模式时只念一段', async () => {
    const { synth, spoken } = fakeSynth();
    const tts = new TtsController({
      getSettings: settings({ ttsEngine: 'browser', ttsContinuous: false }),
      synth,
      createUtterance: makeUtterance,
    });

    let finished = 0;
    tts.start(['A', 'B'], 0, { onFinish: () => (finished += 1) });
    spoken[0]!.onend?.();

    await vi.waitFor(() => expect(finished).toBe(1));
    expect(spoken).toHaveLength(1);
  });

  it('停止之后，在途的 onend 不能再推进（旧版的并发 bug）', async () => {
    const { synth, spoken } = fakeSynth();
    const tts = new TtsController({
      getSettings: settings({ ttsEngine: 'browser', ttsContinuous: true }),
      synth,
      createUtterance: makeUtterance,
    });

    tts.start(['A', 'B'], 0);
    const first = spoken[0]!;
    tts.stop();
    first.onend?.(); // 停止后旧回调才到

    await new Promise((r) => setTimeout(r, 10));
    expect(spoken).toHaveLength(1); // 没有偷偷开始第二段
    expect(tts.speaking).toBe(false);
  });

  it('优先挑中文音色', () => {
    const { synth } = fakeSynth();
    const tts = new TtsController({
      getSettings: settings(),
      synth,
      createUtterance: makeUtterance,
    });
    expect(tts.pickVoice()?.lang).toBe('zh-CN');
  });

  it('用户指定音色优先于语言偏好', () => {
    const { synth } = fakeSynth();
    const tts = new TtsController({
      getSettings: settings({ ttsVoice: 'English Voice' }),
      synth,
      createUtterance: makeUtterance,
    });
    expect(tts.pickVoice()?.name).toBe('English Voice');
  });

  it('环境不支持语音合成时给一句人话提示', () => {
    const tts = new TtsController({ getSettings: settings(), synth: null });
    const notes: string[] = [];
    tts.start(['A'], 0, { onNotice: (m) => notes.push(m) });
    expect(notes[0]).toContain('不支持语音合成');
    expect(tts.supported).toBe(false);
  });

  it('越界索引直接收工，不抛异常', async () => {
    const { synth } = fakeSynth();
    const tts = new TtsController({
      getSettings: settings(),
      synth,
      createUtterance: makeUtterance,
    });
    let finished = 0;
    tts.start(['A'], 99, { onFinish: () => (finished += 1) });
    await vi.waitFor(() => expect(finished).toBe(1));
  });
});

describe('Edge TTS 引擎', () => {
  function fakeFetch(status = 200): FetchLike {
    return vi.fn(async () => {
      if (status !== 200) return new Response('nope', { status });
      return new Response(new Blob(['fake-mp3']), { status: 200 });
    }) as unknown as FetchLike;
  }

  it('发的是 /audio/speech，带 model=edge-tts 和音色', async () => {
    const { synth } = fakeSynth();
    const { createAudio } = makeAudio('end');
    const fetchImpl = fakeFetch();
    const tts = new TtsController({
      getSettings: settings({ ttsEngine: 'edge', ttsContinuous: false }),
      synth,
      createUtterance: makeUtterance,
      createAudio,
      fetchImpl,
      revokeUrl: vi.fn(),
    });

    let finished = 0;
    tts.start(['要念的话'], 0, { onFinish: () => (finished += 1) });
    await vi.waitFor(() => expect(finished).toBe(1));

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(String(call[0])).toContain('/audio/speech');
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.model).toBe('edge-tts');
    expect(body.voice).toBe('zh-CN-XiaoxiaoNeural');
    expect(body.input).toBe('要念的话');
  });

  it('服务不可达时自动退回系统语音，且从同一段重念', async () => {
    const { synth, spoken } = fakeSynth();
    const { createAudio } = makeAudio();
    const tts = new TtsController({
      getSettings: settings({ ttsEngine: 'edge', ttsContinuous: false }),
      synth,
      createUtterance: makeUtterance,
      createAudio,
      fetchImpl: fakeFetch(500),
      revokeUrl: vi.fn(),
    });

    const notes: string[] = [];
    const fallbacks: string[] = [];
    tts.start(['要念的话'], 0, {
      onNotice: (m) => notes.push(m),
      onEngineFallback: (e) => fallbacks.push(e),
    });

    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]!.text).toBe('要念的话');
    expect(notes[0]).toContain('Edge-TTS 不可用');
    expect(fallbacks).toEqual(['browser']);
  });

  it('合成期间用户点了停止：合成回来的音频不会被播出来', async () => {
    const { synth } = fakeSynth();
    const { created, createAudio } = makeAudio();

    // 卡住等我们手动的 fetch
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = (async () => {
      await gate;
      return new Response(new Blob(['x']), { status: 200 });
    }) as unknown as FetchLike;

    const tts = new TtsController({
      getSettings: settings({ ttsEngine: 'edge' }),
      synth,
      createUtterance: makeUtterance,
      createAudio,
      fetchImpl,
      revokeUrl: vi.fn(),
    });

    tts.start(['A'], 0);
    tts.stop();
    release!();
    await new Promise((r) => setTimeout(r, 20));

    expect(created).toHaveLength(0); // 没有为已作废的请求创建音频
  });
});
