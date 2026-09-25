'use strict';

/**
 * 极简 JSON 文件数据库（仓储层的存储引擎）。
 *
 * 设计要点：
 * - 进程内单例，首次访问时从磁盘懒加载；
 * - 写入串行化（写队列），避免并发写互相覆盖；
 * - 原子落盘：先写临时文件，再 rename 覆盖，避免半截文件；
 * - 全部数据常驻内存，读取零 IO —— 对本项目的量级完全够用。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { logger } = require('./logger');

class JsonDatabase {
  /**
   * @param {object} options
   * @param {string} options.file 数据文件绝对路径
   * @param {object} options.defaultData 文件不存在时的初始数据
   */
  constructor({ file, defaultData = {} }) {
    this.file = file;
    this.defaultData = defaultData;
    this.data = null;
    this.writeQueue = Promise.resolve();
    this.writeCount = 0;
  }

  _cloneDefault() {
    return JSON.parse(JSON.stringify(this.defaultData));
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });

    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('数据文件根节点必须是对象');
      }
      this.data = parsed;
      logger.info('数据文件已加载', { file: this.file });
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.data = this._cloneDefault();
        await this.flush();
        logger.info('数据文件不存在，已创建初始数据', { file: this.file });
      } else {
        // 数据损坏时明确失败，绝不静默用空数据覆盖用户数据
        throw new Error(
          `数据文件解析失败：${this.file}（${error.message}）。请修复或删除该文件后重试。`
        );
      }
    }

    return this;
  }

  /** 直接读取整份数据（调用方请勿长期持有引用） */
  read() {
    if (!this.data) throw new Error('数据库尚未初始化');
    return this.data;
  }

  /**
   * 原子地修改数据：mutator 返回 null/undefined 表示放弃写入。
   * @param {(data: object) => any} mutator
   */
  async mutate(mutator) {
    if (!this.data) throw new Error('数据库尚未初始化');

    const task = this.writeQueue.then(async () => {
      const result = mutator(this.data);
      if (result !== null && result !== undefined && result !== false) {
        await this.flush();
      }
      return result;
    });

    // 保证队列不因单次失败而中断
    this.writeQueue = task.catch(() => {});

    return task;
  }

  /** 原子写盘 */
  async flush() {
    const payload = JSON.stringify(this.data, null, 2);
    const tmpFile = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

    await fs.writeFile(tmpFile, payload, 'utf8');
    await fs.rename(tmpFile, this.file);

    this.writeCount += 1;
    logger.debug('数据已落盘', { file: this.file, writes: this.writeCount });
  }

  /**
   * 生成业务 ID：短、可读、按时间递增，避免 UUID 过长影响肉眼排查。
   */
  static nextId(prefix = 'id') {
    const time = Date.now().toString(36);
    const random = crypto.randomBytes(3).toString('hex');
    return `${prefix}_${time}${random}`;
  }
}

module.exports = { JsonDatabase };
