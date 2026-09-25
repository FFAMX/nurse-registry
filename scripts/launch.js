'use strict';

/**
 * 启动器：由「一键启动.bat」调用。
 *
 * 为什么要有这个文件：
 *   Windows 批处理对非 ASCII（中文）字符极其敏感，中文一旦出现在
 *   if (...) 代码块内部，会因代码页解析问题导致命令被截断。
 *   因此把「所有逻辑 + 所有中文输出」都放在 Node 里，
 *   批处理只保留纯 ASCII 的 Node 定位与转发。
 *
 * 职责：
 *   1. 检查依赖（node_modules/express）
 *   2. 检查端口占用
 *   3. 打印友好的中文启动信息
 *   4. 以子进程方式拉起 src/server.js，并把输出转发到当前窗口
 *   5. 转发 Ctrl+C，保证优雅停机
 */

const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const PORT = Number(process.env.PORT) || 3000;

/* ------------------------------------------------------------------ *
 * 输出辅助
 * ------------------------------------------------------------------ */

/**
 * 后台密码提示。
 *
 * 这里刻意不写死密码：本项目的仓库是**公开仓库**，把口令硬编码进
 * 代码等于直接告诉全网。优先读 .env 里配置的 ADMIN_PASSWORD
 * （也就是本机实际在用的那个），没配就提示去看启动日志 ——
 * 首次启动会随机生成一次并打印出来。
 */
function adminPasswordHint() {
  try {
    const { loadEnv } = require('../src/lib/env-loader');
    loadEnv(ROOT);
  } catch (error) {
    /* .env 不存在或解析失败都不该影响启动，忽略即可 */
  }
  const fromEnv = String(process.env.ADMIN_PASSWORD || '').trim();
  return fromEnv || '见 .env 的 ADMIN_PASSWORD（或首次启动日志里打印的随机密码）';
}

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function banner() {
  line('');
  line('  ============================================================');
  line('     护士电子化注册信息系统 · 一键启动');
  line('  ============================================================');
  line('');
}

/* ------------------------------------------------------------------ *
 * 前置检查
 * ------------------------------------------------------------------ */

function checkDependencies() {
  const express = path.join(ROOT, 'node_modules', 'express');
  return fs.existsSync(express);
}

/** 检查端口是否已被占用 */
function findPortOwner(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen(port, '0.0.0.0');
  });
}

/** 探测服务是否真的可访问，避免误判 */
async function probeHealth(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  banner();

  if (!fs.existsSync(SERVER)) {
    line('  [错误] 未找到服务入口 src/server.js');
    line('');
    line('  请确认项目文件完整，尤其是 src 目录。');
    line('');
    return 1;
  }

  if (!checkDependencies()) {
    line('  [错误] 依赖尚未安装（缺少 node_modules/express）');
    line('');
    line('  本项目交付时应已附带 node_modules。');
    line('  若确实缺失，请在项目目录下执行：');
    line('');
    line('    portable-node\\npm.cmd install');
    line('');
    return 1;
  }

  line('  正在检查运行环境，请稍候…');
  line('');

  const occupied = await findPortOwner(PORT);
  if (occupied) {
    const alive = await probeHealth(PORT);
    line('  ------------------------------------------------------------');
    line(`  [提示] 端口 ${PORT} 已被占用，服务很可能已经在运行。`);
    line('');
    if (alive) {
      line('  健康检查通过，直接打开浏览器即可：');
    } else {
      line('  端口被占用，但健康检查未通过，可能是其他程序占用。');
      line('');
      line('  建议：');
      line('    1. 双击「停止服务.bat」结束旧进程；');
      line('    2. 或用「诊断.bat」查看是哪个程序占用。');
      line('');
      line('  访问地址（若服务正常）：');
    }
    line('');
    line(`      后台管理    http://localhost:${PORT}/admin`);
    line(`      前台登录页  http://localhost:${PORT}/login.html`);
    line('');
    line('  ------------------------------------------------------------');
    return 1;
  }

  line('  ------------------------------------------------------------');
  line('    服务启动中，请勿关闭本窗口');
  line('');
  line(`      后台管理    http://localhost:${PORT}/admin`);
  line(`      前台登录页  http://localhost:${PORT}/login.html`);
  line('');
  line('    后台账号    admin');
  line(`    后台密码    ${adminPasswordHint()}`);
  line('');
  line('    按 Ctrl+C 可停止服务');
  line('  ------------------------------------------------------------');
  line('');

  // 以子进程方式启动服务，直连当前窗口的输入输出
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  // Ctrl+C 转发给子进程，让它走优雅停机
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      line('');
      if (signal) {
        line(`  服务已停止（信号 ${signal}）`);
      } else {
        line(`  服务已退出（代码 ${code}）`);
      }
      line('');
      resolve(code === null ? 0 : code);
    });
    child.on('error', (err) => {
      line('');
      line(`  [错误] 无法启动服务进程：${err.message}`);
      line('');
      resolve(1);
    });
  });
}

main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    line('');
    line(`  [错误] 启动器异常：${err.message}`);
    line('');
    process.exit(1);
  });
