'use strict';

/**
 * 账号仓储层：只负责数据查询与写入，不承载业务规则。
 */
const { JsonDatabase } = require('../lib/json-db');

class AccountRepository {
  /** @param {import('../lib/json-db').JsonDatabase} db */
  constructor(db) {
    this.db = db;
  }

  _accounts() {
    const data = this.db.read();
    if (!Array.isArray(data.accounts)) data.accounts = [];
    return data.accounts;
  }

  /** 列出全部账号（不含口令散列） */
  list() {
    return this._accounts().map((account) => this.toPublic(account));
  }

  /**
   * 列出全部原始记录（含口令散列与页面密码）。
   * 仅供服务端内部使用：生成加密页面需要拿到页面密码明文。
   * 任何对外接口都必须走 toPublic / list，不要把本方法的返回值直接返回给客户端。
   */
  listRaw() {
    return this._accounts().slice();
  }

  /** 按 id 查找原始记录（含口令散列，仅认证流程使用） */
  findRawById(id) {
    return this._accounts().find((account) => account.id === id) || null;
  }

  /** 按用户名查找原始记录（用户名大小写不敏感，便于学习时手动输入） */
  findRawByUsername(username) {
    if (typeof username !== 'string') return null;
    const target = username.trim().toLowerCase();
    return (
      this._accounts().find(
        (account) => String(account.username).toLowerCase() === target
      ) || null
    );
  }

  /** 判断用户名是否已被占用（可排除某个 id，用于更新场景） */
  usernameExists(username, { excludeId = null } = {}) {
    const target = String(username || '').trim().toLowerCase();
    return this._accounts().some(
      (account) =>
        String(account.username).toLowerCase() === target && account.id !== excludeId
    );
  }

  /** 统计信息 */
  stats() {
    const accounts = this._accounts();
    return {
      total: accounts.length,
      active: accounts.filter((account) => account.is_active).length,
      registered: accounts.filter((account) => account.profile?.['执业注册状态'] === '在册')
        .length,
    };
  }

  /** 新增账号 */
  async create(record) {
    return this.db.mutate((data) => {
      data.accounts.push(record);
      return record;
    });
  }

  /** 更新账号（仅覆盖传入的字段） */
  async update(id, patch) {
    return this.db.mutate((data) => {
      const index = data.accounts.findIndex((account) => account.id === id);
      if (index === -1) return null;
      data.accounts[index] = { ...data.accounts[index], ...patch };
      return data.accounts[index];
    });
  }

  /** 删除账号，返回是否命中 */
  async remove(id) {
    return this.db.mutate((data) => {
      const index = data.accounts.findIndex((account) => account.id === id);
      if (index === -1) return null;
      const [removed] = data.accounts.splice(index, 1);
      return removed;
    });
  }

  /** 批量删除，返回实际删除的数量 */
  async removeMany(ids) {
    const target = new Set(ids);
    return this.db.mutate((data) => {
      const before = data.accounts.length;
      data.accounts = data.accounts.filter((account) => !target.has(account.id));
      return before - data.accounts.length;
    });
  }

  /**
   * 对外输出：剥离口令散列与页面密码等敏感字段。
   * 页面密码只通过专门的后台接口单独下发，避免混在账号列表里被前端接口带出去。
   */
  toPublic(account) {
    if (!account) return null;
    const { password_hash: _hash, page_password: _pagePassword, ...rest } = account;
    return rest;
  }
}

class AdminRepository {
  /** @param {import('../lib/json-db').JsonDatabase} db */
  constructor(db) {
    this.db = db;
  }

  _admins() {
    const data = this.db.read();
    if (!Array.isArray(data.admins)) data.admins = [];
    return data.admins;
  }

  list() {
    return this._admins().map((admin) => ({
      id: admin.id,
      username: admin.username,
      display_name: admin.display_name || admin.username,
      role: admin.role || 'admin',
      is_active: admin.is_active !== false,
      created_at: admin.created_at,
      last_login_at: admin.last_login_at || null,
    }));
  }

  findRawByUsername(username) {
    if (typeof username !== 'string') return null;
    const target = username.trim().toLowerCase();
    return (
      this._admins().find(
        (admin) => String(admin.username).toLowerCase() === target
      ) || null
    );
  }

  findRawById(id) {
    return this._admins().find((admin) => admin.id === id) || null;
  }

  count() {
    return this._admins().length;
  }

  async create(record) {
    return this.db.mutate((data) => {
      data.admins.push(record);
      return record;
    });
  }

  async update(id, patch) {
    return this.db.mutate((data) => {
      const index = data.admins.findIndex((admin) => admin.id === id);
      if (index === -1) return null;
      data.admins[index] = { ...data.admins[index], ...patch };
      return data.admins[index];
    });
  }

  async remove(id) {
    return this.db.mutate((data) => {
      const index = data.admins.findIndex((admin) => admin.id === id);
      if (index === -1) return null;
      const [removed] = data.admins.splice(index, 1);
      return removed;
    });
  }

  /** 记录最近登录时间（失败不影响主流程） */
  async touchLastLogin(id, isoTime) {
    return this.db.mutate((data) => {
      const admin = data.admins.find((item) => item.id === id);
      if (!admin) return null;
      admin.last_login_at = isoTime;
      return admin;
    });
  }
}

class AuditRepository {
  /** @param {import('../lib/json-db').JsonDatabase} db */
  constructor(db) {
    this.db = db;
    this.limit = 200;
  }

  list({ limit = 50 } = {}) {
    const data = this.db.read();
    const logs = Array.isArray(data.audit_logs) ? data.audit_logs : [];
    return logs.slice(0, Math.min(limit, this.limit));
  }

  async append(entry) {
    return this.db.mutate((data) => {
      if (!Array.isArray(data.audit_logs)) data.audit_logs = [];
      data.audit_logs.unshift(entry);
      // 只保留最近 N 条，避免文件无限膨胀
      if (data.audit_logs.length > this.limit) {
        data.audit_logs.length = this.limit;
      }
      return entry;
    });
  }
}

module.exports = { AccountRepository, AdminRepository, AuditRepository, JsonDatabase };
