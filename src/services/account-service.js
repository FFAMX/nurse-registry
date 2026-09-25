'use strict';

/**
 * 账号服务：承载账号增删改查的业务规则（校验、唯一性、口令散列、对外脱敏）。
 */
const { hashPassword } = require('../lib/passwords');
const { JsonDatabase } = require('../lib/json-db');
const { validate } = require('../lib/validate');
const { generatePagePassword } = require('../lib/page-crypto');
const { NotFoundError, ConflictError, ValidationError } = require('../lib/errors');

/** 列表查询支持的排序字段白名单 */
const SORTABLE = new Set(['created_at', 'updated_at', 'username', 'display_name']);

class AccountService {
  /**
   * @param {object} deps
   * @param {import('../repositories').AccountRepository} deps.accountRepository
   * @param {import('../repositories').AuditRepository} deps.auditRepository
   * @param {import('../lib/logger').logger} deps.logger
   */
  constructor({ accountRepository, auditRepository, logger }) {
    this.accountRepository = accountRepository;
    this.auditRepository = auditRepository;
    this.logger = logger;
  }

  /**
   * 列表查询：关键字搜索 + 状态过滤 + 排序 + 分页。
   * 分页在服务层完成，仓储层只提供原始集合。
   */
  list({ keyword = '', status = '', sort = 'created_at', order = 'desc', page = 1, pageSize = 10 } = {}) {
    let items = this.accountRepository.list();

    const trimmedKeyword = String(keyword || '').trim().toLowerCase();
    if (trimmedKeyword) {
      items = items.filter((account) => {
        const haystack = [
          account.username,
          account.display_name,
          account.profile?.['姓名'],
          account.profile?.['身份证号'],
          account.profile?.['执业机构'],
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(trimmedKeyword);
      });
    }

    if (status === 'active') items = items.filter((account) => account.is_active);
    else if (status === 'disabled') items = items.filter((account) => !account.is_active);

    const sortKey = SORTABLE.has(sort) ? sort : 'created_at';
    const direction = order === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const left = String(a[sortKey] ?? '');
      const right = String(b[sortKey] ?? '');
      if (left === right) return 0;
      return left > right ? direction : -direction;
    });

    const total = items.length;
    const safePageSize = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const totalPages = Math.max(Math.ceil(total / safePageSize), 1);
    const currentPage = Math.min(safePage, totalPages);
    const start = (currentPage - 1) * safePageSize;

    return {
      items: items.slice(start, start + safePageSize),
      pagination: {
        page: currentPage,
        pageSize: safePageSize,
        total,
        totalPages,
      },
      stats: this.accountRepository.stats(),
    };
  }

  getById(id) {
    const account = this.accountRepository.findRawById(id);
    if (!account) throw new NotFoundError('账号不存在');
    return this.accountRepository.toPublic(account);
  }

  /** 新增账号：校验 → 查重 → 散列口令 → 落库 */
  async create(input, { operator = 'system' } = {}) {
    const data = validate(input, (v) => {
      v.username('username', { required: true });
      v.password('password', { required: true, min: 6 });
      v.string('display_name', { required: false, max: 64, label: '显示名称' });
      v.profile('profile');
      v.boolean('is_active', { fallback: true, label: '启用状态' });
    });

    if (this.accountRepository.usernameExists(data.username)) {
      throw new ConflictError(`用户名「${data.username}」已存在`);
    }

    const now = new Date().toISOString();
    const record = {
      id: JsonDatabase.nextId('acc'),
      username: data.username,
      display_name: data.display_name || data.profile['姓名'] || data.username,
      password_hash: await hashPassword(data.password),
      is_active: data.is_active,
      profile: data.profile,
      created_at: now,
      updated_at: now,
      last_login_at: null,
    };

    await this.accountRepository.create(record);
    await this._audit(operator, 'account.create', record.id, `新增账号 ${record.username}`);

    return this.accountRepository.toPublic(record);
  }

  /**
   * 更新账号。username 允许修改，但需通过唯一性检查。
   * password 字段为空时表示保持原口令不变。
   */
  async update(id, input, { operator = 'system' } = {}) {
    const existing = this.accountRepository.findRawById(id);
    if (!existing) throw new NotFoundError('账号不存在');

    // PATCH 语义：先把未提供的字段用原值补齐，再走统一校验。
    // 这样调用方只传 display_name 之类的单个字段也能成功更新。
    const merged = {
      username: existing.username,
      display_name: existing.display_name,
      is_active: existing.is_active !== false,
      profile: existing.profile || {},
      ...input,
    };

    const data = validate(merged, (v) => {
      v.username('username', { required: true });
      v.password('password', { required: false, min: 6 });
      v.string('display_name', { required: false, max: 64, label: '显示名称' });
      v.profile('profile');
      v.boolean('is_active', { fallback: existing.is_active !== false, label: '启用状态' });
    });

    if (this.accountRepository.usernameExists(data.username, { excludeId: id })) {
      throw new ConflictError(`用户名「${data.username}」已被其他账号使用`);
    }

    const patch = {
      username: data.username,
      display_name: data.display_name || data.profile['姓名'] || data.username,
      is_active: data.is_active,
      profile: data.profile,
      updated_at: new Date().toISOString(),
    };

    if (data.password) {
      patch.password_hash = await hashPassword(data.password);
    }

    const updated = await this.accountRepository.update(id, patch);
    if (!updated) throw new NotFoundError('账号不存在');

    await this._audit(operator, 'account.update', id, `更新账号 ${patch.username}`);

    return this.accountRepository.toPublic(updated);
  }

  /** 删除单个账号 */
  async remove(id, { operator = 'system' } = {}) {
    const account = this.accountRepository.findRawById(id);
    if (!account) throw new NotFoundError('账号不存在');

    const removed = await this.accountRepository.remove(id);
    if (!removed) throw new NotFoundError('账号不存在');

    await this._audit(operator, 'account.delete', id, `删除账号 ${account.username}`);

    return { id, username: account.username };
  }

  /** 批量删除 */
  async removeMany(ids, { operator = 'system' } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('请至少选择一个要删除的账号', [
        { field: 'ids', message: 'ids 必须是非空数组' },
      ]);
    }
    if (ids.length > 100) {
      throw new ValidationError('单次最多删除 100 条记录', [
        { field: 'ids', message: '数量超出上限' },
      ]);
    }

    const deleted = await this.accountRepository.removeMany(ids);
    await this._audit(operator, 'account.delete_batch', null, `批量删除 ${deleted} 个账号`);

    return { deleted };
  }

  /** 切换启用/停用状态 */
  async toggleActive(id, { operator = 'system' } = {}) {
    const account = this.accountRepository.findRawById(id);
    if (!account) throw new NotFoundError('账号不存在');

    const next = !(account.is_active !== false);
    const updated = await this.accountRepository.update(id, {
      is_active: next,
      updated_at: new Date().toISOString(),
    });

    await this._audit(
      operator,
      'account.toggle_active',
      id,
      `${next ? '启用' : '停用'}账号 ${account.username}`
    );

    return this.accountRepository.toPublic(updated);
  }

  /**
   * 给账号设置页面密码（用于加密对外信息页）。
   * 传 password 则使用指定值，否则随机生成一个高强度密码。
   * 返回值是**明文密码**：页面密码必须能被管理员读出来发给护士，
   * 因此不能像登录口令那样只存散列。（本字段不会出现在任何对外接口里）
   */
  async setPagePassword(id, password = null, { operator = 'system' } = {}) {
    const account = this.accountRepository.findRawById(id);
    if (!account) throw new NotFoundError('账号不存在');

    const value = password ? String(password).trim() : generatePagePassword();
    if (value.length < 8) {
      throw new ValidationError('页面密码至少 8 位', { field: 'page_password' });
    }

    await this.accountRepository.update(id, {
      page_password: value,
      updated_at: new Date().toISOString(),
    });

    await this._audit(
      operator,
      'account.page_password',
      id,
      `${password ? '设置' : '重置'}账号 ${account.username} 的页面密码`
    );

    return value;
  }

  /** 账号没有页面密码时才生成，已有则原样返回；供推送时自动补齐 */
  async ensurePagePassword(id, { operator = 'system' } = {}) {
    const account = this.accountRepository.findRawById(id);
    if (!account) throw new NotFoundError('账号不存在');
    if (account.page_password) return account.page_password;
    return this.setPagePassword(id, null, { operator });
  }

  /** 读取页面密码（仅后台接口使用，用于把密码发给护士） */
  getPagePassword(id) {
    const account = this.accountRepository.findRawById(id);
    if (!account) throw new NotFoundError('账号不存在');
    return account.page_password || null;
  }

  /** 写审计日志；失败不应影响主业务流程 */
  async _audit(operator, action, targetId, detail) {
    try {
      await this.auditRepository.append({
        id: JsonDatabase.nextId('log'),
        at: new Date().toISOString(),
        operator,
        action,
        target_id: targetId,
        detail,
      });
    } catch (error) {
      this.logger.warn('审计日志写入失败', { action, error: error.message });
    }
  }
}

module.exports = { AccountService };
