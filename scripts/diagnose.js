'use strict';

/**
 * 环境诊断：由「诊断.bat」调用。
 *
 * 只做检查，不修改任何东西。输出可直接截图发给他人定位问题。
 *
 * 为什么用 Node 而不是纯批处理：见 scripts/launch.js 顶部说明 ——
 * cmd.exe 对中文的解析极不可靠，纯 ASCII 的批处理 + Node 输出
 * 才是稳定方案。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { execFile } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function section(title) {
  line('');
  line('  ------------------------------------------------------------');
  line(`   ${title}`);
  line('  ------------------------------------------------------------');
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

/** 找可用的 node 可执行文件（与 launcher 保持同样的探测顺序） */
function findNode() {
  const candidates = [
    path.join(ROOT, 'portable-node', 'node.exe'),
    path.join(ROOT, 'node.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    'C:\\nodejs\\node.exe',
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

async function main() {
  line('');
  line('  ============================================================');
  line('     护士电子化注册信息系统 · 环境诊断');
  line('  ============================================================');
  line('');
  line('  本脚本只做检查，不修改任何东西。');
  line('  把本窗口全部内容截图发出来，就能定位问题。');

  // ---- 1. 基本信息 ----
  section('1. 基本信息');
  line(`   项目目录  ：${ROOT}`);
  line(`   当前平台  ：${process.platform} ${process.arch}`);
  line(`   系统版本  ：${os.type()} ${os.release()}`);
  line(`   运行中的 Node：${process.execPath}`);
  line(`   Node 版本 ：${process.version}`);

  // ---- 2. 可用 Node ----
  section('2. 可用的 Node.js');
  const portable = path.join(ROOT, 'portable-node', 'node.exe');
  if (fs.existsSync(portable)) {
    const v = (await run(portable, ['-v'])).trim();
    line(`   [正常] 项目自带便携版 portable-node\\node.exe（${v || '版本未知'}）`);
  } else {
    line('   [提示] 项目内没有 portable-node\\node.exe（将回退到系统 Node）');
  }
  const sysNode = await run(path.join(SYS32, 'where.exe'), ['node']);
  if (sysNode.trim()) {
    line('   [正常] 系统 PATH 中的 node：');
    for (const p of sysNode.split(/\r?\n/).filter(Boolean)) line(`          ${p.trim()}`);
  } else {
    line('   [提示] 系统 PATH 中没有 node（不影响，便携版已覆盖）');
  }

  // ---- 3. 项目文件 ----
  section('3. 项目文件完整性');
  const mustHave = [
    'src/server.js',
    'src/app.js',
    'src/lib/env-loader.js',
    'scripts/launch.js',
    'package.json',
    '.env',
    'data/db.json',
    'public/login.html',
    'public/index.html',
    'public/admin/index.html',
    'public/admin/api.js',
    'public/admin/app.js',
    'node_modules/express',
  ];
  for (const rel of mustHave) {
    const p = path.join(ROOT, rel);
    const exists = fs.existsSync(p);
    const isDir = exists && fs.statSync(p).isDirectory();
    line(`   ${exists ? '[正常]' : '[缺失]'} ${rel}${isDir ? ' （目录）' : ''}`);
  }

  // ---- 4. 端口 ----
  section(`4. 端口 ${PORT}`);
  const free = await isPortFree(PORT);
  if (free) {
    line(`   [空闲] 端口 ${PORT} 没有被占用`);
    line('          如果浏览器打不开，说明服务还没启动。');
  } else {
    line(`   [占用] 端口 ${PORT} 已被监听（服务可能已在运行）`);
    const info = await run(path.join(SYS32, 'netstat.exe'), ['-ano', '-p', 'TCP']);
    for (const raw of info.split(/\r?\n/)) {
      if (raw.includes(`:${PORT} `) && raw.includes('LISTENING')) line(`          ${raw.trim()}`);
    }
    // 做个真实健康检查，避免「端口被占但不是本项目」的误判
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      const body = await res.json();
      line(`   [正常] 健康检查通过：${JSON.stringify(body.data)}`);
      line('          服务是好的，直接打开浏览器即可。');
    } catch {
      line('   [注意] 端口被占用，但健康检查没通过。');
      line('          可能是别的程序占用了这个端口，或服务卡住了。');
    }
  }

  // ---- 5. 进程 ----
  section('5. 相关进程');
  const tasks = await run(path.join(SYS32, 'tasklist.exe'), [
    '/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH',
  ]);
  const pids = [...tasks.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => m[1]);
  if (pids.length === 0) {
    line('   （当前没有 node.exe 进程）');
  } else {
    for (const pid of pids) line(`   node.exe  PID=${pid}`);
  }

  // ---- 6. 数据文件 ----
  section('6. 数据文件');
  const dbPath = path.join(ROOT, 'data', 'db.json');
  if (fs.existsSync(dbPath)) {
    try {
      const raw = fs.readFileSync(dbPath, 'utf8');
      const db = JSON.parse(raw);
      line(`   [正常] data\\db.json（${raw.length} 字节）`);
      line(`          账号 ${(db.accounts || []).length} 条，管理员 ${(db.admins || []).length} 个`);
      if (db.accounts?.length) {
        for (const a of db.accounts.slice(0, 5)) {
          line(`            - ${a.username}  (${a.display_name || '无姓名'})`);
        }
      }
    } catch (err) {
      line(`   [异常] data\\db.json 无法解析：${err.message}`);
      line('          可双击「停止服务.bat」后删除该文件，重启会自动重建。');
    }
  } else {
    line('   [提示] data\\db.json 不存在，首次启动会自动创建');
  }

  // ---- 7. 配置摘要 ----
  section('7. 配置摘要（.env）');
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    const pick = ['NODE_ENV', 'PORT', 'HOST', 'ADMIN_USERNAME', 'RESET_ADMIN_PASSWORD'];
    for (const key of pick) {
      const m = text.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
      line(`   ${key.padEnd(20)} = ${m ? m[1].trim() || '(空)' : '(未设置)'}`);
    }
    const hasSecret = /^JWT_SECRET\s*=\s*\S+/m.test(text);
    line(`   ${'JWT_SECRET'.padEnd(20)} = ${hasSecret ? '(已设置)' : '(未设置，将使用开发兜底密钥)'}`);
  } else {
    line('   [提示] .env 不存在，启动时会自动从 .env.example 生成');
  }

  section('诊断结束');
  line('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    line('');
    line(`  [错误] 诊断异常：${err.message}`);
    line('');
    process.exit(1);
  });
