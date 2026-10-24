/**
 * 电脑端同步桥 · 渲染侧
 *
 * 主进程负责监听端口，但数据在渲染进程的 localStorage 里。
 * 这个模块做两件事把两边接上：
 *   1. 本机数据一变就把新快照交给主进程（手机上拉到的就是这一份）
 *   2. 主进程收到手机推上来的数据后，落盘并整页重载
 *
 * 为什么不直接监听 localStorage 事件：同文档内写 localStorage 不触发 storage 事件
 * （那是给别的标签页用的）。这里用「轻量指纹轮询」——只数键名和值的长度，
 * 不复制不序列化，10 个键的开销可以忽略。
 */

import { collectSnapshot } from '@wenjin/core';
import { applyIncoming, reloadSoon } from './lan';

const POLL_MS = 2000;

/** 只数长度，够判断"变了没有" */
function fingerprint(): string {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('wj_')) continue;
    n += 1;
    sum += k.length + (localStorage.getItem(k)?.length ?? 0);
  }
  return `${n}:${sum}`;
}

export function setupDesktopSync(): void {
  const bridge = typeof window !== 'undefined' ? window.wjBridge : undefined;
  if (!bridge) return;

  let last = '';

  function push(force = false): void {
    const now = fingerprint();
    if (!force && now === last) return;
    last = now;
    try {
      bridge!.pushSnapshot(collectSnapshot(localStorage, '电脑'));
    } catch {
      /* 快照失败不影响应用本身 */
    }
  }

  // 立刻交一份，手机连上来就有数据可拉
  push(true);
  const timer = window.setInterval(() => push(), POLL_MS);

  // 关窗前再交一次，避免最后几秒的改动没同步过去
  window.addEventListener('beforeunload', () => {
    window.clearInterval(timer);
    push(true);
  });

  bridge.onIncoming((raw) => {
    const r = applyIncoming(raw);
    if (r.ok) {
      /* 重载是故意的：设置/藏书/格物卡分别缓存在不同 store 里，
         逐个通知刷新太容易漏，整页重载最稳，代价只有几百毫秒。 */
      reloadSoon();
    }
  });
}
