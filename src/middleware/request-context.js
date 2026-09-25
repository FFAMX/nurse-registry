'use strict';

/**
 * 请求上下文：为每个请求生成 ID，并记录请求起止与耗时。
 */
const crypto = require('node:crypto');

const { logger } = require('../lib/logger');

const REQUEST_ID_HEADER = 'x-request-id';

function requestContext(req, res, next) {
  // 支持上游（如 Nginx）透传的请求 ID，否则自行生成
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId =
    typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();

  req.id = requestId;
  req.startedAt = process.hrtime.bigint();
  res.setHeader(REQUEST_ID_HEADER, requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    const meta = {
      request_id: requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      ip: req.ip,
    };

    // 5xx 记为 error，4xx 记为 warn，其余 info —— 便于日志系统分级告警
    if (res.statusCode >= 500) logger.error('请求处理失败', meta);
    else if (res.statusCode >= 400) logger.warn('请求被拒绝', meta);
    else logger.info('请求完成', meta);
  });

  next();
}

module.exports = { requestContext, REQUEST_ID_HEADER };
