/* 致知 · 电脑端 Electron 主进程（3.7）
 *
 * 除了开窗口，还担着一件事：**本机局域网同步服务**。
 * 手机端是 WebView，起不了 HTTP 服务，所以由电脑当服务端、手机来连。
 * 服务只做三件事：报活、给出本机快照、接收手机推上来的快照。
 */

/* ---- 自愈：本机若设有 ELECTRON_RUN_AS_NODE=1，Electron 会被当成纯 Node 跑 ----
   ⚠️ 这段必须先于 require('electron')：RUN_AS_NODE 模式下那一行会直接抛
   "Cannot find module 'electron'"。
   注意：打包成便携版后这段实际上不会被执行（RUN_AS_NODE 下 Electron 根本不加载
   这个 main 文件，而是按 node 起一个交互式 shell 挂住），真正能救的只有开发态。
   便携版遇到这个环境变量怎么办，写在《使用说明》里。 */
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('child_process');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  /* 便携版：process.execPath 指向临时解压目录里那份，父进程退出后启动器会
     删掉这个目录，所以必须从用户双击的原始 exe 重来一遍。 */
  const portable = env.PORTABLE_EXECUTABLE_FILE;
  const exe = portable || process.execPath;
  const args = portable
    ? []
    : process.argv.slice(1).filter((a) => typeof a === 'string' && a.length > 0);
  try {
    spawn(exe, args, { detached: true, stdio: 'ignore', env }).unref();
  } catch (e) {
    /* 连重启都失败就没什么可做的了，安静退出即可 */
  }
  process.exit(0);
}

const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');

/* ============================================================
 * 数据备份（磁盘文件）
 *
 * 渲染进程的 localStorage 有 5MB 配额且换台电脑就没了，真正的备份
 * 必须是本机磁盘上的文件。目录取 userData/backups（便携版也在
 * %APPDATA% 下，卸载软件不会误删用户数据）。
 * ============================================================ */

const MAX_DISK_BACKUPS = 10;

/** 备份文件名白名单：只认我们自己的命名，挡掉路径穿越 */
const BACKUP_NAME_RE = /^wj-backup-[\w\u4e00-\u9fa5-]+\.json$/;

function backupDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeReason(r) {
  return (
    String(r || 'backup')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .slice(0, 20) || 'backup'
  );
}

function backupStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 按 mtime 排序，只留最近 MAX_DISK_BACKUPS 份 */
function pruneDiskBackups() {
  try {
    const dir = backupDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => BACKUP_NAME_RE.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    while (files.length > MAX_DISK_BACKUPS) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(dir, old.f));
    }
  } catch {
    /* 清理失败不影响备份本身 */
  }
}

ipcMain.handle('wj:backupDir', () => backupDir());

ipcMain.handle('wj:saveBackup', (_e, text, reason) => {
  try {
    const dir = backupDir();
    const name = `wj-backup-${backupStamp(new Date())}-${safeReason(reason)}.json`;
    fs.writeFileSync(path.join(dir, name), String(text), 'utf8');
    pruneDiskBackups();
    return { ok: true, name, path: path.join(dir, name) };
  } catch (e) {
    return { ok: false, reason: `写备份失败：${e.message}` };
  }
});

ipcMain.handle('wj:listBackups', () => {
  try {
    const dir = backupDir();
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!BACKUP_NAME_RE.test(f)) continue;
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      let at = st.mtimeMs;
      let reason = '';
      try {
        const snap = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (typeof snap.at === 'number') at = snap.at;
        if (typeof snap.reason === 'string') reason = snap.reason;
      } catch {
        reason = '（损坏）';
      }
      out.push({ name: f, at, reason, bytes: st.size });
    }
    return out.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
});

ipcMain.handle('wj:readBackup', (_e, name) => {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
    return { ok: false, reason: '文件名不合法' };
  }
  try {
    return { ok: true, text: fs.readFileSync(path.join(backupDir(), name), 'utf8') };
  } catch (e) {
    return { ok: false, reason: `读备份失败：${e.message}` };
  }
});

ipcMain.handle('wj:deleteBackup', (_e, name) => {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
    return { ok: false, reason: '文件名不合法' };
  }
  try {
    fs.unlinkSync(path.join(backupDir(), name));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `删除失败：${e.message}` };
  }
});

/** 导出备份文件：弹系统另存为，用户自己选位置（U 盘 / 网盘目录） */
ipcMain.handle('wj:exportBackup', async (_e, defaultName, text) => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: defaultName || '致知备份.json',
    filters: [{ name: '致知备份', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  try {
    fs.writeFileSync(r.filePath, String(text), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, reason: `写入失败：${e.message}` };
  }
});

/* ============================================================
 * 局域网同步服务
 * ============================================================ */

const SYNC_PORT = 47800;
const SYNC_APP = 'wenjin-sync';
/** 与 core/sync 的上限一致，超过就拒绝，绝不半截写入 */
const MAX_BODY = 12 * 1024 * 1024;

/** 渲染进程交上来的最新快照。手机来拉的就是这一份。 */
let latest = null;

/** 真正监听成功的端口（47800 被占用时会顺延） */
let syncServer = null;
let boundPort = SYNC_PORT;

/** 本机内网 IPv4，优先常见的家用网段 */
function lanIP() {
  const found = [];
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      found.push(a.address);
    }
  }
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || '127.0.0.1';
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从快照里数出几样东西，给手机端「连上后先看看对面有什么」 */
function snapshotStats(snap) {
  const data = (snap && snap.data) || {};
  const books = parseJSON(data.wj_user_books || 'null');
  const materials = parseJSON(data.wj_materials_v1 || 'null');
  return {
    cards: Array.isArray(materials && materials.cards) ? materials.cards.length : 0,
    books: Array.isArray(books) ? books.length : 0,
  };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJSON(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function startSyncServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    /* 手机 WebView 的 origin 是 http://localhost，跨域到 http://192.168.x.x
       —— 必须带 CORS 头，且要应答预检，否则请求根本到不了这里。 */
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url === '/wj/ping') {
      const stats = snapshotStats(latest);
      sendJSON(res, 200, {
        app: 'wenjin',
        device: '电脑',
        host: os.hostname(),
        version: app.getVersion(),
        hasData: !!latest,
        cards: stats.cards,
        books: stats.books,
      });
      return;
    }

    if (req.method === 'GET' && url === '/wj/snapshot') {
      if (!latest) {
        sendJSON(res, 503, { ok: false, reason: '电脑还没准备好数据' });
        return;
      }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(latest));
      return;
    }

    if (req.method === 'POST' && url === '/wj/snapshot') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          sendJSON(res, 413, { ok: false, reason: '数据太大' });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        let snap = null;
        try {
          snap = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          sendJSON(res, 400, { ok: false, reason: 'JSON 解析失败' });
          return;
        }
        /* 与 core/sync 同一套校验口径：只认自家快照。
           这挡不住同局域网里的恶意请求，但能防止一段乱数据把本机存储写坏 ——
           写坏了用户是真的会丢记录。 */
        if (!snap || snap.app !== SYNC_APP || typeof snap.data !== 'object' || Array.isArray(snap.data)) {
          sendJSON(res, 400, { ok: false, reason: '不是致知的快照' });
          return;
        }
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('wj:incoming', snap);
        }
        sendJSON(res, 200, { ok: true });
      });
      return;
    }

    sendJSON(res, 404, { ok: false, reason: '没有这个接口' });
  });

  /**
   * 端口被占用（常见原因：同时开了两个致知）时往后顺延。
   * 早先这里是静默失败，设置页只会显示「服务没起来」，
   * 用户看到地址却连不上，比直接给个新端口更让人困惑。
   */
  const tryListen = (port, left) =>
    new Promise((resolve) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && left > 0) {
          resolve(tryListen(port + 1, left - 1));
          return;
        }
        resolve(0);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });

  syncServer = server;
  void tryListen(SYNC_PORT, 5).then((port) => {
    if (port) {
      boundPort = port;
      /* 监听成功之后不能再挂一次性错误处理，否则一次客户端断连就把进程带崩 */
      server.on('error', () => {});
    }
  });

  return server;
}

ipcMain.on('wj:snapshot', (_e, snap) => {
  if (!snap || snap.app !== SYNC_APP || typeof snap.data !== 'object') return;
  latest = snap;
});

ipcMain.handle('wj:info', () => {
  /* 读真实监听端口，端口顺延过的话这里也跟着变 */
  const addr = syncServer && syncServer.listening ? syncServer.address() : null;
  const port = addr && typeof addr === 'object' && addr.port ? addr.port : boundPort;
  return {
    ip: lanIP(),
    port,
    host: os.hostname(),
    version: app.getVersion(),
  };
});

/* ============================================================
 * 窗口
 * ============================================================ */

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    title: '致知 · 思想栖所',
    backgroundColor: '#0B0E14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      /* 本地单机应用：放开同源策略，让设置页里的 Ollama / DeepSeek / Edge-TTS
         直连不被 CORS 挡。这台的配置本来就是给本机服务用的，不存在跨站攻击面。 */
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

  /* 3.0 起前端产物是 Vite 构建的 dist（不再是单个 HTML）。
     路径必须相对 __dirname —— 打包进 asar 后 CWD 不是应用目录。 */
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(() => {
  syncServer = startSyncServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (syncServer) syncServer.close();
  if (process.platform !== 'darwin') app.quit();
});

/* 退出前最后一份备份。数据在渲染进程的 localStorage 里，主进程手里的 latest
   是最新推送的快照（每 2 秒或有变化就推一次）——写它，比在渲染进程的
   beforeunload 里发起异步写更可靠（窗口关了写盘可能被腰斩）。 */
app.on('before-quit', () => {
  if (!latest) return;
  try {
    const dir = backupDir();
    const name = `wj-backup-${backupStamp(new Date())}-退出前.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...latest, reason: '退出前' }), 'utf8');
    pruneDiskBackups();
  } catch {
    /* 备份失败不该拦住退出 */
  }
});
