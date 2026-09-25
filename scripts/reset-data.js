'use strict';

/**
 * 重置数据脚本：清空数据库并重新执行启动引导。
 *
 * 用法：
 *   npm run reset-data              # 需要输入 yes 确认
 *   npm run reset-data -- --force   # 跳过确认
 *
 * ⚠️ 该操作会删除全部账号与操作日志，且不可恢复。
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
  const dbFile = path.join(dataDir, 'db.json');

  process.stdout.write(`\n即将删除数据文件：${dbFile}\n`);
  process.stdout.write('删除后所有账号、管理员与操作日志都会丢失，且无法恢复。\n\n');

  if (!fs.existsSync(dbFile)) {
    process.stdout.write('数据文件不存在，无需重置。\n\n');
    return;
  }

  if (!force) {
    const ok = await confirm('确认继续？输入 yes 继续，其它任意键取消：');
    if (!ok) {
      process.stdout.write('已取消，未做任何修改。\n\n');
      return;
    }
  }

  fs.rmSync(dbFile, { force: true });
  process.stdout.write('\n已删除数据文件。\n');
  process.stdout.write('下次执行 npm start 时会重新创建数据库，并再次从 public/config.js 迁移账号。\n');
  process.stdout.write('新的管理员初始密码会打印在启动日志中。\n\n');
}

main().catch((error) => {
  process.stderr.write(`重置失败：${error.message}\n`);
  process.exit(1);
});
