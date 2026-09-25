'use strict';

/**
 * 冒烟测试：启动服务后验证关键端点是否按预期工作。
 * 用法：
 *   node scripts/smoke-test.js                       # 自动拉起服务并测试
 *   node scripts/smoke-test.js --base http://host:3000 --admin admin --password xxx
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const [key, inlineValue] = item.slice(2).split('=');
      args[key] = inlineValue !== undefined ? inlineValue : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port) || 3199;
const BASE = args.base || `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  \u2717 ${name}${extra ? ` -> ${extra}` : ''}\n`);
  }
}

async function call(path_, options = {}) {
  const response = await fetch(`${BASE}${path_}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload, headers: response.headers };
}

/** 轮询 /health 直到服务就绪 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function main() {
  let child = null;
  let tempDataDir = null;

  if (!args.base) {
    // 用独立的临时数据目录启动，避免污染开发数据
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nurse-smoke-'));

    child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'test',
        DATA_DIR: tempDataDir,
        ADMIN_USERNAME: args.admin || 'admin',
        ADMIN_PASSWORD: args.password || 'SmokeTest#2026',
        LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    const ready = await waitForServer();
    if (!ready) {
      process.stderr.write('服务启动超时\n');
      child.kill();
      process.exit(1);
    }
  }

  const adminUser = args.admin || 'admin';
  const adminPass = args.password || 'SmokeTest#2026';

  try {
    process.stdout.write('\n[1] 健康检查\n');
    const health = await call('/health');
    check('GET /health 返回 200', health.status === 200, `status=${health.status}`);
    check('健康检查包含请求 ID', Boolean(health.headers.get('x-request-id')));

    const ready = await call('/ready');
    check('GET /ready 返回 200', ready.status === 200, `status=${ready.status}`);

    process.stdout.write('\n[2] 安全响应头\n');
    const csp = health.headers.get('content-security-policy');
    check('已设置 Content-Security-Policy', Boolean(csp));
    check('已设置 X-Content-Type-Options', health.headers.get('x-content-type-options') === 'nosniff');
    check('已设置 X-Frame-Options', health.headers.get('x-frame-options') === 'DENY');

    process.stdout.write('\n[3] 未认证访问被拒绝\n');
    const anon = await call('/api/admin/accounts');
    check('无令牌访问后台接口返回 401', anon.status === 401, `status=${anon.status}`);

    process.stdout.write('\n[4] 管理员登录\n');
    const badLogin = await call('/api/auth/admin/login', {
      method: 'POST',
      body: { username: adminUser, password: 'wrong-password' },
    });
    check('错误密码返回 401', badLogin.status === 401, `status=${badLogin.status}`);

    const login = await call('/api/auth/admin/login', {
      method: 'POST',
      body: { username: adminUser, password: adminPass },
    });
    check('正确密码登录成功', login.status === 200, `status=${login.status}`);
    const token = login.payload && login.payload.data && login.payload.data.access_token;
    check('已签发访问令牌', typeof token === 'string' && token.split('.').length === 3);

    const me = await call('/api/auth/admin/me', { token });
    check('GET /api/auth/admin/me 可用', me.status === 200, `status=${me.status}`);

    const tampered = `${token.slice(0, -3)}abc`;
    const badToken = await call('/api/auth/admin/me', { token: tampered });
    check('篡改签名后令牌被拒绝', badToken.status === 401, `status=${badToken.status}`);

    process.stdout.write('\n[5] 账号 CRUD\n');
    const list0 = await call('/api/admin/accounts', { token });
    check('GET 账号列表成功', list0.status === 200, `status=${list0.status}`);
    const initialTotal = list0.payload.data.pagination.total;

    const created = await call('/api/admin/accounts', {
      method: 'POST',
      token,
      body: {
        username: 'test_account_001',
        password: 'test123456',
        display_name: '测试账号',
        is_active: true,
        profile: {
          姓名: '测试账号',
          性别: '男',
          执业注册状态: '在册',
          身份证号: '110101199001011234',
          执业机构: '测试医院',
          出生日期: '1990-01-01',
        },
      },
    });
    check('POST 新增账号返回 201', created.status === 201, `status=${created.status}`);
    const accountId = created.payload && created.payload.data.account.id;
    check('返回了账号 ID', Boolean(accountId));

    const created2 = await call('/api/admin/accounts', {
      method: 'POST',
      token,
      body: { username: 'test_account_001', password: 'test123456' },
    });
    check('重复用户名返回 409', created2.status === 409, `status=${created2.status}`);

    const invalid = await call('/api/admin/accounts', {
      method: 'POST',
      token,
      body: { username: 'bad name!!', password: '123' },
    });
    check('非法输入返回 400', invalid.status === 400, `status=${invalid.status}`);
    check(
      '校验错误包含字段明细',
      Boolean(invalid.payload && Array.isArray(invalid.payload.error.details) && invalid.payload.error.details.length)
    );

    const detail = await call(`/api/admin/accounts/${accountId}`, { token });
    check('GET 账号详情成功', detail.status === 200, `status=${detail.status}`);
    check('详情不包含口令散列', detail.payload && !('password_hash' in detail.payload.data.account));

    const updated = await call(`/api/admin/accounts/${accountId}`, {
      method: 'PATCH',
      token,
      body: {
        username: 'test_account_001',
        display_name: '已更新的名称',
        is_active: true,
        profile: { 姓名: '已更新', 性别: '女', 执业注册状态: '在册', 执业机构: '更新后的医院' },
      },
    });
    check('PATCH 修改账号成功', updated.status === 200, `status=${updated.status}`);
    check(
      '修改已生效',
      updated.payload && updated.payload.data.account.display_name === '已更新的名称',
      updated.payload && updated.payload.data.account.display_name
    );

    const toggled = await call(`/api/admin/accounts/${accountId}/toggle-active`, {
      method: 'POST',
      token,
    });
    check('POST 启停切换成功', toggled.status === 200, `status=${toggled.status}`);
    check('状态已翻转', toggled.payload && toggled.payload.data.account.is_active === false);

    const search = await call('/api/admin/accounts?keyword=test_account_001', { token });
    check('关键字搜索可用', search.status === 200 && search.payload.data.pagination.total >= 1);

    const paged = await call('/api/admin/accounts?page=1&pageSize=1', { token });
    check('分页参数生效', paged.payload && paged.payload.data.pagination.pageSize === 1);

    const fields = await call('/api/admin/profile-fields', { token });
    check('GET 字段定义成功', fields.status === 200 && Array.isArray(fields.payload.data.fields));

    const logs = await call('/api/admin/audit-logs', { token });
    check('GET 操作日志成功', logs.status === 200 && logs.payload.data.items.length > 0);

    process.stdout.write('\n[6] 删除\n');
    const removed = await call(`/api/admin/accounts/${accountId}`, { method: 'DELETE', token });
    check('DELETE 删除账号成功', removed.status === 200, `status=${removed.status}`);

    const afterDelete = await call('/api/admin/accounts', { token });
    check(
      '删除后总数回到初始值',
      afterDelete.payload.data.pagination.total === initialTotal,
      `expected=${initialTotal} actual=${afterDelete.payload.data.pagination.total}`
    );

    const notFound = await call(`/api/admin/accounts/${accountId}`, { token });
    check('查询已删除账号返回 404', notFound.status === 404, `status=${notFound.status}`);

    const missingDelete = await call('/api/admin/accounts/acc_not_exist', { method: 'DELETE', token });
    check('删除不存在的账号返回 404', missingDelete.status === 404, `status=${missingDelete.status}`);

    process.stdout.write('\n[7] 静态资源与页面\n');
    const loginPage = await fetch(`${BASE}/login.html`);
    check('GET /login.html 返回 200', loginPage.status === 200, `status=${loginPage.status}`);

    const adminPage = await fetch(`${BASE}/admin`);
    check('GET /admin 返回 200', adminPage.status === 200, `status=${adminPage.status}`);

    const bootstrapCss = await fetch(`${BASE}/assets/css/bootstrap.min.css`);
    check('Bootstrap 样式可访问', bootstrapCss.status === 200, `status=${bootstrapCss.status}`);

    const notFoundPage = await fetch(`${BASE}/not-exist-page`);
    check('未知页面返回 404', notFoundPage.status === 404, `status=${notFoundPage.status}`);

    process.stdout.write('\n' + '='.repeat(52) + '\n');
    process.stdout.write(`  通过 ${passed} 项，失败 ${failed} 项\n`);
    process.stdout.write('='.repeat(52) + '\n\n');
  } finally {
    if (child) child.kill();
    if (tempDataDir) {
      try {
        fs.rmSync(tempDataDir, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`冒烟测试异常：${error.stack}\n`);
  process.exit(1);
});
