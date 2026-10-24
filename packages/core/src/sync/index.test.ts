import { describe, expect, it } from 'vitest';
import {
  SYNC_APP,
  SYNC_VERSION,
  applySnapshot,
  collectSnapshot,
  describeSnapshot,
  latestBackupKey,
  parseSnapshot,
  type SyncStore,
} from './index';

/** localStorage 的最小假实现，够 sync 模块用 */
function fakeStore(init: Record<string, string> = {}): SyncStore & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k: string) {
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      map.set(k, v);
    },
    removeItem(k: string) {
      map.delete(k);
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

const BASE: Record<string, string> = {
  wj_settings_v1: JSON.stringify({ fontSize: 17, theme: 'night' }),
  wj_ai_sig: 'ollama|http://127.0.0.1:11434/v1||qwen2.5:7b',
  wj_user_books: JSON.stringify([{ id: 'b1' }, { id: 'b2' }]),
  wj_materials_v1: JSON.stringify({ cards: [{ id: 'c1' }], debates: [], readings: [{ id: 'r1' }] }),
  wj_lit: JSON.stringify(['a1', 'a4']),
  wj_prog_doc1: JSON.stringify({ pos: 12 }),
  // 下面两个是本机专有，不该跟着快照走
  wj_lan_host: '192.168.1.8:47800',
  wj_backup_1700000000000: '{"old":true}',
  // 非 wj_ 前缀的键要被忽略
  other_key: 'x',
};

describe('collectSnapshot', () => {
  it('只收 wj_ 前缀，且排掉本机专有的连接地址与备份', () => {
    const snap = collectSnapshot(fakeStore(BASE), '电脑');
    expect(Object.keys(snap.data).sort()).toEqual(
      ['wj_ai_sig', 'wj_lit', 'wj_materials_v1', 'wj_prog_doc1', 'wj_settings_v1', 'wj_user_books'].sort(),
    );
    expect(snap.data['wj_lan_host']).toBeUndefined();
    expect(snap.data['other_key']).toBeUndefined();
    expect(snap.device).toBe('电脑');
    expect(snap.app).toBe(SYNC_APP);
    expect(snap.v).toBe(SYNC_VERSION);
  });

  it('动态键（wj_prog_<docId>）也能带走', () => {
    const store = fakeStore({ ...BASE, wj_prog_doc2: '{}' });
    const snap = collectSnapshot(store);
    expect(snap.data['wj_prog_doc2']).toBe('{}');
  });
});

describe('describeSnapshot', () => {
  it('数得清书、卡、场次、点亮数', () => {
    const stats = describeSnapshot(collectSnapshot(fakeStore(BASE)));
    expect(stats.books).toBe(2);
    expect(stats.cards).toBe(1);
    expect(stats.debates).toBe(0);
    expect(stats.readings).toBe(1);
    expect(stats.lit).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('键值坏掉时统计归零而不是抛错', () => {
    const stats = describeSnapshot(collectSnapshot(fakeStore({ wj_user_books: 'not json' })));
    expect(stats.books).toBe(0);
  });
});

describe('parseSnapshot', () => {
  it('认自己人', () => {
    const r = parseSnapshot(collectSnapshot(fakeStore(BASE)));
    expect(r.ok).toBe(true);
  });

  it.each([
    ['空', null],
    ['字符串', 'hello'],
    ['别人的快照', { app: 'other', v: 1, data: {} }],
    ['版本不对', { app: SYNC_APP, v: 99, data: {} }],
    ['缺 data', { app: SYNC_APP, v: SYNC_VERSION }],
    ['data 是数组', { app: SYNC_APP, v: SYNC_VERSION, data: [] }],
    ['值不是字符串', { app: SYNC_APP, v: SYNC_VERSION, data: { wj_lit: [1, 2] } }],
  ])('拒绝 %s', (_name, raw) => {
    const r = parseSnapshot(raw);
    expect(r.ok).toBe(false);
  });

  it('超长键名直接拒掉', () => {
    const r = parseSnapshot({
      app: SYNC_APP,
      v: SYNC_VERSION,
      data: { ['wj_' + 'x'.repeat(200)]: '1' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('applySnapshot', () => {
  it('整体覆盖，并留下覆盖前的备份', () => {
    const store = fakeStore(BASE);
    const incoming = collectSnapshot(
      fakeStore({
        wj_settings_v1: JSON.stringify({ fontSize: 20 }),
        wj_lit: JSON.stringify(['b1']),
      }),
      '手机',
    );

    const res = applySnapshot(store, incoming);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const after = store.dump();
    // 旧的格物卡被覆盖掉（这正是「整包覆盖」的语义）
    expect(after['wj_materials_v1']).toBeUndefined();
    expect(JSON.parse(after['wj_lit'] ?? '[]')).toEqual(['b1']);
    expect(JSON.parse(after['wj_settings_v1'] ?? '{}')).toEqual({ fontSize: 20 });

    // 备份里存着覆盖前的东西
    const backup = JSON.parse(after[res.backupKey] ?? '{}');
    expect(backup.data['wj_materials_v1']).toBe(BASE['wj_materials_v1']);
    expect(latestBackupKey(store)).toBe(res.backupKey);
  });

  it('不动本机专有键（连接地址不会被对方的覆盖）', () => {
    const store = fakeStore(BASE);
    const res = applySnapshot(store, collectSnapshot(fakeStore({ wj_lit: '[]' })));
    expect(res.ok).toBe(true);
    expect(store.dump()['wj_lan_host']).toBe(BASE['wj_lan_host']);
  });

  it('对方快照里夹带的本机专有键也会被忽略', () => {
    const store = fakeStore({ wj_lan_host: '1.1.1.1:1' });
    const res = applySnapshot(store, {
      app: SYNC_APP,
      v: SYNC_VERSION,
      at: 1,
      device: '手机',
      data: { wj_lan_host: '9.9.9.9:9', wj_lit: '["z"]' },
    });
    expect(res.ok).toBe(true);
    expect(store.dump()['wj_lan_host']).toBe('1.1.1.1:1');
  });

  it('坏数据一个字都不写', () => {
    const store = fakeStore(BASE);
    const before = store.dump();
    const res = applySnapshot(store, { app: 'evil', v: 1, data: { wj_lit: '["x"]' } });
    expect(res.ok).toBe(false);
    expect(store.dump()).toEqual(before);
  });

  it('备份只留最近三份，不会把存储挤爆', () => {
    const store = fakeStore({ wj_lit: '["a"]' });
    for (let i = 0; i < 5; i += 1) {
      applySnapshot(store, collectSnapshot(fakeStore({ wj_lit: `["b${i}"]` })));
    }
    const backups = Object.keys(store.dump()).filter((k) => k.startsWith('wj_backup_'));
    expect(backups.length).toBeLessThanOrEqual(3);
  });
});
