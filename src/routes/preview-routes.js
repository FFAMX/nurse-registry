'use strict';

/**
 * 公开预览路由。
 *
 * 用途：后台新增账号后，点「预览信息页」直接在浏览器打开该账号的前台展示页。
 *
 * 为什么单独开一个公开路由：
 *   后台接口需要管理员令牌，而前台展示页（index.html）是普通页面、不带令牌。
 *   预览本身就是「把结果给别人看」的场景，做成只读公开接口更直接。
 *
 * 安全控制：
 *   1. 只读 —— 仅 GET，不提供任何写操作；
 *   2. 只返回展示所需字段（accountService.getById 走 toPublic，不含 password_hash）；
 *   3. 独立限流，避免被脚本批量枚举；
 *   4. 账号 id 由服务端随机生成（acc_xxx），不可顺序猜测。
 */
const express = require('express');

const { rateLimit } = require('../middleware/auth');

function createPreviewRouter({ accountService }) {
  const router = express.Router();

  // 预览是低频人工操作，限流可以收得比较紧
  const previewLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    message: '预览请求过于频繁，请稍后再试',
  });

  /** GET /api/preview/account/:id —— 只读获取账号展示数据 */
  router.get('/account/:id', previewLimiter, (req, res, next) => {
    try {
      const account = accountService.getById(req.params.id);
      res.json({
        ok: true,
        data: {
          account: {
            id: account.id,
            username: account.username,
            display_name: account.display_name,
            is_active: account.is_active,
            profile: account.profile,
            created_at: account.created_at,
            updated_at: account.updated_at,
          },
        },
        request_id: req.id,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createPreviewRouter };
