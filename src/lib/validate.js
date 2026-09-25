'use strict';

/**
 * 边界处输入校验：绝不信任客户端数据。
 * 所有校验失败都抛出 ValidationError，由全局错误处理中间件统一格式化。
 */
const { ValidationError } = require('./errors');

const PROFILE_FIELD_ORDER = [
  '姓名',
  '性别',
  '执业注册状态',
  '出生日期',
  '国籍',
  '民族',
  '身份证号',
  '护士执业证书编号',
  '注册有效期至',
  '通过考试时间',
  '健康状况',
  '参加工作时间',
  '执业机构',
  '工作科室',
  '工作类别',
  '职务',
  '技术职称',
  '审批机关',
  '审批时间',
  '头像',
];

/** 单字段最大长度，避免超大字符串污染数据文件 */
const MAX_FIELD_LENGTH = 500;
const MAX_USERNAME_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 64;

class Validator {
  constructor() {
    this.errors = [];
    this.value = {};
  }

  _fail(field, message) {
    this.errors.push({ field, message });
    return this;
  }

  /** 必填字符串 */
  string(field, { required = false, max = MAX_FIELD_LENGTH, label = field } = {}) {
    const raw = this.input?.[field];
    const value = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim();

    if (required && value.length === 0) {
      return this._fail(field, `${label}不能为空`);
    }
    if (value.length > max) {
      return this._fail(field, `${label}长度不能超过 ${max} 个字符`);
    }
    this.value[field] = value;
    return this;
  }

  /** 枚举校验 */
  enum(field, allowed, { label = field, fallback = '' } = {}) {
    const raw = this.input?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (value.length === 0) {
      this.value[field] = fallback;
      return this;
    }
    if (!allowed.includes(value)) {
      return this._fail(field, `${label}只能是：${allowed.join('、')}`);
    }
    this.value[field] = value;
    return this;
  }

  /** 日期格式 YYYY-MM-DD（允许为空） */
  date(field, { label = field } = {}) {
    const raw = this.input?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (value.length === 0) {
      this.value[field] = '';
      return this;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return this._fail(field, `${label}格式应为 YYYY-MM-DD`);
    }

    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const valid =
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;

    if (!valid) return this._fail(field, `${label}不是一个有效日期`);

    this.value[field] = value;
    return this;
  }

  /** 可选 URL（仅允许 http/https，杜绝 javascript: 之类注入） */
  url(field, { label = field, max = 1000 } = {}) {
    const raw = this.input?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (value.length === 0) {
      this.value[field] = '';
      return this;
    }
    if (value.length > max) {
      return this._fail(field, `${label}长度不能超过 ${max} 个字符`);
    }

    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return this._fail(field, `${label}必须是合法的 URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return this._fail(field, `${label}仅支持 http/https 协议`);
    }

    this.value[field] = value;
    return this;
  }

  /** 布尔值 */
  boolean(field, { fallback = false, label = field } = {}) {
    const raw = this.input?.[field];
    if (raw === undefined || raw === null || raw === '') {
      this.value[field] = fallback;
      return this;
    }
    if (typeof raw !== 'boolean') {
      return this._fail(field, `${label}必须是布尔值`);
    }
    this.value[field] = raw;
    return this;
  }

  /** 用户名：字母数字与 - _ . @，便于使用身份证号作为用户名 */
  username(field, { required = true, label = '用户名' } = {}) {
    const raw = this.input?.[field];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (required && value.length === 0) {
      return this._fail(field, `${label}不能为空`);
    }
    if (value.length > MAX_USERNAME_LENGTH) {
      return this._fail(field, `${label}长度不能超过 ${MAX_USERNAME_LENGTH} 个字符`);
    }
    if (value.length > 0 && !/^[A-Za-z0-9._@-]+$/.test(value)) {
      return this._fail(field, `${label}只能包含字母、数字及 . _ - @`);
    }
    this.value[field] = value;
    return this;
  }

  /** 口令：长度下限校验，不做字符集限制（长度优先于复杂度） */
  password(field, { required = true, min = 6, max = 128, label = '密码' } = {}) {
    const raw = this.input?.[field];

    if (raw === undefined || raw === null || raw === '') {
      if (required) return this._fail(field, `${label}不能为空`);
      this.value[field] = undefined;
      return this;
    }
    if (typeof raw !== 'string') {
      return this._fail(field, `${label}格式不正确`);
    }
    if (raw.length < min) {
      return this._fail(field, `${label}长度不能少于 ${min} 位`);
    }
    if (raw.length > max) {
      return this._fail(field, `${label}长度不能超过 ${max} 位`);
    }

    this.value[field] = raw;
    return this;
  }

  /** 资料对象：按白名单字段逐个清洗，未识别的键一律丢弃 */
  profile(field, { label = '资料' } = {}) {
    const raw = this.input?.[field];

    if (raw === undefined || raw === null) {
      this.value[field] = {};
      return this;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return this._fail(field, `${label}必须是对象`);
    }

    const cleaned = {};
    for (const key of PROFILE_FIELD_ORDER) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      // 白名单键名 + 强制字符串化，防止写入对象/数组
      cleaned[key] = String(value).trim().slice(0, MAX_FIELD_LENGTH);
    }

    if (cleaned['头像']) {
      const avatar = cleaned['头像'];
      // 允许三种写法：
      //   1) 完整 URL            https://example.com/a.png
      //   2) 站点根路径          /assets/img/a.png
      //   3) 相对当前页面的路径  ./assets/img/a.png
      // 注意 new URL() 只接受绝对地址，相对路径需要基于一个基准地址解析。
      let parsed;
      try {
        parsed = new URL(avatar, 'http://localhost/');
      } catch {
        return this._fail(`${field}.头像`, '头像必须是合法的 URL 或站点内路径');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return this._fail(`${field}.头像`, '头像仅支持 http/https 协议');
      }
      // 拦截 javascript: 等协议被基准地址包装的情况
      if (/^[a-zA-Z][\w+.-]*:/.test(avatar) && !/^https?:/i.test(avatar)) {
        return this._fail(`${field}.头像`, '头像仅支持 http/https 协议');
      }
    }

    if (cleaned['性别'] && !['男', '女', '其他'].includes(cleaned['性别'])) {
      return this._fail(`${field}.性别`, '性别只能是：男、女、其他');
    }
    if (cleaned['执业注册状态'] && !['在册', '注销', '变更中', '暂停'].includes(cleaned['执业注册状态'])) {
      return this._fail(`${field}.执业注册状态`, '执业注册状态只能是：在册、注销、变更中、暂停');
    }

    this.value[field] = cleaned;
    return this;
  }

  /** 执行校验，返回清洗后的数据；有错误则抛 ValidationError */
  run(input, { partial = false } = {}) {
    this.input = input && typeof input === 'object' ? input : {};
    this.errors = [];
    this.value = {};
    this.partial = partial;
    this._validate();

    if (this.errors.length > 0) {
      throw new ValidationError('请求参数校验未通过', this.errors);
    }
    return this.value;
  }

  // 由各调用点通过 createValidator 覆写
  _validate() {}

  static count(value) {
    return Array.isArray(value) ? value.length : 0;
  }
}

/**
 * 构造一个校验器：传入字段定义函数与输入，返回清洗结果。
 * @param {object} input 请求体
 * @param {(v: Validator) => void} define 字段定义
 */
function validate(input, define) {
  const validator = new Validator();
  validator._validate = function validateFields() {
    define(this);
  };
  return validator.run(input);
}

module.exports = { validate, Validator, PROFILE_FIELD_ORDER, MAX_FIELD_LENGTH };
