/**
 * 点亮状态。
 *
 * 星图 HUD 上的「已点亮 N / M」直接读这里，删节点时如果不同步清，
 * 分子就会残留一个图里已经不存在的 id。
 */

import { describe, expect, it } from 'vitest';
import { ProgressStore } from './index';
import { KeyValueStore, MemoryStorage } from '../storage';

function store(): ProgressStore {
  return new ProgressStore(new KeyValueStore(new MemoryStorage()));
}

describe('ProgressStore', () => {
  it('点亮会落盘：换个实例读得到', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const a = new ProgressStore(kv);
    a.light(['u_abc']);
    expect(new ProgressStore(kv).lit()).toContain('u_abc');
  });

  it('重复点亮不产生重复项', () => {
    const s = store();
    s.light(['x']);
    expect(s.light(['x'])).toHaveLength(0);
    expect(s.lit().filter((id) => id === 'x')).toHaveLength(1);
  });

  it('取消点亮会同步落盘', () => {
    const kv = new KeyValueStore(new MemoryStorage());
    const s = new ProgressStore(kv);
    s.light(['u_gone']);
    s.unlight(['u_gone']);
    expect(s.lit()).not.toContain('u_gone');
    expect(new ProgressStore(kv).lit()).not.toContain('u_gone');
  });

  it('取消一个不存在的 id 不触发无谓的通知', () => {
    const s = store();
    let fired = 0;
    s.subscribe(() => {
      fired += 1;
    });
    s.unlight(['根本没点亮过']);
    expect(fired).toBe(0);
  });
});
