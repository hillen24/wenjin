/**
 * 手机端 fetch · AI 请求走原生通道
 *
 * 为什么要有这个文件：
 *
 * 电脑端（Electron）把 webSecurity 关了，DeepSeek / SiliconFlow 这些第三方
 * API 直连没问题。手机 WebView 关不掉同源策略——这些 API 又不带 CORS 头，
 * 于是伴读问答、论道、AI 梳理、拉模型列表在手机上**全部被浏览器层拦死**，
 * 表现就是「AI 配了也用不了」。
 *
 * 解法：AI 这一路 fetch 不走 WebView，改走 CapacitorHttp（原生 Java HTTP），
 * 天生没有 CORS。其余请求保持标准 fetch——局域网同步和 TTS 桥对面是
 * 我们自己的服务，带 CORS 头就行，不需要为它们放开全局补丁
 * （全局补丁会吞掉 AbortSignal，超时控制会失灵）。
 *
 * 注意：这只在真机/模拟器里生效，浏览器 dev 模式没有原生层，
 * 会自动落回标准 fetch。
 */

import { CapacitorHttp } from '@capacitor/core';

/** 与 core 的 FetchLike 对齐：(input, init) => Promise<Response> */
export function isNativeHttp(): boolean {
  return typeof window !== 'undefined' && !!(window as { Capacitor?: unknown }).Capacitor;
}

/**
 * base64 → Blob
 *
 * Android 原生层拿到二进制（mp3/wav）时没法直接跨桥传字节，
 * 它的做法是 base64 编码成字符串再送回 JS。所以这里要解回来。
 *
 * 坑：atob 解出来的是「每个字符一个字节」的 binary string，
 * 直接 new Blob([binaryString]) 会按 UTF-8 再编码一次 → 高位字节全乱，音频变噪音。
 * 必须先转成 Uint8Array。
 */
function base64ToBlob(b64: string, mime: string): Blob {
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export const capFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? 'GET').toUpperCase();

  // init.body 在这里只会是字符串（core 全部 JSON 序列化后再传）
  const rawBody = init?.body;
  const bodyText = typeof rawBody === 'string' ? rawBody : rawBody ? String(rawBody) : undefined;

  // core 传的 headers 是普通对象（含 Authorization），兼容 Headers 实例
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers;
  if (rawHeaders) {
    if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
  }

  // CapacitorHttp 对 JSON 请求：data 传对象，原生层自动序列化并补 Content-Type
  let data: unknown = bodyText;
  if (bodyText !== undefined) {
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = bodyText;
    }
  }

  // 要二进制响应（TTS 音频）。原生层见到 arraybuffer 会把 body base64 送回来。
  const wantsBinary = (init as { wjBinary?: boolean } | undefined)?.wjBinary === true;

  const signal = init?.signal;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const task = CapacitorHttp.request({
    url,
    method: method as 'GET' | 'POST',
    headers,
    data,
    connectTimeout: 10_000,
    readTimeout: 60_000,
    ...(wantsBinary ? { responseType: 'arraybuffer' as const } : {}),
  });

  // 原生请求没法中途取消，但超时 / 用户取消时要让调用方立刻返回
  const abortP = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      })
    : null;

  let native: Awaited<ReturnType<typeof CapacitorHttp.request>>;
  try {
    native = abortP ? await Promise.race([task, abortP]) : await task;
  } catch (e) {
    // 原生层报的错统一转成浏览器风格的 Failed to fetch，core 的错误翻译才认得
    throw new TypeError(`Failed to fetch: ${(e as Error)?.message ?? e}`);
  }

  const resHeaders = (native.headers ?? {}) as Record<string, string>;
  const contentType =
    resHeaders['content-type'] ?? resHeaders['Content-Type'] ?? 'application/octet-stream';

  // 二进制分支：原生层给的是 base64 字符串，解回 Blob
  if (wantsBinary && typeof native.data === 'string') {
    const blob = base64ToBlob(native.data, contentType);
    return new Response(blob, { status: native.status, headers: resHeaders });
  }

  // 原生层对 JSON 响应会直接给对象；拼回字符串交给 Response 统一解析
  const payload =
    typeof native.data === 'string' ? native.data : JSON.stringify(native.data ?? '');

  return new Response(payload, {
    status: native.status,
    headers: resHeaders,
  });
};
