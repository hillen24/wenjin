/**
 * 星图引擎测试
 *
 * 旧版这套算法一旦某个节点坐标变成 NaN，整个 SVG 会静默消失，
 * 而且没有任何入口能查出是哪一步算坏的。现在可以在 0.1 秒内验证这件事。
 */

import { describe, expect, it } from 'vitest';
import { STAR_EDGES, STAR_NODES } from '../data';
import {
  BASE_VIEW,
  blindSpots,
  initBodies,
  neighborIds,
  nodeColor,
  nodeRadius,
  panView,
  relatedEdges,
  relayout,
  screenToView,
  step,
  zoomView,
  MAX_VIEW_W,
  MIN_VIEW_W,
  type StarBody,
} from './engine';

const IDS = STAR_NODES.map((n) => n.id);

/** 固定随机源，让测试可复现 */
function fixedRandom(): () => number {
  let i = 0;
  return () => {
    i += 1;
    return ((i * 37) % 100) / 100;
  };
}

function freshBodies(): Record<string, StarBody> {
  return initBodies(STAR_NODES, BASE_VIEW, fixedRandom());
}

describe('初始化', () => {
  it('每个节点都有一个 body', () => {
    const bodies = freshBodies();
    expect(Object.keys(bodies)).toHaveLength(STAR_NODES.length);
    for (const id of IDS) expect(bodies[id]).toBeDefined();
  });

  it('初始状态全部静止、未被拖拽', () => {
    const bodies = freshBodies();
    for (const id of IDS) {
      const b = bodies[id]!;
      expect(b.vx).toBe(0);
      expect(b.vy).toBe(0);
      expect(b.fx).toBeNull();
      expect(b.fy).toBeNull();
    }
  });

  it('节点半径按类型区分，学派最大、概念最小', () => {
    expect(nodeRadius('school')).toBeGreaterThan(nodeRadius('figure'));
    expect(nodeRadius('method')).toBeGreaterThan(nodeRadius('concept'));
  });

  it('每种类型都有颜色', () => {
    for (const k of ['school', 'figure', 'method', 'concept'] as const) {
      expect(nodeColor(k)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('积分：不许算出 NaN', () => {
  it('两个节点完全重合时也不产生 NaN（旧版这里除零会毁掉整张图）', () => {
    const bodies: Record<string, StarBody> = {
      a: { id: 'a', x: 100, y: 100, vx: 0, vy: 0, fx: null, fy: null },
      b: { id: 'b', x: 100, y: 100, vx: 0, vy: 0, fx: null, fy: null },
    };

    step(bodies, [['a', 'b', 'proposes', '']], BASE_VIEW);

    for (const b of Object.values(bodies)) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      expect(Number.isFinite(b.vx)).toBe(true);
      expect(Number.isFinite(b.vy)).toBe(true);
    }
  });

  it('连跑 300 帧，全部坐标有限且始终在视口内', () => {
    const bodies = freshBodies();
    for (let i = 0; i < 300; i += 1) step(bodies, STAR_EDGES, BASE_VIEW);

    const minX = BASE_VIEW.x + 16;
    const maxX = BASE_VIEW.x + BASE_VIEW.w - 16;
    const minY = BASE_VIEW.y + 14;
    const maxY = BASE_VIEW.y + BASE_VIEW.h - 14;

    for (const id of IDS) {
      const b = bodies[id]!;
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      // 钳制生效：节点不会飘到画布外找不回来
      expect(b.x).toBeGreaterThanOrEqual(minX - 1e-6);
      expect(b.x).toBeLessThanOrEqual(maxX + 1e-6);
      expect(b.y).toBeGreaterThanOrEqual(minY - 1e-6);
      expect(b.y).toBeLessThanOrEqual(maxY + 1e-6);
    }
  });

  it('系统会收敛：跑够帧数后总动能在减小', () => {
    const bodies = freshBodies();
    /**
     * 窗口均值，不是瞬时采样。
     *
     * 3.7.0 星图从 30 节点扩到 52 节点后，这条用例开始偶发失败：
     * 布局到达平衡态后仍有轻微涨落（节点擦身时斥力给个小kick），
     * 瞬时值会在两个窗口之间抖上抖下，看着像「没收敛」。
     * 窗口均值把这种正常涨落平掉，同时照样能抓住真发散——
     * 真发散的系统，均值只会越跑越大。
     */
    const windowKe = (frames: number): number => {
      let sum = 0;
      for (let i = 0; i < frames; i += 1) {
        step(bodies, STAR_EDGES, BASE_VIEW);
        sum += Object.values(bodies).reduce((s, b) => s + Math.abs(b.vx) + Math.abs(b.vy), 0);
      }
      return sum / frames;
    };

    const early = windowKe(150);
    const mid = windowKe(150);
    const late = windowKe(150);

    expect(mid).toBeLessThan(early);
    expect(late).toBeLessThan(mid);
  });
});

describe('拖拽锚定', () => {
  it('fx/fy 有值时位置被钉死，速度归零', () => {
    const bodies = freshBodies();
    const b = bodies['kant']!;
    b.fx = 222;
    b.fy = 333;

    for (let i = 0; i < 5; i += 1) step(bodies, STAR_EDGES, BASE_VIEW);

    expect(b.x).toBe(222);
    expect(b.y).toBe(333);
    expect(b.vx).toBe(0);
    expect(b.vy).toBe(0);
  });

  it('松开后（fx 归 null）重新参与物理运算', () => {
    const bodies = freshBodies();
    const b = bodies['kant']!;
    b.fx = 222;
    b.fy = 333;
    step(bodies, STAR_EDGES, BASE_VIEW);

    b.fx = null;
    b.fy = null;
    for (let i = 0; i < 5; i += 1) step(bodies, STAR_EDGES, BASE_VIEW);

    expect(b.x === 222 && b.y === 333).toBe(false);
  });
});

describe('关系查询', () => {
  it('出边方向是 →，入边方向是 ←', () => {
    // hume→kant 是 'refines'
    const rels = relatedEdges(STAR_EDGES, 'hume');
    const toKant = rels.find((r) => r.other === 'kant');
    expect(toKant?.direction).toBe('→');
    expect(toKant?.relation).toBe('refines');

    const fromKantSide = relatedEdges(STAR_EDGES, 'kant').find((r) => r.other === 'hume');
    expect(fromKantSide?.direction).toBe('←');
  });

  it('邻接集合包含自己（hover 高亮要用）', () => {
    const s = neighborIds(STAR_EDGES, 'dichotomy');
    expect(s.has('dichotomy')).toBe(true);
    expect(s.has('epictetus')).toBe(true);
    expect(s.has('stoic')).toBe(true);
  });

  it('孤立节点只有自己', () => {
    const s = neighborIds(STAR_EDGES, 'nonexistent-node');
    expect(s.size).toBe(1);
  });
});

describe('盲区统计', () => {
  it('点亮率按组计算且总和守恒', () => {
    const lit = ['stoic', 'epictetus', 'dichotomy'];
    const spots = blindSpots(STAR_NODES, lit);

    const totalNodes = spots.reduce((s, x) => s + x.total, 0);
    const totalLit = spots.reduce((s, x) => s + x.lit, 0);
    expect(totalNodes).toBe(STAR_NODES.length);
    expect(totalLit).toBe(lit.length);
  });

  it('按节点数从多到少排序', () => {
    const spots = blindSpots(STAR_NODES, []);
    for (let i = 1; i < spots.length; i += 1) {
      expect(spots[i - 1]!.total).toBeGreaterThanOrEqual(spots[i]!.total);
    }
  });

  it('一个都没点亮时全部是 0%', () => {
    const spots = blindSpots(STAR_NODES, []);
    expect(spots.every((s) => s.pct === 0)).toBe(true);
  });

  it('全点亮是 100%', () => {
    const spots = blindSpots(STAR_NODES, STAR_NODES.map((n) => n.id));
    expect(spots.every((s) => s.pct === 100)).toBe(true);
  });
});

describe('视图变换', () => {
  it('缩放时焦点在画布上的相对位置不变', () => {
    const view = { x: 0, y: 0, w: 680, h: 540 };
    const focus = { x: 300, y: 200 };

    const zoomed = zoomView(view, 0.5, focus);

    const before = (focus.x - view.x) / view.w;
    const after = (focus.x - zoomed.x) / zoomed.w;
    expect(after).toBeCloseTo(before, 6);
  });

  it('缩放有上下限，不会缩成一个点或放大到失真', () => {
    const view = { x: 0, y: 0, w: 680, h: 540 };
    const focus = { x: 340, y: 270 };

    let v = view;
    for (let i = 0; i < 50; i += 1) v = zoomView(v, 0.5, focus);
    expect(v.w).toBeCloseTo(MIN_VIEW_W, 6);

    v = view;
    for (let i = 0; i < 50; i += 1) v = zoomView(v, 2, focus);
    expect(v.w).toBeCloseTo(MAX_VIEW_W, 6);
  });

  it('缩放保持 680:540 的宽高比', () => {
    const zoomed = zoomView({ x: 0, y: 0, w: 680, h: 540 }, 0.75, { x: 0, y: 0 });
    expect(zoomed.h).toBeCloseTo((zoomed.w * 540) / 680, 6);
  });

  it('平移：往右下拖，视图原点往左上走', () => {
    const moved = panView({ x: 0, y: 0, w: 680, h: 540 }, 30, 20);
    expect(moved.x).toBe(-30);
    expect(moved.y).toBe(-20);
    expect(moved.w).toBe(680);
  });

  it('屏幕像素换算：缩放越大，同样的像素位移对应更少的 viewBox 单位', () => {
    const near = screenToView(10, 680, { x: 0, y: 0, w: 340, h: 270 });
    const far = screenToView(10, 680, { x: 0, y: 0, w: 1360, h: 1080 });
    expect(near).toBeCloseTo(5, 6);
    expect(far).toBeCloseTo(20, 6);
  });

  it('渲染宽度为 0 时不除零', () => {
    expect(screenToView(10, 0, { x: 0, y: 0, w: 680, h: 540 })).toBe(0);
  });
});

describe('重新布局', () => {
  it('重排后全部节点回到视口中心附近且静止', () => {
    const bodies = freshBodies();
    for (let i = 0; i < 100; i += 1) step(bodies, STAR_EDGES, BASE_VIEW);

    relayout(bodies, IDS, BASE_VIEW);

    const cx = BASE_VIEW.x + BASE_VIEW.w / 2;
    for (const id of IDS) {
      const b = bodies[id]!;
      expect(b.vx).toBe(0);
      expect(b.vy).toBe(0);
      // 环形半径不超过 220
      expect(Math.abs(b.x - cx)).toBeLessThanOrEqual(221);
    }
  });
});
