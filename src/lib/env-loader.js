'use strict';

/**
 * 极简 .env 加载器（零依赖）。
 *
 * 为什么自己写：项目只依赖 express，不想为了读一个配置文件引入 dotenv。
 * 加载顺序遵循「环境变量优先」原则 —— 已存在的 process.env 键不会被文件覆盖，
 * 这样 `PORT=4000 node src/server.js` 这类临时覆盖依然有效。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 解析 .env 文本为键值对。
 * 支持：
 *   KEY=value
 *   KEY="quoted value"
 *   KEY='single quoted'
 *   export KEY=value        （忽略 export 前缀）
 *   # 注释行、空行          （跳过）
 *   value=with=equals       （只按第一个 = 切分）
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseEnv(text) {
  const result = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    // 跳过空行与注释
    if (line === '' || line.startsWith('#')) continue;

    // 去掉可选的 export 前缀
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;

    const eq = body.indexOf('=');
    if (eq <= 0) continue; // 没有等号，或等号在最前面

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // 非法键名

    let value = body.slice(eq + 1).trim();

    // 去掉成对的引号
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * 从文件加载环境变量到 process.env。
 *
 * @param {string} filePath .env 文件路径
 * @returns {{loaded: boolean, count: number, file: string}}
 */
function loadEnvFile(filePath) {
  const stats = { loaded: false, count: 0, file: filePath };

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return stats; // 文件不存在或不可读：静默跳过
  }

  const parsed = parseEnv(text);

  for (const [key, value] of Object.entries(parsed)) {
    // 环境变量优先级更高：已存在的键不覆盖
    // 但空字符串视为「未设置」，允许被文件填充
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      stats.count += 1;
    }
  }

  stats.loaded = true;
  return stats;
}

/**
 * 在项目根目录查找并加载 .env。
 * 在 require 入口的最早期调用。
 *
 * @param {string} [rootDir] 项目根目录，默认取本文件的上两级
 * @returns {{loaded: boolean, count: number, file: string}}
 */
function loadEnv(rootDir = path.resolve(__dirname, '..', '..')) {
  return loadEnvFile(path.join(rootDir, '.env'));
}

module.exports = { loadEnv, loadEnvFile, parseEnv };
