#!/usr/bin/env bash
set -e

echo "== Bigfish Linux 开发环境准备 =="

# 1. 检查 Node（dsh 需要 Node >= 22）
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js，请先安装 Node 22+："
  echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  exit 1
fi
echo "✅ Node $(node -v)"

# 2. 原生模块（node-pty / sharp / koffi）均为 N-API，标准安装即可；
#    保险起见仍安装编译工具（某些平台 prebuild 下载失败时回退源码编译）
if ! command -v gcc >/dev/null 2>&1; then
  echo "安装 build-essential（原生模块编译兜底需要）..."
  sudo apt-get update -y
  sudo apt-get install -y build-essential python3
fi

# 3. 安装依赖（国内网络设 DSH_CN_MIRROR=1 走镜像）
if [ "${DSH_CN_MIRROR:-0}" = "1" ]; then
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo "使用国内 electron 镜像"
fi
npm install

# 4. 启动
echo "== 启动 Bigfish =="
npm start
