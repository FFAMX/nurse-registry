'use strict';

/**
 * 口令散列：scrypt + 随机盐，恒定时间比较，绝不存明文。
 * 使用 Node 内置 crypto，不引入第三方依赖。
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * @param {string} plain 明文口令
 * @returns {Promise<string>} 形如 scrypt$<saltHex>$<hashHex>
 */
async function hashPassword(plain) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * 恒定时间校验口令，避免时序侧信道。
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;

  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }

  const derived = await scrypt(plain, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
