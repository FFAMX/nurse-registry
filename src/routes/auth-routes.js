'use strict';

/**
 * 认证路由（控制器层）：只解析请求、调用服务、格式化响应，不写业务逻辑。
 */
const express = require('express');

const { validate } = require('../lib/validate');
const { requireAuth, rateLimit } = require('../middleware/auth');

/**
 * @param {object} deps
 * @param {import('../services/auth-service').AuthService} deps.authService
 */
function createAuthRouter({ authService }) {
  const router = express.Router();

  // 登录接口单独施加更严格的限流
  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    message: '登录请求过于频繁，请稍后再试',
  });

  // 解析客户端 IP（兼容反向代理场景下由代理解析出的 req.ip）
  const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

  /** 前台账号登录 */
  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const data = validate(req.body, (v) => {
        v.username('username', { required: true, label: '用户名' });
        v.password('password', { required: true, label: '密码' });
      });

      const result = await authService.loginAccount({
        username: data.username,
        password: data.password,
        ip: clientIp(req),
      });

      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** 后台管理员登录 */
  router.post('/admin/login', loginLimiter, async (req, res, next) => {
    try {
      const data = validate(req.body, (v) => {
        v.username('username', { required: true, label: '用户名' });
        v.password('password', { required: true, label: '密码' });
      });

      const result = await authService.loginAdmin({
        username: data.username,
        password: data.password,
        ip: clientIp(req),
      });

      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** 当前登录账号信息 */
  router.get(
    '/me',
    requireAuth({ authService, type: 'account' }),
    async (req, res, next) => {
      try {
        const user = await authService.loadAccount(req.auth.sub);
        res.json({ ok: true, data: { user }, request_id: req.id });
      } catch (error) {
        next(error);
      }
    }
  );

  /** 当前登录管理员信息 */
  router.get(
    '/admin/me',
    requireAuth({ authService, type: 'admin' }),
    async (req, res, next) => {
      try {
        const admin = await authService.loadAdmin(req.auth.sub);
        res.json({ ok: true, data: { admin }, request_id: req.id });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

module.exports = { createAuthRouter };
