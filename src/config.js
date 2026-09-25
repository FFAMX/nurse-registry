'use strict';

/**
 * 集中配置：所有配置从环境变量读取，并在启动时集中校验（快速失败）。
 */
const crypto = require('node:crypto');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

/** 开发环境下的兜底密钥；生产环境必须通过环境变量提供 */
const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret-change-me';

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${name} 必须是整数，当前值：${raw}`);
  }
  return value;
}

function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  let jwtSecret = process.env.JWT_SECRET || '';
  const warnings = [];

  if (jwtSecret.length === 0) {
    if (isProduction) {
      throw new Error(
        '缺少环境变量 JWT_SECRET。生产环境（NODE_ENV=production）必须显式提供至少 32 位的随机密钥。'
      );
    }
    jwtSecret = DEV_FALLBACK_SECRET;
    warnings.push(
      'JWT_SECRET 未设置，当前使用开发兜底密钥。请勿用于生产环境。'
    );
  } else if (jwtSecret.length < 32) {
    throw new Error(
      `JWT_SECRET 长度不足（当前 ${jwtSecret.length} 位），请至少提供 32 位随机字符。`
    );
  }

  const config = {
    nodeEnv,
    isProduction,
    port: intFromEnv('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',

    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, 'public'),
    dataDir: process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : path.join(ROOT_DIR, 'data'),

    jwt: {
      secret: jwtSecret,
      accessTokenTtlSec: intFromEnv('ACCESS_TOKEN_TTL_SEC', 2 * 60 * 60),
      adminTokenTtlSec: intFromEnv('ADMIN_TOKEN_TTL_SEC', 8 * 60 * 60),
      issuer: 'nurse-registry-demo',
    },

    bootstrap: {
      adminUsername: process.env.ADMIN_USERNAME || 'admin',
      // 未提供时随机生成，并在首次启动日志中打印一次
      adminPassword:
        process.env.ADMIN_PASSWORD ||
        crypto.randomBytes(9).toString('base64url'),
      generatedPassword: !process.env.ADMIN_PASSWORD,
      resetAdminPassword: process.env.RESET_ADMIN_PASSWORD === '1',
    },

    security: {
      maxLoginAttempts: intFromEnv('MAX_LOGIN_ATTEMPTS', 8),
      loginWindowMs: intFromEnv('LOGIN_WINDOW_MS', 5 * 60 * 1000),
      jsonBodyLimit: process.env.JSON_BODY_LIMIT || '256kb',
    },

    // GitHub 私有仓库同步（后台「推送仓库」按钮）
    // 未配置时服务照常运行，只是推送相关接口会返回明确的配置指引。
    github: {
      token: process.env.GITHUB_TOKEN || '',
      owner: process.env.GITHUB_OWNER || '',
      repo: process.env.GITHUB_REPO || '',
      branch: process.env.GITHUB_BRANCH || 'main',
      // 置 1 时对身份证号做部分打码。
      // 注意：页面内容本身已经加密，正常情况下无需再打码；
      // 这个开关保留给"必须脱敏展示"的场景。
      maskIdentity: process.env.GITHUB_MASK_IDENTITY === '1',
    },

    // 受保护信息站点：内容加密后发布到 GitHub Pages
    publicPage: (() => {
      const owner = String(process.env.GITHUB_OWNER || '').toLowerCase();
      const repo = String(process.env.GITHUB_REPO || '');
      const fallback = owner && repo ? `https://${owner}.github.io/${repo}` : '';
      return {
        // idnumber：文件名用账号名（本系统是身份证号），一眼看出是谁的页面
        // code：改用由账号 id 派生的短码，文件名不含任何敏感信息
        slug: process.env.PUBLIC_PAGE_SLUG === 'code' ? 'code' : 'idnumber',
        // Pages 站点根地址，后台据此拼出「每个账号的公开链接」
        pagesBaseUrl: (process.env.PAGES_BASE_URL || fallback).replace(/\/$/, ''),
      };
    })(),

    warnings,
  };

  return config;
}

module.exports = { loadConfig };
