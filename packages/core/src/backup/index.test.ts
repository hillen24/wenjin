import { describe, expect, it } from 'vitest';
import {
  AUTO_BACKUP_PREFIX,
  MAX_AUTO_BACKUPS,
  createBackup,
  deleteAutoBackup,
  listAutoBackups,
  parseBackupFile,
  readAutoBackup,
  restoreFromBackup,
  saveAutoBackup,
  serializeBackup,
} from './index';
import { SYNC_VERSION, type SyncStore } from '../sync';

/** localStorage 的最小假实现（与 sync 测试同一套） */
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
  wj_user_books: JSON.stringify([{ id: 'ub_1', title: '理想国', paras: ['段一'] }]),
  wj_prog_epictetus: JSON.stringify([0, 1]),
  wj_lan_host: 'http://192.168.1.5:47800', // 本机专有，不该进备份
};

describe('备份导出', () => {
  it('导出带上 reason，且不带本机专有键', () => {
    const s = fakeStore(BASE);
    const b = createBackup(s, '手动导出');
    expect(b.reason).toBe('手动导出');
    expect(b.app).toBe('wenjin-sync');
    expect(b.v).toBe(SYNC_VERSION);
    expect(b.data['wj_settings_v1']).toBeDefined();
    expect(b.data['wj_prog_epictetus']).toBeDefined(); // 动态键也带走
    expect(b.data['wj_lan_host']).toBeUndefined(); // 本机地址不跟着备份跑
  });

  it('序列化 → 解析  roundtrip 保真', () => {
    const s = fakeStore(BASE);
    const text = serializeBackup(createBackup(s, '文献入库前'));
    const r = parseBackupFile(JSON.parse(text));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reason).toBe('文献入库前');
    expect(r.snap.data['wj_user_books']).toBe(BASE['wj_user_books']);
  });

  it('拒绝不是致知备份的东西', () => {
    expect(parseBackupFile(null).ok).toBe(false);
    expect(parseBackupFile({ app: '别的应用', v: 1, data: {} }).ok).toBe(false);
    expect(parseBackupFile({ app: 'wenjin-sync', v: 99, data: {} }).ok).toBe(false);
    const r = parseBackupFile({ app: 'wenjin-sync', v: 1, data: { wj_x: 'y' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBe('手动导入'); // 没写 reason 的裸快照也能导
  });
});

describe('从备份恢复', () => {
  it('恢复 = 先备份当前，再整包覆盖', () => {
    const s = fakeStore(BASE);
    const backupText = serializeBackup(
      createBackup(fakeStore({ wj_settings_v1: JSON.stringify({ fontSize: 22 }) }), '旧数据'),
    );

    const r = restoreFromBackup(s, JSON.parse(backupText));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 当前数据被备份文件覆盖
    expect(JSON.parse(s.dump()['wj_settings_v1']!)).toEqual({ fontSize: 22 });
    // 原来的数据进了覆盖前备份
    expect(r.backupKey).toMatch(/^wj_backup_\d+$/);
    const before = JSON.parse(s.getItem(r.backupKey)!);
    expect(JSON.parse(before.data['wj_settings_v1']!)).toEqual({ fontSize: 17, theme: 'night' });
  });

  it('恢复会拒绝坏数据，且不动本机数据', () => {
    const s = fakeStore(BASE);
    const r = restoreFromBackup(s, { app: 'wenjin-sync', v: 1, data: { wj_x: 5 } });
    expect(r.ok).toBe(false);
    expect(s.dump()['wj_settings_v1']).toBe(BASE['wj_settings_v1']);
  });
});

describe('自动备份（localStorage 版）', () => {
  it('写入 / 列表 / 读取 / 删除', () => {
    const s = fakeStore(BASE);
    const key = saveAutoBackup(s, '文献入库前');
    expect(key).toBeTruthy();
    expect(key!.startsWith(AUTO_BACKUP_PREFIX)).toBe(true);

    const list = listAutoBackups(s);
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe('文献入库前');
    expect(list[0]!.bytes).toBeGreaterThan(0);

    const raw = readAutoBackup(s, key!);
    expect(raw).toBeTruthy();
    const r = parseBackupFile(JSON.parse(raw!));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBe('文献入库前');

    deleteAutoBackup(s, key!);
    expect(listAutoBackups(s)).toHaveLength(0);
  });

  it('只留最近几份，新的在前', () => {
    const s = fakeStore(BASE);
    for (let i = 0; i < MAX_AUTO_BACKUPS + 2; i += 1) {
      saveAutoBackup(s, `第 ${i} 次`);
    }
    const list = listAutoBackups(s);
    expect(list).toHaveLength(MAX_AUTO_BACKUPS);
    expect(list[0]!.reason).toBe(`第 ${MAX_AUTO_BACKUPS + 1} 次`);
  });

  it('拒读 / 拒删非自动备份前缀的键（不许借备份接口动别的数据）', () => {
    const s = fakeStore(BASE);
    expect(readAutoBackup(s, 'wj_settings_v1')).toBeNull();
    deleteAutoBackup(s, 'wj_settings_v1');
    expect(s.dump()['wj_settings_v1']).toBe(BASE['wj_settings_v1']);
  });

  it('超大快照：只留最新一份，再超限就放弃而不抛', () => {
    const s = fakeStore({ wj_huge: 'x'.repeat(1_600_000) });
    const key = saveAutoBackup(s, '超大');
    expect(key).toBeNull();
    // 放弃了也不能把原数据冲掉
    expect(s.dump()['wj_huge']).toHaveLength(1_600_000);
  });
});
