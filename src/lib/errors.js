'use strict';

/**
 * 类型化错误体系。
 * 客户端只会看到规范化的错误结构，绝不返回堆栈或内部细节。
 */
class AppError extends Error {
  /**
   * @param {string} message 面向开发者的描述
   * @param {object} options
   * @param {number} options.status HTTP 状态码
   * @param {string} options.code 机器可读的错误码
   * @param {Array}  [options.details] 字段级错误明细
   * @param {boolean}[options.expose] 是否可安全返回给客户端
   */
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details = null, expose = true } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
    this.isOperational = true;
  }
}

class ValidationError extends AppError {
  constructor(message = '请求参数校验未通过', details = null) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

class UnauthorizedError extends AppError {
  constructor(message = '未登录或登录状态已失效', code = 'UNAUTHORIZED') {
    super(message, { status: 401, code });
  }
}

class ForbiddenError extends AppError {
  constructor(message = '没有权限执行该操作') {
    super(message, { status: 403, code: 'FORBIDDEN' });
  }
}

class NotFoundError extends AppError {
  constructor(message = '请求的资源不存在') {
    super(message, { status: 404, code: 'NOT_FOUND' });
  }
}

class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, { status: 409, code: 'CONFLICT' });
  }
}

class RateLimitError extends AppError {
  constructor(message = '请求过于频繁，请稍后再试', retryAfterSec = 60) {
    super(message, { status: 429, code: 'RATE_LIMITED' });
    this.retryAfterSec = retryAfterSec;
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
};
