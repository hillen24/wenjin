<script setup lang="ts">
/**
 * 概念星系
 *
 * 这里能看清新旧写法的差别：
 * 物理运算全在 @wenjin/core 的纯函数里（已有单测覆盖），
 * 这个文件只负责「把坐标画出来」和「把指针事件翻译成物理参数」。
 *
 * 60fps 的动画刻意不走响应式：每帧直接 setAttribute，
 * 让 Vue 只承担一次性结构渲染。用响应式驱动物理帧会拖垮列表 diff。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  BASE_VIEW,
  RELATION_NAME,
  STAR_EDGES,
  STAR_NODES,
  blindSpots,
  buildAiPrompt,
  initBodies,
  nameToId,
  neighborIds,
  nodeRadius,
  parseAiGraph,
  relatedEdges,
  relayout,
  screenToView,
  step,
  zoomView,
  type CustomGraph,
  type EdgeRelation,
  type NodeKind,
  type StarBody,
  type StarEdge,
  type StarNode,
  type ViewBox,
} from '@wenjin/core';
import { useCore } from '../providers';
import { useNav } from '../nav';

const core = useCore();
const nav = useNav();

/**
 * focus：外部指定的选中节点（从伴读回答、格物卡、方法论卡跳过来时带过来的）。
 * 视图是 v-if 挂载的，所以既要在挂载时接住，也要在已挂载时响应变化。
 */
const props = defineProps<{ focus?: string | null }>();

/* ---------------- 状态 ---------------- */

const view = shallowRef<ViewBox>({ ...BASE_VIEW });

/**
 * 星图共建（3.5.0）：
 * 内置星图仍是只读常量，用户自己加的节点/边存在 core.star（localStorage），
 * 展示时合并 —— 升级内置数据不会踩掉用户加的内容。
 */
const graph = ref<CustomGraph>(core.star.load());

const allNodes = computed<readonly StarNode[]>(() => [...STAR_NODES, ...graph.value.nodes]);
const allEdges = computed<readonly StarEdge[]>(() => [...STAR_EDGES, ...graph.value.edges]);

const customIds = computed(() => new Set(graph.value.nodes.map((n) => n.id)));

const bodies = shallowRef<Record<string, StarBody>>(initBodies(allNodes.value, BASE_VIEW));

const selectedId = ref<string | null>(null);
const hoverId = ref<string | null>(null);
/**
 * 已点亮的概念。
 * 旧版这里是写死的七项，点亮后刷新即丢；现在读 core.progress（落 localStorage）。
 */
const litIds = ref<string[]>([...core.progress.lit()]);

const svgEl = ref<SVGSVGElement | null>(null);
const panning = ref(false);

/**
 * 窄屏下侧栏变成底部滑出层，由这个开关控制。
 * 宽屏上它不起作用（CSS 不给 .panel 加位移），所以两端共用一份状态也无害。
 */
const panelOpen = ref(false);

/**
 * 窄屏标签降噪。
 *
 * 星图有 27 个节点，每个都挂着名字。桌面端画布宽、节点散得开，看得清；
 * 手机上一个 390px 宽的画布里塞 27 个名字，必然互相压字——点亮的、没点亮的
 * 全糊成一团。所以窄屏只留「已点亮 / 选中 / 悬停」这三种名字，
 * 其余节点只画点。名字随时可以在点开后的面板里看到，不会丢信息。
 */
const narrow = ref(false);

function syncNarrow(): void {
  const w = svgEl.value?.getBoundingClientRect().width ?? window.innerWidth;
  narrow.value = w > 0 && w < 620;
}

/** DOM 引用。帧循环直接操作它们，不经过虚拟 DOM。 */
const nodeEls = new Map<string, SVGGElement>();
const lineEls = new Map<number, SVGLineElement>();

let raf = 0;

/* ---------------- 派生数据 ---------------- */

const KIND_LABEL: Record<NodeKind, string> = {
  school: '流派',
  figure: '人物',
  method: '方法论',
  concept: '概念',
};

const viewBoxAttr = computed(
  () => `${view.value.x} ${view.value.y} ${view.value.w} ${view.value.h}`,
);

const hoverSet = computed(() =>
  hoverId.value ? neighborIds(allEdges.value, hoverId.value) : null,
);

const selected = computed(() =>
  selectedId.value ? (allNodes.value.find((n) => n.id === selectedId.value) ?? null) : null,
);

const selectedRels = computed(() =>
  selectedId.value ? relatedEdges(allEdges.value, selectedId.value) : [],
);

const blind = computed(() => blindSpots(allNodes.value, litIds.value));

/**
 * 只统计「图里真实存在」的点亮。
 *
 * 删掉一个自定义节点时 litIds 里的记录也会同步清掉，但局域网同步、手工改数据
 * 都可能留下对不上号的 id —— 这里再兜一层，免得 HUD 飘出「已点亮 30 / 28」。
 */
const litCount = computed(
  () => litIds.value.filter((id) => allNodes.value.some((n) => n.id === id)).length,
);

const litPct = computed(() =>
  allNodes.value.length ? Math.round((litCount.value / allNodes.value.length) * 100) : 0,
);

/**
 * 手动表单里「连到」的下拉按脉络分组。
 * 30 多个名字平铺在一个 select 里根本找不着人，分组后至少知道往哪个星区翻。
 */
const groupedNodes = computed(() => {
  const map = new Map<string, StarNode[]>();
  for (const n of allNodes.value) {
    const arr = map.get(n.school) ?? [];
    arr.push(n);
    map.set(n.school, arr);
  }
  return [...map.entries()].map(([school, list]) => ({ school, list }));
});

/* ---------------- 帧循环 ---------------- */

function loop(): void {
  step(bodies.value, allEdges.value, view.value);

  for (const [id, el] of nodeEls) {
    const b = bodies.value[id];
    if (!b) continue;
    el.setAttribute('transform', `translate(${b.x.toFixed(2)},${b.y.toFixed(2)})`);
  }

  for (const [i, el] of lineEls) {
    const edge = allEdges.value[i];
    if (!edge) continue;
    const A = bodies.value[edge[0]];
    const B = bodies.value[edge[1]];
    if (!A || !B) continue;
    el.setAttribute('x1', A.x.toFixed(2));
    el.setAttribute('y1', A.y.toFixed(2));
    el.setAttribute('x2', B.x.toFixed(2));
    el.setAttribute('y2', B.y.toFixed(2));
  }

  raf = requestAnimationFrame(loop);
}

/* ---------------- 坐标换算 ---------------- */

/**
 * 屏幕坐标 → viewBox 坐标。
 *
 * 必须走 getScreenCTM().inverse()：它会一并处理 preserveAspectRatio 造成的
 * letterbox（容器比 viewBox 更"高瘦"时，内容上下留白）。
 * 旧版早期用 (clientY-top)*540/height 硬算，没补偿 letterbox，
 * 结果拖拽时纵向偏移严重失真。
 */
function toViewPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const svg = svgEl.value;
  if (!svg) return { x: 0, y: 0 };
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/* ---------------- 节点拖拽 ---------------- */

let dragId: string | null = null;
let dragMoved = false;

function onNodeDown(e: PointerEvent, id: string): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const target = e.currentTarget as Element | null;
  try {
    target?.setPointerCapture(e.pointerId);
  } catch {
    /* 某些环境不支持捕获，忽略即可，拖拽仍能工作 */
  }

  dragId = id;
  dragMoved = false;

  const pt = toViewPoint(e);
  const b = bodies.value[id];
  if (b) {
    b.fx = pt.x;
    b.fy = pt.y;
  }
}

function onNodeMove(e: PointerEvent, id: string): void {
  if (dragId !== id) return;
  dragMoved = true;
  const pt = toViewPoint(e);
  const b = bodies.value[id];
  if (b) {
    b.fx = pt.x;
    b.fy = pt.y;
  }
}

function onNodeUp(id: string): void {
  if (dragId !== id) return;
  const b = bodies.value[id];
  if (b) {
    b.fx = null;
    b.fy = null;
  }
  dragId = null;
  // 拖完立刻抬手会误触发 click，留一点冷却
  setTimeout(() => {
    dragMoved = false;
  }, 60);
}

function onNodeClick(id: string): void {
  if (dragMoved) return;
  selectedId.value = id;
  panelOpen.value = true;
}

/* ---------------- 画布平移与缩放 ---------------- */

let panPointerId: number | null = null;
let panOrigin: { x: number; y: number; view: ViewBox } | null = null;

/**
 * 当前按在画布上的所有指针。
 *
 * 手机上没有滚轮，缩放只能靠双指 —— 两根手指落下时立刻放弃平移改走缩放，
 * 否则第一根手指已经把画布拖走一截了。鼠标环境这个表里永远只有一个 id，
 * 所以下面的分支对它完全等价于原来的单指逻辑。
 */
const pointers = new Map<number, { x: number; y: number }>();
let pinchStart: { dist: number; view: ViewBox; cx: number; cy: number } | null = null;

function pinchGeom(): { dist: number; cx: number; cy: number } | null {
  const pts = [...pointers.values()];
  const a = pts[0];
  const b = pts[1];
  if (!a || !b) return null;
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
  };
}

function onCanvasDown(e: PointerEvent): void {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // 第二根手指落下：切到双指缩放，并作废已经开始的平移
  if (pointers.size === 2) {
    const g = pinchGeom();
    if (g) pinchStart = { dist: g.dist, view: { ...view.value }, cx: g.cx, cy: g.cy };
    panPointerId = null;
    panOrigin = null;
    panning.value = false;
    return;
  }

  if (pointers.size > 2) return;

  const target = e.target as Element | null;
  if (target?.closest('g.node')) return;

  try {
    svgEl.value?.setPointerCapture(e.pointerId);
  } catch {
    /* 忽略 */
  }

  panPointerId = e.pointerId;
  panOrigin = { x: e.clientX, y: e.clientY, view: view.value };
  panning.value = true;
}

function onCanvasMove(e: PointerEvent): void {
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  // 双指：按两指间距的变化比例缩放，锚点是两指中点
  if (pinchStart && pointers.size >= 2) {
    const g = pinchGeom();
    if (!g) return;
    // 手指张开 → ratio > 1 → 视野该缩小（即放大），所以取倒数
    const factor = 1 / (g.dist / pinchStart.dist);
    const anchor = toViewPoint({ clientX: pinchStart.cx, clientY: pinchStart.cy });
    view.value = zoomView(pinchStart.view, factor, anchor);
    return;
  }

  if (panPointerId !== e.pointerId || !panOrigin) return;
  const rect = svgEl.value?.getBoundingClientRect();
  if (!rect) return;

  // 屏幕像素 → viewBox 单位。缩放程度不同，同样的手部位移对应的世界距离也不同。
  const dx = screenToView(e.clientX - panOrigin.x, rect.width, panOrigin.view);
  const dy = screenToView(e.clientY - panOrigin.y, rect.width, panOrigin.view);

  view.value = {
    ...panOrigin.view,
    x: panOrigin.view.x - dx,
    y: panOrigin.view.y - dy,
  };
}

function onCanvasUp(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;

  if (panPointerId !== e.pointerId) return;
  panPointerId = null;
  panOrigin = null;
  panning.value = false;
}

function onWheel(e: WheelEvent): void {
  const focus = toViewPoint(e);
  view.value = zoomView(view.value, e.deltaY < 0 ? 0.92 : 1.09, focus);
}

/* ---------------- 操作 ---------------- */

/**
 * 把标准视野按容器适配一遍。
 *
 * BASE_VIEW 是 680×540 的宽屏比例，直接塞进 390px 宽的手机：
 * 节点半径 10 的「概念」直径只剩 11 个 CSS 像素，手指根本点不中。
 * 窄屏下按 0.62 收窄视野（等比，中心对齐），节点视觉尺寸放大到可点。
 */
function fitView(source: ViewBox): ViewBox {
  const rect = svgEl.value?.getBoundingClientRect();
  const narrow = !!rect && rect.width > 0 && rect.width < 620;
  if (!narrow) return { ...source };

  /**
   * k 的取值是被"标签"逼出来的，不是拍脑袋。
   *
   * 节点云直径约 380 个用户单位，加上两侧标签各约 30 单位 ≈ 440 单位要装进
   * 390px 宽。k=0.62 时内容占 407px，最右侧那圈节点的名字会被切掉半个字；
   * k=0.7 时占 360px，左右各留 15px 余量，正好。
   */
  const k = 0.7;
  const w = source.w * k;
  const h = source.h * k;
  return {
    x: source.x + (source.w - w) / 2,
    y: source.y + (source.h - h) / 2,
    w,
    h,
  };
}

function doRelayout(): void {
  relayout(
    bodies.value,
    allNodes.value.map((n) => n.id),
    view.value,
  );
  view.value = fitView(BASE_VIEW);
}

/**
 * 点亮 / 取消点亮。
 *
 * 3.5.1 修：旧版这里只改内存里的 ref，从不落盘 —— 界面上看着点亮了，
 * 刷新一次就回到初始值。真正的写入必须走 core.progress。
 */
function toggleLit(id: string): void {
  if (litIds.value.includes(id)) {
    core.progress.unlight([id]);
    nav.toast('已取消点亮');
  } else {
    core.progress.light([id]);
    nav.toast('已点亮 · 记入你的进度');
  }
}

/* ============================================================
 * 星图共建
 *
 * 两条路进同一个校验漏斗（validateIncoming）：
 * - AI 路：用自然语言描述 → 模型输出 JSON → parseAiGraph 规范化 → 预览 → 入库
 * - 手动路：表单填一个 → 直接入库
 * 模型说错话最多浪费一次生成，污染不进图；用户还能在预览里逐条剔除。
 * ============================================================ */

const builderOpen = ref(false);
const builderMode = ref<'ai' | 'manual'>('ai');
/** 弹窗卡片本身，用来在打开时接住焦点（Esc 才能生效） */
const builderCard = ref<HTMLElement | null>(null);

const aiInput = ref('');
const aiBusy = ref(false);
/** 红字错误（阻断操作） */
const aiError = ref('');
/** 黄字提醒（校验漏斗的 warnings，不阻断） */
const notice = ref<string[]>([]);
const preview = ref<{ nodes: StarNode[]; edges: StarEdge[] } | null>(null);

const aiLive = computed(() => core.ai.isLive());

/**
 * 生成请求代号。
 *
 * 3.5.1 修：AI 请求是异步的，旧版关掉弹窗后返回仍会往 preview 里写，
 * 下次打开就凭空冒出上一次的结果；连点两次「生成预览」也会互相覆盖。
 * 每次发起 +1，回来时对不上号就直接丢弃。
 */
let genToken = 0;

/** 手动表单 */
const emptyForm = (): {
  name: string;
  kind: NodeKind;
  school: string;
  brief: string;
  src: string;
  toId: string;
  rel: EdgeRelation;
  label: string;
} => ({
  name: '',
  kind: 'concept',
  school: '',
  brief: '',
  src: '',
  toId: '',
  rel: 'refines',
  label: '',
});

const form = ref(emptyForm());

/** 清空「我的星区」的二次确认（点一下变成确认按钮，再点才真删） */
const confirmClear = ref(false);

function openBuilder(): void {
  builderOpen.value = true;
  aiError.value = '';
  notice.value = [];
  preview.value = null;
  confirmClear.value = false;
  // 没接 AI 就别让用户对着一个按不动的按钮发呆
  builderMode.value = aiLive.value ? 'ai' : 'manual';
  // 打开即聚焦：AI 页直接落在输入框上，手动页落在卡片上，Esc 才有地方接
  void nextTick().then(() => {
    const el = builderCard.value?.querySelector<HTMLTextAreaElement>('textarea');
    (el ?? builderCard.value)?.focus();
  });
}

/** Esc 关弹窗：键鼠用户最顺手的一下，之前只能去点右上角 */
function onBuilderKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeBuilder();
  }
}

function closeBuilder(): void {
  builderOpen.value = false;
  preview.value = null;
  aiError.value = '';
  notice.value = [];
  aiBusy.value = false;
  confirmClear.value = false;
}

function switchMode(mode: 'ai' | 'manual'): void {
  if (builderMode.value === mode) return;
  builderMode.value = mode;
  // 换路要清掉上一路的产物，否则手动填完切到 AI 会看到手动的预览
  preview.value = null;
  aiError.value = '';
  notice.value = [];
}

function nodeName(id: string): string {
  return allNodes.value.find((n) => n.id === id)?.name ?? id;
}

/** 预览里的边可能连到「还没入库的新节点」，先在本批里找名字，不然会印出一串 u_xxx */
function previewName(id: string): string {
  return preview.value?.nodes.find((n) => n.id === id)?.name ?? nodeName(id);
}

/** AI 生成 → 规范化 → 预览 */
async function generate(): Promise<void> {
  const text = aiInput.value.trim();
  if (!text) {
    aiError.value = '先说说你想加什么';
    return;
  }
  if (!core.ai.isLive()) {
    aiError.value = '还没接入 AI：先去「设置」配好模型，或改用手动填写。';
    return;
  }
  const token = (genToken += 1);
  aiBusy.value = true;
  aiError.value = '';
  notice.value = [];
  preview.value = null;

  const r = await core.ai.chat([
    {
      role: 'system',
      content: buildAiPrompt(allNodes.value.map((n) => ({ id: n.id, name: n.name, kind: n.kind }))),
    },
    { role: 'user', content: text },
  ]);

  // 过期请求：用户已经关了弹窗 / 重新生成过，结果作废
  if (token !== genToken || !builderOpen.value) return;
  aiBusy.value = false;

  if (!r.ok) {
    aiError.value = `模型没回应（${r.reason}）`;
    return;
  }
  const parsed = parseAiGraph(
    r.reply.text,
    new Set(allNodes.value.map((n) => n.id)),
    new Set(allNodes.value.map((n) => n.name)),
    { existingEdges: allEdges.value },
  );
  if (!parsed.ok) {
    aiError.value = `模型输出不合格：${parsed.reason}。换个说法再试一次，或改用手动填写。`;
    return;
  }
  preview.value = { nodes: parsed.nodes, edges: parsed.edges };
  notice.value = parsed.warnings;
}

/** 预览里剔除一个节点（连带它的边） */
function dropPreviewNode(i: number): void {
  const p = preview.value;
  if (!p) return;
  const id = p.nodes[i]?.id;
  if (!id) return;
  p.nodes.splice(i, 1);
  const keep = p.edges.filter(([a, b]) => a !== id && b !== id);
  p.edges.splice(0, p.edges.length, ...keep);
  if (p.nodes.length === 0) preview.value = null;
}

/** 预览里剔除一条边 */
function dropPreviewEdge(i: number): void {
  preview.value?.edges.splice(i, 1);
}

/** 手动表单 → 直接入库（单节点没必要走「生成预览」两步） */
function addManual(): void {
  const name = form.value.name.trim();
  if (!name) {
    aiError.value = '至少要有个名字';
    return;
  }
  if (allNodes.value.some((n) => n.name === name)) {
    aiError.value = `「${name}」已经在星图里了`;
    return;
  }
  aiError.value = '';
  const id = nameToId(name, new Set(allNodes.value.map((n) => n.id)));
  const edges: Array<{ from: string; to: string; rel: EdgeRelation; label: string }> = [];
  if (form.value.toId) {
    edges.push({ from: id, to: form.value.toId, rel: form.value.rel, label: form.value.label.trim() });
  }
  const r = core.star.add(
    {
      nodes: [
        {
          id,
          name,
          kind: form.value.kind,
          school: form.value.school.trim(),
          brief: form.value.brief.trim(),
          src: form.value.src.trim(),
        },
      ],
      edges,
    },
    { nodes: STAR_NODES, edges: STAR_EDGES },
  );
  if (!r.ok) {
    aiError.value = r.reason;
    return;
  }
  // 实际入库的边数可能少于填的（与已有关系重复会被拦），按落盘结果报
  const addedEdges = r.graph.edges.length - graph.value.edges.length;
  graph.value = r.graph;
  form.value = emptyForm();
  preview.value = null;
  notice.value = r.warnings;
  finishAdd(id, 1, addedEdges);
}

/** 预览确认 → 落库 */
function commitPreview(): void {
  const p = preview.value;
  if (!p || p.nodes.length === 0) return;
  const r = core.star.add(
    { nodes: p.nodes, edges: p.edges },
    { nodes: STAR_NODES, edges: STAR_EDGES },
  );
  if (!r.ok) {
    aiError.value = r.reason;
    return;
  }
  const firstId = p.nodes[0]!.id;
  const nodeCount = p.nodes.length;
  const edgeCount = p.edges.length;
  const warnings = [...r.warnings];
  graph.value = r.graph;
  closeBuilder();
  finishAdd(firstId, nodeCount, edgeCount);
  /* toast 一次只留一条，所以提醒必须合并成一句话再发，
     否则「已加入」会把「已加入」前面的提醒直接顶掉（旧版就丢在这儿） */
  if (warnings.length) {
    nav.toast(warnings.length === 1 ? warnings[0]! : `${warnings[0]!} 等 ${warnings.length} 条提醒`);
  }
}

/** 入库后的收尾：选中新节点让人看见它在哪，并给一条不互相覆盖的提示 */
function finishAdd(firstId: string, nodeCount: number, edgeCount: number): void {
  const parts = [`+${nodeCount} 节点`];
  if (edgeCount > 0) parts.push(`+${edgeCount} 关系`);
  selectedId.value = firstId;
  nav.toast(`已加入星图 · ${parts.join(' · ')}`);
}

/** 清空「我的星区」 */
function clearMine(): void {
  if (!confirmClear.value) {
    confirmClear.value = true;
    return;
  }
  const n = graph.value.nodes.length;
  const ids = graph.value.nodes.map((x) => x.id);
  graph.value = core.star.clear();
  core.progress.unlight(ids);
  if (selectedId.value && ids.includes(selectedId.value)) selectedId.value = null;
  confirmClear.value = false;
  preview.value = null;
  nav.toast(`已清空我的星区（${n} 个节点）`);
}

/** 移除自定义节点（内置节点不可删） */
function removeCustom(id: string): void {
  if (!customIds.value.has(id)) return;
  const name = nodeName(id);
  graph.value = core.star.removeNode(id);
  // 点亮记录不同步清，HUD 的分子就会留一个不存在的 id
  core.progress.unlight([id]);
  if (selectedId.value === id) selectedId.value = null;
  nav.toast(`已移除「${name}」`);
}

/** 图变化后：新增节点补刚体、删除节点清刚体，并重扫 DOM 引用 */
watch(allNodes, (nodes, prev) => {
  const prevIds = new Set((prev ?? []).map((n) => n.id));
  const added = nodes.filter((n) => !prevIds.has(n.id));
  const next = { ...bodies.value };
  if (added.length) Object.assign(next, initBodies(added, view.value));
  const ids = new Set(nodes.map((n) => n.id));
  for (const id of Object.keys(next)) {
    if (!ids.has(id)) delete next[id];
  }
  bodies.value = next;
  void nextTick().then(scanEls);
});

function scanEls(): void {
  const svg = svgEl.value;
  if (!svg) return;
  nodeEls.clear();
  lineEls.clear();
  for (const el of svg.querySelectorAll<SVGGElement>('g.node')) {
    const id = el.dataset.node;
    if (id) nodeEls.set(id, el);
  }
  for (const el of svg.querySelectorAll<SVGLineElement>('line.edge')) {
    const idx = Number(el.dataset.idx);
    if (Number.isFinite(idx)) lineEls.set(idx, el);
  }
}

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  const svg = svgEl.value;
  if (!svg) return;

  syncNarrow();
  window.addEventListener('resize', syncNarrow);

  // 结构由 Vue 渲染一次，之后帧循环直接操作这批元素
  scanEls();

  // 窄屏重新拟合视野。必须放在挂载之后 —— 这之前量不到容器尺寸。
  view.value = fitView(BASE_VIEW);

  raf = requestAnimationFrame(loop);

  // 从别处跳进来时带的选中节点
  if (props.focus) {
    selectedId.value = props.focus;
    panelOpen.value = true;
  }
});

/* 已挂载时外部又指定了节点（同一个视图内导航） */
watch(
  () => props.focus,
  (id) => {
    if (id) {
      selectedId.value = id;
      panelOpen.value = true;
    }
  },
);

/* 格物点亮后星图要立刻反映，不用等刷新 */
const offLit = core.progress.subscribe((lit) => {
  litIds.value = [...lit];
});

onBeforeUnmount(() => {
  offLit();
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', syncNarrow);
  nodeEls.clear();
  lineEls.clear();
});
</script>

<template>
  <div class="star-view">
    <div class="canvas" :class="{ panning }">
      <svg
        ref="svgEl"
        :viewBox="viewBoxAttr"
        preserveAspectRatio="xMidYMid meet"
        @pointerdown="onCanvasDown"
        @pointermove="onCanvasMove"
        @pointerup="onCanvasUp"
        @pointercancel="onCanvasUp"
        @wheel.prevent="onWheel"
      >
        <defs>
          <marker
            id="ah"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.2" />
          </marker>
        </defs>

        <line
          v-for="(e, i) in allEdges"
          :key="`e${i}`"
          class="edge"
          :class="e[2]"
          :data-idx="i"
          marker-end="url(#ah)"
        />

        <g
          v-for="n in allNodes"
          :key="n.id"
          class="node"
          :class="[{ dim: hoverSet && !hoverSet.has(n.id), mine: customIds.has(n.id) }, 'k-' + n.kind]"
          :data-node="n.id"
          @pointerdown="onNodeDown($event, n.id)"
          @pointermove="onNodeMove($event, n.id)"
          @pointerup="onNodeUp(n.id)"
          @pointercancel="onNodeUp(n.id)"
          @pointerenter="hoverId = n.id"
          @pointerleave="hoverId = null"
          @click="onNodeClick(n.id)"
        >
          <!--
            透明命中圈：触屏上圆点只有十来像素，手指点不准。
            给它垫一个更大的圈专门收事件，视觉上完全不可见。
          -->
          <circle class="hit" :r="nodeRadius(n.kind) + 11" />
          <circle class="ring" :r="nodeRadius(n.kind) + 7" :opacity="selectedId === n.id ? 0.9 : 0" />
          <circle class="dot" :class="{ lit: litIds.includes(n.id) }" :r="nodeRadius(n.kind)" />
          <text
            v-if="!narrow || litIds.includes(n.id) || selectedId === n.id || hoverId === n.id"
            class="lbl"
            :class="{ lit: litIds.includes(n.id) }"
            text-anchor="middle"
            :y="nodeRadius(n.kind) + 13"
          >
            {{ n.name }}
          </text>
        </g>
      </svg>

      <div class="hud">
        <span>已点亮 {{ litCount }} / {{ allNodes.length }} · {{ litPct }}%</span>
        <span v-if="narrow" class="hud-tip">点节点看名字</span>
        <button type="button" @click="doRelayout">
          <Icon name="i-refresh" :size="13" />
          重新布局
        </button>
        <button type="button" @click="openBuilder">
          <Icon name="i-plus" :size="13" />
          共建星图
          <b v-if="graph.nodes.length" class="badge">{{ graph.nodes.length }}</b>
        </button>
      </div>
    </div>

    <aside class="panel" :class="{ open: panelOpen }">
      <!-- 窄屏专用：收起底部滑出层。宽屏下这个按钮被 CSS 藏起来 -->
      <button type="button" class="panel-close" @click="panelOpen = false">
        <Icon name="i-minus" :size="16" />
      </button>

      <div v-if="!selected" class="empty">
        <p>点击任意节点查看它是什么，以及它跟谁有关系。</p>
        <p class="dim">拖动节点可以重排；空白处拖拽平移，双指（或滚轮）缩放。</p>
      </div>

      <div v-else class="detail">
        <h3>{{ selected.name }}</h3>
        <div class="kind">
          {{ KIND_LABEL[selected.kind] }} · {{ selected.school }} ·
          <b v-if="litIds.includes(selected.id)" class="on">已点亮</b>
          <span v-else class="off">盲区</span>
          <b v-if="customIds.has(selected.id)" class="mine-tag">· 我添加的</b>
        </div>
        <p class="brief">{{ selected.brief }}</p>
        <p class="src">出处：{{ selected.src }}</p>

        <div class="btn-row">
          <button type="button" class="btn" @click="toggleLit(selected.id)">
            {{ litIds.includes(selected.id) ? '取消点亮' : '点亮此节点' }}
          </button>
          <button
            v-if="customIds.has(selected.id)"
            type="button"
            class="btn danger"
            @click="removeCustom(selected.id)"
          >
            移除此节点
          </button>
        </div>

        <div v-if="selectedRels.length" class="rels">
          <h4>关系网</h4>
          <button
            v-for="r in selectedRels"
            :key="r.other + r.relation"
            type="button"
            class="rel"
            @click="selectedId = r.other"
          >
            <span>{{ allNodes.find((n) => n.id === r.other)?.name ?? r.other }}</span>
            <span class="rel-meta">
              {{ r.direction }} {{ RELATION_NAME[r.relation] }}
              <template v-if="r.note"> · {{ r.note }}</template>
            </span>
          </button>
        </div>
      </div>

      <div class="blind">
        <h4>盲区检测 · 各星区点亮率</h4>
        <div v-for="b in blind" :key="b.school" class="blind-row">
          <span class="school">{{ b.school }}</span>
          <div class="bar"><i :class="{ low: b.pct < 40 }" :style="{ width: Math.max(b.pct, 4) + '%' }" /></div>
          <b>{{ b.pct }}%</b>
        </div>
      </div>
    </aside>

    <!-- 星图共建弹窗：AI 规范化 / 手动填写 双路进同一个校验漏斗 -->
    <div v-if="builderOpen" class="builder" @click.self="closeBuilder" @keydown="onBuilderKey">
      <div ref="builderCard" class="builder-card" tabindex="-1">
        <div class="builder-head">
          <h3>共建星图</h3>
          <button type="button" class="x" title="关闭（Esc）" @click="closeBuilder">
            <Icon name="i-close" :size="14" />
          </button>
        </div>

        <div class="mode-tabs">
          <button type="button" :class="{ on: builderMode === 'ai' }" @click="switchMode('ai')">
            AI 帮我建
            <b v-if="!aiLive" class="off">未接入</b>
          </button>
          <button type="button" :class="{ on: builderMode === 'manual' }" @click="switchMode('manual')">
            手动填写
          </button>
        </div>

        <template v-if="builderMode === 'ai'">
          <p class="hint">
            用自己的话说想加什么，AI 会把它规范化成星图节点并连好关系。例如：
            「把忒修斯之船和同一性问题加进来，跟休谟的因果关系有点关联」
          </p>
          <textarea
            v-model="aiInput"
            rows="4"
            placeholder="描述你想加的概念、人物、它们之间的关系…"
          />
          <div class="act-row">
            <button type="button" class="btn" :disabled="aiBusy || !aiInput.trim()" @click="generate">
              {{ aiBusy ? '正在规范化…' : '生成预览' }}
            </button>
            <template v-if="!aiLive">
              <span class="warn">未接入 AI</span>
              <button type="button" class="link" @click="nav.go('set')">去设置</button>
            </template>
          </div>
        </template>

        <template v-else>
          <div class="form-grid">
            <label>名称<input v-model="form.name" maxlength="30" placeholder="如：忒修斯之船" /></label>
            <label>类型
              <select v-model="form.kind">
                <option value="concept">概念</option>
                <option value="figure">人物</option>
                <option value="method">方法论</option>
                <option value="school">流派</option>
              </select>
            </label>
            <label>脉络<input v-model="form.school" maxlength="20" placeholder="留空归入「我的星区」" /></label>
            <label>出处<input v-model="form.src" maxlength="60" placeholder="书名 / 思想来源" /></label>
          </div>
          <label class="full">一句话释义<textarea v-model="form.brief" rows="2" maxlength="200" placeholder="这个概念在讲什么？" /></label>
          <div class="edge-row">
            <label>连到
              <select v-model="form.toId">
                <option value="">（暂不连边）</option>
                <optgroup v-for="g in groupedNodes" :key="g.school" :label="g.school">
                  <option v-for="n in g.list" :key="n.id" :value="n.id">{{ n.name }}</option>
                </optgroup>
              </select>
            </label>
            <label>关系
              <select v-model="form.rel" :disabled="!form.toId">
                <option value="proposes">提出</option>
                <option value="refines">修正</option>
                <option value="inherits">继承</option>
                <option value="opposes">反对</option>
              </select>
            </label>
            <label class="grow">说明<input v-model="form.label" maxlength="40" placeholder="一句话说明这层关系" :disabled="!form.toId" /></label>
          </div>
          <div class="act-row">
            <button type="button" class="btn" :disabled="!form.name.trim()" @click="addManual">
              加入星图
            </button>
            <span class="inline-tip">填好直接入库，不用再点确认</span>
          </div>
        </template>

        <p v-if="aiError" class="err">{{ aiError }}</p>

        <template v-if="notice.length">
          <p v-for="(w, i) in notice" :key="`w${i}`" class="warn">⚠ {{ w }}</p>
        </template>

        <!-- 预览：可以逐条剔除，确认才入库 -->
        <template v-if="preview">
          <div class="preview">
            <h4>预览 · 不合适的可以剔掉，确认后才入库</h4>
            <div v-for="(n, i) in preview.nodes" :key="n.id" class="pv-node">
              <div class="pv-top">
                <b>{{ n.name }}</b>
                <span class="pv-meta">{{ KIND_LABEL[n.kind] }} · {{ n.school }}</span>
                <button type="button" class="pv-del" title="不要这个" @click="dropPreviewNode(i)">×</button>
              </div>
              <p>{{ n.brief }}</p>
            </div>
            <div v-for="(e, i) in preview.edges" :key="`pe${i}`" class="pv-edge">
              <span>{{ previewName(e[0]) }} — {{ RELATION_NAME[e[2]] }} → {{ previewName(e[1]) }}</span>
              <em v-if="e[3]">（{{ e[3] }}）</em>
              <button type="button" class="pv-del" title="不要这条" @click="dropPreviewEdge(i)">×</button>
            </div>
            <div class="act-row">
              <button type="button" class="btn" @click="commitPreview">
                入库（{{ preview.nodes.length }} 节点 · {{ preview.edges.length }} 关系）
              </button>
              <button type="button" class="link" @click="preview = null">放弃这次结果</button>
            </div>
          </div>
        </template>

        <!-- 我的星区管理 -->
        <div v-if="graph.nodes.length" class="mine-row">
          <span>我的星区已加 {{ graph.nodes.length }} 个节点 · {{ graph.edges.length }} 条关系</span>
          <button type="button" class="link danger" :class="{ armed: confirmClear }" @click="clearMine">
            {{ confirmClear ? '再点一次确认清空' : '清空' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.star-view {
  display: flex;
  height: 100%;
  /* 窄屏下侧栏是绝对定位的滑出层，需要它作为定位基准 */
  position: relative;
}


/* 窄屏专用的收起把手。宽屏不存在这个概念，所以默认不占位。 */
.panel-close {
  display: none;
  align-self: center;
  flex: none;
  width: 58px;
  height: 20px;
  place-items: center;
  color: var(--ink3);
}

.panel-close svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.6;
  stroke-linecap: round;
}

/* ---------- 画布 ---------- */

.canvas {
  flex: 1;
  min-width: 0;
  position: relative;
  background: var(--star-bg);
}

/* 只作用于画布本身那个 svg。
   写成 .canvas svg 会把 hud 里的图标也一起撑成 100%（第一次截图就翻车了）。 */
.canvas > svg {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  /* 触屏上禁用默认手势，否则拖节点会变成滚页面 */
  touch-action: none;
}

.canvas.panning > svg {
  cursor: grabbing;
}

/* 边 */
.edge {
  stroke: var(--star-edge);
  stroke-width: 1;
  opacity: 0.75;
  transition: opacity 0.2s;
}

.edge.proposes,
.edge.refines {
  stroke-dasharray: 1.5 4;
}

.edge.opposes {
  /* v2.1 这里写的变量名是 --star-edge-opposes（多了个 s），
     变量不存在 → 回落到默认色，"反对"关系从来没显示成红色。已修正。 */
  stroke: var(--star-edge-oppose);
  stroke-dasharray: 5 4;
}

/* 节点 */
.node {
  cursor: pointer;
  transition: opacity 0.2s;
}

.node.dim {
  opacity: 0.18;
}

.dot {
  stroke: var(--bg);
  stroke-width: 2;
  transition: r 0.15s ease, filter 0.2s ease, opacity 0.2s;
}

.k-school .dot {
  fill: var(--n-school);
}

.k-figure .dot {
  fill: var(--n-figure);
}

.k-method .dot {
  fill: var(--n-method);
}

.k-concept .dot {
  fill: var(--n-concept);
}

/* 未点亮：降为轮廓，靠"空"来表达"你还没读过" */
.dot:not(.lit) {
  fill: var(--n-off);
  stroke: var(--n-off-line);
}

.node:hover .dot {
  r: 17;
}

.ring {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  transition: opacity 0.18s;
}

/* fill: none 本身不接收事件，必须显式放开 pointer-events 才有命中区域 */
.hit {
  fill: none;
  pointer-events: all;
}

.lbl {
  font-family: inherit;
  font-size: 11px;
  fill: var(--star-ink-off);
  pointer-events: none;
  transition: opacity 0.2s;
  /* 标签压在密集的边上时，用背景色给文字描一圈，保证任何位置都读得清。
     旧版没有这层，标签跟边叠在一起基本看不清。 */
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 3px;
  stroke-linejoin: round;
}

.lbl.lit {
  fill: var(--star-ink);
}

.k-method .lbl.lit {
  font-weight: 600;
}

/* 状态条 */
.hud {
  position: absolute;
  left: 16px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--star-legend-bg);
  border: 1px solid var(--line);
  backdrop-filter: blur(12px);
  font-size: 12px;
  color: var(--ink2);
}

.hud button {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ink2);
  font-size: 12px;
}

.hud button svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

.hud button:hover {
  color: var(--accent);
}

/* ---------- 右侧面板 ---------- */

.panel {
  width: 296px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 16px;
  border-left: 1px solid var(--line);
  background: var(--card);
  overflow-y: auto;
}

.empty p {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ink2);
  line-height: 1.7;
}

.empty .dim {
  font-size: 12px;
  color: var(--ink3);
}

.detail h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 500;
}

.kind {
  font-size: 12px;
  color: var(--ink3);
  margin-bottom: 10px;
}

.kind .on {
  color: var(--accent);
}

.kind .off {
  color: var(--ink3);
}

.brief {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink);
}

.src {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--ink3);
}

.btn {
  width: 100%;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 13px;
  margin-bottom: 14px;
}

.btn:hover {
  background: var(--accent-hi);
}

.rels h4,
.blind h4 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink3);
  letter-spacing: 0.04em;
}

.rel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--radius-xs);
  text-align: left;
  font-size: 12.5px;
  color: var(--ink2);
}

.rel:hover {
  background: var(--card-hi);
  color: var(--ink);
}

.rel-meta {
  font-size: 11.5px;
  color: var(--ink3);
}

/* ---------- 盲区 ---------- */

.blind {
  margin-top: auto;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.blind-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--ink2);
  margin-bottom: 6px;
}

.school {
  width: 68px;
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--field);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--jade);
}

.bar i.low {
  background: var(--gold);
}

.blind-row b {
  width: 34px;
  text-align: right;
  font-weight: 500;
  color: var(--ink3);
}

/* ============================================================
 * 窄屏（手机）
 *
 * 右栏 296px 固定宽度会把 390px 的屏吃掉四分之三，
 * 星图被挤成左边一条缝（这个在截图里非常明显）。
 * 这里改成底部滑出层：点节点弹出、点把手收起。
 * ============================================================ */

@media (max-width: 760px) {
  .panel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 54vh;
    padding: 6px 16px 20px;
    border-left: 0;
    border-top: 1px solid var(--line);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -14px 34px rgba(0, 0, 0, 0.34);
    transform: translateY(102%);
    transition: transform 0.26s var(--ease);
    z-index: 3;
  }

  .panel.open {
    transform: translateY(0);
  }

  .panel-close {
    display: grid;
  }

  .hud {
    left: 10px;
    bottom: 10px;
    gap: 8px;
    padding: 4px 10px;
    font-size: 11px;
  }

  /* 窄屏标签降噪后，得让用户知道"名字不是没了，是点一下才出来" */
  .hud-tip {
    padding-left: 8px;
    border-left: 1px solid var(--line);
    color: var(--ink3);
    font-size: 10.5px;
  }

  .hud button {
    gap: 4px;
    font-size: 11px;
  }
}

/* ============================================================
 * 星图共建（3.5.0）
 * ============================================================ */

/* 自定义节点：给光点外圈一道虚线环，跟内置的区分开 */
.node.mine .ring {
  opacity: 0.55;
  stroke-dasharray: 3 3;
  stroke: var(--gold, #d9a06b);
}

.mine-tag {
  color: var(--gold, #d9a06b);
}

.btn-row {
  display: flex;
  gap: 8px;
}

.btn-row .btn {
  margin-bottom: 14px;
  flex: 1;
}

.btn.danger {
  background: transparent;
  border: 1px solid var(--rose, #b0483f);
  color: var(--rose, #b0483f);
}

/* ---------- 共建弹窗 ---------- */

.builder {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

.builder-card {
  width: min(520px, calc(100% - 32px));
  max-height: min(86vh, 640px);
  overflow-y: auto;
  padding: 18px 20px 20px;
  border-radius: var(--radius-md, 14px);
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--sh-pop, 0 18px 48px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 打开时会被程序聚焦，但它是容器不是控件，不该出现焦点环 */
  outline: none;
}

/* 弹窗淡入 + 微上浮；只看一眼就知道「它出现了」 */
.builder {
  animation: builder-in 0.2s var(--ease);
}

@keyframes builder-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.builder-card {
  animation: card-in 0.24s var(--ease);
}

@keyframes card-in {
  from {
    transform: translateY(10px) scale(0.985);
  }
  to {
    transform: none;
  }
}

.builder-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.builder-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.builder-head .x {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--ink3);
}

.builder-head .x:hover {
  background: var(--card-hi);
  color: var(--ink);
}

.builder-head .x svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.4;
  stroke-linecap: round;
}

.mode-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  background: var(--field);
}

.mode-tabs button {
  flex: 1;
  padding: 7px 0;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--ink2);
}

.mode-tabs button.on {
  background: var(--card);
  color: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14);
}

.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink3);
}

.builder textarea,
.builder input,
.builder select {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 8px);
  border: 1px solid var(--line);
  background: var(--field);
  color: var(--ink);
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
}

.builder textarea {
  resize: vertical;
  line-height: 1.7;
}

.builder label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--ink3);
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.form-grid label.full {
  grid-column: 1 / -1;
}

label.full {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--ink3);
}

.edge-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.edge-row .grow {
  flex: 1;
}

.act-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.act-row .btn {
  width: auto;
  padding: 8px 18px;
  margin-bottom: 0;
}

.act-row .btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.warn {
  margin: 0;
  font-size: 11.5px;
  color: var(--gold, #d9a06b);
}

/* 中性说明文字：和 .warn 区分开，别让「填完直接入库」读起来像报错 */
.inline-tip {
  font-size: 11.5px;
  color: var(--ink3);
}

.err {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-xs, 6px);
  background: rgba(176, 72, 63, 0.12);
  font-size: 12px;
  line-height: 1.6;
  color: var(--rose, #b0483f);
}

.preview {
  padding-top: 12px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preview h4 {
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink3);
  letter-spacing: 0.04em;
}

/* HUD 上「共建星图」按钮的角标：我加了几个节点，一眼可见 */
.badge {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
}

/* 文字按钮：去设置 / 放弃预览 / 清空，都是次要动作，别跟主按钮抢 */
.link {
  padding: 4px 2px;
  font-size: 12px;
  color: var(--ink3);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link:hover {
  color: var(--ink);
}

.link.danger {
  color: var(--rose, #b0483f);
}

/* 二次确认：点一次变成这句红字，再点才真清空 */
.link.danger.armed {
  font-weight: 500;
  text-decoration: none;
}

.mode-tabs .off {
  margin-left: 5px;
  font-size: 10px;
  font-weight: 400;
  opacity: 0.7;
}

.pv-node {
  padding: 9px 11px;
  border-radius: var(--radius-sm, 8px);
  background: var(--field);
  font-size: 12.5px;
}

.pv-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pv-del {
  margin-left: auto;
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 15px;
  line-height: 1;
  color: var(--ink3);
}

.pv-del:hover {
  background: var(--card-hi);
  color: var(--rose, #b0483f);
}

.mine-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--ink3);
}

.mine-row .link {
  margin-left: auto;
}

.pv-node b {
  font-weight: 500;
}

.pv-meta {
  margin-left: 8px;
  font-size: 11px;
  color: var(--ink3);
}

.pv-node p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--ink2);
}

.pv-edge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
  color: var(--ink2);
}

.pv-edge em {
  font-style: normal;
  color: var(--ink3);
}

@media (max-width: 760px) {
  .builder {
    align-items: flex-end;
  }

  .builder-card {
    width: 100%;
    max-height: 78vh;
    border-radius: 16px 16px 0 0;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .edge-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
