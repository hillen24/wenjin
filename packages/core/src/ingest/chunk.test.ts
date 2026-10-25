/**
 * 文献分段的单测。
 *
 * 分段是容灾的第一层：切坏了（段太大撑爆窗口 / 段太碎烧请求），
 * 后面全乱。这里把四种切分路径都钉死。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_CHARS, MAX_CHUNKS_PER_JOB, estimateChunks, splitIntoChunks } from './chunk';

describe('splitIntoChunks', () => {
  it('空文本返回空数组', () => {
    expect(splitIntoChunks('')).toEqual([]);
    expect(splitIntoChunks('   \n\n  ')).toEqual([]);
  });

  it('按空行切自然段，段间语义完整', () => {
    // 300 字的段落在 500 上限下各自成块（贪心也合并不了）
    const p1 = '甲'.repeat(300);
    const p2 = '乙'.repeat(300);
    const chunks = splitIntoChunks(`${p1}\n\n${p2}`, 500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toBe(p2);
  });

  it('没有空行的连续排版按单换行切', () => {
    const p1 = '甲'.repeat(300);
    const p2 = '乙'.repeat(300);
    const chunks = splitIntoChunks(`${p1}\n${p2}`, 500);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(p1);
  });

  it('贪心装桶：小段会合并进同一块，减少请求次数', () => {
    const text = Array.from({ length: 10 }, (_, i) => `第${i}小段。`).join('\n\n');
    const chunks = splitIntoChunks(text, 50);
    // 10 段 × 5 字，每块最多 50 字 → 应该合并成一两块，不是 10 块
    expect(chunks.length).toBeLessThan(5);
    expect(chunks.join('').length).toBeGreaterThanOrEqual(text.replace(/\n\n/g, '').length);
  });

  it('超过上限 1.5 倍的自然段按句读硬切', () => {
    const para = '句子一。'.repeat(200); // 800 字，无空行
    const chunks = splitIntoChunks(para, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500);
      // 每段都该在句号处收尾（允许最后一块不满）
      expect(c.endsWith('。') || c.length < 500).toBe(true);
    }
  });

  it('碎尾巴（< 200 字）并进前一块', () => {
    const long = '长'.repeat(400);
    const tail = '短尾巴';
    const chunks = splitIntoChunks(`${long}\n\n${tail}`, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('短尾巴');
  });

  it('CRLF 与首尾空白被规范化', () => {
    const chunks = splitIntoChunks('\r\n\r\n  第一段。  \r\n\r\n  第二段。  \r\n\r\n', 1000);
    expect(chunks).toEqual(['第一段。\n第二段。']);
  });

  it('maxChars 有下限保护，传 0 也不会按字符切碎', () => {
    const chunks = splitIntoChunks('一二三四五六七八九十', 0);
    expect(chunks).toHaveLength(1);
  });
});

describe('estimateChunks', () => {
  it('与 splitIntoChunks 的长度一致', () => {
    const text = Array.from({ length: 30 }, (_, i) => `第${i}段，一些哲学论述内容。`).join('\n\n');
    expect(estimateChunks(text, 200)).toBe(splitIntoChunks(text, 200).length);
  });

  it('整本书级别的文本也能给出可预期的段数', () => {
    const book = Array.from({ length: 2000 }, (_, i) => `第${i}段内容。`).join('\n\n');
    const n = estimateChunks(book);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(MAX_CHUNKS_PER_JOB);
  });

  it('默认段容量是 3000 字', () => {
    expect(DEFAULT_CHUNK_CHARS).toBe(3000);
  });
});
