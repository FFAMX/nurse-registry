'use strict';

/**
 * 页面加解密：Node 侧加密、浏览器 Web Crypto 解密。
 *
 * 用途：把账号信息页做成「没有密码只能看到乱码」的静态 HTML，
 * 从而在 GitHub Pages 这类**没有任何服务端**的托管上，也能做到
 * 「打开链接需要密码才能看到内容」。
 *
 * 与普通加密最大的区别是**必须是确定性的**：
 * 同一账号 + 同一密码 + 同一内容，必须生成逐字节相同的密文。
 * 否则每次生成密文都不同，同步服务会永远判定「有改动」，
 * 点一次推送就产生一个无意义的提交。
 *
 * 做法：
 *   salt = sha256(标签|账号id|密码)          —— 由账号与密码确定性派生
 *   key  = PBKDF2-SHA256(密码, salt, 20万次)  —— 与浏览器端参数一致
 *   iv   = sha256(标签|账号id|明文)           —— 随明文变化，避免同一密钥下 IV 重用
 *
 * 安全性说明：
 *   - 密文与 IV 都在公开页面上，攻击者只能对密码做**离线爆破**；
 *     因此密码必须是高强度随机串（见 generatePagePassword），
 *     不能用 123456、也不能用身份证号片段。
 *   - 同一明文重复加密会得到相同密文，这只泄露「内容没变」，可以接受。
 */

const crypto = require('node:crypto');

const KDF_ITERATIONS = 200000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SALT_LABEL = 'nurse-registry/v1/page-salt';
const IV_LABEL = 'nurse-registry/v1/page-iv';

/** 去掉容易看错的 0/O/1/I/L，避免手抄密码出错 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 10;

function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

function deriveSalt(accountId, password) {
  return sha256(`${SALT_LABEL}|${accountId}|${password}`).subarray(0, SALT_BYTES);
}

function deriveIv(accountId, plaintext) {
  return crypto
    .createHash('sha256')
    .update(`${IV_LABEL}|${accountId}|`, 'utf8')
    .update(plaintext, 'utf8')
    .digest()
    .subarray(0, IV_BYTES);
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, KDF_ITERATIONS, KEY_BYTES, 'sha256');
}

/** 生成一个高强度、易抄写的页面密码 */
function generatePagePassword() {
  const bytes = crypto.randomBytes(PASSWORD_LENGTH);
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

/** 页面密码只用于核对，界面展示时保留前后各 2 位 */
function maskPassword(password) {
  const text = String(password || '');
  if (text.length <= 4) return text;
  return `${text.slice(0, 2)}${'*'.repeat(text.length - 4)}${text.slice(-2)}`;
}

/**
 * 加密明文，返回可直接写进 HTML 的信封。
 * @param {object} options
 * @param {string} options.accountId 账号 id，参与盐值与 IV 派生
 * @param {string} options.password  页面密码
 * @param {string} options.plaintext 待加密内容（JSON 字符串）
 * @returns {{v:number,kdf:string,iter:number,salt:string,iv:string,ct:string}}
 */
function encryptForPage({ accountId, password, plaintext }) {
  if (!password) throw new Error('缺少页面密码，无法加密');
  const salt = deriveSalt(accountId, password);
  const iv = deriveIv(accountId, plaintext);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: KDF_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    // Web Crypto 的 AES-GCM 期望密文尾部带认证标签，这里按同样格式拼接
    ct: Buffer.concat([body, tag]).toString('base64'),
  };
}

/** 解密（仅用于本地自测与排查；页面侧由浏览器 Web Crypto 完成） */
function decryptFromPage({ accountId, password, envelope }) {
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const raw = Buffer.from(envelope.ct, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

module.exports = {
  KDF_ITERATIONS,
  PASSWORD_LENGTH,
  generatePagePassword,
  maskPassword,
  encryptForPage,
  decryptFromPage,
};
