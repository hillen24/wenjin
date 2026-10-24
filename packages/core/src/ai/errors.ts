/**
 * AI 错误模型
 *
 * 旧版把所有失败都塞进一个 Error(message)，靠正则去猜是哪种问题，
 * 判定逻辑还写在 UI 函数 aiHint() 里 —— 想复用就得先把 DOM 拖进来。
 *
 * 现在错误自带 code，谁都能判断，翻译成中文只是最后一层皮。
 */

export type AiErrorCode =
  | 'unknown-provider'
  | 'no-base-url'
  | 'no-model'
  | 'no-api-key'
  | 'http'
  | 'empty'
  | 'network'
  | 'timeout';

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** 仅 code === 'http' 时有值 */
  readonly status: number | undefined;

  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }

  /** 认证类失败：Key 无效或无权限。上层据此撤销「已接入」状态。 */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** 把任意异常收口成 AiError（网络层抛的是 TypeError，没有 code）。 */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const e = err as { name?: string; message?: string };
  if (e && (e.name === 'AbortError' || /abort/i.test(e.message ?? ''))) {
    return new AiError('timeout', '请求超时');
  }
  const msg = e?.message ?? String(err);
  if (/Failed to fetch|NetworkError|load failed|ERR_/i.test(msg)) {
    return new AiError('network', msg);
  }
  return new AiError('network', msg);
}

/**
 * 把错误翻成用户能看懂的一句话，并给出该动哪。
 * 这是旧版 aiHint() 的直系后代，行为保持一致。
 */
export function explainAiError(err: unknown): string {
  const e = toAiError(err);
  switch (e.code) {
    case 'no-api-key':
      return '这个服务商必须填 API Key';
    case 'no-model':
      return '先点「拉取模型列表」选一个，或手填模型名';
    case 'no-base-url':
      return '先填 Base URL，多数服务需要末尾带 /v1';
    case 'timeout':
      return '超过 45 秒没响应，可能是服务没启动或网络不通';
    case 'empty':
      return '模型返回空内容，可能这个模型名不被支持';
    case 'unknown-provider':
      return '服务商标识不认识，请重新选择';
    case 'http':
      if (e.status === 401 || e.status === 403) return 'Key 无效或没有该模型权限';
      if (e.status === 404) return 'Base URL 或模型名不对（多数服务需要末尾 /v1）';
      if (e.status === 429) return '请求太频繁或额度用完了';
      if (e.status !== undefined && e.status >= 500) return '服务端出错，稍后再试';
      return `服务返回 HTTP ${e.status ?? '?'}`;
    case 'network':
      return '连不上：服务没启动 / 地址不对 / 被跨域拦';
  }
}

/** 给状态条用的完整描述：原始信息 + 人话解释 */
export function describeAiFailure(err: unknown): string {
  const e = toAiError(err);
  const hint = explainAiError(e);
  // 底层报错本身已经很啰嗦或就跟解释一样时，不再重复
  if (!e.message || e.message === hint) return hint;
  // 用间隔号分隔，别用全角空格 —— 那个字符在某些字体下会渲染成一个怪符号
  return `${e.message} · ${hint}`;
}
