'use strict';

/**
 * 认证服务：承载登录、令牌签发、口令修改等业务规则。
 * 不依赖任何 HTTP 对象，便于单元测试。
 */
const { hashPassword, verifyPassword } = require('../lib/passwords');
const { UnauthorizedError, ForbiddenError, NotFoundError, RateLimitError } = require('../lib/errors');

/** 内存级登录限流：按「用户名 + IP」计数，用于抵御口令爆破 */
class LoginThrottle {
  constructor({ maxAttempts, windowMs }) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  _key(username, ip) {
    return `${String(username).toLowerCase()}|${ip}`;
  }

  /** 若已超限则抛错，并附带待重试秒数 */
  assertAllowed(username, ip) {
    const key = this._key(username, ip);
    const bucket = this.buckets.get(key);
    if (!bucket) return;

    if (Date.now() - bucket.firstAt > this.windowMs) {
      this.buckets.delete(key);
      return;
    }
    if (bucket.count >= this.maxAttempts) {
      const retryAfterSec = Math.ceil(
        (bucket.windowMs - (Date.now() - bucket.firstAt)) / 1000
      );
      throw new RateLimitError(
        `登录尝试过于频繁，请 ${Math.max(retryAfterSec, 1)} 秒后再试`,
        Math.max(retryAfterSec, 1)
      );
    }
  }

  recordFailure(username, ip) {
    const key = this._key(username, ip);
    const bucket = this.buckets.get(key);
    if (!bucket || Date.now() - bucket.firstAt > this.windowMs) {
      this.buckets.set(key, { count: 1, firstAt: Date.now(), windowMs: this.windowMs });
      return;
    }
    bucket.count += 1;
  }

  reset(username, ip) {
    this.buckets.delete(this._key(username, ip));
  }

  /** 定期清理过期桶，避免内存缓慢增长 */
  startSweeper() {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.firstAt > bucket.windowMs) this.buckets.delete(key);
      }
    }, this.windowMs);
    timer.unref();
    return timer;
  }
}

class AuthService {
  /**
   * @param {object} deps
   * @param {import('../repositories').AccountRepository} deps.accountRepository
   * @param {import('../repositories').AdminRepository} deps.adminRepository
   * @param {import('./token-service').TokenService} deps.tokenService
   * @param {import('../lib/logger').logger} deps.logger
   * @param {object} deps.config
   */
  constructor({ accountRepository, adminRepository, tokenService, logger, config }) {
    this.accountRepository = accountRepository;
    this.adminRepository = adminRepository;
    this.tokenService = tokenService;
    this.logger = logger;
    this.config = config;
    this.throttle = new LoginThrottle(config.security);
  }

  /**
   * 前台账号登录：校验凭据并签发访问令牌。
   * 无论用户不存在还是口令错误，返回的错误文案完全一致，避免账号枚举。
   */
  async loginAccount({ username, password, ip }) {
    this.throttle.assertAllowed(username, ip);

    const account = this.accountRepository.findRawByUsername(username);
    const passwordOk = account
      ? await verifyPassword(password, account.password_hash)
      : await verifyPassword(password, 'scrypt$00$00'); // 不存在时也走一次运算，抹平时序差异

    if (!account || !passwordOk) {
      this.throttle.recordFailure(username, ip);
      this.logger.warn('前台登录失败', { username, ip });
      throw new UnauthorizedError('用户名或密码错误', 'INVALID_CREDENTIALS');
    }

    if (account.is_active === false) {
      this.logger.warn('前台登录被拒：账号已停用', { username, ip });
      throw new ForbiddenError('该账号已被停用，请联系管理员');
    }

    this.throttle.reset(username, ip);
    this.logger.info('前台登录成功', { username, ip });

    const token = this.tokenService.sign(
      { sub: account.id, username: account.username, typ: 'account' },
      { expiresInSec: this.config.jwt.accessTokenTtlSec }
    );

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.config.jwt.accessTokenTtlSec,
      user: this.accountRepository.toPublic(account),
    };
  }

  /**
   * 后台管理员登录。仅 superadmin / admin 角色可进入后台。
   */
  async loginAdmin({ username, password, ip }) {
    this.throttle.assertAllowed(`admin:${username}`, ip);

    const admin = this.adminRepository.findRawByUsername(username);
    const passwordOk = admin
      ? await verifyPassword(password, admin.password_hash)
      : await verifyPassword(password, 'scrypt$00$00');

    if (!admin || !passwordOk) {
      this.throttle.recordFailure(`admin:${username}`, ip);
      this.logger.warn('后台登录失败', { username, ip });
      throw new UnauthorizedError('用户名或密码错误', 'INVALID_CREDENTIALS');
    }
    if (admin.is_active === false) {
      throw new ForbiddenError('该管理员账号已被停用');
    }

    this.throttle.reset(`admin:${username}`, ip);
    await this.adminRepository.touchLastLogin(admin.id, new Date().toISOString());
    this.logger.info('后台登录成功', { username, ip, role: admin.role });

    const token = this.tokenService.sign(
      { sub: admin.id, username: admin.username, role: admin.role || 'admin', typ: 'admin' },
      { expiresInSec: this.config.jwt.adminTokenTtlSec }
    );

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.config.jwt.adminTokenTtlSec,
      admin: {
        id: admin.id,
        username: admin.username,
        display_name: admin.display_name || admin.username,
        role: admin.role || 'admin',
      },
    };
  }

  /** 解析访问令牌，返回载荷 */
  verifyToken(token) {
    return this.tokenService.verify(token);
  }

  /** 读取当前登录的账号信息 */
  async loadAccount(accountId) {
    const account = this.accountRepository.findRawById(accountId);
    if (!account) throw new NotFoundError('账号不存在或已被删除');
    return this.accountRepository.toPublic(account);
  }

  /** 读取当前登录的管理员信息 */
  async loadAdmin(adminId) {
    const admin = this.adminRepository.findRawById(adminId);
    if (!admin) throw new NotFoundError('管理员账号不存在');
    return {
      id: admin.id,
      username: admin.username,
      display_name: admin.display_name || admin.username,
      role: admin.role || 'admin',
    };
  }

  /** 修改口令：需校验原口令，且新口令不得与原口令相同 */
  async changePassword({ repository, record, oldPassword, newPassword, kind = 'account' }) {
    const ok = await verifyPassword(oldPassword, record.password_hash);
    if (!ok) {
      throw new UnauthorizedError('原密码不正确', 'OLD_PASSWORD_MISMATCH');
    }
    if (oldPassword === newPassword) {
      throw new UnauthorizedError('新密码不能与原密码相同', 'PASSWORD_UNCHANGED');
    }

    const passwordHash = await hashPassword(newPassword);
    await repository.update(record.id, {
      password_hash: passwordHash,
      updated_at: new Date().toISOString(),
    });
    this.logger.info('口令已修改', { kind, userId: record.id });
  }
}

module.exports = { AuthService, LoginThrottle };
