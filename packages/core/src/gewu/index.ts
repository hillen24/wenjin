/**
 * 格物会话：晚间复盘的状态机
 *
 * 旧版这套状态是五个散落的全局变量（gwEntry / gwScript / gwStep / gwLastAnswer / litNodes）
 * 加一堆直接改 DOM 的函数。中间任何一个变量没跟上，界面就会卡在奇怪的中间态 ——
 * 比如在 A1 的剧本里看到了 A4 的选项。
 *
 * 这里把「一次格物」做成对象：它自己知道走到第几步、答了什么、二分怎么分的。
 * 视图只负责把状态画出来，不再持有业务状态。
 *
 * AI 调用不在这里（那是异步 + 打字机效果，属于视图的事），
 * 但离线剧本的推进、二分归类、出卡内容是纯逻辑，全在这。
 */

import type { CardText, GewuCardRecord, GewuScript, GewuStep, MethodEntry } from '../types';
import { CARD_LABELS, entryById } from '../data/extras';
import { CARD_TEXTS, GEWU_SCRIPTS } from '../data/gewu';
import { today } from '../reader';

export interface SortItem {
  /** 稳定 id，用作 v-for key */
  readonly key: string;
  readonly text: string;
  side: 'ctrl' | 'un';
}

/**
 * 没有专属剧本的条目，用 SOP 现场拼一个。
 * 这是「11 条方法论里只有 3 条有手写剧本」的兜底，别删。
 */
export function genericScript(e: MethodEntry): GewuScript {
  return [
    {
      t: `今晚用「${e.name}」。${e.one}——今天有什么事，想用它过一遍？`,
      opts: ['工作上的一件烦扰', '人际上的一次摩擦', '自己的一个老毛病'],
    },
    {
      t: `按 SOP 第一步来：${e.sop[0]}。具体到你今天这件事，怎么做？`,
      opts: ['我试着列出来', '卡在第一步', '换个条目试试'],
    },
    {
      t: `当心常见误用：${e.misuse}。到点了，归类，出卡。`,
      end: true,
    },
  ];
}

/** 某条目该用的剧本 */
export function scriptFor(entryId: string): GewuScript {
  const own = GEWU_SCRIPTS[entryId];
  if (own) return own;
  const e = entryById(entryId);
  return e ? genericScript(e) : [];
}

export class GewuSession {
  /** 当前选中的方法论 id */
  entryId = 'A1';

  private steps: GewuScript = [];
  private index = 0;
  private answers: string[] = [];

  /** 二分归类的条目。进入出卡阶段前为空。 */
  sortItems: SortItem[] = [];

  /** 用户自己的回答（不含点选的快捷选项），给 AI 做上下文 */
  get said(): readonly string[] {
    return this.answers;
  }

  get entry(): MethodEntry | undefined {
    return entryById(this.entryId);
  }

  get current(): GewuStep | undefined {
    return this.steps[this.index];
  }

  get stepIndex(): number {
    return this.index;
  }

  get total(): number {
    return this.steps.length;
  }

  get atEnd(): boolean {
    return this.index >= this.steps.length;
  }

  setEntry(id: string): void {
    this.entryId = id;
    this.reset();
  }

  reset(): void {
    this.steps = scriptFor(this.entryId);
    this.index = 0;
    this.answers = [];
    this.sortItems = [];
  }

  /** 开始一次复盘，返回第一个剧本步骤 */
  begin(): GewuStep | undefined {
    this.reset();
    return this.current;
  }

  /** 用户答了一句，推进到下一步。返回下一步（可能为空 = 该出卡了） */
  answer(text: string): GewuStep | undefined {
    if (text) this.answers.push(text);
    this.index++;
    return this.current;
  }

  /**
   * 用预填文案初始化二分归类。
   * 有预填就用预填，没有就给出两个空列 —— 保证界面永远有东西可操作。
   */
  prepareSort(): SortItem[] {
    const t: CardText | undefined = CARD_TEXTS[this.entryId];
    const items: SortItem[] = [
      ...(t?.ctrl ?? []).map((text, i) => ({ key: `c${i}`, text, side: 'ctrl' as const })),
      ...(t?.un ?? []).map((text, i) => ({ key: `u${i}`, text, side: 'un' as const })),
    ];
    this.sortItems = items;
    return items;
  }

  /** 点一下切换归属。返回新数组（Vue 靠新引用触发更新）。 */
  toggle(key: string): SortItem[] {
    this.sortItems = this.sortItems.map((i) =>
      i.key === key ? { ...i, side: i.side === 'ctrl' ? 'un' : 'ctrl' } : i,
    );
    return this.sortItems;
  }

  /** 用户自己加一条到某一列 */
  addItem(text: string, side: 'ctrl' | 'un'): SortItem[] {
    const t = text.trim();
    if (!t) return this.sortItems;
    this.sortItems = [...this.sortItems, { key: `x${Date.now().toString(36)}`, text: t, side }];
    return this.sortItems;
  }

  /**
   * 出卡。
   *
   * 有预填文案就用预填（那是精心写过的话），没有就从对话和 SOP 里拼一份 ——
   * 旧版这种情况直接显示「已记录于追问对话」，等于什么也没给用户。
   */
  buildCard(newLit: readonly string[] = []): GewuCardRecord {
    const e = this.entry;
    const t: CardText | undefined = CARD_TEXTS[this.entryId];

    if (t) {
      return {
        date: today(),
        entry: this.entryId,
        title: t.bother,
        bother: t.bother,
        ctrl: t.ctrl,
        un: t.un,
        practice: t.practice,
        next: t.next,
        lit: [...newLit],
      };
    }

    const bother = this.answers[0] || (e ? `${e.name} · 一次复盘` : '一次复盘');
    return {
      date: today(),
      entry: this.entryId,
      title: bother,
      bother,
      ctrl: this.sortItems.filter((i) => i.side === 'ctrl').map((i) => i.text),
      un: this.sortItems.filter((i) => i.side === 'un').map((i) => i.text),
      practice: e ? `${e.sop[0]}（沿用 ${e.id} 的 SOP）` : '',
      next: e ? e.sop[0] : '把它拆成明天能做完的一步',
      lit: [...newLit],
    };
  }

  /** 卡片上「练习句」那行的标题 */
  get practiceLabel(): string {
    return CARD_LABELS[this.entryId] ?? CARD_LABELS.default;
  }

  /** 本次可新点亮的概念：条目关联的、还没点过的 */
  newLights(lit: readonly string[]): string[] {
    const e = this.entry;
    if (!e) return [];
    return e.lit.filter((id) => !lit.includes(id));
  }
}
