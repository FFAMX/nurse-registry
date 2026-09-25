'use strict';

/**
 * 启动引导：确保数据库中存在初始数据。
 *
 * - 首次启动：创建管理员账号，并把 public/config.js 中原有的账号数据迁移进数据库
 *   （这样后台一打开就能看到并管理原有内容，而不是空列表）。
 * - 后续启动：幂等，不会重复插入，也不会覆盖已有修改。
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const { hashPassword } = require('../lib/passwords');
const { JsonDatabase } = require('../lib/json-db');

/**
 * 从原有前端配置文件 public/config.js 中解析出账号数据。
 *
 * 原文件形如：
 *   window.WEB003_CONFIG = { accounts: { "用户名": {...} } };
 *
 * 这里把它当作历史数据源读取一次，之后所有数据都以数据库为准，
 * config.js 保持原样供前端继续读取（满足「保持原有项目内容」的要求）。
 */
/**
 * 把 JavaScript 对象字面量文本转换为 JSON 文本。
 *
 * config.js 里写的是 JS 字面量（键名未加引号，且可能有尾随逗号），
 * 直接 JSON.parse 会失败，所以这里做一次「加引号 + 去尾随逗号」的规范化。
 * 先扫描字符串与注释，避免误改引号内部的内容。
 */
function jsObjectToJson(source) {
  let output = '';
  let i = 0;
  const length = source.length;

  while (i < length) {
    const char = source[i];

    // 字符串字面量：整体原样搬运，并统一转义
    if (char === '"' || char === "'") {
      const quote = char;
      let raw = '';
      i += 1;
      while (i < length) {
        const current = source[i];
        if (current === '\\') {
          raw += current + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (current === quote) {
          i += 1;
          break;
        }
        raw += current;
        i += 1;
      }
      let value;
      try {
        value = JSON.parse(`"${raw.replace(/"/g, '\\"').replace(/\\\\"/g, '\\"')}"`);
      } catch {
        value = raw;
      }
      output += JSON.stringify(value);
      continue;
    }

    // 整行注释
    if (char === '/' && source[i + 1] === '/') {
      while (i < length && source[i] !== '\n') i += 1;
      continue;
    }

    // 块注释
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    output += char;
    i += 1;
  }

  // 收敛尾随逗号：} / ] 前的逗号在 JS 中合法，在 JSON 中非法
  output = output.replace(/,(\s*[}\]])/g, '$1');

  // 给裸露的键名补上双引号：{ accounts: ... } → { "accounts": ... }
  // 注意 profile 里的键名是中文标识符（如 姓名:、身份证号:），
  // 所以字符类必须包含 Unicode 字母，不能用 [A-Za-z_$]。
  // 因为字符串内容此时已全部是合法的 JSON 字符串，可以安全地全局匹配。
  output = output.replace(/([{,]\s*)([\p{L}_$][\p{L}\p{N}_$]*)(\s*:)/gu, '$1"$2"$3');

  return output;
}

/**
 * 从原有前端配置文件 public/config.js 中解析出账号数据。
 *
 * 原文件形如（注意键名是 JS 写法，没有双引号）：
 *   window.WEB003_CONFIG = { accounts: { "用户名": {...} } };
 *
 * 这里把它当作历史数据源读取一次，之后所有数据都以数据库为准，
 * config.js 保持原样供前端继续读取（满足「保持原有项目内容」的要求）。
 */
async function readLegacyConfig(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    return null;
  }

  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    const parsed = JSON.parse(jsObjectToJson(raw.slice(start, end + 1)));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.accounts || typeof parsed.accounts !== 'object') return null;

    return parsed.accounts;
  } catch (error) {
    return { __error: error.message };
  }
}

/**
 * 把原有账号写入数据库（仅在对应用户名不存在时）。
 * 原有明文口令在此处一次性散列，之后数据库中不再保存明文。
 */
async function importLegacyAccounts({ config, accountRepository, logger }) {
  const configPath = path.join(config.publicDir, 'config.js');
  const accounts = await readLegacyConfig(configPath);

  if (!accounts) {
    logger.warn('public/config.js 不存在或内容为空，跳过历史账号迁移', { path: configPath });
    return 0;
  }
  if (accounts.__error) {
    // 明确报错而不是静默跳过，否则「后台看不到原有账号」会很难排查
    logger.warn('public/config.js 解析失败，跳过历史账号迁移', {
      path: configPath,
      reason: accounts.__error,
    });
    return 0;
  }

  let imported = 0;

  for (const [username, account] of Object.entries(accounts)) {
    if (!account || typeof account !== 'object') continue;
    if (accountRepository.usernameExists(username)) continue;

    const now = new Date().toISOString();
    const record = {
      id: JsonDatabase.nextId('acc'),
      username: account.username || username,
      display_name: account.display_name || account.profile?.['姓名'] || username,
      // 原有明文口令散列后入库
      password_hash: await hashPassword(String(account.password || '123456')),
      is_active: true,
      profile: account.profile && typeof account.profile === 'object' ? account.profile : {},
      created_at: now,
      updated_at: now,
      last_login_at: null,
    };

    await accountRepository.create(record);
    imported += 1;
    logger.info('已迁移历史账号', { username: record.username, display_name: record.display_name });
  }

  return imported;
}

/** 确保至少存在一个管理员账号 */
async function ensureAdmin({ adminRepository, config, logger }) {
  const { adminUsername, adminPassword, generatedPassword, resetAdminPassword } = config.bootstrap;

  const existing = adminRepository.findRawByUsername(adminUsername);

  if (existing && !resetAdminPassword) {
    logger.info('管理员账号已存在，跳过创建', { username: existing.username });
    return { created: false, password: null };
  }

  const passwordHash = await hashPassword(adminPassword);
  const now = new Date().toISOString();

  if (existing) {
    await adminRepository.update(existing.id, {
      password_hash: passwordHash,
      is_active: true,
      updated_at: now,
    });
    logger.warn('管理员密码已按 RESET_ADMIN_PASSWORD=1 重置', { username: adminUsername });
    return { created: false, password: adminPassword, reset: true };
  }

  await adminRepository.create({
    id: JsonDatabase.nextId('adm'),
    username: adminUsername,
    display_name: '系统管理员',
    password_hash: passwordHash,
    role: 'superadmin',
    is_active: true,
    created_at: now,
    updated_at: now,
    last_login_at: null,
  });

  logger.info('已创建初始管理员账号', { username: adminUsername });
  return { created: true, password: adminPassword, generated: generatedPassword };
}

/**
 * 执行全部启动引导任务。
 * @returns {Promise<{admin: object, importedAccounts: number}>}
 */
async function runBootstrap({ db, accountRepository, adminRepository, config, logger }) {
  const importedAccounts = await importLegacyAccounts({ config, accountRepository, logger });
  const admin = await ensureAdmin({ adminRepository, config, logger });

  return { admin, importedAccounts };
}

module.exports = { runBootstrap, importLegacyAccounts, ensureAdmin, readLegacyConfig };
