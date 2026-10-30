# 问津 / 致知 —— 项目长期记忆

> 权威版本：3.9.2（2026-10-30）· 仓库 `github.com/hillen24/zhizhi`（GPL-3.0）
> 交付目录 `D:/问津/`（exe + apk + 使用说明.md + 路线图.md）

## 定位

「致知 · 思想栖所」——思想训练场。四模块闭环：概念星系 / 精读伴读 / 日常格物 / 论道。
产品原则（任何取舍回来对这四条）：①追问优先于答案 ②每次使用必须落到可操作的一步
③数据在家（断网全功能可用）④克制。

## 架构铁律

- `packages/core` 不认识 Vue / Electron / Capacitor；`packages/app` 认识 Vue 但不认识运行壳；
  只有 `apps/*` 知道自己跑哪儿。
- **core 层全部逻辑抽成纯函数**才可单测。请求体拼装这类最容易错的地方必须抽（见 `tts/synth.ts`）。
- 单测 305 条 / typecheck 0 错是发版门槛。
- 视觉验收走 Playwright 实拍（Chromium 在 `C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243`），
  静态服务必须 Bash `run_in_background=true` 起。

## 各端运行壳的关键事实（都是踩出来的）

| 事实 | 说明 |
|---|---|
| **安卓 WebView 没有 speechSynthesis** | 系统语音引擎在手机上等于哑的 → 手机端要出声只能走云端 TTS |
| **CapacitorHttp 会毁掉二进制** | 非 JSON 响应走 `readStreamAsBase64()` 送回字符串 → 必须 `responseType:'arraybuffer'` + 解回 Blob |
| **atob 结果不能直接进 Blob** | binary string 会被 UTF-8 再编码 → 必须先转 Uint8Array |
| 手机顶栏底栏不用 backdrop-filter | Android WebView 合成层不稳 |
| 手机版硬编码版本号 = 定时炸弹 | 已改为 vite define 构建期注入 |
| `hash` 路由 + 安卓返回键 = 用户被弹退出应用 | 已改显式页面栈 |

## 已实现的关键能力

- AI：多服务商路由 + 三级降级（真模型 → 兜底服务商 → 离线剧本），接入门禁 `aiVerified`
- 文献研读 Agent：分段提取 / 容灾运行 / 质检漏斗 / 四处入库
- 公版全文书 14 部（道德经 81 段、庄子 98 段 2.2 万字、皮科编译本…）
- **版权立场**：现代中译本仍在保护期的（尼采/克尔凯郭尔）**不内置**，留给用户导入
- TTS 三引擎：系统内置 / Edge 桥 / **云端 API（3.9.2 补真的）**
- 数据备份（一键导出/自动/恢复）+ 局域网同步（整机快照覆盖）
- 双端：Electron portable exe / Capacitor debug apk

## 自定义 TTS 的结构（3.9.2 新增，改动前先读）

- `core/src/tts/providers.ts`：服务商预设表。**音色两种拼法**——
  OpenAI 音色独立命名原样用；硅基流动是「模型名:音色名」，表里存后缀、合成时拼**生效模型**前缀
  （用预设模型是 bug：用户改模型后音色 id 留在旧模型上，服务端报「音色不存在」）。
- `core/src/tts/synth.ts`：请求构造纯函数。三个自定义口子：端点路径、附加请求头、附加请求体。
- `probe()` 自检失败时**必须透传服务端说的真原因**（`HTTP 401 · Token is invalid.`），
  只报 HTTP 码等于让用户瞎猜。

## 后续方向

见 `docs/路线图.md`。核心判断：**v3.9 解决「能不能用」，v4.0 要解决「长出习惯」**。
优先级前三：①星图自生长 ②检索增强的伴读（让 AI 记住你）③每日回看（留存分水岭）。
公网化是最后的事且很可能永远不做——价值在于安静、属于自己。

## 踩坑备忘

- **grid 子项的自动最小尺寸 = 内容高度** → 内层 `overflow:auto` 永远不触发，
  必须 `.wrap > * { min-height: 0 }`。这个坑在 3.9.1 精读伴读上犯过一次。
- electron-builder 每次版本变更后**第一次 dist 必失败**（safe-delete 拦 dist-app 清理）→ 重跑即过。
- 两个同名「测试连接」按钮（AI 区 + 语音区）→ 自动化测试要按 h2 定位 section。
- Playwright mobile context 未必满足 `hover:none and pointer:coarse` → CSS 断点别只靠 pointer 特性。
- 沙箱里 Playwright 截图 Read 出来无图 → 改用 DOM 精确测量，数字比肉眼可靠。
