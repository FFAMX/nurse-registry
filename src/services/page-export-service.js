'use strict';

/**
 * 受保护信息站点导出服务。
 *
 * 产出（仓库内路径，供 GitHub Pages 发布）：
 *   docs/index.html                落地页（不含任何账号数据）
 *   docs/accounts/<slug>.html      每个账号一个页面，内容为**密文**
 *
 * 为什么这样设计：
 *   GitHub Pages 是纯静态托管，没有任何服务端可以做鉴权。
 *   想让「打开链接需要密码才能看内容」，唯一的正路是**把内容加密**：
 *   页面里只有盐值、IV 与密文，访客输入正确密码后才在浏览器本地解密。
 *   没有密码就只是一堆乱码，因此仓库即使公开也不泄露数据。
 *
 * 关键约束：
 *   1. 生成必须**可复现** —— 同一账号同一密码同一内容，产物逐字节相同，
 *      否则每次比对都判定「有改动」，点一次推送就产生一个无意义的提交。
 *      （确定性由 lib/page-crypto.js 保证：盐值与 IV 都是派生出来的）
 *   2. 文件名必须**只取决于账号自身**，与本次导出包含哪些账号无关，
 *      否则推送集合一变，已有页面的文件名就会变，导致远端页面反复增删。
 *   3. 头像以 data URL 内嵌进密文，页面完全自包含，
 *      这样仓库里不会留下任何可被直接看到的照片文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { encryptForPage } = require('../lib/page-crypto');

/** 目录标题分组：决定页面上的排版顺序 */
const PROFILE_GROUPS = [
  {
    title: '基本信息',
    fields: ['姓名', '性别', '执业注册状态', '出生日期', '国籍', '民族', '身份证号', '健康状况', '参加工作时间'],
  },
  {
    title: '执业信息',
    fields: [
      '护士执业证书编号', '注册有效期至', '通过考试时间',
      '执业机构', '工作科室', '工作类别', '职务', '技术职称', '审批机关', '审批时间',
    ],
  },
];

const SITE_DIR = 'docs';
const ACCOUNTS_DIR = `${SITE_DIR}/accounts`;
const INDEX_PATH = `${SITE_DIR}/index.html`;
const ACCOUNT_EXT = '.html';

/** 页面里展示的时间统一按北京时间 */
function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return (
    `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ` +
    `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
  );
}

/** 把任意字符串压成安全的文件名片段 */
function safeFileName(value) {
  const base = String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 60);
  return base || '';
}

/** 由账号 id 确定性派生一个短码，用于不放身份证号时当文件名 */
function shortCode(accountId) {
  return crypto.createHash('sha256').update(`page-slug|${accountId}`, 'utf8').digest('hex').slice(0, 10);
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 把本地头像读成 data URL，随密文一起内嵌 */
function readAvatarDataUrl(rootDir, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || /^(https?:)?\/\//i.test(value) || value.startsWith('data:')) return null;

  let rel = value.replace(/\\/g, '/');
  if (rel.startsWith('./')) rel = rel.slice(2);
  if (rel.startsWith('/')) rel = rel.slice(1);
  const abs = path.join(rootDir, 'public', rel);
  if (!fs.existsSync(abs)) return null;

  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null;
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

/** 页面自带的解密与渲染脚本（不含任何数据，也无需外部依赖） */
const PAGE_SCRIPT = [
  '(function () {',
  "  var node = document.getElementById('payload');",
  "  var gate = document.getElementById('gate');",
  "  var view = document.getElementById('view');",
  "  var input = document.getElementById('pw');",
  "  var button = document.getElementById('go');",
  "  var msg = document.getElementById('msg');",
  '  var envelope;',
  '  try { envelope = JSON.parse(node.textContent); } catch (e) { envelope = null; }',
  "  if (!envelope) { msg.textContent = '页面数据损坏，无法解密。'; button.disabled = true; return; }",
  '  function b64ToBytes(value) {',
  '    var bin = atob(value);',
  '    var out = new Uint8Array(bin.length);',
  '    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);',
  '    return out;',
  '  }',
  '  function el(tag, className, text) {',
  '    var node = document.createElement(tag);',
  "    if (className) node.className = className;",
  "    if (text !== undefined) node.textContent = text;",
  '    return node;',
  '  }',
  '  function renderTable(group) {',
  "    var wrap = el('section', 'group');",
  "    wrap.appendChild(el('h3', null, group.title));",
  "    var table = el('table');",
  '    for (var i = 0; i < group.rows.length; i += 1) {',
  "      var tr = el('tr');",
  "      tr.appendChild(el('th', null, group.rows[i][0]));",
  "      tr.appendChild(el('td', null, group.rows[i][1] || '-'));",
  '      table.appendChild(tr);',
  '    }',
  '    wrap.appendChild(table);',
  '    return wrap;',
  '  }',
  '  function render(data) {',
  "    view.textContent = '';",
  '    if (data.avatar) {',
  "      var img = el('img', 'avatar');",
  "      img.alt = data.name + ' 的照片';",
  '      img.src = data.avatar;',
  '      view.appendChild(img);',
  '    }',
  "    var head = el('div', 'head');",
  "    head.appendChild(el('h2', null, data.name));",
  "    if (data.status) head.appendChild(el('span', 'badge', data.status));",
  '    view.appendChild(head);',
  '    for (var i = 0; i < data.groups.length; i += 1) view.appendChild(renderTable(data.groups[i]));',
  "    var foot = el('p', 'foot');",
  "    foot.textContent = '本页由后台管理系统加密生成，最后更新：' + (data.updatedAt || '未知');",
  '    view.appendChild(foot);',
  '    gate.hidden = true;',
  '    view.hidden = false;',
  "    document.title = data.name + ' - 护士执业注册信息';",
  '  }',
  '  async function unlock() {',
  "    button.disabled = true;",
  "    msg.textContent = '正在解密…';",
  '    try {',
  "      var enc = new TextEncoder();",
  "      var baseKey = await crypto.subtle.importKey('raw', enc.encode(input.value), 'PBKDF2', false, ['deriveKey']);",
  '      var key = await crypto.subtle.deriveKey(',
  "        { name: 'PBKDF2', salt: b64ToBytes(envelope.salt), iterations: envelope.iter, hash: 'SHA-256' },",
  "        baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']",
  '      );',
  '      var plain = await crypto.subtle.decrypt(',
  "        { name: 'AES-GCM', iv: b64ToBytes(envelope.iv) }, key, b64ToBytes(envelope.ct)",
  '      );',
  '      render(JSON.parse(new TextDecoder().decode(plain)));',
  '    } catch (error) {',
  "      msg.textContent = '密码不正确，或页面内容已更新，请向管理员确认最新的页面密码。';",
  '      button.disabled = false;',
  '    }',
  '  }',
  "  button.addEventListener('click', unlock);",
  "  input.addEventListener('keydown', function (event) { if (event.key === 'Enter') unlock(); });",
  '  input.focus();',
  '})();',
].join('\n');

const PAGE_STYLE = [
  ':root { color-scheme: light; }',
  '* { box-sizing: border-box; }',
  'body { margin: 0; padding: 24px 16px 48px; background: #f1f5f9; color: #0f172a;',
  "  font: 15px/1.7 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }",
  '.card { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 12px;',
  '  border: 1px solid #e2e8f0; padding: 28px 24px; }',
  'h1 { margin: 0 0 6px; font-size: 19px; font-weight: 600; }',
  '.sub { margin: 0 0 24px; color: #64748b; font-size: 13px; }',
  'label { display: block; font-size: 13px; color: #334155; margin-bottom: 8px; }',
  '#pw { width: 100%; padding: 11px 12px; font-size: 15px; letter-spacing: 2px;',
  '  border: 1px solid #cbd5e1; border-radius: 8px; font-family: ui-monospace, Menlo, Consolas, monospace; }',
  '#pw:focus { outline: 2px solid #26abe8; outline-offset: 1px; border-color: #26abe8; }',
  '#go { margin-top: 14px; width: 100%; padding: 12px; border: 0; border-radius: 8px;',
  '  background: #26abe8; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }',
  '#go:hover { background: #1d95cd; }',
  '#go:disabled { background: #94a3b8; cursor: default; }',
  '.msg { min-height: 20px; margin: 12px 0 0; font-size: 13px; color: #b91c1c; }',
  '.head { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; }',
  '.head h2 { margin: 0; font-size: 21px; }',
  '.badge { background: #e0f2fe; color: #075985; border-radius: 999px; padding: 2px 10px; font-size: 12px; }',
  '.avatar { width: 84px; height: 84px; object-fit: cover; border-radius: 50%;',
  '  border: 3px solid #fff; box-shadow: 0 0 0 1px #e2e8f0; display: block; margin: 0 0 16px; }',
  '.group { margin-bottom: 22px; }',
  '.group h3 { margin: 0 0 10px; font-size: 15px; color: #075985; }',
  'table { width: 100%; border-collapse: collapse; font-size: 14px; }',
  'th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }',
  'th { background: #f8fafc; color: #475569; font-weight: 500; width: 42%; }',
  'td { word-break: break-all; }',
  '.foot { margin: 24px 0 0; padding-top: 14px; border-top: 1px solid #e2e8f0;',
  '  color: #94a3b8; font-size: 12px; }',
].join('\n');

class PageExportService {
  /**
   * @param {object} deps
   * @param {object} deps.accountRepository
   * @param {string} deps.rootDir              项目根目录
   * @param {object} [deps.config]             完整配置（读取 config.publicPage 与 config.github）
   */
  constructor({ accountRepository, rootDir, config }) {
    this.accountRepository = accountRepository;
    this.rootDir = rootDir;
    const publicPage = (config && config.publicPage) || {};
    const github = (config && config.github) || {};
    this.slugMode = publicPage.slug === 'code' ? 'code' : 'idnumber';
    this.maskIdentity = Boolean(github.maskIdentity);
  }

  /** 身份证号打码：保留前 4 位与后 4 位 */
  _maskId(value) {
    const text = String(value || '');
    if (!this.maskIdentity || text.length < 10) return text;
    return `${text.slice(0, 4)}${'*'.repeat(text.length - 8)}${text.slice(-4)}`;
  }

  /** 全部账号（含页面密码，仅供生成加密页面使用） */
  listAccountsWithSecrets() {
    const list =
      typeof this.accountRepository.listRaw === 'function'
        ? this.accountRepository.listRaw()
        : this.accountRepository.list();
    return list
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  }

  /** 对外可用的账号清单（不含任何口令） */
  listAccounts() {
    return this.listAccountsWithSecrets().map((account) => {
      const { password_hash: _h, page_password: _p, ...rest } = account;
      return rest;
    });
  }

  /** 账号 -> 页面文件名（不含扩展名）；只取决于账号自身 */
  slugOf(account) {
    if (this.slugMode === 'code') return shortCode(account.id);
    return safeFileName(account.username) || shortCode(account.id);
  }

  /** 账号 id -> 文件名映射（同步服务用它判断远端是否已存在该账号的页面） */
  fileNameMap() {
    const map = {};
    for (const account of this.listAccountsWithSecrets()) {
      map[account.id] = this.slugOf(account);
    }
    return map;
  }

  /** 某个账号在站点里的页面路径 */
  detailPathOf(accountId) {
    const account = this.listAccountsWithSecrets().find((item) => item.id === accountId);
    return account ? `${ACCOUNTS_DIR}/${this.slugOf(account)}${ACCOUNT_EXT}` : null;
  }

  /** 账号页的公开网址（GitHub Pages） */
  pageUrlOf(account, pagesBaseUrl) {
    if (!pagesBaseUrl) return null;
    const slug = this.slugOf(account);
    return `${pagesBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(slug)}${ACCOUNT_EXT}`;
  }

  /** 组装待加密的展示数据 */
  _payload(account) {
    const profile = account.profile || {};
    const displayName = profile['姓名'] || account.display_name || account.username;

    const consumed = new Set();
    const groups = [];
    for (const group of PROFILE_GROUPS) {
      const rows = group.fields
        .filter((field) => Object.prototype.hasOwnProperty.call(profile, field))
        .map((field) => {
          consumed.add(field);
          const raw = profile[field];
          const value = field === '身份证号' ? this._maskId(raw) : raw;
          return [field, value === undefined || value === null || value === '' ? '-' : String(value)];
        });
      if (rows.length) groups.push({ title: group.title, rows });
    }

    // 兜底：profile 里出现但未在分组中列出的字段，避免新增字段被静默丢掉
    const extras = Object.keys(profile).filter((key) => !consumed.has(key) && key !== '头像');
    if (extras.length) {
      groups.push({
        title: '其他信息',
        rows: extras.map((field) => {
          const value = profile[field];
          return [field, value === undefined || value === null || value === '' ? '-' : String(value)];
        }),
      });
    }

    return {
      name: displayName,
      status: profile['执业注册状态'] || (account.is_active === false ? '已停用' : '在册'),
      avatar: readAvatarDataUrl(this.rootDir, profile['头像']),
      groups,
      updatedAt: formatTime(account.updated_at || account.created_at),
    };
  }

  /** 渲染单个账号的加密页面 */
  _renderAccountPage(account) {
    const password = account.page_password;
    if (!password) {
      const name = (account.profile || {})['姓名'] || account.display_name || account.username;
      const error = new Error(
        `账号「${name}」还没有页面密码，无法生成加密页面。请先在后台为它生成页面密码。`
      );
      error.code = 'PAGE_PASSWORD_MISSING';
      error.status = 400;
      throw error;
    }

    const plaintext = JSON.stringify(this._payload(account));
    const envelope = encryptForPage({
      accountId: account.id,
      password,
      plaintext,
    });

    // 密文里只有 base64，仍按安全习惯把 < 转义，避免任何注入可能
    const payloadJson = JSON.stringify(envelope).replace(/</g, '\\u003c');

    const html = [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '<meta name="robots" content="noindex, nofollow" />',
      '<title>受保护的护士执业注册信息</title>',
      '<style>',
      PAGE_STYLE,
      '</style>',
      '</head>',
      '<body>',
      '<main class="card">',
      '<h1>护士执业注册信息</h1>',
      '<p class="sub">本页内容已加密，需要输入专属页面密码才能查看。</p>',
      '<section id="gate">',
      '<label for="pw">页面密码</label>',
      '<input id="pw" type="password" autocomplete="off" spellcheck="false" placeholder="请输入管理员发给你的页面密码" />',
      '<button id="go" type="button">查看信息</button>',
      '<p class="msg" id="msg" role="status" aria-live="polite"></p>',
      '</section>',
      '<section id="view" hidden></section>',
      '</main>',
      `<script type="application/json" id="payload">${payloadJson}</script>`,
      '<script>',
      PAGE_SCRIPT,
      '</script>',
      '</body>',
      '</html>',
      '',
    ].join('\n');

    return { html, payload: plaintext };
  }

  /** 落地页：刻意不含任何账号数据，避免把所有人的链接集中公开 */
  indexFile() {
    const html = [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      '<meta name="robots" content="noindex, nofollow" />',
      '<title>护士执业注册信息</title>',
      '<style>',
      ':root { color-scheme: light; }',
      'body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;',
      '  padding: 24px; background: #f1f5f9; color: #0f172a;',
      "  font: 15px/1.8 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }",
      '.card { max-width: 520px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px 28px; }',
      'h1 { margin: 0 0 12px; font-size: 19px; }',
      'p { margin: 0 0 10px; color: #475569; font-size: 14px; }',
      '.tip { margin-top: 18px; padding: 12px 14px; background: #f8fafc; border-left: 3px solid #26abe8;',
      '  color: #334155; font-size: 13px; border-radius: 6px; }',
      '</style>',
      '</head>',
      '<body>',
      '<main class="card">',
      '<h1>护士执业注册信息</h1>',
      '<p>这里存放的是受保护的执业注册信息页。</p>',
      '<p>每个页面都有自己的专属链接与页面密码，请通过管理员获取。</p>',
      '<div class="tip">出于隐私考虑，本站不提供账号列表；请使用管理员发给你的专属链接直接打开。</div>',
      '</main>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
    return { path: INDEX_PATH, content: html, encoding: 'utf8' };
  }

  /** 单个账号的页面文件（推送前的比对基准） */
  accountFile(accountId) {
    const account = this.listAccountsWithSecrets().find((item) => item.id === accountId);
    if (!account) return null;
    const { html } = this._renderAccountPage(account);
    return {
      path: `${ACCOUNTS_DIR}/${this.slugOf(account)}${ACCOUNT_EXT}`,
      content: html,
      encoding: 'utf8',
    };
  }

  /**
   * 生成待推送文件。
   * @param {object} [options]
   * @param {Iterable<string>} [options.accountIds] 只生成这些账号；省略表示全部
   */
  build(options = {}) {
    const accounts = this.listAccountsWithSecrets();
    let selected = accounts;
    if (options.accountIds) {
      const wanted = new Set(options.accountIds);
      selected = accounts.filter((account) => wanted.has(account.id));
    }

    const files = [];
    const accountPaths = {};
    for (const account of selected) {
      const { html } = this._renderAccountPage(account);
      const pagePath = `${ACCOUNTS_DIR}/${this.slugOf(account)}${ACCOUNT_EXT}`;
      accountPaths[account.id] = pagePath;
      files.push({ path: pagePath, content: html, encoding: 'utf8' });
    }
    files.push(this.indexFile());

    return {
      files,
      manifest: files.map((file) => file.path).sort(),
      accountPaths,
      summary: {
        accounts: selected.length,
        pages: selected.length,
      },
    };
  }

  /**
   * 撤回后同步删除本地页面文件，避免本地 docs/ 与仓库不一致。
   * @returns {string|null} 被删除的相对路径
   */
  removeLocalPage(accountId) {
    const account = this.listAccountsWithSecrets().find((item) => item.id === accountId);
    if (!account) return null;
    const rel = `${ACCOUNTS_DIR}/${this.slugOf(account)}${ACCOUNT_EXT}`;
    const abs = path.join(this.rootDir, rel);
    if (!fs.existsSync(abs)) return null;
    fs.unlinkSync(abs);
    return rel;
  }

  /**
   * 把生成结果写回本地（保持本地 docs/ 与仓库一致）。
   * @param {ReturnType<PageExportService['build']>} built
   * @param {object} [options]
   * @param {boolean} [options.prune] 是否清掉本地已不属于任何账号的页面（全量重建时用）
   */
  writeToDisk(built, options = {}) {
    const touched = [];
    for (const file of built.files) {
      const target = path.join(this.rootDir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, 'utf8');
      touched.push(file.path);
    }

    if (options.prune) {
      const keep = new Set(built.files.map((file) => file.path));
      const dir = path.join(this.rootDir, ACCOUNTS_DIR);
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          const rel = `${ACCOUNTS_DIR}/${name}`;
          if (!keep.has(rel)) {
            fs.unlinkSync(path.join(dir, name));
            touched.push(`(删除) ${rel}`);
          }
        }
      }
    }

    return touched;
  }
}

module.exports = {
  PageExportService,
  PROFILE_GROUPS,
  SITE_DIR,
  INDEX_PATH,
  ACCOUNTS_DIR,
  ACCOUNT_EXT,
  shortCode,
  safeFileName,
};
