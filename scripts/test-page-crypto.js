'use strict';

/**
 * 加密页面自测。
 *
 * 关键验证点：Node 侧加密出来的密文，必须能被**浏览器同一套 Web Crypto API** 解开。
 * 这里直接用 Node 内置的 globalThis.crypto.subtle（与浏览器实现同一套标准接口）
 * 跑一遍页面上那段解密逻辑，避免"加密完发现浏览器解不开"这种致命问题。
 *
 * 用法：node scripts/test-page-crypto.js
 */

const {
  encryptForPage,
  decryptFromPage,
  generatePagePassword,
  PASSWORD_LENGTH,
} = require('../src/lib/page-crypto');

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  \u2717 ${name}${extra ? ` — ${extra}` : ''}\n`);
  }
}

/* ---- 与页面内联脚本完全一致的浏览器侧解密实现 ---- */
function b64ToBytes(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin);
}

async function browserDecrypt(password, payload) {
  const subtle = globalThis.crypto.subtle;
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b64ToBytes(payload.salt),
      iterations: payload.iter,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(payload.iv) },
    key,
    b64ToBytes(payload.ct)
  );
  return new TextDecoder().decode(plain);
}

(async () => {
  process.stdout.write('\n[1] 生成页面密码\n');
  const password = generatePagePassword();
  check(`长度为 ${PASSWORD_LENGTH}`, password.length === PASSWORD_LENGTH, password.length);
  check('只含易辨认字符', /^[A-HJ-NP-Z2-9]+$/.test(password), password);
  check('两次生成不相同', generatePagePassword() !== generatePagePassword());

  const accountId = 'acc_test0001';
  const plaintext = JSON.stringify({ name: '测试护士', groups: [{ title: '基本信息', rows: [['姓名', '测试护士']] }] });

  process.stdout.write('\n[2] Node 加密 → 浏览器 Web Crypto 解密\n');
  const envelope = encryptForPage({ accountId, password, plaintext });
  check('信封字段完整', !!(envelope.salt && envelope.iv && envelope.ct && envelope.iter));
  check('信封内不含明文', !JSON.stringify(envelope).includes('测试护士'));

  const decrypted = await browserDecrypt(password, envelope);
  check('浏览器侧能解出原文', decrypted === plaintext);

  process.stdout.write('\n[3] 密码错误必须失败\n');
  let wrongFailed = false;
  try {
    await browserDecrypt('WRONGPASS99', envelope);
  } catch (error) {
    wrongFailed = true;
  }
  check('错误密码无法解密（GCM 校验失败）', wrongFailed);

  process.stdout.write('\n[4] 确定性：内容不变则密文不变\n');
  const again = encryptForPage({ accountId, password, plaintext });
  check('同一账号+密码+内容 → 密文逐字节相同', again.ct === envelope.ct && again.iv === envelope.iv);

  process.stdout.write('\n[5] 内容变化或密码变化则密文变化\n');
  const changedContent = encryptForPage({
    accountId,
    password,
    plaintext: plaintext.replace('测试护士', '测试护士2'),
  });
  check('内容变 → 密文变', changedContent.ct !== envelope.ct);
  check('内容变 → IV 也变（避免 IV 重用）', changedContent.iv !== envelope.iv);

  const otherPassword = generatePagePassword();
  const changedPassword = encryptForPage({ accountId, password: otherPassword, plaintext });
  check('密码变 → 盐值与密文都变', changedPassword.salt !== envelope.salt && changedPassword.ct !== envelope.ct);
  check('换密码后仍可解出', (await browserDecrypt(otherPassword, changedPassword)) === plaintext);

  process.stdout.write('\n[6] 账号隔离\n');
  const otherAccount = encryptForPage({ accountId: 'acc_other', password, plaintext });
  check('不同账号 → 不同盐值', otherAccount.salt !== envelope.salt);

  process.stdout.write('\n[7] Node 侧回解（排查用）\n');
  check('decryptFromPage 能还原', decryptFromPage({ accountId, password, envelope }) === plaintext);

  process.stdout.write('\n====================================================\n');
  process.stdout.write(`  通过 ${passed} 项，失败 ${failed} 项\n`);
  process.stdout.write('====================================================\n\n');
  if (failed) process.exit(1);
})();
