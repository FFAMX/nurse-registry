'use strict';

/**
 * 全局错误处理中间件。
 * 客户端只看到规范化的错误结构，绝不暴露堆栈或内部实现细节。
 */
const { AppError, ValidationError } = require('../lib/errors');
const { logger } = require('../lib/logger');

function notFoundHandler(req, res, next) {
  // 静态资源未命中时也走到这里；API 返回 JSON，页面返回简单提示
  if (req.path.startsWith('/api/')) {
    res.status(404).json({
      ok: false,
      error: { code: 'NOT_FOUND', message: '接口不存在', details: null },
      request_id: req.id,
    });
    return;
  }
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>404</title>' +
      '<div style="font-family:system-ui;padding:48px;text-align:center;color:#333">' +
      '<h1 style="font-size:64px;margin:0">404</h1><p>页面不存在</p>' +
      '<p><a href="/login.html" style="color:#26abe8">返回登录页</a></p></div>'
  );
}

// eslint-disable-next-line no-unused-vars -- Express 依靠四个参数识别错误中间件
function errorHandler(err, req, res, next) {
  let normalized = err;

  // 统一转换已知的第三方/运行时错误为标准 AppError
  if (!(err instanceof AppError)) {
    if (err && err.type === 'entity.too.large') {
      normalized = new AppError('请求体过大', { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    } else if (err && err.type === 'entity.parse.failed') {
      normalized = new ValidationError('请求体不是合法的 JSON', [
        { field: 'body', message: 'JSON 解析失败' },
      ]);
    } else if (err && err.code === 'EBADCSRFTOKEN') {
      normalized = new AppError('请求令牌无效', { status: 403, code: 'CSRF_INVALID' });
    } else {
      normalized = new AppError(
        (err && err.message) || '服务器内部错误',
        { status: 500, code: 'INTERNAL_ERROR', expose: false }
      );
    }
  }

  const isServerError = normalized.status >= 500;

  if (isServerError) {
    // 服务端错误才记录堆栈，且只进日志、不进响应
    logger.error('未处理的服务端异常', {
      request_id: req.id,
      code: normalized.code,
      message: normalized.message,
      stack: normalized.stack,
    });
  }

  if (res.headersSent) return;

  res.status(normalized.status).json({
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.expose ? normalized.message : '服务器内部错误，请稍后重试',
      details: normalized.expose ? (normalized.details ?? null) : null,
    },
    request_id: req.id,
  });
}

module.exports = { errorHandler, notFoundHandler };
