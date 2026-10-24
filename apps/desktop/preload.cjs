/* 问津 · 电脑端 preload
 *
 * 渲染进程是 contextIsolation: true 的，碰不到 Node，也碰不到主进程。
 * 这个桥只开三个口子，全部围绕「局域网同步」一件事：
 *   info()        —— 拿本机 IP / 端口 / 版本，用来在设置页亮出地址
 *   pushSnapshot  —— 把渲染进程（localStorage）里的数据交给主进程，供手机拉取
 *   onIncoming    —— 手机推上来的数据，主进程转给渲染进程去落盘
 *
 * 刻意不暴露 ipcRenderer 本体：一旦整个 ipcRenderer 暴露出去，
 * 渲染进程就能往任意 channel 发消息，这层隔离就白做了。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wjBridge', {
  desktop: true,

  info: () => ipcRenderer.invoke('wj:info'),

  pushSnapshot: (snap) => {
    ipcRenderer.send('wj:snapshot', snap);
  },

  onIncoming: (cb) => {
    ipcRenderer.on('wj:incoming', (_e, snap) => {
      try {
        cb(snap);
      } catch (err) {
        /* 渲染侧抛错不该连累主进程 */
      }
    });
  },
});
