# Bigfish Electron 41 升级实战排障记录

> 记录 2026-08-16 从 Electron 33 → 41.10.1 升级过程中遇到的全部问题、根因与解决方案。
> 关联文档：`docs/electron-41-upgrade-assessment.md`（升级评估与改动清单）。

---

## 排障时间线总览

| # | 阶段 | 症状 | 根因 | 解决 |
|---|---|---|---|---|
| 1 | 打包版启动 | 等几分钟才弹「Timed out waiting for backend」 | 用户 `~/.dsh` profile 引用失效的 link 插件，dsh 启动即退出，主进程傻等超时 | 打包版独立 DSH_HOME + 进程退出立即报错 |
| 2 | 打包版启动 | `--expose-internals is required for HMR service` | `node-addon-require-builtin` 在 Electron 定制 Node 下探测 internal 模块失败 | spawn 参数加 `--expose-internals`（放脚本路径前） |
| 3 | 开发模式 | `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` | 诊断时设置的 `ELECTRON_RUN_AS_NODE=1` 残留在 PowerShell 窗口，`electron .` 变纯 Node 模式 | 清除环境变量 + main.js 加防御性检测 |
| 4 | 任何 npm 命令 | `Unknown user config "python2/python/python3"` | 用户 `.npmrc` 里 node-gyp 时代的旧配置 | 删除这三行（N-API 时代已无用） |
| 5 | 安装/复制 | robocopy 错误 267「目录名称无效」 | WSL 里创建的 symlink（指向 WSL 内路径）在 Windows 侧是无效链接，占据目标路径 | 删除坏链接后重新复制 |

---

## 问题 1：打包版启动极慢 + Timed out

**症状**：双击 `Bigfish.exe` 后几分钟无响应，最终弹窗：
```
Failed to start the DeepSeek Harness backend:
Timed out waiting for the backend at http://127.0.0.1:2961
```

**排查**：GUI 程序无控制台，后端输出全部丢失。先给 `startDsh()` 加了**后端日志落盘**（`%APPDATA%\bigfish\backend.log`），再手动用 Electron 二进制以 `ELECTRON_RUN_AS_NODE` 复现，拿到真实错误：

```
Error: failed to apply loader entry ... (@dsh-external/dsh-client-ui-skin-maid-atelier):
Cannot find package '@dsh-external/dsh-client-ui-skin-maid-atelier'
```

**根因**：用户本机 `C:\Users\Neo\.dsh\profiles\web\package.json`（命令行 dsh 的 profile）的 `dsh.profile.bundles` 里有一个 **link 安装的外部皮肤插件**（maid-atelier，`link:E:/AI_ML/...` 指向本地开发目录），该路径已失效 → cordis loader 加载 bundle 失败 → **dsh 后端进程直接退出** → `waitForReady` 轮询 90s 超时 + 重试 90s → 弹窗。这就是"等几分钟"的来源——不是慢，是**后端根本没起来，主进程在傻等**。

**修复（两层）**：
1. **产品层面（根治）**：打包版改用**独立 DSH_HOME**（`%APPDATA%\bigfish\dsh-home`），与用户命令行 dsh 的 `~/.dsh` 完全隔离——普通用户机器上任何 dsh 配置/插件污染都不影响 Bigfish。开发模式保持默认 `~/.dsh` 便于调试复用。
2. **体验层面**：后端进程**提前退出时立即 reject**（不再傻等满超时）；超时从 90s 放宽到 180s；错误弹窗附 backend.log 尾部内容和日志路径。

**顺带发现**：`main.js` 的 `cleanupStaleDsh` 原来只匹配 `node.exe`，而 `ELECTRON_RUN_AS_NODE` 模式下子进程名是 `Bigfish.exe`——已改为两者都匹配（否则崩溃残留无法清理）。

---

## 问题 2：`--expose-internals is required for HMR service`

**症状**：独立 DSH_HOME 生效后，backend.log 显示新错误：
```
Error: failed to apply loader entry 38f51cdc (@deepseek-ai/cordis-plugin-hmr):
--expose-internals is required for HMR service
```

**排查**（读 dsh 源码）：
- `dsh --profile web` 启动时，launcher（`apps/cli/src/profile-boot.ts`）**无条件创建** watch-only HMR 实例（web bundle 禁用了共享 hmr 行，注释明确"无禁用开关"）。
- `cordis-plugin-hmr` 构造时检查 `this.ctx.loader.internal`，为空即抛错。
- `loader.internal` 来自 `ModuleLoader.fromInternal()`，有两条路径：
  1. `process.execArgv` 含 `--expose-internals` → 直接 `require('internal/modules/esm/loader')`；
  2. 否则用 `node-addon-require-builtin`（N-API 插件，运行时探测 Node 内部模块）。
- **Electron 内置 Node 是定制版**（基于 Node 24.18 打补丁），`node-addon-require-builtin` 的探测在它下面**静默失败** → `loader.internal` 为空 → HMR 抛错 → 后端启动失败。开发模式用系统标准 Node，该插件正常，所以 npm start 没事。

**验证**：Electron 二进制 + `--expose-internals` 下 `require('internal/modules/esm/loader')` 返回正常（`internal OK: function`），完整 `dsh web` 启动成功。

**修复**：`resolveRuntime()` 打包分支的 spawn 参数改为 `['--expose-internals', bin, ...]`——**Node 启动标志必须放在脚本路径之前**，否则会被当作脚本参数。

---

## 问题 3：npm start 报 `requestSingleInstanceLock` TypeError

**症状**：打包版正常后，开发模式 `npm start` 崩：
```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
Node.js v24.18.0
```

**根因**：**环境变量残留**。排障过程中在 PowerShell 执行过 `$env:ELECTRON_RUN_AS_NODE="1"`，PowerShell 窗口内该变量一直生效。此时 `electron .` 实际以**纯 Node 模式**运行 main.js——`require('electron')` 在非 Electron 环境下返回的是**二进制路径字符串**而非 API 对象，解构出 `app = undefined`。`Node.js v24.18.0`（Electron 内置 Node 版本号）是线索。

**修复**：
1. 新开 PowerShell 窗口，或 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 后重跑。
2. `main.js` 顶部加**防御性检测**：发现 `ELECTRON_RUN_AS_NODE` 残留时打印明确提示并退出（替代诡异的 TypeError）。

---

## 问题 4：npm 警告 Unknown user config "python"

**症状**：每条 npm 命令都出现：
```
npm warn Unknown user config "python2". This will stop working in the next major version of npm.
npm warn Unknown user config "python". ...
npm warn Unknown user config "python3". ...
```

**根因**：`C:\Users\Neo\.npmrc` 里有 node-gyp 时代的 `python2=/python=/python3=` 三行（指定 Python 路径用于编译原生模块）。npm 新版不识别这些键。**N-API 时代所有 dsh 原生模块（node-pty 1.1.0 / koffi / sharp）无需编译，配置已无用**。

**修复**：
```powershell
(Get-Content "$env:USERPROFILE\.npmrc") | Where-Object { $_ -notmatch '^python' } | Set-Content "$env:USERPROFILE\.npmrc"
```
（保留 `registry` / `prefix` / `cache` 等有效配置）

---

## 问题 5：robocopy 错误 267「目录名称无效」

**症状**：Windows 侧复制 npx 缓存到 `dsh-bundle\node_modules` 时报 `错误 267 (0x0000010B) 正在访问目标目录`。

**根因**：WSL 验证环境里为省时创建了 `dsh-bundle/node_modules -> /home/neo/.npm/_npx/...` 的 **symlink**（`.gitignore` 忽略、不随 git 提交，但同盘挂载在 Windows 侧可见）。Windows 看到的是指向 WSL 内部路径的**无效链接文件**，robocopy 把目标当目录访问即报 267。

**修复**：删除坏链接（`rm dsh-bundle/node_modules`，只删链接不影响 WSL 缓存）后重新 robocopy。

**教训**：同一工作区被 WSL 和 Windows 双端操作时，避免在共享目录里创建跨平台符号链接。

---

## 经验总结（对后续维护的启示）

1. **GUI 程序必须给子进程留日志**：没有 backend.log，问题 1/2 只能盲猜。现在 `startDsh()` 自动落盘 `%APPDATA%\bigfish\backend.log`，错误弹窗自带日志尾部。
2. **"启动慢"先查"是否根本没起来"**：`waitForReady` 无法感知子进程死亡，进程退出立即报错是必备能力。
3. **Electron 定制 Node ≠ 标准 Node**：`ELECTRON_RUN_AS_NODE` 复用内置 Node 的方案整体可行，但依赖"标准 Node 内部结构"的插件（如 node-addon-require-builtin）会失效——用 `--expose-internals` 走官方路径绕开。未来若 dsh 新增类似依赖，优先排查这一层。
4. **桌面产品要用自己的 DSH_HOME**：命令行 dsh 的 profile 可能被用户装各种实验性插件（link 到本机私有路径），桌面客户端必须隔离，否则"开箱即用"无从谈起。
5. **环境变量残留是 Windows 排查的常见陷阱**：`$env:XXX` 在 PowerShell 窗口内持久，跨命令测试后记得清除或换窗口。
