'use strict';

/**
 * 本地预览「受保护信息站点」（不联网、不需要令牌）。
 *
 * 把后台推送时实际上传的**加密页面**生成到 preview/ 目录，方便推送前先看一眼，
 * 并可用浏览器直接打开验证「输入密码能否正常解密」。
 * preview/ 已被 .gitignore 忽略，不会污染仓库。
 *
 * 注意：docs/ 目录（也就是 GitHub Pages 真正发布的内容）由后台每个账号后面的
 * 推送 / 撤回 按钮维护，本脚本不会去改它 —— 否则本地预览会把线上内容改乱。
 *
 * 用法：
 *   node scripts/export-pages.js                  # 预览全部账号
 *   node scripts/export-pages.js --one <账号id>   # 只预览某一个账号
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { loadEnv } = require('../src/lib/env-loader');
loadEnv(ROOT);

const { loadConfig } = require('../src/config');
const { JsonDatabase } = require('../src/lib/json-db');
const { AccountRepository } = require('../src/repositories');
const { PageExportService } = require('../src/services/page-export-service');
const { generatePagePassword } = require('../src/lib/page-crypto');

const argv = process.argv.slice(2);
const oneIndex = argv.indexOf('--one');
const oneId = oneIndex >= 0 ? argv[oneIndex + 1] : null;

function printPreviewUrlHint() {
  process.stdout.write('  提示：直接双击页面文件是以 file:// 打开的，浏览器会禁用解密所需的加密接口。\n');
  process.stdout.write('        请通过本地服务访问，例如在项目目录执行：\n');
  process.stdout.write('          npm start\n');
  process.stdout.write('        然后打开 http://localhost:3000/preview/docs/index.html\n');
}

(async () => {
  const config = loadConfig();

  const db = new JsonDatabase({
    file: path.join(config.dataDir, 'db.json'),
    defaultData: { version: 1, accounts: [], admins: [], audit_logs: [] },
  });
  await db.init();

  const accountRepository = new AccountRepository(db);
  const service = new PageExportService({
    accountRepository,
    rootDir: config.rootDir,
    config,
  });

  const all = service.listAccountsWithSecrets();
  if (!all.length) {
    process.stdout.write('\n  本地还没有任何账号，无需预览。\n\n');
    return;
  }

  const selected = oneId ? all.filter((account) => account.id === oneId) : all;
  if (oneId && selected.length === 0) {
    process.stderr.write(`找不到账号 id：${oneId}\n`);
    process.exit(1);
  }

  // 没有页面密码的账号，用一次性临时密码渲染，方便先看效果（不写回数据库）
  const ephemeral = new Map();
  const renderable = selected.map((account) => {
    if (account.page_password) return account;
    const password = generatePagePassword();
    ephemeral.set(account.id, password);
    return { ...account, page_password: password };
  });

  // 用一个只暴露本次选中账号的仓储替身，保证预览不牵扯其他账号
  const previewService = new PageExportService({
    accountRepository: { listRaw: () => renderable, list: () => renderable },
    rootDir: config.rootDir,
    config,
  });

  const built = previewService.build();

  // 清掉上一次的预览，避免残留旧页面造成误解
  const previewDir = path.join(config.rootDir, 'preview');
  fs.rmSync(previewDir, { recursive: true, force: true });
  for (const file of built.files) {
    const target = path.join(previewDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }

  const slugModeText =
    config.publicPage.slug === 'code' ? '短码（不含身份证号）' : '账号名（身份证号）';

  process.stdout.write('\n  本地预览已生成（仅本地查看，不影响仓库）\n');
  process.stdout.write('  ------------------------------------------\n');
  process.stdout.write(`  账号数量    : ${renderable.length} / 共 ${all.length}\n`);
  process.stdout.write(`  文件数量    : ${built.files.length}\n`);
  process.stdout.write(`  文件名规则  : ${slugModeText}\n`);
  process.stdout.write(`  身份证打码  : ${config.github.maskIdentity ? '已开启' : '未开启'}\n`);
  process.stdout.write('  ------------------------------------------\n');

  for (const account of renderable) {
    const name = (account.profile || {})['姓名'] || account.display_name || account.username;
    const rel = built.accountPaths[account.id];
    const temp = ephemeral.has(account.id);
    process.stdout.write(`  ${name}\n`);
    process.stdout.write(`    页面：${rel}\n`);
    process.stdout.write(
      `    密码：${account.page_password}${temp ? '   ← 本次临时生成，未保存到数据库' : '   ← 已保存的页面密码'}\n`
    );
  }

  process.stdout.write('  ------------------------------------------\n');
  process.stdout.write(`  打开落地页：${path.join(previewDir, 'docs', 'index.html')}\n`);
  printPreviewUrlHint();
  process.stdout.write('  仓库内容由后台列表里的「推送 / 撤回」按钮维护。\n\n');
})();
