<script setup lang="ts">
/**
 * 文献研读 · 导入 → 分段提取 → 预览入库
 *
 * 这是软件里的 Agent，不是聊天框：用户把哲学文本丢进来，
 * AI 逐段提炼，产物反哺四个模块（方法论 / 概念星系 / 日常格物 / 论道），
 * 用户预览勾选后才真正落库。
 *
 * 为什么长这样（三个 phase 的来源）：
 *   setup   导入与配置。模块不勾就不提（模型很老实，列了空数组它也编）；
 *           段容量给三档 —— 文本动辄几万字，一次请求塞不下，也撞不穿上下文。
 *   running 逐段进度。每段独立请求 / 独立重试 / 独立记账，一段抽风不拖垮整篇；
 *           可暂停（当前段跑完再停）、可中止（立刻掐断在途请求）、可续跑
 *           （中止或失败后，没跑成的段重新排队，已成功的靠 takenNames 去重）。
 *   preview 按模块预览勾选。重复条目自动取消勾选并标注「已存在」——
 *           确认入库才写 store，一步确认、四处落库（commitStaged 管分发顺序）。
 *
 * 容灾的最后一块在 core：提取产物先落暂存区（wj_ingest_stage_v1），
 * 任务跑到一半关窗口、中止、失败重试，成果都不丢，回来还能预览入库。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  DEFAULT_CHUNK_CHARS,
  MAX_CHUNKS_PER_JOB,
  STAR_EDGES,
  STAR_NODES,
  buildExtractSystem,
  commitStaged,
  estimateChunks,
  splitIntoChunks,
  parseExtractReply,
  IngestJob,
  type CommitReport,
  type IngestModule,
  type JobSnapshot,
  type ParseContext,
  type StagedItem,
} from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';

const core = useCore();
const nav = useNav();

/* ============================================================
 * 阶段与任务持有
 * ============================================================ */

type Phase = 'setup' | 'running' | 'preview';
const phase = ref<Phase>('setup');

/**
 * 文件级持有当前任务。
 *
 * 视图是 v-if 挂载的，切走即销毁；但一次提取动辄跑几分钟，
 * 不能因为用户去星图看了一眼就中断。任务对象比视图活得久，
 * 切回来时接管（卸载时只做优雅暂停，不掐断在途请求）。
 */
let activeJob: IngestJob | null = null;
let offJob: (() => void) | null = null;

const job = ref<IngestJob | null>(null);
const snap = ref<JobSnapshot | null>(null);

/* ============================================================
 * AI 接入状态
 * ============================================================ */

const aiState = ref(core.ai.status);
const offAi = core.ai.subscribe((s) => {
  aiState.value = s;
});
/** 文献提取必须有真模型——预置剧本替不了「读懂一段话」 */
const aiLive = computed(() => aiState.value.state === 'verified');

/* ============================================================
 * 暂存区
 * ============================================================ */

const staged = ref<readonly StagedItem[]>(core.ingestStage.load());
const offStage = core.ingestStage.subscribe((s) => {
  staged.value = s;
});

/* ============================================================
 * setup：导入表单
 * ============================================================ */

const MODULES: readonly { key: IngestModule; label: string; desc: string }[] = [
  { key: 'method', label: '方法论', desc: '可操作的程序：一句话说明 + SOP + 常见误用' },
  { key: 'concept', label: '概念星系', desc: '概念节点 + 概念之间的关系（挂上星图）' },
  { key: 'topic', label: '日常格物', desc: '今晚能复盘的具体问题，自带追问剧本' },
  { key: 'debate', label: '论道', desc: '能拿去和哲学家对辩的问句' },
];

const text = ref('');
const source = ref('');
const picked = ref<Set<IngestModule>>(
  new Set<IngestModule>(['method', 'concept', 'topic', 'debate']),
);
const CHAR_OPTIONS: readonly number[] = [1500, 3000, 5000];
const chunkChars = ref<number>(DEFAULT_CHUNK_CHARS);

const charCount = computed(() => text.value.length);
const estimate = computed(() => estimateChunks(text.value, chunkChars.value));
const tooMany = computed(() => estimate.value > MAX_CHUNKS_PER_JOB);

const canStart = computed(
  () =>
    aiLive.value &&
    text.value.trim().length > 0 &&
    source.value.trim().length > 0 &&
    picked.value.size > 0 &&
    !tooMany.value &&
    !(snap.value?.status === 'running' || snap.value?.status === 'paused'),
);

function toggleModule(key: IngestModule): void {
  const next = new Set(picked.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  picked.value = next;
}

/** 开始按钮旁的提示：缺什么说什么，别让用户对着一颗灰按钮猜 */
const startHint = computed(() => {
  if (!aiLive.value) return '先接通 AI';
  if (!text.value.trim()) return '先导入文本';
  if (!source.value.trim()) return '先填文献标题';
  if (picked.value.size === 0) return '至少勾一个模块';
  if (tooMany.value) return '段数超限';
  return `约 ${estimate.value} 次请求，可随时暂停`;
});

/** 提示词与解析都按固定顺序走，与 buildExtractSystem 的栏目顺序一致 */
function moduleOrder(): IngestModule[] {
  return MODULES.map((m) => m.key).filter((k) => picked.value.has(k));
}

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  const content = await f.text();
  text.value = content;
  // 没填标题就用文件名顶上，省一步输入
  if (!source.value.trim()) source.value = f.name.replace(/\.[^.]+$/, '');
  input.value = '';
}

function onDrop(e: DragEvent): void {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  void f.text().then((content) => {
    text.value = content;
    if (!source.value.trim()) source.value = f.name.replace(/\.[^.]+$/, '');
  });
}

/* ============================================================
 * 跨段去重上下文：每段现场组装，暂存区增量实时可见
 * ============================================================ */

/** 喂给模型的既有概念名（内置 + 自定义 + 本批已暂存），关系端点只能挂这些 */
function conceptNames(): string[] {
  const out = new Set<string>();
  for (const n of STAR_NODES) out.add(n.name);
  for (const n of core.star.load().nodes) out.add(n.name);
  for (const i of staged.value) {
    if (i.module === 'concept') out.add(i.node.name);
  }
  return [...out];
}

function parseCtx(): ParseContext {
  // 名字去重覆盖四个模块：方法名、概念名、格物题题、论题名共用一个命名空间
  const names = new Set<string>();
  for (const n of STAR_NODES) names.add(n.name);
  for (const n of core.star.load().nodes) names.add(n.name);
  for (const i of staged.value) {
    if (i.module !== 'relation') names.add(i.name);
  }
  for (const m of core.methods.load()) names.add(m.name);
  for (const t of core.gewuTopics.load()) names.add(t.title);
  for (const d of core.debateTopics.load()) names.add(d.title);

  const ids = new Set<string>();
  for (const n of STAR_NODES) ids.add(n.id);
  for (const n of core.star.load().nodes) ids.add(n.id);
  for (const i of staged.value) {
    if (i.module !== 'relation') ids.add(i.id);
  }

  const nameToId = new Map<string, string>();
  for (const n of STAR_NODES) nameToId.set(n.name, n.id);
  for (const n of core.star.load().nodes) nameToId.set(n.name, n.id);
  for (const [k, v] of core.ingestStage.conceptNameToId()) nameToId.set(k, v);

  return {
    modules: moduleOrder(),
    takenNames: names,
    existingIds: ids,
    nodeNameToId: nameToId,
    source: source.value.trim(),
  };
}

/* ============================================================
 * running：任务控制
 * ============================================================ */

const running = computed(() => snap.value?.status === 'running');
const paused = computed(() => snap.value?.status === 'paused');
const jobDone = computed(() => snap.value?.status === 'done');
const jobAborted = computed(() => snap.value?.status === 'aborted');
const hasPending = computed(() => snap.value?.chunks.some((c) => c.status !== 'ok') ?? false);

function startJob(): void {
  if (!canStart.value) return;
  const chunks = splitIntoChunks(text.value, chunkChars.value);
  if (chunks.length === 0) return;

  const j = new IngestJob({
    chunks,
    extract: async (chunkText, signal) => {
      const r = await core.ai.chat(
        [
          { role: 'system', content: buildExtractSystem(conceptNames(), moduleOrder()) },
          {
            role: 'user',
            content: `下面是哲学文献《${source.value.trim()}》的一个片段，请按系统指令提炼：\n\n${chunkText}`,
          },
        ],
        // 低温求稳：提炼不是创作，模型撒欢起来每条都得人工返工
        { signal, maxTokens: 4096, temperature: 0.3 },
      );
      if (!r.ok) throw new Error(r.reason === 'not-live' ? 'AI 未接入' : r.reason);
      return r.reply.text;
    },
    parse: (raw) => parseExtractReply(raw, parseCtx()),
    onItems: (items) => {
      core.ingestStage.add(items);
    },
  });

  activeJob = j;
  job.value = j;
  snap.value = j.snapshot;
  offJob?.();
  offJob = j.subscribe(() => {
    snap.value = j.snapshot;
  });
  phase.value = 'running';
  j.start();
}

function togglePause(): void {
  const j = job.value;
  if (!j) return;
  if (running.value) j.pause();
  else if (paused.value) j.resume();
}

function abortJob(): void {
  job.value?.abort();
}

function retryJob(): void {
  job.value?.retryPending();
}

function backToSetup(): void {
  phase.value = 'setup';
}

function goPreview(): void {
  phase.value = 'preview';
}

/* ============================================================
 * preview：勾选与入库
 * ============================================================ */

const keyOf = (i: StagedItem): string => `${i.module}:${i.id}`;

/** 反选集合：默认全选，重复/已存在的自动进这里 */
const unpicked = ref<ReadonlySet<string>>(new Set<string>());

/** 这条在目标库里是不是已经有了。是就自动取消勾选——选了也白选 */
function dupReason(item: StagedItem): string {
  switch (item.module) {
    case 'method':
      return core.methods.load().some((e) => e.id === item.id || e.name === item.name)
        ? '方法论库已有'
        : '';
    case 'concept': {
      const n = item.node;
      const hit =
        STAR_NODES.some((x) => x.id === n.id || x.name === n.name) ||
        core.star.load().nodes.some((x) => x.id === n.id || x.name === n.name);
      return hit ? '星图已有' : '';
    }
    case 'relation': {
      const [from, to] = item.edge;
      const seen = (edges: readonly (readonly [string, string, string, string])[]): boolean =>
        edges.some((e) => e[0] === from && e[1] === to);
      return seen(STAR_EDGES) || seen(core.star.load().edges) ? '星图已有同向连线' : '';
    }
    case 'topic':
      return core.gewuTopics.load().some((t) => t.id === item.id || t.title === item.name)
        ? '格物题已有'
        : '';
    case 'debate':
      return core.debateTopics.load().some((d) => d.id === item.id || d.title === item.name)
        ? '论题已有'
        : '';
  }
}

// 暂存区一变就重算重复标记：新提取的、入库后剩下的，都当场标出来
watch(
  staged,
  (list) => {
    const next = new Set(unpicked.value);
    for (const i of list) {
      if (dupReason(i)) next.add(keyOf(i));
    }
    unpicked.value = next;
  },
  { immediate: true },
);

const isChecked = (i: StagedItem): boolean => !unpicked.value.has(keyOf(i));
const pickedCount = computed(() => staged.value.filter(isChecked).length);

function toggle(item: StagedItem): void {
  const next = new Set(unpicked.value);
  const k = keyOf(item);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  unpicked.value = next;
}

function selectAll(): void {
  unpicked.value = new Set<string>();
}

function selectNone(): void {
  unpicked.value = new Set(staged.value.map(keyOf));
}

/** 从暂存区移除单条（删错了不心疼，重新导入还能再提炼） */
function dropItem(item: StagedItem): void {
  core.ingestStage.remove(item.module, item.id);
}

const FILTERS: readonly { key: 'all' | StagedItem['module']; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'method', label: '方法论' },
  { key: 'concept', label: '概念' },
  { key: 'relation', label: '关系' },
  { key: 'topic', label: '格物题' },
  { key: 'debate', label: '论题' },
];
const filter = ref<'all' | StagedItem['module']>('all');
const visible = computed(() =>
  filter.value === 'all' ? staged.value : staged.value.filter((i) => i.module === filter.value),
);
const filterCount = (key: 'all' | StagedItem['module']): number =>
  key === 'all' ? staged.value.length : staged.value.filter((i) => i.module === key).length;

const report = ref<CommitReport | null>(null);

function commit(): void {
  const pickedItems = staged.value.filter(isChecked);
  if (pickedItems.length === 0) {
    nav.toast('没有勾选任何条目');
    return;
  }
  const r = commitStaged(
    pickedItems,
    {
      methods: core.methods,
      star: core.star,
      topics: core.gewuTopics,
      debates: core.debateTopics,
    },
    { nodes: STAR_NODES, edges: STAR_EDGES },
  );
  // 入库的（和被挡下的）都从暂存区撤下——暂存区是停机坪，不是仓库
  for (const i of pickedItems) core.ingestStage.remove(i.module, i.id);
  report.value = r;
  nav.toast(
    `已入库 · 概念 ${r.concepts} · 关系 ${r.relations} · 方法 ${r.methods} · 格物题 ${r.topics} · 论题 ${r.debates}`,
  );
}

/** 清空暂存区要按两次：第一次只是把按钮 armed 起来，3 秒内再按才真删 */
const clearArmed = ref(false);
let clearTimer = 0;

function clearStage(): void {
  if (!clearArmed.value) {
    clearArmed.value = true;
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearArmed.value = false;
    }, 3000);
    return;
  }
  window.clearTimeout(clearTimer);
  clearArmed.value = false;
  core.ingestStage.clear();
  unpicked.value = new Set<string>();
  nav.toast('暂存区已清空');
}

/* ============================================================
 * 展示辅助
 * ============================================================ */

/** 列表里每条的第二行说明 */
function detailOf(item: StagedItem): string {
  switch (item.module) {
    case 'method':
      return `${item.entry.one}（${item.entry.sop.length} 步）`;
    case 'concept':
      return item.node.brief;
    case 'relation':
      return item.edge[3] || `关系：${item.edge[2]}`;
    case 'topic':
      return item.topic.question;
    case 'debate':
      return item.debate.phil ? `${item.debate.phil} · ${item.debate.question}` : item.debate.question;
  }
}

/** 每条产物的出处（文献标题）。关系是派生的，没有独立出处 */
function srcOf(item: StagedItem): string {
  switch (item.module) {
    case 'method':
      return item.entry.src;
    case 'concept':
      return item.node.src;
    case 'relation':
      return '';
    case 'topic':
      return item.topic.src;
    case 'debate':
      return item.debate.src;
  }
}

const statusLabel: Record<string, string> = {
  pending: '待跑',
  running: '提取中',
  ok: '完成',
  failed: '失败',
};

const chunkSummary = computed(() => {
  const s = snap.value;
  if (!s) return '';
  const done = s.ok + s.failed;
  return `${done}/${s.total} 段 · 成功 ${s.ok} · 失败 ${s.failed}`;
});

/* ============================================================
 * 生命周期：接管跨视图存活的任务
 * ============================================================ */

onMounted(() => {
  const j = activeJob;
  if (!j) return;
  job.value = j;
  snap.value = j.snapshot;
  offJob = j.subscribe(() => {
    snap.value = j.snapshot;
  });
  const st = j.snapshot.status;
  if (st === 'running' || st === 'paused' || st === 'aborted') phase.value = 'running';
  else if (staged.value.length > 0) phase.value = 'preview';
});

onBeforeUnmount(() => {
  offAi();
  offStage();
  offJob?.();
  offJob = null;
  // 任务比视图活得久：只优雅暂停（当前段跑完再停），不掐断在途请求
  if (job.value?.snapshot.status === 'running') job.value.pause();
});
</script>

<template>
  <div class="ingest">
    <div class="hint">
      导入哲学文本，AI <b>分段提炼</b>后反哺四个模块 · 一段失败不拖垮整篇 · 产物先进暂存区，<b>预览勾选后才入库</b>
    </div>

    <!-- ======================= ① 导入与配置 ======================= -->
    <template v-if="phase === 'setup'">
      <div class="body">
        <div v-if="!aiLive" class="gate">
          <Icon name="i-warn" :size="16" />
          <div class="gate-txt">
            <b>文献分析需要接通 AI</b>
            <span>到「设置 → AI 服务」填好 Base URL 和 API Key 并通过验证，再回来导入。</span>
          </div>
          <button type="button" class="btn sm" @click="nav.go('set')">去设置</button>
        </div>

        <section class="card">
          <h4>1 · 导入文本</h4>
          <input
            id="ingest-file"
            type="file"
            accept=".txt,.md,.markdown,text/plain"
            class="file-input"
            @change="onFile"
          />
          <div class="src-row">
            <input v-model="source" type="text" placeholder="文献标题（写进每条产物的出处）" />
            <label for="ingest-file" class="btn ghost sm file-btn">
              <Icon name="i-upload" :size="14" /> 选择文件
            </label>
          </div>
          <textarea
            v-model="text"
            class="ta"
            rows="9"
            placeholder="把哲学文本粘到这里，或把 .txt / .md 文件拖进来……"
            @drop.prevent="onDrop"
            @dragover.prevent
          />
          <div class="ta-foot">
            <span>已导入 {{ charCount }} 字</span>
            <span v-if="charCount > 0">约 {{ estimate }} 段 · 每段 {{ chunkChars }} 字</span>
          </div>
        </section>

        <section class="card">
          <h4>2 · 提炼哪些模块</h4>
          <div class="mods">
            <label v-for="m in MODULES" :key="m.key" class="mod" :class="{ on: picked.has(m.key) }">
              <input type="checkbox" :checked="picked.has(m.key)" @change="toggleModule(m.key)" />
              <span class="mod-txt">
                <b>{{ m.label }}</b>
                <small>{{ m.desc }}</small>
              </span>
            </label>
          </div>
        </section>

        <section class="card">
          <h4>3 · 每段容量</h4>
          <div class="caps">
            <button
              v-for="c in CHAR_OPTIONS"
              :key="c"
              type="button"
              class="cap"
              :class="{ on: chunkChars === c }"
              @click="chunkChars = c"
            >
              {{ c }} 字
            </button>
          </div>
          <p class="note">
            一次请求只喂一段：文本再长也撑不爆 AI 窗口，一段抽风只重跑那一段。
            容量越大段数越少、请求越快，但单段输出容易超限被截断。
          </p>
          <p v-if="tooMany" class="warn-line">
            <Icon name="i-warn" :size="13" /> 预计 {{ estimate }} 段，超过单次任务上限
            {{ MAX_CHUNKS_PER_JOB }} 段。调大每段容量，或分两次导入。
          </p>
        </section>

        <div class="start-row">
          <button type="button" class="btn ochre" :disabled="!canStart" @click="startJob">
            开始分析 →
          </button>
          <span class="note">{{ startHint }}</span>
        </div>
      </div>
    </template>

    <!-- ======================= ② 逐段提取 ======================= -->
    <template v-else-if="phase === 'running'">
      <div class="body">
        <section class="card run-head">
          <div class="run-title">
            <h4>{{ source || '文献提取' }}</h4>
            <span class="run-sub">{{ chunkSummary }}</span>
          </div>
          <div class="bar"><i :style="{ width: `${snap ? ((snap.ok + snap.failed) / snap.total) * 100 : 0}%` }" /></div>
          <div class="run-ctrls">
            <button v-if="!jobDone && !jobAborted" type="button" class="btn sm" @click="togglePause">
              {{ running ? '暂停' : '继续' }}
            </button>
            <button v-if="!jobDone && !jobAborted" type="button" class="btn ghost sm" @click="abortJob">
              中止
            </button>
            <button v-if="hasPending && (jobAborted || jobDone || paused)" type="button" class="btn sm" @click="retryJob">
              续跑未完成段
            </button>
            <button type="button" class="btn ghost sm" @click="goPreview">
              去预览入库<template v-if="staged.length">（暂存 {{ staged.length }} 条）</template>
            </button>
            <button type="button" class="btn ghost sm" @click="backToSetup">重新导入</button>
          </div>
          <p v-if="running" class="note live">
            <Icon name="i-sparkle" :size="13" /> 正在提取第 {{ (snap?.activeIndex ?? 0) + 1 }} 段……
            切走页面任务不中断（自动暂停，回来点继续）
          </p>
          <p v-else-if="paused" class="note">已暂停 · 已提取的成果都在暂存区，随时可以预览入库</p>
          <p v-else-if="jobDone" class="note">
            全部段跑完 · 去预览勾选入库，或重新导入下一篇
          </p>
          <p v-else-if="jobAborted" class="note">已中止 · 已成功的段不重跑，剩下的可以续跑</p>
        </section>

        <section class="card">
          <h4>分段清单</h4>
          <div class="chunks">
            <div v-for="c in snap?.chunks ?? []" :key="c.index" class="chunk" :class="c.status">
              <span class="ci">{{ c.index + 1 }}</span>
              <span class="cbadge" :class="c.status">{{ statusLabel[c.status] }}</span>
              <span class="cprev">{{ c.preview }}…</span>
              <span class="cmeta">
                <template v-if="c.status === 'ok'">
                  {{
                    [
                      c.counts.method ? `方法 ${c.counts.method}` : '',
                      c.counts.concept ? `概念 ${c.counts.concept}` : '',
                      c.counts.topic ? `格物 ${c.counts.topic}` : '',
                      c.counts.debate ? `论题 ${c.counts.debate}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || '这段没有可提炼的'
                  }}
                </template>
                <template v-else-if="c.status === 'failed'">{{ c.error }}</template>
                <template v-else>{{ c.chars }} 字</template>
              </span>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- ======================= ③ 预览与入库 ======================= -->
    <template v-else>
      <div class="body">
        <section class="card">
          <div class="pv-head">
            <h4>暂存区 · {{ staged.length }} 条</h4>
            <span class="note">勾选 {{ pickedCount }} 条入库</span>
          </div>

          <div class="filters">
            <button
              v-for="f in FILTERS"
              :key="f.key"
              type="button"
              class="fbtn"
              :class="{ on: filter === f.key }"
              @click="filter = f.key"
            >
              {{ f.label }} {{ filterCount(f.key) }}
            </button>
          </div>

          <div v-if="staged.length === 0" class="empty">
            暂存区是空的。<br />回到导入页分析一篇文献，提炼出的条目会先停在这里。
          </div>

          <div v-else class="items">
            <label v-for="i in visible" :key="keyOf(i)" class="item" :class="{ off: !isChecked(i) }">
              <input type="checkbox" :checked="isChecked(i)" @change="toggle(i)" />
              <span class="itxt">
                <span class="iline">
                  <b>{{ i.name }}</b>
                  <span class="tag" :class="i.module">{{ i.module }}</span>
                  <span v-if="dupReason(i)" class="dup">{{ dupReason(i) }} · 已取消勾选</span>
                </span>
                <span class="idet">{{ detailOf(i) }}</span>
                <span class="isrc">出处：{{ srcOf(i) }}</span>
              </span>
              <button type="button" class="idel" title="从暂存区移除" @click.prevent="dropItem(i)">
                <Icon name="i-close" :size="13" />
              </button>
            </label>
          </div>

          <div v-if="staged.length" class="pv-ctrls">
            <button type="button" class="btn ghost sm" @click="selectAll">全选</button>
            <button type="button" class="btn ghost sm" @click="selectNone">全不选</button>
            <span class="grow" />
            <button type="button" class="btn ghost sm" :class="{ armed: clearArmed }" @click="clearStage">
              {{ clearArmed ? '再点一次确认清空' : '清空暂存区' }}
            </button>
            <button type="button" class="btn ochre" :disabled="pickedCount === 0" @click="commit">
              确认入库（{{ pickedCount }}）
            </button>
          </div>
        </section>

        <section v-if="report" class="card report">
          <h4>上次入库</h4>
          <p class="note">
            概念 {{ report.concepts }} · 关系 {{ report.relations }} · 方法 {{ report.methods }} ·
            格物题 {{ report.topics }} · 论题 {{ report.debates }} · 跳过 {{ report.skipped }}
          </p>
          <div v-if="report.warnings.length" class="warns">
            <div v-for="(w, i) in report.warnings" :key="i" class="warn-line">
              <Icon name="i-warn" :size="13" /> {{ w }}
            </div>
          </div>
        </section>

        <div class="start-row">
          <button type="button" class="btn ghost sm" @click="backToSetup">← 再导入一篇</button>
          <span class="note">入库后到「概念星系 / 方法论库 / 日常格物 / 论道」查看新内容</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ingest {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 26px 36px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 860px;
}

/* ---------- 卡片 ---------- */

.card {
  padding: 16px 18px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--card);
}

.card h4 {
  margin: 0 0 12px;
  font-size: 13.5px;
  font-weight: 550;
  color: var(--ink);
}

.note {
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink3);
}

.grow {
  flex: 1;
}

/* ---------- AI 未接入引导 ---------- */

.gate {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 15px;
  border-radius: var(--radius);
  border: 1px solid var(--ochre-soft);
  background: var(--ochre-soft);
  color: var(--ochre);
}

.gate svg {
  flex: none;
}

.gate-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gate-txt b {
  font-size: 13px;
}

.gate-txt span {
  font-size: 12px;
  color: var(--ink2);
  line-height: 1.6;
}

/* ---------- 导入 ---------- */

.file-input {
  display: none;
}

.src-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.src-row input {
  flex: 1;
  min-width: 0;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--line);
  font-size: 13px;
  outline: none;
  transition: border-color 0.16s;
}

.src-row input:focus {
  border-color: var(--accent);
}

.file-btn {
  cursor: pointer;
}

.ta {
  width: 100%;
  box-sizing: border-box;
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink);
  resize: vertical;
  outline: none;
  transition: border-color 0.16s;
  font-family: inherit;
}

.ta:focus {
  border-color: var(--accent);
}

.ta::placeholder {
  color: var(--ink3);
}

.ta-foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 7px;
  font-size: 11.5px;
  color: var(--ink3);
}

/* ---------- 模块勾选 ---------- */

.mods {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
}

.mod {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--field);
  cursor: pointer;
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}

.mod:hover {
  border-color: var(--line-hi);
}

.mod.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.mod input {
  margin-top: 2px;
  accent-color: var(--accent);
}

.mod-txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mod-txt b {
  font-size: 13px;
  font-weight: 550;
  color: var(--ink);
}

.mod-txt small {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink3);
}

/* ---------- 段容量 ---------- */

.caps {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.cap {
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--field);
  font-size: 12.5px;
  color: var(--ink2);
  transition: border-color 0.16s var(--ease), background 0.16s var(--ease);
}

.cap:hover {
  border-color: var(--line-hi);
}

.cap.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.warn-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ochre);
}

.warn-line svg {
  flex: none;
}

/* ---------- 开始行 ---------- */

.start-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* ---------- running ---------- */

.run-head .run-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}

.run-head h4 {
  margin: 0;
}

.run-sub {
  font-size: 12px;
  color: var(--ink3);
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 5px;
  margin: 10px 0 12px;
  border-radius: 999px;
  background: var(--field-2);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.3s var(--ease);
}

.run-ctrls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.note.live {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
}

.note.live svg {
  flex: none;
}

.chunks {
  max-height: 380px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.chunk {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 11px;
  border-radius: var(--radius-xs);
  background: var(--field);
  border: 1px solid transparent;
  font-size: 12px;
}

.chunk.ok {
  border-color: var(--jade-soft);
}

.chunk.failed {
  border-color: var(--ochre-soft);
}

.chunk.running {
  border-color: var(--accent);
}

.ci {
  flex: none;
  width: 22px;
  font-variant-numeric: tabular-nums;
  color: var(--ink3);
}

.cbadge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  background: var(--field-2);
  color: var(--ink3);
}

.cbadge.ok {
  background: var(--jade-soft);
  color: var(--jade);
}

.cbadge.failed {
  background: var(--ochre-soft);
  color: var(--ochre);
}

.cbadge.running {
  background: var(--accent-soft);
  color: var(--accent);
}

.cprev {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink2);
}

.cmeta {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink3);
  font-size: 11.5px;
}

/* ---------- preview ---------- */

.pv-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.pv-head h4 {
  margin: 0;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.fbtn {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--field);
  font-size: 11.5px;
  color: var(--ink2);
  transition: border-color 0.16s var(--ease), color 0.16s var(--ease);
}

.fbtn.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.empty {
  padding: 22px 0;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--ink3);
}

.items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
}

.item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--field);
  cursor: pointer;
  transition: border-color 0.16s var(--ease), opacity 0.16s var(--ease);
}

.item:hover {
  border-color: var(--line-hi);
}

.item.off {
  opacity: 0.55;
}

.item input {
  margin-top: 3px;
  accent-color: var(--accent);
}

.itxt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.iline {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.iline b {
  font-size: 13px;
  font-weight: 550;
  color: var(--ink);
}

.tag {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  background: var(--field-2);
  color: var(--ink3);
}

.tag.method {
  background: var(--accent-soft);
  color: var(--accent);
}

.tag.concept {
  background: var(--jade-soft);
  color: var(--jade);
}

.tag.topic {
  background: var(--steel-soft, rgba(125, 167, 217, 0.16));
  color: var(--steel);
}

.dup {
  font-size: 10.5px;
  color: var(--ochre);
}

.idet {
  font-size: 12px;
  line-height: 1.65;
  color: var(--ink2);
}

.isrc {
  font-size: 10.5px;
  color: var(--ink3);
}

.idel {
  flex: none;
  padding: 4px;
  border-radius: 6px;
  color: var(--ink3);
  transition: color 0.16s var(--ease), background 0.16s var(--ease);
}

.idel:hover {
  color: var(--ochre);
  background: var(--ochre-soft);
}

.pv-ctrls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.btn.armed {
  border-color: var(--ochre);
  color: var(--ochre);
}

/* ---------- 入库报告 ---------- */

.report .warns {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.report .warn-line {
  margin: 0;
}

/* ============================================================
 * 窄屏（手机）
 * ============================================================ */

@media (max-width: 760px) {
  .body {
    padding: 12px 14px 28px;
    gap: 10px;
  }

  .mods {
    grid-template-columns: minmax(0, 1fr);
  }

  .chunks {
    max-height: 300px;
  }

  .cmeta {
    display: none;
  }

  .items {
    max-height: none;
  }

  .src-row {
    flex-wrap: wrap;
  }
}
</style>
