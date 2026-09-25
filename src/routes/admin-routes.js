'use strict';

/**
 * 后台管理路由（控制器层）。
 * 完整 CRUD：列表 / 详情 / 新增 / 修改 / 删除 / 批量删除 / 启停切换。
 * 全部接口都需要管理员令牌。
 */
const express = require('express');

const { requireAuth, requireRole, rateLimit } = require('../middleware/auth');
const { validate } = require('../lib/validate');
const { NotFoundError, ForbiddenError } = require('../lib/errors');
const { JsonDatabase } = require('../lib/json-db');
const { pickSample } = require('../services/sample-data');

/**
 * @param {object} deps
 * @param {import('../services/auth-service').AuthService} deps.authService
 * @param {import('../services/account-service').AccountService} deps.accountService
 * @param {import('../repositories').AdminRepository} deps.adminRepository
 * @param {import('../repositories').AuditRepository} deps.auditRepository
 */
function createAdminRouter({
  authService,
  accountService,
  avatarService,
  githubSyncService,
  adminRepository,
  auditRepository,
}) {
  const router = express.Router();

  // 所有 /api/admin/* 接口统一要求管理员令牌
  router.use(requireAuth({ authService, type: 'admin', roles: ['superadmin', 'admin'] }));

  // 写操作限流，防止误操作或脚本刷数据
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, message: '操作过于频繁，请稍后再试' });

  const operatorOf = (req) => `${req.auth.username}`;

  /** 账号页面的公开链接；未配置 Pages 地址或账号不存在时为 null */
  const pageUrlOfAccount = (accountId) =>
    githubSyncService ? githubSyncService.pageUrlFor(accountId) : null;

  /**
   * GET /api/admin/accounts
   * 查询参数：keyword, status(active|disabled), sort, order, page, pageSize
   */
  router.get('/accounts', (req, res, next) => {
    try {
      const result = accountService.list({
        keyword: req.query.keyword,
        status: req.query.status,
        sort: req.query.sort,
        order: req.query.order,
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** POST /api/admin/accounts —— 新增 */
  router.post('/accounts', writeLimiter, async (req, res, next) => {
    try {
      const account = await accountService.create(req.body, { operator: operatorOf(req) });
      res.status(201).json({ ok: true, data: { account }, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** GET /api/admin/accounts/:id —— 详情 */
  router.get('/accounts/:id', (req, res, next) => {
    try {
      const account = accountService.getById(req.params.id);
      res.json({ ok: true, data: { account }, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** PATCH /api/admin/accounts/:id —— 修改 */
  router.patch('/accounts/:id', writeLimiter, async (req, res, next) => {
    try {
      const account = await accountService.update(req.params.id, req.body, {
        operator: operatorOf(req),
      });
      res.json({ ok: true, data: { account }, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** DELETE /api/admin/accounts/:id —— 删除 */
  router.delete('/accounts/:id', writeLimiter, async (req, res, next) => {
    try {
      const removed = await accountService.remove(req.params.id, { operator: operatorOf(req) });
      res.json({ ok: true, data: removed, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/accounts/batch-delete —— 批量删除
   * 用 POST 而非 DELETE，是为了让请求体语义更清晰。
   */
  router.post('/accounts/batch-delete', writeLimiter, async (req, res, next) => {
    try {
      const data = validate(req.body, (v) => {
        // 复用 string 校验逐个清洗，再在下面收集为数组
      });
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      const result = await accountService.removeMany(ids, { operator: operatorOf(req) });
      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** POST /api/admin/accounts/:id/toggle-active —— 启用/停用 */
  router.post('/accounts/:id/toggle-active', writeLimiter, async (req, res, next) => {
    try {
      const account = await accountService.toggleActive(req.params.id, {
        operator: operatorOf(req),
      });
      res.json({ ok: true, data: { account }, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /** GET /api/admin/profile-fields —— 前端表单可用的字段与枚举定义 */
  router.get('/profile-fields', (req, res) => {
    res.json({
      ok: true,
      data: {
        fields: require('../lib/validate').PROFILE_FIELD_ORDER,
        options: {
          性别: ['男', '女', '其他'],
          执业注册状态: ['在册', '注销', '变更中', '暂停'],
        },
      },
      request_id: req.id,
    });
  });

  /** GET /api/admin/audit-logs —— 操作日志 */
  router.get('/audit-logs', (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      res.json({
        ok: true,
        data: { items: auditRepository.list({ limit }) },
        request_id: req.id,
      });
    } catch (error) {
      next(error);
    }
  });

  /** GET /api/admin/admins —— 管理员列表 */
  router.get('/admins', (req, res, next) => {
    try {
      res.json({
        ok: true,
        data: { items: adminRepository.list() },
        request_id: req.id,
      });
    } catch (error) {
      next(error);
    }
  });

  /** POST /api/admin/admins —— 新增管理员（仅超级管理员） */
  router.post(
    '/admins',
    requireRole('superadmin'),
    writeLimiter,
    async (req, res, next) => {
      try {
        const data = validate(req.body, (v) => {
          v.username('username', { required: true, label: '管理员用户名' });
          v.password('password', { required: true, min: 8, label: '管理员密码' });
          v.string('display_name', { required: false, max: 64, label: '显示名称' });
          v.enum('role', ['admin', 'superadmin'], { label: '角色', fallback: 'admin' });
        });

        if (adminRepository.findRawByUsername(data.username)) {
          throw new ForbiddenError(`管理员「${data.username}」已存在`);
        }

        const { hashPassword } = require('../lib/passwords');
        const { JsonDatabase } = require('../lib/json-db');

        const record = {
          id: JsonDatabase.nextId('adm'),
          username: data.username,
          display_name: data.display_name || data.username,
          password_hash: await hashPassword(data.password),
          role: data.role || 'admin',
          is_active: true,
          created_at: new Date().toISOString(),
        };

        await adminRepository.create(record);
        await auditRepository.append({
          id: JsonDatabase.nextId('log'),
          at: new Date().toISOString(),
          operator: operatorOf(req),
          action: 'admin.create',
          target_id: record.id,
          detail: `新增管理员 ${record.username}`,
        });

        res.status(201).json({
          ok: true,
          data: {
            admin: {
              id: record.id,
              username: record.username,
              display_name: record.display_name,
              role: record.role,
            },
          },
          request_id: req.id,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /** DELETE /api/admin/admins/:id —— 删除管理员（仅超级管理员，且不能删自己） */
  router.delete(
    '/admins/:id',
    requireRole('superadmin'),
    writeLimiter,
    async (req, res, next) => {
      try {
        if (req.params.id === req.auth.sub) {
          throw new ForbiddenError('不能删除当前登录的管理员账号');
        }
        const existing = adminRepository.findRawById(req.params.id);
        if (!existing) throw new NotFoundError('管理员不存在');

        await adminRepository.remove(req.params.id);
        await auditRepository.append({
          id: require('../lib/json-db').JsonDatabase.nextId('log'),
          at: new Date().toISOString(),
          operator: operatorOf(req),
          action: 'admin.delete',
          target_id: req.params.id,
          detail: `删除管理员 ${existing.username}`,
        });

        res.json({ ok: true, data: { id: req.params.id }, request_id: req.id });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /api/admin/samples —— 测试样本数据（供表单「随机生成」按钮使用）
   * 查询参数：count（1~20，默认 1）
   */
  router.get('/samples', (req, res, next) => {
    try {
      const count = Math.min(Math.max(Number(req.query.count) || 1, 1), 20);
      const items = pickSample(count);
      res.json({
        ok: true,
        data: { items, total: items.length, source: 'synthetic' },
        request_id: req.id,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/upload/avatar —— 上传头像
   * body: { dataUrl: "data:image/jpeg;base64,..." }
   *
   * 前端已先用 canvas 压到 320px 再提交，这里再做一次格式与体积校验后落盘，
   * 返回站点内路径（/uploads/avatars/xxx.jpg）供表单回填。
   */
  router.post('/upload/avatar', writeLimiter, async (req, res, next) => {
    try {
      if (!avatarService) {
        throw new ForbiddenError('当前未配置头像上传服务');
      }
      const result = await avatarService.save(req.body && req.body.dataUrl);
      res.status(201).json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /* ==================== GitHub 私有仓库同步 ==================== */

  // 推送会真正改动远端仓库，限流收紧一些
  const githubLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    message: '推送操作过于频繁，请稍后再试',
  });

  /** 记录同步动作到审计日志（失败不影响主流程） */
  async function auditGithub(operator, action, detail) {
    try {
      await auditRepository.append({
        id: JsonDatabase.nextId('log'),
        at: new Date().toISOString(),
        operator,
        action,
        target_id: 'github',
        detail,
      });
    } catch {
      /* 审计日志失败不阻断同步 */
    }
  }

  /**
   * GET /api/admin/github/status
   * 返回：是否已配置令牌、每个账号的推送状态（已推送 / 有改动 / 未推送）。
   */
  router.get('/github/status', async (req, res, next) => {
    try {
      if (!githubSyncService) {
        throw new ForbiddenError('当前未启用 GitHub 同步服务');
      }
      res.json({ ok: true, data: await githubSyncService.status(), request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/github/accounts/:id/push
   * 只把这一个账号的信息页推送到私有仓库（已存在则更新）。
   */
  router.post('/github/accounts/:id/push', githubLimiter, async (req, res, next) => {
    try {
      if (!githubSyncService) {
        throw new ForbiddenError('当前未启用 GitHub 同步服务');
      }
      const operator = operatorOf(req);
      const result = await githubSyncService.pushAccount(req.params.id, { actor: operator });

      await auditGithub(
        operator,
        'github.push',
        result.unchanged
          ? `推送账号「${result.accountName || req.params.id}」：内容无变化，已跳过`
          : `推送账号「${result.accountName}」的加密页面到仓库，提交 ${result.shortSha}`
      );

      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/github/accounts/:id/revert
   * 把这一个账号从仓库撤下来（删除其信息页，本地数据不动）。
   */
  router.post('/github/accounts/:id/revert', githubLimiter, async (req, res, next) => {
    try {
      if (!githubSyncService) {
        throw new ForbiddenError('当前未启用 GitHub 同步服务');
      }
      const operator = operatorOf(req);
      const result = await githubSyncService.revertAccount(req.params.id, { actor: operator });

      await auditGithub(
        operator,
        'github.revert',
        `从仓库撤回账号「${result.accountName}」的页面，提交 ${result.shortSha}`
      );

      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/github/prune
   * 全量重建加密站点，并清掉受管理目录里多余的远端文件。
   * 典型用途：清理历史遗留的明文页面（仓库转公开前必须做一次）。
   */
  router.post('/github/prune', githubLimiter, async (req, res, next) => {
    try {
      if (!githubSyncService) {
        throw new ForbiddenError('当前未启用 GitHub 同步服务');
      }
      const operator = operatorOf(req);
      const result = await githubSyncService.prune({ actor: operator });

      await auditGithub(
        operator,
        'github.prune',
        result.unchanged
          ? '重建加密站点：仓库已与本地一致，无需操作'
          : `重建加密站点：写入 ${result.changed} 个文件、清理 ${result.deleted} 个文件，提交 ${result.shortSha}`
      );

      res.json({ ok: true, data: result, request_id: req.id });
    } catch (error) {
      next(error);
    }
  });

  /* ==================== 账号页面密码 ==================== */

  /**
   * GET /api/admin/accounts/:id/page-password
   * 读取该账号的页面密码与公开链接，供管理员发给护士。
   */
  router.get('/accounts/:id/page-password', async (req, res, next) => {
    try {
      const password = accountService.getPagePassword(req.params.id);
      res.json({
        ok: true,
        data: {
          accountId: req.params.id,
          password,
          hasPassword: Boolean(password),
          pageUrl: pageUrlOfAccount(req.params.id),
        },
        request_id: req.id,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/admin/accounts/:id/page-password
   * 生成 / 重置页面密码。不传 password 时随机生成。
   * 返回明文密码 —— 只有在这里才能拿到，请及时复制发给本人。
   */
  router.post('/accounts/:id/page-password', writeLimiter, async (req, res, next) => {
    try {
      const operator = operatorOf(req);
      const provided = req.body && req.body.password ? String(req.body.password) : null;
      const password = await accountService.setPagePassword(req.params.id, provided, {
        operator,
      });

      await auditRepository.append({
        id: JsonDatabase.nextId('log'),
        at: new Date().toISOString(),
        operator,
        action: 'account.page_password_reset',
        target_id: req.params.id,
        detail: provided ? '按管理员指定值设置页面密码' : '重新生成随机页面密码',
      });

      res.json({
        ok: true,
        data: {
          accountId: req.params.id,
          password,
          hasPassword: true,
          pageUrl: pageUrlOfAccount(req.params.id),
        },
        request_id: req.id,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAdminRouter };
