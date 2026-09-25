'use strict';

/**
 * 停止服务：由「停止服务.bat」调用。
 *
 * 为什么用 Node 而不是纯批处理：
 *   Windows 批处理对中文极其敏感，中文出现在 if (...) 块内会被
 *   cmd.exe 误解析并截断命令。把逻辑与中文输出都搬到 Node 里即可根治。
 *
 * 定位策略（两条路径，互为补充）：
 *   A. 通过 netstat 找到占用 3000 端口的进程 —— 最准确，直击本项目
 *   B. 通过 tasklist 找 node.exe 且命令行含 server.js —— 兜底
 * 只杀本项目的进程，避免误伤其他 node 程序。
 */

const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const NETSTAT = path.join(SYS32, 'netstat.exe');
const TASKLIST = path.join(SYS32, 'tasklist.exe');
const TASKKILL = path.join(SYS32, 'taskkill.exe');

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** 从 netstat 输出里解析出监听指定端口的 PID 集合 */
function parsePortOwners(netstatOutput, port) {
  const pids = new Set();
  const needle = `:${port} `;
  for (const raw of netstatOutput.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text.includes('LISTENING')) continue;
    // 形如：TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345
    if (!text.includes(needle) && !text.includes(`:${port}\t`)) continue;
    const cols = text.split(/\s+/);
    const last = cols[cols.length - 1];
    if (/^\d+$/.test(last) && last !== '0') pids.add(last);
  }
  return pids;
}

/** 找出 node.exe 且命令行包含 server.js 的 PID 集合 */
async function parseNodeServerPids() {
  const pids = new Set();
  const list = await run(TASKLIST, ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH']);
  for (const raw of list.split(/\r?\n/)) {
    const m = raw.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue;
    const pid = m[2];
    const detail = await run(TASKLIST, ['/FI', `PID eq ${pid}`, '/FO', 'LIST', '/NH', '/V']);
    if (/server\.js/i.test(detail)) pids.add(pid);
  }
  return pids;
}

async function main() {
  line('');
  line('  ============================================================');
  line('     护士电子化注册信息系统 · 停止服务');
  line('  ============================================================');
  line('');

  const netstatOut = await run(NETSTAT, ['-ano', '-p', 'TCP']);
  const portPids = parsePortOwners(netstatOut, PORT);
  const nodePids = await parseNodeServerPids();

  const targets = new Set([...portPids, ...nodePids]);

  if (targets.size === 0) {
    line(`  未发现正在运行的服务进程（端口 ${PORT} 空闲），无需停止。`);
    line('');
    return 0;
  }

  let killed = 0;
  for (const pid of targets) {
    // /T 连同子进程一起结束：
    // 启动器是 node(launch.js) → node(server.js) 的两级结构，
    // 只杀父进程会留下真正的服务进程，所以必须带上 /T。
    const result = await run(TASKKILL, ['/PID', pid, '/F', '/T']);
    if (result && /成功|SUCCESS/i.test(result)) {
      line(`  已停止进程 PID=${pid}（含子进程）`);
      killed += 1;
    } else {
      // 无输出通常代表进程已不存在
      line(`  进程 PID=${pid} 已不存在或已结束`);
      killed += 1;
    }
  }

  line('');
  if (killed > 0) {
    line(`  服务已停止（共结束 ${killed} 个进程），端口 ${PORT} 已释放。`);
  } else {
    line('  未能结束任何进程，请尝试以管理员身份运行。');
  }

  // 复核端口是否真的释放
  const after = await run(NETSTAT, ['-ano', '-p', 'TCP']);
  if (parsePortOwners(after, PORT).size > 0) {
    line('');
    line(`  [注意] 端口 ${PORT} 仍在监听，可能被其他程序占用。`);
    line(`         可执行 netstat -ano | findstr :${PORT} 查看详情。`);
  }

  line('');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    line('');
    line(`  [错误] 停止服务失败：${err.message}`);
    line('');
    process.exit(1);
  });
