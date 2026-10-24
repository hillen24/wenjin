/**
 * 成书：把散落的沉淀编成一本有章节的书
 *
 * 这是纯函数 —— 给定素材，出结构；不碰 DOM、不碰存储、不碰网络。
 * 旧版这段逻辑混在 renderBook() 里，直接拼 innerHTML 字符串，
 * 于是「书里应该有几章」这个产品决策和 HTML 转义、class 名搅在一起，改不动也测不了。
 *
 * 现在结构归这里，样式归视图。以后想加「第五章 · 我改变过的看法」，
 * 只改这个文件，两个端自动都有。
 */

import type {
  BookChapter,
  BookDraft,
  BookItem,
  BookStage,
  BookSynth,
  Materials,
  MethodEntry,
} from '../types';

/** 成书所需的总素材点数 */
export const BOOK_FULL_SCORE = 40;

/**
 * 素材权重：格物卡 ×2。
 * 理由：一张格物卡是一次完整的「烦扰 → 拆分 → 归位 → 下一步」，
 * 信息密度远高于一次问答，所以它该更值钱。
 */
export function bookScore(m: Materials): number {
  return m.cards.length * 2 + m.debates.length + m.readings.length;
}

export function bookPct(m: Materials): number {
  return Math.min(100, Math.round((bookScore(m) / BOOK_FULL_SCORE) * 100));
}

export function bookStage(pct: number): BookStage {
  if (pct < 20) return '萌芽';
  if (pct < 50) return '小册';
  if (pct < 80) return '逼近成稿';
  return '成书';
}

const DEFAULT_PREFACE =
  '这不是从谁那里抄来的体系，是你自己一次一次复盘、一场一场辩论、一句一句追问，攒出来的。' +
  '苏格拉底说「未经审视的人生不值得过」——这本书，就是审视本身的沉积岩。' +
  'AI 不替你思考，只负责把你散落的思考归拢起来，指给你看。';

/** 用得最多的方法论 id。书末的叮嘱要引用它。 */
export function topEntryId(m: Materials): string | undefined {
  const count: Record<string, number> = {};
  for (const c of m.cards) count[c.entry] = (count[c.entry] ?? 0) + 1;
  return Object.keys(count).sort((a, b) => count[b] - count[a])[0];
}

/** 每条方法论被用了几次，按次数降序 */
export function entryUsage(m: Materials): Array<{ id: string; n: number }> {
  const count: Record<string, number> = {};
  for (const c of m.cards) count[c.entry] = (count[c.entry] ?? 0) + 1;
  return Object.keys(count)
    .sort((a, b) => count[b] - count[a])
    .map((id) => ({ id, n: count[id] }));
}

function defaultCoda(m: Materials, entries: readonly MethodEntry[]): string {
  const top = topEntryId(m);
  const e = entries.find((x) => x.id === top);
  if (!e) return '继续沉淀。方法要用过才算数。';
  return (
    `你反复回到 ${e.id} ${e.name}——它已经是你的「第一方法」。` +
    '下一步：把它的 SOP 用到一件你从未用它过的事上，然后回来记录哪里不灵。' +
    (e.misuse ? `另外，当心它的常见误用：${e.misuse}` : '')
  );
}

/**
 * 编书。
 *
 * synth 是 AI 润色过的序言/叮嘱，为空时用本地版 —— 离线也能出书，
 * 只是绪言少一点「有人读过你」的温度。
 */
export function buildBook(
  m: Materials,
  entries: readonly MethodEntry[],
  synth: BookSynth = {},
): BookDraft {
  const pct = bookPct(m);
  const usage = entryUsage(m);

  const chapters: BookChapter[] = [
    {
      title: '第一章 · 我的烦恼地图',
      hint: '格物卡会在这里画出你的烦恼地形。',
      items: m.cards.map<BookItem>((c) => ({
        tag: c.date,
        text: c.bother || c.title,
      })),
    },
    {
      title: '第二章 · 我在用的方法',
      hint: '用过的格物条目会统计到这里。',
      items: usage.map<BookItem>((u) => {
        const e = entries.find((x) => x.id === u.id);
        return {
          tag: `×${u.n}`,
          text: e ? `${e.name} · ${e.one}` : u.id,
        };
      }),
    },
    {
      title: '第三章 · 我的命题',
      hint: '格物卡里的「练习句」会在这里凝结成你的命题——先从 A1 开始。',
      items: m.cards
        .filter((c) => c.practice)
        .map<BookItem>((c) => ({ tag: c.date, text: c.practice, serif: true })),
    },
    {
      title: '第四章 · 我的疑问与对话',
      hint: '论道和伴读的问答会流到这里。',
      items: [
        ...m.debates.map<BookItem>((d) => ({
          tag: d.date,
          text: `${d.phil} · ${d.title}`,
        })),
        ...m.readings.map<BookItem>((r) => ({
          tag: r.date,
          text: `${r.doc} · ${r.skill}「${r.quote}」`,
        })),
      ],
    },
  ];

  return {
    preface: synth.preface || DEFAULT_PREFACE,
    coda: synth.coda || defaultCoda(m, entries),
    chapters,
    pct,
    stage: bookStage(pct),
    counts: {
      cards: m.cards.length,
      debates: m.debates.length,
      readings: m.readings.length,
    },
  };
}

/** 给 AI 编辑看的素材摘要。只取前 N 条，避免把上下文塞爆。 */
export function digestForEditor(m: Materials, limits = { cards: 12, debates: 6, readings: 6 }): string {
  const cards = m.cards.slice(0, limits.cards);
  const debates = m.debates.slice(0, limits.debates);
  const readings = m.readings.slice(0, limits.readings);

  const lines: string[] = [];
  lines.push('【格物卡】');
  lines.push(...cards.map((x) => `- [${x.entry}] ${x.bother || x.title} → ${x.practice || ''}`));
  lines.push('【论道】');
  lines.push(...debates.map((x) => `- 与${x.phil}聊「${x.title}」`));
  lines.push('【伴读问答】');
  lines.push(...readings.map((x) => `- ${x.skill}「${x.quote}」`));
  return lines.join('\n');
}

/**
 * 从 AI 回复里切出序言与叮嘱。
 *
 * 为什么不用简单的 split：模型常常在【序言】前加一句「好的，以下是两段」，
 * 也可能只给一段。旧版正则没兜住后面这种情况，导致整段被丢弃、书里显示本地版序言，
 * 用户看到的是「梳理完成」但内容没变。
 */
export function parseEditorReply(text: string): BookSynth {
  const t = text.trim();
  const prefaceMatch = t.match(/【序言】([\s\S]*?)(?=【叮嘱】|$)/);
  const codaMatch = t.match(/【叮嘱】([\s\S]*?)$/);

  const preface = prefaceMatch?.[1]?.trim();
  const coda = codaMatch?.[1]?.trim();

  // 两段都没切出来：说明模型没按格式走。整段当序言，至少别白跑一趟。
  if (!preface && !coda) return { preface: t };

  return {
    ...(preface ? { preface } : {}),
    ...(coda ? { coda } : {}),
  };
}

/** 导出 Markdown。旧版直接拼字符串，这里同样，但要保证结构跟屏幕上一一对应。 */
export function bookToMarkdown(draft: BookDraft, date: string): string {
  const out: string[] = [];
  out.push('# 我的哲学书', '');
  out.push(
    `> 由致知 自动梳理 · ${date} · 收录 ${draft.counts.cards} 条格物 / ` +
      `${draft.counts.debates} 场论道 / ${draft.counts.readings} 次伴读问答`,
    '',
  );
  out.push('## 序言 · 这本书怎么来的', '', draft.preface, '');

  draft.chapters.forEach((ch, i) => {
    out.push(`## ${ch.title}`, '');
    if (ch.items.length === 0) {
      out.push(`（${ch.hint}）`, '');
      return;
    }
    ch.items.forEach((it) => {
      // 第三章是命题，用有序列表；其余用无序列表
      const bullet = i === 2 ? '1.' : '-';
      out.push(`${bullet} ${it.tag ? `${it.tag} ` : ''}${it.text}`);
    });
    out.push('');
  });

  out.push('## 尾声 · 叮嘱', '', draft.coda, '');
  return out.join('\n');
}
