'use strict';

/**
 * 认证与授权中间件。
 *
 * 标准中间件顺序（在 app.js 中体现）：
 *   请求ID → 安全头 → CORS → 日志 → 解析体 → 限流 → 路由级鉴权 → 业务处理器 → 错误处理
 */
const { UnauthorizedError, ForbiddenError } = require('../lib/errors');
const { TokenService } = require('../services/token-service');

/**
 * 生成「需要指定令牌类型」的鉴权中间件。
 * @param {object} deps
 * @param {import('../services/auth-service').AuthService} deps.authService
 * @param {'account'|'admin'} deps.type 期望的令牌类型
 * @param {string[]} [deps.roles] 允许的角色（仅 admin 令牌有效）
 */
function requireAuth({ authService, type, roles = null }) {
  return function authenticate(req, res, next) {
    try {
      const candidates = TokenService.candidatesFromRequest(req);

      if (candidates.length === 0) {
        throw new UnauthorizedError('请先登录后再访问', 'TOKEN_MISSING');
      }

      // 逐个候选尝试验签。
      // 为什么需要这样：云平台网关可能往 Authorization 头里注入它自己的令牌，
      // 与应用的令牌拼在一起，仅凭格式无法区分。能验签通过的那个才是应用签发的。
      let payload = null;
      let lastError = null;

      for (const token of candidates) {
        try {
          payload = authService.verifyToken(token);
          break; // 验签成功
        } catch (error) {
          lastError = error; // 记下最后一个错误，全部失败时抛出
        }
      }

      if (!payload) {
        throw lastError || new UnauthorizedError('访问令牌无效', 'TOKEN_INVALID');
      }

      if (payload.typ !== type) {
        throw new UnauthorizedError('当前令牌类型无权访问该接口', 'TOKEN_TYPE_MISMATCH');
      }
      if (roles && !roles.includes(payload.role)) {
        throw new ForbiddenError('当前角色没有权限执行该操作');
      }

      req.auth = payload;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** 仅管理员角色可访问 */
function requireRole(...roles) {
  return function authorize(req, res, next) {
    if (!req.auth || req.auth.typ !== 'admin') {
      return next(new UnauthorizedError('请先登录后台', 'TOKEN_MISSING'));
    }
    if (!roles.includes(req.auth.role)) {
      return next(new ForbiddenError('当前角色没有权限执行该操作'));
    }
    return next();
  };
}

/**
 * 简单内存限流：滑动窗口计数。
 * 生产环境建议替换为 Redis 等共享存储，以支持多实例部署。
 */
function rateLimit({ windowMs = 60_000, max = 120, message = '请求过于频繁，请稍后再试' } = {}) {
  const hits = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (now - bucket.firstAt > windowMs) hits.delete(key);
    }
  }, windowMs);
  timer.unref();

  return function limiter(req, res, next) {
    const key = `${req.ip}|${req.method}|${req.path}`;
    const now = Date.now();
    const bucket = hits.get(key);

    if (!bucket || now - bucket.firstAt > windowMs) {
      hits.set(key, { count: 1, firstAt: now });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((windowMs - (now - bucket.firstAt)) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfterSec, 1)));
      return res.status(429).json({
        ok: false,
        error: { code: 'RATE_LIMITED', message, details: null },
        request_id: req.id,
      });
    }

    return next();
  };
}

module.exports = { requireAuth, requireRole, rateLimit };
