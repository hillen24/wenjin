/* 问津 · 电脑版 Electron 主进程 */
/* ---- 自愈：本机若设有 ELECTRON_RUN_AS_NODE=1，Electron 会被当成纯 Node 跑 ----
   ⚠️ 这段必须先于 require('electron')：RUN_AS_NODE 模式下那一行会直接抛
   "Cannot find module 'electron'"，整个 main.js 在第 2 行就崩了，
   用户看到的现象就是"双击 exe 没反应"（便携版没有控制台，错误无从显示）。
   所以这里先检查环境变量，清掉它后把自己重新拉起来，然后退出。 */
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('child_process');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; // 清掉它，用真正的 GUI 模式重启自己
  /* 打包后的便携版里 process.argv[1] 是 undefined——原样传进去 spawn 会失败。
     这里先把空参数滤掉：打包态传空数组（重新加载 asar 的 main），开发态保留入口路径。 */
  const args = process.argv.slice(1).filter((a) => typeof a === 'string' && a.length > 0);
  try {
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', env }).unref();
  } catch (e) {
    /* 连重启都失败就没什么可做的了，安静退出即可 */
  }
  process.exit(0);
}

const electronApi = require('electron');
const { app, BrowserWindow, shell } = electronApi;

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    title: '问津 · 思想栖所',
    backgroundColor: '#0B0E14',
    autoHideMenuBar: true,
    webPreferences: {
      // 本地单机应用：放开同源策略，让设置页里的 Ollama / DeepSeek / Edge-TTS 直连不被 CORS 挡
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  // 外部链接交给系统浏览器，应用内不跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(require('path').join(__dirname, 'www', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
