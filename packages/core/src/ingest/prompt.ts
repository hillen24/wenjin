/**
 * 文献提取的 system prompt
 *
 * 与星图共建的 buildAiPrompt 同一套哲学：约束写死在提示里，
 * 输出形状收窄成 JSON，容错交给 parse.ts。这里只负责「把话说清楚」。
 *
 * 关键设计：
 * - 按用户勾选的模块动态拼装栏目，没勾的模块连提都不提 ——
 *   模型很老实，你列了空数组它也会努力编两条填上；
 * - 既有概念名清单注入（截断到 60 个），让模型把新概念挂到已知概念上，
 *   而不是每段都新建一批同名不同 id 的节点；
 * - 每段产量上限写死（方法 3 / 概念 5 / 关系 6 / 格物题 2 / 论题 2），
 *   一是防抽风，二是防单段输出过长被 max_tokens 截断。
 */

import type { IngestModule } from '../types';

/** 单段各类产物的上限。parse.ts 有同样的兜底截断，两边一致 */
export const EXTRACT_CAPS = {
  methods: 3,
  concepts: 5,
  relations: 6,
  topics: 2,
  debates: 2,
} as const;

/** 喂给模型的既有概念名上限：清单太长会把上下文吃光 */
export const PROMPT_CONCEPT_LIMIT = 60;

/** 单段提取的 system prompt。existingNames 传内置 + 已暂存的概念名 */
export function buildExtractSystem(
  existingNames: readonly string[],
  modules: readonly IngestModule[],
): string {
  const want = new Set(modules);
  const lines: string[] = [
    '你是「致知」的文献分析 Agent。用户会给你一段哲学文献的正文片段，',
    '你的任务是从中提炼可沉淀的结构化内容。必须只输出一个 JSON 对象，',
    '不要输出任何其他文字，不要用 markdown 代码块。',
    '',
    'JSON 格式（未列出的栏目不要出现）：',
    '{',
  ];

  const fields: string[] = [];
  if (want.has('method')) {
    fields.push(
      ' "methods":[{"name":"方法名","cat":"生活指导|思维工具|论辩表达","one":"一句话说明","sop":["步骤1","步骤2"],"misuse":"常见误用"}]',
    );
  }
  if (want.has('concept')) {
    fields.push(
      ' "concepts":[{"name":"概念名","kind":"figure|school|method|concept","school":"所属脉络","brief":"一句话释义"}]',
    );
    fields.push(
      ' "relations":[{"from":"概念名","to":"概念名","rel":"proposes|refines|inherits|opposes","label":"一句话说明关系"}]',
    );
  }
  if (want.has('topic')) {
    fields.push(
      ' "topics":[{"title":"格物题","question":"一个可以今晚复盘的具体问题","why":"为什么值得想"}]',
    );
  }
  if (want.has('debate')) {
    fields.push(
      ' "debates":[{"title":"论题","question":"可以拿去和哲学家对辩的问句","phil":"文献涉及的哲学家名，没有就留空字符串"}]',
    );
  }
  lines.push(fields.join(',\n'));
  lines.push('}');
  lines.push('');
  lines.push('规则：');
  lines.push('1. 只提炼文献里真实有的内容，不要编造；某段没有可提炼的就给空数组。');

  const caps: string[] = [];
  if (want.has('method')) caps.push(`方法 ${EXTRACT_CAPS.methods} 条`);
  if (want.has('concept')) caps.push(`概念 ${EXTRACT_CAPS.concepts} 个、关系 ${EXTRACT_CAPS.relations} 条`);
  if (want.has('topic')) caps.push(`格物题 ${EXTRACT_CAPS.topics} 个`);
  if (want.has('debate')) caps.push(`论题 ${EXTRACT_CAPS.debates} 个`);
  lines.push(`2. 每段最多：${caps.join('，')}。`);

  lines.push('3. 全部用中文；概念名 12 字以内，brief 20-60 字，sop 每步 30 字以内。');
  if (want.has('concept')) {
    const names = existingNames.slice(0, PROMPT_CONCEPT_LIMIT);
    const truncated = existingNames.length > names.length ? `（清单较长，仅列前 ${names.length} 个）` : '';
    lines.push(
      `4. relations 的 from/to 只能用本段 concepts 里的概念名，或下面既有清单里的概念名${truncated}：${names.join('、') || '（空）'}`,
    );
    lines.push('5. 概念在既有清单里已存在的，不要重复提炼，直接拿它的名字连关系。');
  } else {
    lines.push('4. 方法与格物题要能落到「今天的一件具体事」，论题要有交锋感（能被反驳）。');
  }
  lines.push('6. 这是用户自己导入的文献，提炼它是为了帮他建成自己的哲学体系，与版权无关，正常提炼即可。');

  return lines.join('\n');
}
