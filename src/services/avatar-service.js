'use strict';

/**
 * 头像上传服务。
 *
 * 为什么不让前端直接把 Data URL 存进 profile.头像：
 *   1. `validate.js` 的口令/字段校验里，头像只允许 http/https，且单字段上限 500 字符；
 *      Data URL 动辄几十上百 KB，会被直接拒绝或截断。
 *   2. 把二进制塞进 db.json 会让数据文件迅速膨胀，也难以排查。
 *
 * 所以采用常规做法：前端把图片压缩后以 base64 提交，服务端解码落盘，
 * 返回站点内相对路径（如 /uploads/avatars/xxx.jpg）写回表单。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { ValidationError } = require('../lib/errors');

/** 允许的图片类型 —— 前端已统一压成 jpeg，这里保留 png/webp 以兼容 */
const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 落盘后的最大体积（解码后，字节） */
const MAX_BYTES = 1.5 * 1024 * 1024;

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

class AvatarService {
  /**
   * @param {object} deps
   * @param {string} deps.publicDir 静态资源根目录
   * @param {import('../lib/logger').logger} deps.logger
   */
  constructor({ publicDir, logger }) {
    this.publicDir = publicDir;
    this.logger = logger;
    // 上传目录：public/uploads/avatars
    this.uploadDir = path.join(publicDir, 'uploads', 'avatars');
  }

  /** 确保上传目录存在（启动时调用一次即可，重复调用无害） */
  ensureDir() {
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  /**
   * 保存一张头像。
   *
   * @param {string} dataUrl 形如 data:image/jpeg;base64,xxxx
   * @returns {Promise<{url: string, bytes: number, filename: string}>}
   * @throws {ValidationError} 格式或体积不合法时抛出
   */
  async save(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
      throw new ValidationError('请求参数校验未通过', [
        { field: 'dataUrl', message: '缺少图片数据' },
      ]);
    }

    const match = DATA_URL_RE.exec(dataUrl.trim());
    if (!match) {
      throw new ValidationError('请求参数校验未通过', [
        { field: 'dataUrl', message: '图片格式不支持，仅接受 jpeg / png / webp' },
      ]);
    }

    const mime = match[1];
    const base64 = match[2].replace(/\s/g, '');
    const ext = ALLOWED[mime];

    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw new ValidationError('请求参数校验未通过', [
        { field: 'dataUrl', message: '图片数据无法解析' },
      ]);
    }

    if (buffer.length === 0) {
      throw new ValidationError('请求参数校验未通过', [
        { field: 'dataUrl', message: '图片内容为空' },
      ]);
    }

    if (buffer.length > MAX_BYTES) {
      throw new ValidationError('请求参数校验未通过', [
        {
          field: 'dataUrl',
          message: `图片过大（${(buffer.length / 1024 / 1024).toFixed(2)}MB），请压缩到 ${MAX_BYTES / 1024 / 1024}MB 以内`,
        },
      ]);
    }

    // 校验真实文件头，避免把非图片内容伪装成 image/jpeg 落盘
    if (!AvatarService.looksLikeImage(buffer, ext)) {
      throw new ValidationError('请求参数校验未通过', [
        { field: 'dataUrl', message: '文件内容不是有效的图片' },
      ]);
    }

    this.ensureDir();

    const filename = `${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
    const target = path.join(this.uploadDir, filename);

    await fsp.writeFile(target, buffer);

    this.logger.info('头像已保存', { filename, bytes: buffer.length });

    // 返回站点内路径，前端直接写进「头像」字段
    return {
      url: `/uploads/avatars/${filename}`,
      bytes: buffer.length,
      filename,
    };
  }

  /**
   * 按文件头魔数判断是否真的是图片。
   * 仅信任声明的 mime 是不够的 —— base64 里可以写任意字节。
   */
  static looksLikeImage(buffer, ext) {
    if (buffer.length < 12) return false;

    if (ext === 'jpg') {
      // JPEG: FF D8 FF
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (ext === 'png') {
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      );
    }
    if (ext === 'webp') {
      // WebP: 'RIFF' .... 'WEBP'
      return (
        buffer.toString('latin1', 0, 4) === 'RIFF' &&
        buffer.toString('latin1', 8, 12) === 'WEBP'
      );
    }
    return false;
  }
}

module.exports = { AvatarService, MAX_BYTES };
