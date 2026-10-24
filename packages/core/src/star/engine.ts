/**
 * 星图物理引擎
 *
 * ===== 为什么单独抽出来 =====
 * 旧版这套力导向算法和 SVG 元素、指针事件、面板 HTML 搅在一起，
 * 于是「节点为什么飘出画布」「为什么会 NaN」这类问题只能靠肉眼看出，
 * 一处算错就全图崩掉，也没法写测试。
 *
 * 现在这里面全是纯函数：给状态、算下一个状态，不碰 DOM。
 * 渲染层只负责把 x/y 读出来画上去。
 *
 * 物理参数原样保留 v2.1 的值，不做"顺手优化" —— 视觉手感是调出来的，
 * 改一个数字就得重新看图，没有理由在重构时动它。
 */

import type { EdgeRelation, NodeKind, StarEdge, StarNode } from '../types';

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个漂浮的节点 */
export interface StarBody {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 拖拽中锚定的位置，null 表示自由飘 */
  fx: number | null;
  fy: number | null;
}

/* ============================================================
 * 视觉常量
 * ============================================================ */

/** 星图基准坐标系 */
export const BASE_VIEW: ViewBox = { x: 0, y: 0, w: 680, h: 540 };

const KIND_RADIUS: Record<NodeKind, number> = {
  school: 17,
  method: 14,
  figure: 12,
  concept: 10,
};

export function nodeRadius(kind: NodeKind): number {
  return KIND_RADIUS[kind];
}

/** 节点类型色。UI 层也可以直接用 CSS 变量 --n-* 覆盖。 */
const KIND_COLOR: Record<NodeKind, string> = {
  school: '#7DA7D9',
  method: '#FF6A4D',
  figure: '#4FD1C5',
  concept: '#A8B3C4',
};

export function nodeColor(kind: NodeKind): string {
  return KIND_COLOR[kind];
}

export const RELATION_NAME: Record<EdgeRelation, string> = {
  proposes: '提出',
  inherits: '继承',
  opposes: '反对',
  refines: '修正',
};

/* ============================================================
 * 物理参数（v2.1 原值）
 * ============================================================ */

const REPULSION_CAP = 3;
const REPULSION_K = 900;
const SPRING_LENGTH = 100;
const SPRING_K = 0.02;
const CENTER_PULL = 0.004;
const DAMPING = 0.86;
const PAD_X = 16;
const PAD_Y = 14;

/* ============================================================
 * 初始化
 * ============================================================ */

/**
 * 环形撒点 + 一点随机扰动。
 *
 * 随机扰动的用处：完全对称的初始位置会让斥力两两抵消，
 * 图形永远散不开、卡成一个正圆。抖一下才能长出结构。
 */
export function initBodies(
  nodes: readonly StarNode[],
  view: ViewBox = BASE_VIEW,
  random: () => number = Math.random,
): Record<string, StarBody> {
  const out: Record<string, StarBody> = {};
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;

  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    out[n.id] = {
      id: n.id,
      x: cx + Math.cos(angle) * 190 + random() * 20,
      y: cy + Math.sin(angle) * 160 + random() * 20,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
  });

  return out;
}

/** 重新布局：按当前视口半径重新排成环 */
export function relayout(
  bodies: Record<string, StarBody>,
  ids: readonly string[],
  view: ViewBox,
): void {
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const rx = Math.min(view.w * 0.3, 220);
  const ry = Math.min(view.h * 0.3, 180);

  ids.forEach((id, i) => {
    const b = bodies[id];
    if (!b) return;
    const a = (i / ids.length) * Math.PI * 2;
    b.x = cx + Math.cos(a) * rx;
    b.y = cy + Math.sin(a) * ry;
    b.vx = 0;
    b.vy = 0;
  });
}

/* ============================================================
 * 单步积分
 * ============================================================ */

/**
 * 推进一帧。
 *
 * 三个阶段，顺序不能换：
 * 1. 两两斥力 —— 让节点散开
 * 2. 边上的弹簧 —— 把有关系的拉近到 SPRING_LENGTH
 * 3. 向心力 + 阻尼 + 边界钳制
 *
 * 原地修改 bodies，避免每帧分配几千个对象。
 */
export function step(
  bodies: Record<string, StarBody>,
  edges: readonly StarEdge[],
  view: ViewBox = BASE_VIEW,
): void {
  const arr = Object.keys(bodies)
    .map((id) => bodies[id])
    .filter((b): b is StarBody => b !== undefined);

  // 1. 斥力
  for (let i = 0; i < arr.length; i += 1) {
    const a = arr[i];
    if (!a) continue;
    for (let j = i + 1; j < arr.length; j += 1) {
      const b = arr[j];
      if (!b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      const d = Math.sqrt(d2);
      const f = Math.min(REPULSION_K / d2, REPULSION_CAP);
      const ux = dx / d;
      const uy = dy / d;
      a.vx -= ux * f;
      a.vy -= uy * f;
      b.vx += ux * f;
      b.vy += uy * f;
    }
  }

  // 2. 弹簧（沿边拉近/推远到目标长度）
  for (const [from, to] of edges) {
    const A = bodies[from];
    const B = bodies[to];
    if (!A || !B) continue;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.max(Math.hypot(dx, dy), 1);
    const f = (d - SPRING_LENGTH) * SPRING_K;
    const ux = dx / d;
    const uy = dy / d;
    A.vx += ux * f;
    A.vy += uy * f;
    B.vx -= ux * f;
    B.vy -= uy * f;
  }

  // 3. 向心 + 阻尼 + 积分 + 边界
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const minX = view.x + PAD_X;
  const maxX = view.x + view.w - PAD_X;
  const minY = view.y + PAD_Y;
  const maxY = view.y + view.h - PAD_Y;

  for (const n of arr) {
    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;
    n.vx *= DAMPING;
    n.vy *= DAMPING;

    if (n.fx !== null || n.fy !== null) {
      /**
       * ★ 这里修掉了一个 v2.1 遗留的真 bug。
       *
       * 旧代码是：
       *     if (n.fx != null) { n.x = n.fx; n.vx = 0; n.vy = 0; }
       *     else              { n.x += n.vx; n.y += n.vy; }
       *
       * 拖拽时 fx 和 fy 是一起设置的，但上面只把 x 钉到 fx 上，
       * y 既没被赋值也没参与积分 —— 于是节点垂直方向纹丝不动。
       * 表现就是「星图只能左右拖，上下拖不动」。
       *
       * v1.0 那轮修的是屏幕坐标 → viewBox 的换算（getScreenCTM），
       * 那条确实修好了手感和缩放偏差，但垂直方向这一处没改到，
       * 所以「上下拖不动」其实一直残留着，只是拖的时候横轴会动，
       * 看起来像"能拖"，不容易发现纵轴是死的。
       *
       * 现在两轴各自独立锚定。
       */
      if (n.fx !== null) {
        n.x = n.fx;
        n.vx = 0;
      }
      if (n.fy !== null) {
        n.y = n.fy;
        n.vy = 0;
      }
    } else {
      n.x += n.vx;
      n.y += n.vy;
    }

    /**
     * 钳制在视口内，避免节点飘到看不见的地方再也抓不回来。
     *
     * ★ 3.7.0 修：撞墙必须同时把对应轴的速度归零。
     * 旧代码只钳位置不碰速度 —— 节点贴边后，斥力/弹簧每帧继续把它往外推，
     * 位置被钳住、速度却照攒，整个系统在边界上被持续注入能量，
     * 表现为星图永远在轻微抖动、收不到稳定布局。
     * 30 个节点时看不出来（贴边的是少数），52 个节点时直接抖成限环。
     */
    if (n.x < minX) {
      n.x = minX;
      n.vx = 0;
    } else if (n.x > maxX) {
      n.x = maxX;
      n.vx = 0;
    }
    if (n.y < minY) {
      n.y = minY;
      n.vy = 0;
    } else if (n.y > maxY) {
      n.y = maxY;
      n.vy = 0;
    }
  }
}

/* ============================================================
 * 关系查询
 * ============================================================ */

export interface RelatedEdge {
  /** 另一端的节点 id */
  other: string;
  relation: EdgeRelation;
  /** '→' 表示本节点指向对方，'←' 表示被对方指向 */
  direction: '→' | '←';
  note: string;
}

/** 某个节点的全部关系，用于右侧面板的「关系网」 */
export function relatedEdges(
  edges: readonly StarEdge[],
  id: string,
): RelatedEdge[] {
  const out: RelatedEdge[] = [];
  for (const [a, b, rel, note] of edges) {
    if (a === id) out.push({ other: b, relation: rel, direction: '→', note });
    else if (b === id) out.push({ other: a, relation: rel, direction: '←', note });
  }
  return out;
}

/** 邻接集合（含自己），用于 hover 时高亮一圈 */
export function neighborIds(edges: readonly StarEdge[], id: string): Set<string> {
  const s = new Set<string>([id]);
  for (const [a, b] of edges) {
    if (a === id) s.add(b);
    else if (b === id) s.add(a);
  }
  return s;
}

/* ============================================================
 * 盲区统计
 * ============================================================ */

export interface BlindSpot {
  school: string;
  total: number;
  lit: number;
  /** 点亮百分比，0–100 取整 */
  pct: number;
}

/**
 * 各星区点亮率。按节点数从多到少排。
 *
 * 这是整个应用里少见的「真的在用数据说话」的功能：
 * 告诉你哪条思想脉络你还没碰过。
 */
export function blindSpots(
  nodes: readonly StarNode[],
  litIds: readonly string[],
): BlindSpot[] {
  const lit = new Set(litIds);
  const groups = new Map<string, { total: number; lit: number }>();

  for (const n of nodes) {
    const g = groups.get(n.school) ?? { total: 0, lit: 0 };
    g.total += 1;
    if (lit.has(n.id)) g.lit += 1;
    groups.set(n.school, g);
  }

  return Array.from(groups.entries())
    .map(([school, g]) => ({
      school,
      total: g.total,
      lit: g.lit,
      pct: Math.round((g.lit / g.total) * 100),
    }))
    .sort((a, b) => b.total - a.total);
}

/* ============================================================
 * 视图变换
 * ============================================================ */

export const MIN_VIEW_W = 300;
export const MAX_VIEW_W = 1500;

/**
 * 以某点为中心缩放。
 *
 * 关键是「以鼠标位置为中心」：先算出该点在缩放前的位置，
 * 缩放后反解出新的 view.x/y，让这个点视觉上不动。
 * 旧版先实现成以画布中心缩放，放大时目标会往边上飘。
 */
export function zoomView(
  view: ViewBox,
  factor: number,
  focus: { x: number; y: number },
): ViewBox {
  const nextW = Math.max(MIN_VIEW_W, Math.min(MAX_VIEW_W, view.w * factor));
  const s = nextW / view.w;
  return {
    x: focus.x - (focus.x - view.x) * s,
    y: focus.y - (focus.y - view.y) * s,
    w: nextW,
    h: (nextW * BASE_VIEW.h) / BASE_VIEW.w,
  };
}

/** 平移视图。dx/dy 单位是 viewBox 坐标，不是屏幕像素 —— 换算交给调用方。 */
export function panView(view: ViewBox, dx: number, dy: number): ViewBox {
  return { ...view, x: view.x - dx, y: view.y - dy };
}

/** 屏幕像素差 → viewBox 单位差 */
export function screenToView(
  deltaPx: number,
  renderedWidthPx: number,
  view: ViewBox,
): number {
  if (renderedWidthPx <= 0) return 0;
  return (deltaPx * view.w) / renderedWidthPx;
}
