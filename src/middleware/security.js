'use strict';

/**
 * 安全响应头。
 * 本项目的静态资源全部本地化，因此 CSP 可以收得很紧。
 */
const CSP = [
  "default-src 'self'",
  // 原有页面内联了脚本与样式，保留 unsafe-inline；头像允许外链图片
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders({ isProduction = false } = {}) {
  return function applySecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // 仅 https 场景下启用 HSTS，避免本地 http 开发被浏览器强制跳转
    if (isProduction && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // 接口响应一律禁止缓存，避免令牌/数据被中间层缓存
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    next();
  };
}

/**
 * 显式来源 CORS：不使用通配符。
 * 同源访问不需要 CORS，这里主要为本地调试（file:// 或不同端口）留出口子。
 */
function corsHandler({ allowedOrigins = [] } = {}) {
  const allowed = new Set(allowedOrigins.filter(Boolean));

  return function applyCors(req, res, next) {
    const origin = req.get('origin');

    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Auth-Token, X-Request-Id'
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }

    if (req.method === 'OPTIONS') {
      res.status(origin && allowed.has(origin) ? 204 : 403).end();
      return;
    }

    next();
  };
}

module.exports = { securityHeaders, corsHandler, CSP };
