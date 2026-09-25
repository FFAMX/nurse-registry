'use strict';

/**
 * 结构化 JSON 日志，贯穿请求 ID。
 * 明确不记录密码、令牌等敏感数据。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEYS = new Set([
  'password',
  'newPassword',
  'oldPassword',
  'currentPassword',
  'token',
  'accessToken',
  'authorization',
  'secret',
  'jwt',
  'passwordHash',
  'passwordSalt',
]);

const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

/** 递归剔除敏感字段，避免误落盘 */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output = {};
  for (const [key, val] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return output;
}

function write(level, message, meta) {
  if (LEVELS[level] < currentLevel) return;

  const record = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ? redact(meta) : {}),
  };

  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};

module.exports = { logger, redact };
