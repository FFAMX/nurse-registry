'use strict';

/**
 * 应用装配（组合根）：把配置、基础设施、仓储、服务、中间件、路由组装成一个 Express 应用。
 *
 * 中间件顺序（顺序本身就是安全策略的一部分）：
 *   1. 请求 ID / 上下文
 *   2. 安全响应头
 *   3. CORS（显式来源）
 *   4. 请求体解析（限制体积）
 *   5. 访问日志
 *   6. 接口总限流
 *   7. 健康检查
 *   8. 认证路由 → 后台路由
 *   9. 静态资源
 *  10. 404 处理
 *  11. 全局错误处理（必须最后）
 */
const express = require('express');
const path = require('node:path');

const { requestContext } = require('./middleware/request-context');
const { securityHeaders, corsHandler } = require('./middleware/security');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const { rateLimit } = require('./middleware/auth');
const { createAuthRouter } = require('./routes/auth-routes');
const { createAdminRouter } = require('./routes/admin-routes');
const { createPreviewRouter } = require('./routes/preview-routes');

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.repositories
 * @param {object} deps.services
 * @param {import('./lib/logger').logger} deps.logger
 */
function createApp({ config, repositories, services, logger }) {
  const app = express();

  // 部署在反向代理（如 Nginx）之后时，才能拿到真实客户端 IP
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // ---- 1. 请求上下文 ----
  app.use(requestContext);

  // ---- 2. 安全头 ----
  app.use(securityHeaders({ isProduction: config.isProduction }));

  // ---- 3. CORS ----
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  app.use(corsHandler({ allowedOrigins }));

  // ---- 4. 请求体解析 ----
  // 头像上传是 base64 图片，体积明显大于普通 JSON，单独放宽该前缀的上限；
  // 其余接口仍走全局的 256kb 限制。
  app.use('/api/admin/upload', express.json({ limit: '3mb' }));
  app.use(express.json({ limit: config.security.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.security.jsonBodyLimit }));

  // ---- 5. 访问日志已由 request-context 统一记录 ----

  // ---- 6. 接口总限流 ----
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300, message: '请求过于频繁，请稍后再试' }));

  // ---- 7. 健康检查 ----
  // liveness：只表示进程存活
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      data: { status: 'ok', uptime_sec: Math.round(process.uptime()) },
      request_id: req.id,
    });
  });

  // readiness：表示依赖（数据文件）可用
  app.get('/ready', (req, res) => {
    try {
      const data = repositories.db.read();
      res.json({
        ok: true,
        data: {
          status: 'ready',
          accounts: Array.isArray(data.accounts) ? data.accounts.length : 0,
          admins: Array.isArray(data.admins) ? data.admins.length : 0,
          writes: repositories.db.writeCount,
        },
        request_id: req.id,
      });
    } catch (error) {
      logger.error('就绪检查失败', { request_id: req.id, message: error.message });
      res.status(503).json({
        ok: false,
        error: { code: 'NOT_READY', message: '数据存储不可用', details: null },
        request_id: req.id,
      });
    }
  });

  app.get('/api', (req, res) => {
    res.json({
      ok: true,
      data: {
        name: '护士电子化注册信息系统 · 演示项目 API',
        version: require('../../package.json').version,
        endpoints: [
          'POST   /api/auth/login',
          'POST   /api/auth/admin/login',
          'GET    /api/auth/me',
          'GET    /api/auth/admin/me',
          'GET    /api/admin/accounts',
          'POST   /api/admin/accounts',
          'GET    /api/admin/accounts/:id',
          'PATCH  /api/admin/accounts/:id',
          'DELETE /api/admin/accounts/:id',
          'POST   /api/admin/accounts/batch-delete',
          'POST   /api/admin/accounts/:id/toggle-active',
          'GET    /api/admin/profile-fields',
          'GET    /api/admin/audit-logs',
          'GET    /api/admin/admins',
          'POST   /api/admin/admins',
          'DELETE /api/admin/admins/:id',
        ],
      },
      request_id: req.id,
    });
  });

  // ---- 8. 业务路由 ----
  app.use('/api/auth', createAuthRouter(services));
  app.use('/api/admin', createAdminRouter({ ...services, ...repositories }));
  // 公开只读预览：供后台「预览信息页」在无令牌的普通页面中取数
  app.use('/api/preview', createPreviewRouter(services));

  // ---- 9. 静态资源 ----
  // 原有页面保持原样：/ → index.html，/login.html、/config.js、/assets/* 直接提供
  app.use(
    express.static(config.publicDir, {
      index: 'index.html',
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        // 指纹化的第三方库可长缓存；页面与配置必须实时生效，避免改了数据看不到
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  // 后台管理界面：/admin 与 /admin/ 都指向同一入口
  app.get(['/admin', '/admin/'], (req, res) => {
    res.sendFile(path.join(config.publicDir, 'admin', 'index.html'));
  });

  // ---- 10. 404 ----
  app.use(notFoundHandler);

  // ---- 11. 全局错误处理（必须放在最后）----
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
