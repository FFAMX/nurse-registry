#!/usr/bin/env bash
# 护士电子化注册信息系统 - 一键启动（macOS / Linux、以及 Windows 的 Git Bash）

set -e
cd "$(dirname "$0")"

echo ""
echo "  =========================================================="
echo "    护士电子化注册信息系统 - 一键启动"
echo "  =========================================================="
echo ""

# ---- 1. 定位 Node.js ----
# 顺序：项目自带的便携版（若有 Linux 版）→ 系统 PATH
NODE_BIN=""

if [ -x "portable-node/bin/node" ]; then
  NODE_BIN="portable-node/bin/node"
elif [ -x "portable-node/node" ]; then
  NODE_BIN="portable-node/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "  [错误] 未检测到 Node.js"
  echo ""
  echo "  请先安装 Node.js（建议 18 及以上版本）："
  echo "    https://nodejs.org/zh-cn/download"
  echo ""
  echo "  或把对应平台的便携版 Node 放到项目目录："
  echo "    portable-node/bin/node"
  echo ""
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -v)"
echo "  [1/4] Node.js $NODE_VERSION"
echo "        路径：$NODE_BIN"

# 版本校验：需要 >= 18
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo ""
  echo "  [错误] Node.js 版本过低：$NODE_VERSION（需要 18 或更高）"
  echo "        下载地址：https://nodejs.org/zh-cn/download"
  echo ""
  exit 1
fi

# 可执行性校验
if ! "$NODE_BIN" -e "process.exit(0)" >/dev/null 2>&1; then
  echo ""
  echo "  [错误] 检测到的 Node.js 无法执行：$NODE_BIN"
  echo ""
  exit 1
fi

# npm 定位（用于依赖安装）
NPM_BIN=""
if command -v npm >/dev/null 2>&1; then
  NPM_BIN="npm"
elif [ -x "portable-node/bin/npm" ]; then
  NPM_BIN="portable-node/bin/npm"
fi

# ---- 2. 准备环境变量文件 ----
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "  [2/4] 已从 .env.example 生成 .env"
    echo "        生产环境请修改其中的 JWT_SECRET"
  else
    echo "  [2/4] 未找到 .env.example，跳过"
  fi
else
  echo "  [2/4] 已存在 .env，跳过"
fi

# ---- 3. 安装依赖 ----
if [ ! -d "node_modules/express" ]; then
  if [ -z "$NPM_BIN" ]; then
    echo ""
    echo "  [错误] 需要安装依赖，但未找到 npm。"
    echo "        请安装完整的 Node.js（含 npm）后重试。"
    echo ""
    exit 1
  fi
  echo "  [3/4] 首次运行，正在安装依赖（可能需要 1-2 分钟）..."
  if ! "$NPM_BIN" install --no-audit --no-fund; then
    echo ""
    echo "  [错误] 依赖安装失败，请检查网络后重试。"
    echo "  如在国内网络环境，可先执行："
    echo "    npm config set registry https://registry.npmmirror.com"
    echo ""
    exit 1
  fi
else
  echo "  [3/4] 依赖已安装，跳过"
fi

# ---- 4. 启动服务 ----
echo "  [4/4] 正在启动服务..."
echo ""
echo "  =========================================================="
echo "   启动后请用浏览器访问"
echo "     前台登录页  http://localhost:3000/login.html"
echo "     后台管理    http://localhost:3000/admin"
echo ""
echo "   后台账号    admin"
echo "   后台密码    见 .env 的 ADMIN_PASSWORD（或首次启动日志）"
echo "  =========================================================="
echo ""
echo "  按 Ctrl+C 停止服务"
echo ""

# 注意：这里不设置 NODE_ENV=production。
# 生产模式会强制要求配置 JWT_SECRET，学习/测试场景直接启动更省事。
# 需要体验生产模式时，请在 .env 中设置 NODE_ENV=production 并填写 JWT_SECRET。
exec "$NODE_BIN" src/server.js
