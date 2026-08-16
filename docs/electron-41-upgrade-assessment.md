# Bigfish 项目深度分析 + 升级 Electron 41 改造评估

> 基于源码逐行分析（main.js、package.json、afterPack.js、CI workflow、dsh-bundle）与官方数据核查（Electron releases、npm registry、dsh 依赖树全量扫描）。
> 日期：2026-08 ｜ 状态：**改造完成（代码层面）+ Windows 开发模式验证通过（npm start ✅）；打包版验证待做**

---

## 第一部分：项目现状分析

### 1.1 架构总览（代码级）

```
main.js (Electron 主进程, 单文件 923 行)
├── 后端生命周期  startDsh() / stopDsh() / cleanupStaleDsh()
│     ├── findFreePort()          —— 找空闲 127.0.0.1 端口
│     ├── resolveRuntime()        —— 打包版：process.execPath + ELECTRON_RUN_AS_NODE=1
│     │                            开发版：系统 node
│     └── waitForReady()          —— 90s 轮询 http 就绪
├── 窗口体系      createWindow() / createPetWindow() / createWelcomeWindow()
├── 桌宠状态机    idle / eat / sleep / walk-left / walk-right（+ 定时随机语录）
├── 系统集成      Tray / globalShortcut(Ctrl+Shift+D) / setLoginItemSettings
│                 / Windows 右键菜单(reg 命令) / --open 参数
├── 通知          Notification + 启发式任务完成检测（监控 DSH_HOME 文件 mtime）
├── 新手向导      welcome.html + IPC
└── 更新检查      latest.json (GitHub raw) 版本对比 → 弹窗引导下载（托盘菜单手动触发，非自动）
```

### 1.2 依赖与构建链（升级后）

| 组件 | 现状 | 说明 |
|---|---|---|
| electron | `41.10.1` | 内置 Node 24.18.0，满足 dsh 的 `^22.19.0 || >=24.0.0` |
| electron-builder | `^24.0.0`（实测 24.13.3） | 用户本地缓存齐全（nsis/winCodeSign） |
| 后端 | `dsh-bundle/` 独立安装 `@deepseek-ai/dsh@0.1.0-rc.6` 纯生产依赖 | 规避 electron-builder 丢弃 rc 预发布包 |
| ~~Node 运行时~~ | **已删除** | 不再捆绑 node-runtime（-70MB） |
| afterPack.js | 用 build/rcedit-x64.exe 给 exe 嵌图标/版本 | 版本号已改为从 package.json 读取 |

### 1.3 代码观察（现状问题清单）

1. **main.js 单文件 923 行**，后端生命周期/托盘/桌宠/向导/通知/更新混杂；功能已稳定，重构优先级低。
2. **任务完成通知是启发式**：轮询 DSH_HOME 目录 mtime，30s 空闲判完成。无官方事件源，误报/漏报无法完全避免（可接受）。
3. **`--open <path>` 与右键菜单「用 Bigfish 打开」只唤起窗口 + 通知**，并未把文件内容交给 AI——功能是"半成品"，是潜在改进点。
4. **版本号管理已统一**：`afterPack.js` 改为从 package.json 读取版本（原硬编码 0.1.0.0 会漂移）。
5. **残留引用已清理**：package.json `files` 排除列表删除了不存在的 `probe-electron.js`、`analyze-pet.js`、`f00eacea....jpg`、`download-node.js`。
6. **安全**：更新检查拉取 GitHub raw 无签名校验（只是弹窗 + openExternal，风险低），且**已改为托盘菜单手动触发**（不再启动自动检查）；后端仅监听 127.0.0.1；所有窗口 sandbox + contextIsolation ✅。
7. **进程清理**：cleanupStaleDsh 用 PowerShell/pkill 匹配命令行杀进程，粗暴但有效；启动失败有自动重试 ✅。`ELECTRON_RUN_AS_NODE` 模式下命令行仍含 `dsh/lib/bin.js`，清理逻辑**无需改动**。
8. **dsh-bundle 无 lockfile**（只有 package.json），版本漂移风险；建议在 Windows 上完成 `cd dsh-bundle && npm install --omit=dev` 后提交生成的 package-lock.json。

---

## 第二部分：升级 Electron 41 改造评估（已执行）

### 2.1 结论

> **可行，已完成。** 分享对话中的判断得到官方数据证实；原生模块 ABI 的担忧经源码核查后**基本解除**（见 2.3）。

**执行方案：Electron 33.2.0 → 41.10.1 + `ELECTRON_RUN_AS_NODE` 复用内置 Node + 删除捆绑 Node。**
预期收益：安装包 **~160MB → ~90MB**；捆绑 Node 的全部配套（下载脚本、extraResources、CI 步骤、README 章节）已删除。

### 2.2 关键事实核查（官方数据）

| 事实 | 数据 | 来源 |
|---|---|---|
| Electron 41.0.0 内置 Node | **24.14.0**（2026-03-10 发布） | releases.electronjs.org |
| Electron 41.10.1 内置 Node | **24.18.0** | releases.electronjs.org |
| 顺带：Electron 40.0.0 已是 Node 24.11.1 | 也满足 dsh 要求（`>=24.0.0`） | releases.electronjs.org |
| dsh 的 Node 要求 | `^22.19.0 \|\| >=24.0.0`（deepseek-harness 根 package.json） | 官方仓库 |
| 当前最新 | Electron 43.4.0；electron-builder 26.15.3 | npm registry |

**选型说明**：定版 `electron@41.10.1`（用户本地 `%LOCALAPPDATA%\electron\Cache` 已有该版本 zip 缓存 + Yarn npm 缓存，Windows 安装免下载）；electron-builder 用 `^24.0.0`（用户本地 electron-builder 缓存齐全）。

### 2.3 原生模块核查 —— 结论：全部 N-API，无需 rebuild ✅

全量扫描 dsh 0.1.0-rc.6 依赖树（381 个包），原生模块只有 3 个，**全部是 N-API（Node-API）**：

| 模块 | 依赖方 | 类型 | Electron 41 下 |
|---|---|---|---|
| `koffi` ^3.1.0 | dsh-fs-local / directory-picker-native 等 4 包 | **N-API** | ✅ 直接可用 |
| `sharp` | dsh-attachment-local | **N-API prebuilt** | ✅ 直接可用 |
| `node-pty` ^1.1.0 | dsh-subprocess-local | **N-API**（node-addon-api ^7.1.0） | ✅ 直接可用 |

**关键实测**（本次改造中验证）：
- node-pty 1.1.0 的 package.json 依赖 `node-addon-api@^7.1.0`，已从旧版 NAN 迁移到 N-API；安装脚本 `node scripts/prebuild.js || node-gyp rebuild` 编译出的 `pty.node` 是 N-API 产物，**与 Node/Electron 的 ABI 无关**。
- 实测：用 Electron 41.10.1 headers 编译的 `pty.node` 与标准 Node 24 编译的 `pty.node`，**都能被系统 Node 24 直接加载**（N-API 特性）。
- 因此：**不需要 `@electron/rebuild`，不需要 VS Build Tools / node-gyp 工具链**。CI 与本地打包的构建链与升级前完全一致（只是少了个 node-runtime）。

> 顺带修正 README 旧说法："原生依赖（node-pty / sharp / koffi 等）需在各自目标平台上构建"——N-API 模块无需平台 ABI 编译（跨平台 prebuilt 或源码即装即用）。

> ⚠️ node-pty 仍是 **dsh Web 运行时的必需组件**（不是 CI 工具）：`dsh-base` 的 `cordis.patch.yml` 在 web profile 挂载 `dsh-subprocess-local`（web bundle 未禁用），其 `lib/index.js` 顶层静态 `import * as nodePty from "node-pty"`，启动即加载。只是由于它是 N-API，**加载不再有 ABI 风险**。

### 2.4 改造方案：`ELECTRON_RUN_AS_NODE`（已实施）

Electron 官方支持的环境变量：设置为 `1` 后，**Electron 可执行文件以纯 Node.js 模式运行**（不启动 Chromium/GPU）。打包版：

- `spawn(process.execPath, [bin, ...args], { env: { ..., ELECTRON_RUN_AS_NODE: '1' } })` 启动 dsh
- 用的是 Electron 41 内置的 **Node 24.18**，满足 dsh 要求
- **node-runtime 捆绑已删除**（约 70MB）

#### 已完成改动清单

| # | 文件 | 改动 | 状态 |
|---|---|---|---|
| 1 | `package.json` | `electron: 41.10.1`、`electron-builder: ^24.0.0`；`extraResources` 删除 `node-runtime` 项；`files` 清理残留排除项 | ✅ |
| 2 | `main.js` `resolveRuntime()` | 打包分支改为 `{ command: process.execPath, args: [bin], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }` | ✅ |
| 3 | `.github/workflows/build.yml` | 删除 3 个 `Prepare node-runtime` 步骤；node-version 22 → 24 | ✅ |
| 4 | `README.md` | 「为什么捆绑 Node 运行时」→「为什么不再捆绑」；删除「0. 准备 Node 运行时」；架构图/目录结构/体积说明更新 | ✅ |
| 5 | `download-node.js` | 删除 | ✅ |
| 6 | `afterPack.js` | 版本号改为从 package.json 读取（消除硬编码漂移） | ✅ |
| 7 | `setup-linux.sh` | 注释更新（N-API 无需编译，工具链留作兜底） | ✅ |
| 8 | `dsh-bundle/node_modules` | 本次验证时从 npx 缓存（`@deepseek-ai/dsh@0.1.0-rc.6` 完整依赖树）链接/复制；`.gitignore` 已忽略，不提交 | ✅ |

#### 已验证项

1. ✅ 主项目 `npm install` 成功（electron 41.10.1 + electron-builder 24.13.3，lock 已更新）
2. ✅ dsh-bundle 依赖就绪（Windows：复制 npx 缓存 `D:\nodejs\cache\_npx\1e7f6d9597241db0\node_modules`，dsh 0.1.0-rc.6，含 win32 原生模块 prebuilds）
3. ✅ **端到端后端验证**：dsh web 在 Node 24 下启动成功，HTTP 200，无原生模块错误（WSL 环境）
4. ✅ node-pty N-API 双重验证（Node headers 版与 Electron headers 版均可被 Node 24 加载）
5. ✅ **Windows 开发模式 `npm start` 验证通过**（用户实机 2026-08-16）：Electron 41.10.1 启动、dsh 后端拉起、基本功能正常
6. 升级过程中意外确认：npmmirror 的 Electron SHASUMS256.txt 带 `*` 前缀导致 node-gyp 校验失败——与本次改造无关，仅记录备查

#### 待验证项（Windows 打包版）

1. `npm run pack` 打包（electron-builder 缓存已有 nsis/winCodeSign，应免下载）→ 安装包体积确认（预期 ~90MB）
2. 打包版启动：确认 dsh 由 Bigfish.exe 以 ELECTRON_RUN_AS_NODE 拉起（任务管理器看命令行含 `dsh/lib/bin.js`），`http://127.0.0.1:<port>` 正常
3. 全量回归：桌宠（点击穿透/拖动/动画）、托盘、全局快捷键、通知、开机自启、右键菜单、背景图注入（**背景 CSS 依赖 DSH UI 类名，Chromium 146 下需目视确认**）

#### 兼容性核查（33 → 41 破坏性变更）

项目用到的 Electron API 全部稳定，无迁移风险：
`BrowserWindow / Tray / Menu / globalShortcut / Notification / ipcMain / screen / shell / dialog / nativeImage / app.requestSingleInstanceLock / second-instance / setLoginItemSettings / setIgnoreMouseEvents / insertCSS / setWindowOpenHandler / will-navigate`。
（Electron 35 移除的 BrowserView 项目未使用；其余 breaking change 集中在 Chromium 行为，与本项目无交集。）

### 2.4.1 升级实战中踩过的坑（记录备查）

1. **Electron 定制 Node 下 `node-addon-require-builtin` 失效 → 必须加 `--expose-internals`**：dsh 的 HMR 服务（launcher 无条件创建，无禁用开关）需要访问 Node `internal/modules/esm/loader`。标准 Node 下靠 `node-addon-require-builtin`（N-API 插件）探测；但它在 **Electron 定制 Node** 下探测失败（内部结构差异），导致 `loader.internal` 为空 → dsh 后端启动即失败。实测 Electron 41.10.1 的 Node 支持 `--expose-internals` 后原生 `require('internal/...')` 正常。**解决：spawn 参数改为 `['--expose-internals', bin, ...]`（Node 启动标志必须在脚本路径前）**。症状：`failed to apply loader entry <hash> (@deepseek-ai/cordis-plugin-hmr): --expose-internals is required for HMR service`。
2. **用户 `~/.dsh` profile 引用外部插件会拖垮后端**：本机 `profiles/web/package.json` 的 bundles 含 `link:` 到私有路径的皮肤插件（maid-atelier），link 失效后 dsh 启动即失败。**解决：打包版用独立 DSH_HOME（`userData/dsh-home`）**，与命令行 dsh 配置完全隔离。
3. **用户 `.npmrc` 的 `python` 配置警告**：旧 node-gyp 时代的 `python2/python/python3` 键，npm 新版本不识别，删除即可。
4. **npmmirror 的 Electron SHASUMS256.txt 带 `*` 前缀**导致 node-gyp 校验失败（`local checksum ... not match remote undefined`），官方 electronjs.org 的 SHASUMS 无星号可正常使用——仅影响手动 rebuild 场景（本项目 N-API 模块无需 rebuild）。

### 2.5 备选方案对比（供后续参考）

| 方案 | 说明 | 优劣 |
|---|---|---|
| **A. ELECTRON_RUN_AS_NODE（已采用）** | spawn 自身二进制跑 dsh | 改动最小（1 处函数）；进程模型与现状一致；无原生模块顾虑 |
| B. `utilityProcess.fork()` | Electron ≥22 官方子进程 API | 更"正统"，但 stdio/信号处理需重写 startDsh/stopDsh；收益与 A 相同，成本更高 |
| C. 保持捆绑 Node | 仅升 electron-builder | 零风险但放弃全部收益；捆绑 Node 维护负担持续存在 |

### 2.6 收益与成本汇总

**收益**
- 安装包体积 **~160MB → ~90MB**（去掉 node-runtime 约 70MB）
- 删除 download-node.js、CI 的 node-runtime 步骤、README 大段说明——**构建链显著简化**
- Node 运行时版本随 Electron 自动跟进（不再手动维护 v24.x）
- 原生模块全部 N-API，**无 ABI 维护负担**

**成本/风险**
- Electron 33→41 跨 8 个大版本，Chromium 146 的渲染行为差异需回归（**背景注入 CSS 依赖类名，升级后必须目视验证**；桌宠/托盘等功能 API 层面无风险）
- 若未来 dsh 引入非 N-API 原生模块，才需要考虑 rebuild（当前无）
- npm 11 的 allow-scripts 机制可能拦截 electron postinstall（用户 Windows 如遇此问题：`npm approve-scripts` 或使用 npm 10）

### 2.7 后续建议

1. **Windows 实机验证**（见 2.4 待验证项），通过后提交代码
2. 顺手可做：`latest.json` 版本号与 package.json 对齐；提交 dsh-bundle/package-lock.json；`download-electron.js` 若不再需要可删
3. 若安装包降到 90MB 以下（<100MB），可考虑直接随仓库分发，但 Releases 仍是更优渠道

---

## 附：与分享对话结论的差异点

| 分享对话的说法 | 本次代码级核查 |
|---|---|
| "升级 Electron 41 技术上可行" | ✅ 证实（41.0.0 = Node 24.14.0，官方数据） |
| "捆绑 Node 是为规避原生模块 ABI 风险" | ❌ **已过时**：node-pty 1.1.0 / koffi / sharp **全部是 N-API**，与 ABI 无关，无需 rebuild；该风险实际不存在 |
| "升级需跨版本 API 适配，成本高" | ✅ 部分成立：项目用到的 API 在 33→41 无破坏性变更；真正成本在**回归测试**（Chromium 146 渲染 + 背景 CSS 注入） |
| "安装包 160MB 因捆绑 Node" | ✅ 成立：node-runtime（Node 24 win-x64 约 70MB）是最大单项，现已去除 |
