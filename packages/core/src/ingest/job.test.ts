/**
 * 文献分析任务运行器的单测。
 *
 * 容灾是这套 Agent 的卖点，全在这几条用例上：
 * 一段失败不拖垮整篇、失败会重试、暂停能停住、中止能掐断在途请求、
 * 已完成的段不重跑。每条都对应一个真实会发生的场景。
 */

import { describe, expect, it } from 'vitest';
import { IngestJob, type JobDeps } from './job';
import { parseExtractReply, type ParseContext } from './parse';
import { STAR_NODES } from '../data/star-map';

const PARSE_CTX: ParseContext = {
  modules: ['method', 'concept', 'topic', 'debate'],
  takenNames: new Set<string>(),
  existingIds: new Set(STAR_NODES.map((n) => n.id)),
  nodeNameToId: new Map(STAR_NODES.map((n) => [n.name, n.id])),
  source: '《测试文献》',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时：条件迟迟不成立');
    await sleep(5);
  }
}

const OK_REPLY = JSON.stringify({
  methods: [{ name: '否定之法', cat: '思维工具', one: '先弄清不是什么', sop: ['列候选'] }],
  concepts: [{ name: '否定的自由', kind: 'concept', brief: '自由在否定中显现' }],
});

interface Harness {
  job: IngestJob;
  calls: string[];
  items: unknown[];
}

function makeJob(over: Partial<JobDeps> = {}): Harness {
  const calls: string[] = [];
  const items: unknown[] = [];
  const job = new IngestJob({
    chunks: ['段一', '段二', '段三'],
    extract: async (text) => {
      calls.push(text);
      return OK_REPLY;
    },
    parse: (text) => parseExtractReply(text, PARSE_CTX),
    onItems: (its) => items.push(...its),
    ...over,
  });
  return { job, calls, items };
}

describe('IngestJob 正常路径', () => {
  it('串行跑完所有段，一段一次请求', async () => {
    const { job, calls } = makeJob();
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(3);
    expect(job.snapshot.failed).toBe(0);
    expect(calls).toEqual(['段一', '段二', '段三']);
  });

  it('每段的产物经 onItems 交出，段上记着分类计数', async () => {
    const { job, items } = makeJob();
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    // 每段 1 方法 + 1 概念，三段共 6 条
    expect(items).toHaveLength(6);
    expect(job.snapshot.chunks[0]!.counts).toEqual({ method: 1, concept: 1, topic: 0, debate: 0 });
  });

  it('空产物（模型说这段没啥可提炼）也算成功', async () => {
    const { job } = makeJob({
      extract: async () => JSON.stringify({ methods: [], concepts: [] }),
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(3);
  });

  it('start 只能生效一次', async () => {
    const { job, calls } = makeJob();
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    job.start();
    await sleep(20);
    expect(calls).toEqual(['段一', '段二', '段三']);
  });
});

describe('IngestJob 容灾', () => {
  it('一段失败不拖垮整篇：失败的记原因，其余照常', async () => {
    const { job } = makeJob({
      extract: async (text) => {
        if (text === '段二') throw new Error('网络错误');
        return OK_REPLY;
      },
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(2);
    expect(job.snapshot.failed).toBe(1);
    const c = job.snapshot.chunks[1]!;
    expect(c.status).toBe('failed');
    expect(c.error).toContain('网络错误');
  });

  it('失败会重试：第一次不行，第二次成功', async () => {
    let n = 0;
    let calls_n = 0;
    const { job } = makeJob({
      retryDelayMs: 10,
      extract: async (text) => {
        calls_n += 1;
        if (text === '段一' && n === 0) {
          n += 1;
          return '这段不是 JSON，模型跑飞了';
        }
        return OK_REPLY;
      },
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(3);
    expect(job.snapshot.chunks[0]!.attempts).toBe(2);
    expect(calls_n).toBe(4); // 段一两次 + 段二、段三各一次
  });

  it('maxAttempts 可调成 1：不重试，直接记失败', async () => {
    const { job } = makeJob({
      extract: async (text) => {
        if (text === '段二') throw new Error('限流');
        return OK_REPLY;
      },
      maxAttempts: 1,
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.chunks[1]!.attempts).toBe(1);
    expect(job.snapshot.failed).toBe(1);
  });
});

describe('IngestJob 暂停 / 继续 / 中止', () => {
  it('暂停后停住，继续后接着跑，已完成的段不重跑', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const { job } = makeJob({
      extract: async (text) => {
        seen.push(text);
        if (text === '段一') await gate;
        return OK_REPLY;
      },
    });
    job.start();
    job.pause();
    expect(job.snapshot.status).toBe('paused');

    release();
    await sleep(30);
    // 段一跑完了，但暂停锁着，段二没开始
    expect(job.snapshot.chunks[0]!.status).toBe('ok');
    expect(job.snapshot.chunks[1]!.status).toBe('pending');

    job.resume();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(3);
    // 段一只跑了一次
    expect(seen.filter((c) => c === '段一')).toHaveLength(1);
  });

  it('中止立刻掐断在途请求，并收到 aborted 信号', async () => {
    let sawAbort = false;
    const { job } = makeJob({
      extract: (_text, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('请求已中止'));
          });
        }),
    });
    job.start();
    await sleep(10);
    job.abort();
    await waitFor(() => job.snapshot.status === 'aborted');
    expect(sawAbort).toBe(true);
    expect(job.snapshot.ok).toBe(0);
    // 在途那段退回 pending，没有假装成功
    expect(job.snapshot.chunks[0]!.status).toBe('pending');
  });

  it('失败的段不拖累其他段的产物', async () => {
    const { job, items } = makeJob({
      retryDelayMs: 10,
      extract: async (text) => {
        if (text === '段二') throw new Error('这段永远失败');
        return OK_REPLY;
      },
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    // 段一、段三各 2 条产物
    expect(items).toHaveLength(4);
  });

  it('中止后续跑：没跑成的段重新排队，已成功的不重跑', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const { job } = makeJob({
      extract: async (text) => {
        seen.push(text);
        if (text === '段一') await gate;
        return OK_REPLY;
      },
    });
    job.start();
    await sleep(10);
    job.abort();
    await waitFor(() => job.snapshot.status === 'aborted');
    expect(job.snapshot.ok).toBe(0);

    release();
    // 等在途那段彻底退出：它的 extract 没监听 signal，收尾跑在微任务里，
    // 不wait这一步，retryPending 会被 looping 守卫正确挡下（旧循环还没散）
    await sleep(20);
    job.retryPending();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(3);
    // 段一被中止时没算成功，续跑补上；段二、段三中止时还没开始
    expect(seen).toEqual(['段一', '段一', '段二', '段三']);
  });

  it('失败全部段后续跑也能整批重来', async () => {
    let round = 0;
    const { job } = makeJob({
      retryDelayMs: 10,
      maxAttempts: 1,
      extract: async () => {
        if (round === 0) throw new Error('整轮都失败');
        return OK_REPLY;
      },
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.failed).toBe(3);

    round = 1;
    job.retryPending();
    await waitFor(() => job.snapshot.status === 'done');
    expect(job.snapshot.ok).toBe(3);
    expect(job.snapshot.failed).toBe(0);
  });

  it('retryPending 在任务跑着的时候是空操作（不会双跑）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const { job } = makeJob({
      extract: async (text) => {
        seen.push(text);
        await gate;
        return OK_REPLY;
      },
    });
    job.start();
    await sleep(10);
    job.retryPending(); // 段一还在途，这次调用应该被忽略
    release();
    await waitFor(() => job.snapshot.status === 'done');
    expect(seen).toEqual(['段一', '段二', '段三']);
  });
});

describe('IngestJob 订阅', () => {
  it('状态变化会通知订阅者', async () => {
    const { job } = makeJob();
    let notified = 0;
    const off = job.subscribe(() => {
      notified += 1;
    });
    job.start();
    await waitFor(() => job.snapshot.status === 'done');
    off();
    const before = notified;
    await sleep(10);
    expect(notified).toBeGreaterThan(0);
    expect(notified).toBe(before); // 退订后不再通知
  });
});
