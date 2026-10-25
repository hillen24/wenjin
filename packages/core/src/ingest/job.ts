/**
 * 文献分析任务运行器：逐段提取，段段容灾
 *
 * 这是「AI 窗口会被撑爆」的正解 —— 不是把文本砍小赌一次成功，
 * 而是把任务拆成 N 个独立小节，每节：
 *   · 独立请求（单段输出有上限，撞不穿上下文窗口）；
 *   · 独立重试（网络抖一下、模型抽一下，最多再试一次）；
 *   · 独立记账（哪段成功、哪段失败、失败原因，界面上逐段列出来）。
 *
 * 一段失败不中断整篇 —— 论道者最恨「差一段就全白跑了」。
 * 用户可以暂停（当前段跑完再停）、中止（立刻掐断在途请求）、
 * 中止后已完成的段不会丢（暂存区里躺着，随时可以确认入库）。
 *
 * 单线程串行是有意的：并行发 N 个请求只会更快撞上服务商限流，
 * 本地 Ollama 更是一次只能吐一个字。真要大提速，该优化的是单段质量。
 */

import type { IngestModule, StagedItem } from '../types';
import type { ParseOutcome } from './parse';

/** 单段提取函数。signal 用于中止时掐断在途请求。 */
export type Extractor = (chunkText: string, signal: AbortSignal) => Promise<string>;

export interface JobDeps {
  /** 切好的文本段 */
  chunks: readonly string[];
  /** 真正发请求的人（视图里包 core.ai.chat） */
  extract: Extractor;
  /** 解析 + 校验。闭包里读当前暂存名单，实现跨段去重 */
  parse: (text: string) => ParseOutcome;
  /** 每段成功后的回调（视图负责写暂存区 + 刷新进度） */
  onItems: (items: StagedItem[]) => void;
  /** 单段最多尝试几次。默认 2（第一次 + 重试一次） */
  maxAttempts?: number;
  /** 重试前等待。默认 800ms，给限流留口气 */
  retryDelayMs?: number;
}

export type JobStatus = 'idle' | 'running' | 'paused' | 'done' | 'aborted';
export type ChunkStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface ChunkCounts {
  method: number;
  concept: number;
  topic: number;
  debate: number;
}

export interface ChunkState {
  index: number;
  /** 段原文（运行用） */
  text: string;
  /** 前 30 字，界面列清单用 */
  preview: string;
  chars: number;
  status: ChunkStatus;
  attempts: number;
  /** 失败原因（status=failed 时非空） */
  error: string;
  counts: ChunkCounts;
}

export interface JobSnapshot {
  status: JobStatus;
  chunks: readonly ChunkState[];
  total: number;
  ok: number;
  failed: number;
  /** 正在跑第几段（-1 表示没有在跑） */
  activeIndex: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tally(items: readonly StagedItem[]): ChunkCounts {
  const c: ChunkCounts = { method: 0, concept: 0, topic: 0, debate: 0 };
  for (const it of items) {
    if (it.module === 'relation') continue;
    c[it.module as Exclude<IngestModule, 'relation'>] += 1;
  }
  return c;
}

export class IngestJob {
  private readonly deps: Required<Pick<JobDeps, 'maxAttempts' | 'retryDelayMs'>> & JobDeps;
  private readonly chunks: ChunkState[];
  private readonly listeners = new Set<() => void>();
  private statusValue: JobStatus = 'idle';
  private pauseRequested = false;
  private abortCtl: AbortController | null = null;
  private looping = false;

  constructor(deps: JobDeps) {
    this.deps = {
      ...deps,
      maxAttempts: deps.maxAttempts ?? 2,
      retryDelayMs: deps.retryDelayMs ?? 800,
    };
    this.chunks = deps.chunks.map((text, index) => ({
      index,
      text,
      preview: text.slice(0, 30),
      chars: text.length,
      status: 'pending' as ChunkStatus,
      attempts: 0,
      error: '',
      counts: { method: 0, concept: 0, topic: 0, debate: 0 },
    }));
  }

  /* ---------- 状态读取 ---------- */

  get snapshot(): JobSnapshot {
    const chunks = this.chunks;
    return {
      status: this.statusValue,
      chunks,
      total: chunks.length,
      ok: chunks.filter((c) => c.status === 'ok').length,
      failed: chunks.filter((c) => c.status === 'failed').length,
      activeIndex: chunks.find((c) => c.status === 'running')?.index ?? -1,
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 状态读取走方法而不是直接读字段。
   *
   * TS 会把 `this.statusValue = 'running'` 之后的同字段引用窄缩成字面量，
   * 于是 `this.statusValue === 'aborted'` 被判成「类型不重叠」编译不过。
   * 而 abort()/pause() 是在别的方法里改这个字段的，TS 看不见 ——
   * 用方法调用读取，窄缩分析就干扰不到运行时行为了。
   */
  private isRunning(): boolean {
    return this.statusValue === 'running';
  }

  private isAborted(): boolean {
    return this.statusValue === 'aborted';
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('[ingest-job] 监听器异常', e);
      }
    }
  }

  /* ---------- 控制 ---------- */

  /** 开始（只能从 idle 调用一次；一个 Job 对象对应一次任务） */
  start(): void {
    if (this.statusValue !== 'idle' || this.looping) return;
    void this.loop();
  }

  /** 暂停：当前段跑完就停，不掐在途请求（掐了这段也废了） */
  pause(): void {
    if (this.statusValue !== 'running') return;
    this.pauseRequested = true;
    this.statusValue = 'paused';
    this.emit();
  }

  /** 继续：接着上次的进度往下跑（已完成的段自动跳过） */
  resume(): void {
    if (this.statusValue !== 'paused') return;
    this.pauseRequested = false;
    this.statusValue = 'running';
    this.emit();
  }

  /** 中止：立刻掐断在途请求，剩余段留在 pending */
  abort(): void {
    if (this.statusValue !== 'running' && this.statusValue !== 'paused') return;
    this.pauseRequested = false;
    this.statusValue = 'aborted';
    this.abortCtl?.abort();
    // 在途那段没跑完，退回 pending —— 它的产物没进暂存区，
    // 用户重开任务时它还能再跑一次（已成功的段则靠 takenNames 去重，白跑也不重复入库）
    const active = this.chunks.find((c) => c.status === 'running');
    if (active) {
      active.status = 'pending';
      active.error = '已中止';
    }
    this.emit();
  }

  /**
   * 续跑：把没跑成的段（失败 / 中止退回的 pending）重新排队，接着跑。
   *
   * 中止之后任务就散了（loop 已退出），但用户经常只是想停下来做点别的事，
   * 回来发现还有十几段没跑。这个入口让同一个任务对象能第二次、第三次起跑 ——
   * 已成功的段不重跑，它们的产物在暂存区里，parse 的 takenNames 也会去重。
   */
  retryPending(): void {
    if (this.looping) return;
    for (const c of this.chunks) {
      if (c.status !== 'ok') {
        c.status = 'pending';
        c.error = '';
      }
    }
    this.pauseRequested = false;
    this.emit();
    void this.loop();
  }

  /* ---------- 主循环 ---------- */

  private async loop(): Promise<void> {
    this.looping = true;
    this.statusValue = 'running';
    this.emit();

    for (const c of this.chunks) {
      // 只跳过成功的段：失败段在恢复跑时值得再试一次（暂停后继续、续跑都用这条路径）
      if (c.status === 'ok') continue;

      // 暂停等待：睡醒看一眼状态，被中止就退出去
      while (this.pauseRequested && !this.isAborted()) {
        await sleep(150);
      }
      if (!this.isRunning()) break;

      c.status = 'running';
      c.error = '';
      this.emit();

      for (let attempt = 1; attempt <= this.deps.maxAttempts; attempt += 1) {
        c.attempts = attempt;
        try {
          const ctl = new AbortController();
          this.abortCtl = ctl;
          const text = await this.deps.extract(c.text, ctl.signal);
          if (this.isAborted()) break;
          const r = this.deps.parse(text);
          if (!r.ok) throw new Error(r.reason);
          c.status = 'ok';
          c.counts = tally(r.items);
          if (r.items.length > 0) this.deps.onItems(r.items);
          break;
        } catch (e) {
          this.abortCtl = null;
          if (this.isAborted()) break;
          const msg = (e as Error)?.message || '未知错误';
          if (attempt < this.deps.maxAttempts) {
            await sleep(this.deps.retryDelayMs);
          } else {
            c.status = 'failed';
            c.error = msg;
          }
        } finally {
          this.abortCtl = null;
        }
      }
      this.emit();
    }

    if (this.statusValue === 'running') this.statusValue = 'done';
    this.looping = false;
    this.emit();
  }
}
