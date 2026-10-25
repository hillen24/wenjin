/* 致知 · 电脑端 preload
 *
 * 渲染进程是 contextIsolation: true 的，碰不到 Node，也碰不到主进程。
 * 这个桥只开几个口子，全部围绕「本机数据」两件事：
 *   局域网同步：info() / pushSnapshot / onIncoming
 *   数据备份：  backupDir / saveBackup / listBackups / readBackup /
 *               deleteBackup / exportBackup（弹另存为）
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

  /* ---------- 数据备份 ---------- */

  backupDir: () => ipcRenderer.invoke('wj:backupDir'),

  saveBackup: (text, reason) => ipcRenderer.invoke('wj:saveBackup', text, reason),

  listBackups: () => ipcRenderer.invoke('wj:listBackups'),

  readBackup: (name) => ipcRenderer.invoke('wj:readBackup', name),

  deleteBackup: (name) => ipcRenderer.invoke('wj:deleteBackup', name),

  exportBackup: (defaultName, text) => ipcRenderer.invoke('wj:exportBackup', defaultName, text),
});
