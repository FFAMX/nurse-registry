'use strict';

/**
 * 令牌服务：无第三方依赖的 JWT（HS256）签发与校验。
 *
 * 真实项目中请使用成熟库（如 jose / jsonwebtoken）。
 * 这里手写实现是为了让学习者能完整看懂 JWT 的三段结构与校验逻辑。
 */
const crypto = require('node:crypto');

const { UnauthorizedError } = require('../lib/errors');

function base64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/** 恒定时间字符串比较 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class TokenService {
  /**
   * @param {object} options
   * @param {string} options.secret 签名密钥
   * @param {string} options.issuer 签发者
   */
  constructor({ secret, issuer }) {
    this.secret = Buffer.from(secret, 'utf8');
    this.issuer = issuer;
  }

  /**
   * @param {object} payload 业务载荷（不含 exp/iat/iss）
   * @param {object} options
   * @param {number} options.expiresInSec 有效期（秒）
   */
  sign(payload, { expiresInSec }) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const body = {
      ...payload,
      iss: this.issuer,
      iat: issuedAt,
      exp: issuedAt + expiresInSec,
    };

    const encodedHeader = base64urlEncode(JSON.stringify(header));
    const encodedPayload = base64urlEncode(JSON.stringify(body));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(signingInput)
      .digest('base64url');

    return `${signingInput}.${signature}`;
  }

  /**
   * 校验并解析令牌，失败统一抛 UnauthorizedError。
   * @returns {object} 解析后的载荷
   */
  verify(token) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedError('缺少访问令牌', 'TOKEN_MISSING');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedError('访问令牌格式不正确', 'TOKEN_MALFORMED');
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(signingInput)
      .digest('base64url');

    // 先验签，再解析载荷 —— 顺序不能颠倒
    if (!safeEqual(signature, expected)) {
      throw new UnauthorizedError('访问令牌签名无效', 'TOKEN_INVALID');
    }

    let header;
    let payload;
    try {
      header = JSON.parse(base64urlDecode(encodedHeader));
      payload = JSON.parse(base64urlDecode(encodedPayload));
    } catch {
      throw new UnauthorizedError('访问令牌内容无法解析', 'TOKEN_MALFORMED');
    }

    if (header.alg !== 'HS256') {
      throw new UnauthorizedError('不支持的令牌签名算法', 'TOKEN_ALG_UNSUPPORTED');
    }
    if (payload.iss !== this.issuer) {
      throw new UnauthorizedError('访问令牌签发者不匹配', 'TOKEN_ISSUER_MISMATCH');
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      throw new UnauthorizedError('登录状态已过期，请重新登录', 'TOKEN_EXPIRED');
    }

    return payload;
  }

  /**
   * 从请求中提取所有可能的访问令牌候选（按优先级排序）。
   *
   * 为什么需要「候选列表」而不是单个令牌：部署到云平台时，反向代理/网关可能
   * 自己往 `Authorization` 头注入令牌。Express 会把重复的头用「, 」拼成一个字符串，
   * 于是应用拿到的是 "Bearer <平台令牌>, Bearer <应用令牌>"。
   * 此时无法仅凭格式判断哪个是应用自己的令牌（两者都是合法 JWT），
   * 只能交给上层逐个验签，验签通过的那个才是。
   *
   * 返回顺序：
   *   1. `X-Auth-Token` 自定义头（应用专用，不受平台注入影响）中的令牌
   *   2. `Authorization` 头中的令牌
   *
   * @param {object} req Express 请求对象
   * @returns {string[]} 去重后的候选令牌列表
   */
  static candidatesFromRequest(req) {
    const out = [];

    const push = (list) => {
      for (const item of list) {
        if (!out.includes(item)) out.push(item);
      }
    };

    // 1) 自定义头优先
    const custom = req.get('x-auth-token');
    if (typeof custom === 'string' && custom.trim() !== '') {
      push(TokenService.splitTokens(custom));
    }

    // 2) 标准 Authorization 头
    const auth = req.get('authorization');
    if (typeof auth === 'string' && auth.trim() !== '') {
      push(TokenService.splitTokens(auth));
    }

    return out;
  }

  /**
   * 从一个可能含多个令牌的头部字符串里切出所有形如 JWT 的候选。
   *
   * @param {string} raw
   * @returns {string[]}
   */
  static splitTokens(raw) {
    if (typeof raw !== 'string') return [];

    const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

    const parts = raw
      .replace(/Bearer\s+/gi, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // 整体也可能就是一个 token（头部里没有逗号时 split 结果就是它自己）
    const unique = [];
    for (const candidate of parts) {
      if (JWT_RE.test(candidate) && !unique.includes(candidate)) {
        unique.push(candidate);
      }
    }

    return unique;
  }

  /**
   * 从请求中提取单个访问令牌（兼容旧接口）。
   * 只取优先级最高的候选；需要容错多令牌时请用 candidatesFromRequest。
   *
   * @param {object} req
   * @returns {string|null}
   */
  static fromRequest(req) {
    const list = TokenService.candidatesFromRequest(req);
    return list.length > 0 ? list[0] : null;
  }

  /** 从 Authorization: Bearer <token> 中提取令牌（保留旧接口） */
  static extractBearer(headerValue) {
    if (typeof headerValue !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    return match ? match[1].trim() : null;
  }
}

module.exports = { TokenService };
