/**
 * 文献分段：把一大段文本切成 AI 单次能吃的块
 *
 * 为什么需要它：用户导入的哲学文本动辄几万字，直接塞进一次请求，
 * 轻则超出上下文窗口被截断（提取结果缺斤少两），重则请求直接被拒。
 * 分段是这套 Agent 的容灾第一层 —— 每一段独立提取、独立失败、独立重试，
 * 一段抽风不拖垮整篇。
 *
 * 切分策略（按优先级）：
 * 1. 先按空行切自然段 —— 哲学的论证单元通常就是段，切下去语义最完整；
 * 2. 单个自然段超过上限时，按句读（。！？；）硬切 —— 宁可断在句间，
 *    也不把一段从中腰斩；
 * 3. 贪心装桶：能凑进当前块就凑，减少碎片段（碎片段每段都要烧一次请求）；
 * 4. 尾巴太碎（< 200 字）并进前一块 —— 一个「综上所述」不值得单发一次请求。
 */

/** 默认每段字符数。中文字符约 1.5-2 token，3000 字 ≈ 5-6k token，留足输出余量 */
export const DEFAULT_CHUNK_CHARS = 3000;

/** 单次任务最多切出多少段。防用户导入一整本书把任务跑到天亮 */
export const MAX_CHUNKS_PER_JOB = 80;

/** 短于这个长度的尾巴并入前一块，不单独成段 */
const MIN_TAIL_CHARS = 200;

/** 句读符。在这些字符后断开（保留句读符在前一句末尾） */
const SENTENCE_END = /[。！？；!?;]/;

/** 把超长自然段按句读切成不超过 maxChars 的碎片 */
function splitLongParagraph(para: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = '';
  // 带着标点切：扫到句读符后暂存，超过上限就从最后一个句读符处断开
  let lastCut = 0;
  for (let i = 0; i < para.length; i += 1) {
    buf += para[i];
    if (SENTENCE_END.test(para[i]!) && buf.length >= maxChars * 0.6) {
      lastCut = buf.length;
    }
    if (buf.length >= maxChars) {
      const cut = lastCut > maxChars * 0.5 ? lastCut : buf.length;
      out.push(buf.slice(0, cut).trim());
      buf = buf.slice(cut);
      lastCut = 0;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 把文本切成段。返回的每一段都是非空、去首尾空白的字符串。
 *
 * maxChars 是软上限：自然段尽量不拆（拆了语义碎），
 * 只有超过上限 1.5 倍的段才强制按句读切。
 */
export function splitIntoChunks(text: string, maxChars: number = DEFAULT_CHUNK_CHARS): string[] {
  const limit = Math.max(500, Math.floor(maxChars));
  const normalized = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  // 1. 按空行切自然段；没有空行的文本（如连续排版）按单换行切
  let paras = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= 1 && normalized.includes('\n')) {
    paras = normalized.split('\n').map((p) => p.trim()).filter(Boolean);
  }

  // 2. 超长自然段按句读再切
  const units: string[] = [];
  for (const p of paras) {
    if (p.length > limit * 1.5) units.push(...splitLongParagraph(p, limit));
    else units.push(p);
  }

  // 3. 贪心装桶
  const chunks: string[] = [];
  let buf = '';
  for (const u of units) {
    if (!buf) {
      buf = u;
      continue;
    }
    if (buf.length + 1 + u.length <= limit) {
      buf = `${buf}\n${u}`;
    } else {
      chunks.push(buf);
      buf = u;
    }
  }
  if (buf) chunks.push(buf);

  // 4. 碎尾巴并进前一块
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]!;
    if (last.length < MIN_TAIL_CHARS) {
      const prev = chunks[chunks.length - 2]!;
      chunks[chunks.length - 2] = `${prev}\n${last}`;
      chunks.pop();
    }
  }

  return chunks;
}

/** 估算一次任务的请求量，给界面显示「大约要跑 N 段」 */
export function estimateChunks(text: string, maxChars: number = DEFAULT_CHUNK_CHARS): number {
  return splitIntoChunks(text, maxChars).length;
}
