/**
 * 后台 API 客户端
 *
 * 设计要点：
 * - 统一的类型化 fetch 封装，Base URL 走同源相对路径（无需硬编码域名）；
 * - 访问令牌存内存 + sessionStorage（不用 localStorage，降低 XSS 长期风险）；
 * - 4xx 不重试、5xx / 网络错误自动重试（最多 3 次，指数退避）；
 * - 后端错误码映射为可读中文文案，并把字段级错误一并带出。
 */
(function (global) {
  'use strict';

  // 同源部署下用相对路径即可；如需指向独立后端，改这一处即可
  var BASE_URL = '';

  var TOKEN_KEY = 'nurse_admin_token';
  var TOKEN_TTL_KEY = 'nurse_admin_token_exp';

  /* ------------------------------------------------------------------ *
   * 错误类型
   * ------------------------------------------------------------------ */

  function ApiError(message, options) {
    var opts = options || {};
    this.name = 'ApiError';
    this.message = message;
    this.code = opts.code || 'UNKNOWN';
    this.status = opts.status || 0;
    this.details = opts.details || null;
    this.requestId = opts.requestId || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  /** 网络层异常（断网、DNS 失败等），与业务错误区分开 */
  function NetworkError(message) {
    ApiError.call(this, message, { code: 'NETWORK_ERROR', status: 0 });
    this.name = 'NetworkError';
  }
  NetworkError.prototype = Object.create(ApiError.prototype);
  NetworkError.prototype.constructor = NetworkError;

  /* ------------------------------------------------------------------ *
   * 令牌管理
   * ------------------------------------------------------------------ */

  var memoryToken = null;

  var tokenStore = {
    save: function (token, expiresInSec) {
      memoryToken = token;
      try {
        global.sessionStorage.setItem(TOKEN_KEY, token);
        global.sessionStorage.setItem(
          TOKEN_TTL_KEY,
          String(Date.now() + (Number(expiresInSec) || 0) * 1000)
        );
      } catch (error) {
        /* 隐私模式下 sessionStorage 可能不可用，退化为仅内存保存 */
      }
    },

    get: function () {
      if (memoryToken) return memoryToken;
      try {
        var token = global.sessionStorage.getItem(TOKEN_KEY);
        var expiry = Number(global.sessionStorage.getItem(TOKEN_TTL_KEY) || 0);
        if (!token) return null;
        if (expiry && Date.now() >= expiry) {
          tokenStore.clear();
          return null;
        }
        memoryToken = token;
        return token;
      } catch (error) {
        return null;
      }
    },

    clear: function () {
      memoryToken = null;
      try {
        global.sessionStorage.removeItem(TOKEN_KEY);
        global.sessionStorage.removeItem(TOKEN_TTL_KEY);
      } catch (error) {
        /* 忽略 */
      }
    },
  };

  /* ------------------------------------------------------------------ *
   * 错误文案映射：后端错误码 → 可读中文提示
   * ------------------------------------------------------------------ */

  var CODE_MESSAGES = {
    NETWORK_ERROR: '网络连接失败，请检查网络后重试',
    INTERNAL_ERROR: '服务器开小差了，请稍后重试',
    NOT_FOUND: '请求的资源不存在',
    VALIDATION_ERROR: '提交的内容不符合要求，请检查后重试',
    UNAUTHORIZED: '登录状态已失效，请重新登录',
    TOKEN_EXPIRED: '登录状态已过期，请重新登录',
    TOKEN_MISSING: '请先登录',
    TOKEN_INVALID: '登录凭证无效，请重新登录',
    TOKEN_TYPE_MISMATCH: '当前登录身份无权访问该接口',
    INVALID_CREDENTIALS: '用户名或密码错误',
    FORBIDDEN: '没有权限执行该操作',
    CONFLICT: '该记录已存在，请更换后重试',
    RATE_LIMITED: '操作过于频繁，请稍后再试',
    PAYLOAD_TOO_LARGE: '提交内容过大，请精简后重试',
  };

  function messageFor(code, fallback) {
    if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
    return fallback || '请求失败，请稍后重试';
  }

  /* ------------------------------------------------------------------ *
   * 核心请求
   * ------------------------------------------------------------------ */

  var RETRYABLE_STATUS = [500, 502, 503, 504];
  var MAX_RETRIES = 3;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 发起一次 API 请求。
   * @param {string} path 例如 '/api/admin/accounts'
   * @param {object} options { method, body, query, retries }
   * @returns {Promise<any>} 成功时返回 data 字段
   */
  function request(path, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var attempt = 0;
    // 允许单个接口覆盖重试次数（例如头像上传，重传代价高且意义不大）
    var maxRetries = typeof opts.retries === 'number' ? opts.retries : MAX_RETRIES;

    function buildUrl() {
      var url = BASE_URL + path;
      var query = opts.query;
      if (query) {
        var parts = [];
        Object.keys(query).forEach(function (key) {
          var value = query[key];
          if (value === undefined || value === null || value === '') return;
          parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        });
        if (parts.length) url += (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
      }
      return url;
    }

    /**
     * 是否同时发送标准 Authorization 头。
     *
     * 默认关闭：部署到云平台时，网关会往请求里注入它自己的 Authorization 头。
     * 应用再发一个同名头，两边冲突会导致请求异常（表现为请求挂起不返回）。
     * 只发应用专用的 X-Auth-Token 可以彻底避开这个问题。
     *
     * 若你的部署环境需要一个标准的 Authorization 头（例如自建 Nginx 鉴权），
     * 把这里改成 true 即可。
     */
    var SEND_AUTHORIZATION = false;

    /** 单个请求的超时时间（毫秒）。防止网关异常时请求永久挂起 */
    var REQUEST_TIMEOUT_MS = 20000;

    function run() {
      attempt += 1;

      var headers = { Accept: 'application/json' };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

      var token = tokenStore.get();
      if (token && opts.auth !== false) {
        // 应用专用头 —— 不受云平台网关注入影响，作为主鉴权方式
        headers['X-Auth-Token'] = token;

        // 标准头：按需开启（见 SEND_AUTHORIZATION 说明）
        if (SEND_AUTHORIZATION) {
          headers.Authorization = 'Bearer ' + token;
        }
      }

      // 用 AbortController 给请求加超时，避免网关异常时永久卡在「加载中」
      var controller =
        typeof global.AbortController === 'function' ? new global.AbortController() : null;
      var timer = null;

      if (controller) {
        timer = global.setTimeout(function () {
          controller.abort();
        }, REQUEST_TIMEOUT_MS);
      }

      function clearTimer() {
        if (timer !== null) {
          global.clearTimeout(timer);
          timer = null;
        }
      }

      return global
        .fetch(buildUrl(), {
          method: method,
          headers: headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        })
        .then(function (response) {
          clearTimer();
          return response;
        })
        .catch(function (error) {
          clearTimer();

          // 超时中断：不再重试，直接给出明确提示
          if (error && error.name === 'AbortError') {
            throw new NetworkError('请求超时，请稍后重试');
          }

          // 网络层失败：可重试
          if (attempt <= maxRetries) {
            return sleep(200 * Math.pow(2, attempt - 1)).then(run);
          }
          throw new NetworkError('网络连接失败，请检查网络后重试');
        })
        .then(function (response) {
          // 5xx 自动重试（最多 3 次，指数退避）
          if (RETRYABLE_STATUS.indexOf(response.status) !== -1 && attempt <= maxRetries) {
            return sleep(200 * Math.pow(2, attempt - 1)).then(run);
          }
          // 4xx 一律不重试
          return response
            .json()
            .catch(function () {
              return null;
            })
            .then(function (payload) {
              var requestId =
                (payload && payload.request_id) || response.headers.get('x-request-id');

              if (response.ok && payload && payload.ok) {
                return payload.data;
              }

              if (response.status === 401) {
                tokenStore.clear();
                if (typeof opts.onUnauthorized === 'function') opts.onUnauthorized();
              }

              var errorCode = payload && payload.error && payload.error.code;
              var rawMessage = payload && payload.error && payload.error.message;

              throw new ApiError(messageFor(errorCode, rawMessage), {
                code: errorCode || 'HTTP_' + response.status,
                status: response.status,
                details: payload && payload.error ? payload.error.details : null,
                requestId: requestId,
              });
            });
        });
    }

    return run();
  }

  /* ------------------------------------------------------------------ *
   * 接口封装
   * ------------------------------------------------------------------ */

  var api = {
    ApiError: ApiError,
    NetworkError: NetworkError,
    tokenStore: tokenStore,

    /** 后台登录 */
    login: function (username, password) {
      return request('/api/auth/admin/login', {
        method: 'POST',
        auth: false,
        body: { username: username, password: password },
      });
    },

    /** 当前管理员信息（用于校验令牌是否仍然有效） */
    me: function () {
      return request('/api/auth/admin/me');
    },

    /** 账号列表 */
    listAccounts: function (params) {
      return request('/api/admin/accounts', { query: params });
    },

    /** 账号详情 */
    getAccount: function (id) {
      return request('/api/admin/accounts/' + encodeURIComponent(id));
    },

    /** 新增账号 */
    createAccount: function (payload) {
      return request('/api/admin/accounts', { method: 'POST', body: payload });
    },

    /** 修改账号 */
    updateAccount: function (id, payload) {
      return request('/api/admin/accounts/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: payload,
      });
    },

    /** 删除账号 */
    deleteAccount: function (id) {
      return request('/api/admin/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    /** 批量删除 */
    batchDeleteAccounts: function (ids) {
      return request('/api/admin/accounts/batch-delete', {
        method: 'POST',
        body: { ids: ids },
      });
    },

    /** 启用 / 停用 */
    toggleAccountActive: function (id) {
      return request('/api/admin/accounts/' + encodeURIComponent(id) + '/toggle-active', {
        method: 'POST',
      });
    },

    /** 字段与枚举定义 */
    profileFields: function () {
      return request('/api/admin/profile-fields');
    },

    /** 上传头像：提交压缩后的 Data URL，返回站点内路径 */
    uploadAvatar: function (dataUrl) {
      return request('/api/admin/upload/avatar', {
        method: 'POST',
        body: { dataUrl: dataUrl },
        // 图片体积较大，且上传失败重传代价高，这里不做自动重试
        retries: 0,
      });
    },

    /** 取一份测试样本（供表单「随机生成」按钮使用） */
    randomSample: function () {
      return request('/api/admin/samples', { query: { count: 1 } });
    },

    /** 操作日志 */
    auditLogs: function (limit) {
      return request('/api/admin/audit-logs', { query: { limit: limit || 50 } });
    },

    /** 管理员列表 */
    listAdmins: function () {
      return request('/api/admin/admins');
    },

    /** 新增管理员 */
    createAdmin: function (payload) {
      return request('/api/admin/admins', { method: 'POST', body: payload });
    },

    /** 删除管理员 */
    deleteAdmin: function (id) {
      return request('/api/admin/admins/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    /* ---------------- GitHub 私有仓库同步（按账号） ---------------- */

    /** 推送状态：是否已配置、每个账号的推送状态（已推送 / 有改动 / 未推送） */
    githubStatus: function () {
      return request('/api/admin/github/status');
    },

    /** 把单个账号的信息页推送到私有仓库 */
    githubPushAccount: function (id) {
      return request('/api/admin/github/accounts/' + encodeURIComponent(id) + '/push', {
        method: 'POST',
        // 推送涉及多次远端调用，失败重传可能造成重复提交，交由用户手动重试
        retries: 0,
      });
    },

    /** 把单个账号从私有仓库撤回 */
    githubRevertAccount: function (id) {
      return request('/api/admin/github/accounts/' + encodeURIComponent(id) + '/revert', {
        method: 'POST',
        retries: 0,
      });
    },
  };

  global.AdminApi = api;
})(window);
