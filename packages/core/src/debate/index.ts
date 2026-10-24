/**
 * 论道会话
 *
 * 每个哲学家一条独立的对话线，来回切换不串台。
 * 旧版 debateHistory 也是按 id 分键的，这部分设计是对的，照搬。
 *
 * 唯一的改动：把它从全局 let 收进对象，并明确「什么时候可以存进哲学书」——
 * 旧版这个判断散在视图里（h.length>=2），现在归会话自己。
 */

import type { DebateLine, DebateRecord, Philosopher } from '../types';
import { today } from '../reader';

/** 至少聊两个回合才值得存档。一个来回太薄，撑不起「一场论道」。 */
export const MIN_SAVE_LINES = 2;

export class DebateSession {
  philId = 'socrates';
  private readonly histories: Record<string, DebateLine[]> = {};
  /** AI 正在思考（视图用来画打字气泡） */
  thinking = false;

  constructor(private readonly philosophers: readonly Philosopher[]) {}

  get phil(): Philosopher | undefined {
    return this.philosophers.find((p) => p.id === this.philId);
  }

  open(id: string): Philosopher | undefined {
    this.philId = id;
    return this.phil;
  }

  lines(): readonly DebateLine[] {
    return this.histories[this.philId] ?? [];
  }

  push(line: DebateLine): readonly DebateLine[] {
    const list = (this.histories[this.philId] = this.histories[this.philId] ?? []);
    list.push(line);
    return list;
  }

  clear(): void {
    this.histories[this.philId] = [];
  }

  get canSave(): boolean {
    return this.lines().length >= MIN_SAVE_LINES;
  }

  /** 转成可沉淀的记录。不够两回合返回 null。 */
  toRecord(): DebateRecord | null {
    if (!this.canSave) return null;
    const p = this.phil;
    if (!p) return null;
    const firstMe = this.lines().find((m) => m.who === 'me');
    return {
      date: today(),
      phil: p.name,
      title: firstMe ? firstMe.text : `与${p.name}论道`,
      lines: [...this.lines()],
    };
  }

  /**
   * 离线回复：关键词命中预置问答，否则兜底。
   *
   * 这是「简单反射」本射。它存在的意义不是替代模型，
   * 而是保证断网时这个功能还有反应 —— 但 UI 上必须让用户知道自己在看预置内容。
   */
  mockReply(text: string): string {
    const p = this.phil;
    if (!p) return '……';
    const hit = p.qa.find((x) => x.k.some((k) => text.includes(k)));
    return hit ? hit.a : p.fb;
  }
}
