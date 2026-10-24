/**
 * 测试工具：可注入的 fetch
 *
 * 旧版这些断言是靠「往 HTML 里注入 mock fetch 再跑浏览器」做的，
 * 现在一个函数搞定。
 */

import type { FetchLike } from './ai/client';

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 模拟一次成功的对话响应 */
export function chatOk(text: string): Response {
  return jsonResponse({ choices: [{ message: { content: text } }] });
}

export interface FetchHarness {
  impl: FetchLike;
  calls: RecordedCall[];
  /** 第 n 次调用（从 1 开始） */
  call(n: number): RecordedCall;
  body(n: number): Record<string, unknown>;
}

/**
 * 造一个按调用次序应答的假 fetch。
 * handler 收到 (本次调用, 是第几次)，返回 Response 或直接抛错（模拟网络故障）。
 */
export function makeFetch(
  handler: (call: RecordedCall, n: number) => Response | Promise<Response>,
): FetchHarness {
  const calls: RecordedCall[] = [];

  const impl: FetchLike = async (url, init) => {
    const rec: RecordedCall = { url, init };
    calls.push(rec);
    return handler(rec, calls.length);
  };

  return {
    impl,
    calls,
    call(n: number): RecordedCall {
      const c = calls[n - 1];
      if (!c) throw new Error(`第 ${n} 次调用不存在（共 ${calls.length} 次）`);
      return c;
    },
    body(n: number): Record<string, unknown> {
      const raw = calls[n - 1]?.init?.body;
      if (typeof raw !== 'string') throw new Error(`第 ${n} 次调用没有请求体`);
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

/** 取出请求头里的某个字段 */
export function headerOf(call: RecordedCall, name: string): string | undefined {
  const h = call.init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) {
    const hit = h.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit?.[1];
  }
  const rec = h as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : undefined;
}
