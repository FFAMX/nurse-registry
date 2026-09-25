'use strict';

/**
 * 服务入口：初始化依赖 → 装配应用 → 监听端口 → 注册优雅停机。
 */
const path = require('node:path');

// 必须在读取任何配置之前加载 .env —— 否则 process.env 里拿不到文件里的值
const { loadEnv } = require('./lib/env-loader');
const envStats = loadEnv(path.resolve(__dirname, '..'));

const { loadConfig } = require('./config');
const { logger } = require('./lib/logger');
const { JsonDatabase } = require('./lib/json-db');
const {
  AccountRepository,
  AdminRepository,
  AuditRepository,
} = require('./repositories');
const { AuthService } = require('./services/auth-service');
const { AccountService } = require('./services/account-service');
const { AvatarService } = require('./services/avatar-service');
const { PageExportService } = require('./services/page-export-service');
const { GithubSyncService } = require('./services/github-sync-service');
const { TokenService } = require('./services/token-service');
const { runBootstrap } = require('./bootstrap/seed');
const { createApp } = require('./app');

async function main() {
  // ---- 1. 配置（启动时集中校验，失败即退出）----
  const config = loadConfig();

  if (envStats.loaded) {
    logger.info('已加载环境变量文件', {
      file: envStats.file,
      keys: envStats.count,
    });
  }

  // ---- 2. 基础设施：数据文件 ----
  const db = new JsonDatabase({
    file: path.join(config.dataDir, 'db.json'),
    defaultData: { version: 1, accounts: [], admins: [], audit_logs: [] },
  });
  await db.init();

  // ---- 3. 仓储层 ----
  const repositories = {
    db,
    accountRepository: new AccountRepository(db),
    adminRepository: new AdminRepository(db),
    auditRepository: new AuditRepository(db),
  };

  // ---- 4. 服务层 ----
  const tokenService = new TokenService({
    secret: config.jwt.secret,
    issuer: config.jwt.issuer,
  });

  // 受保护信息站点生成器：被后台接口与 GitHub 推送共用同一实例
  const pageExportService = new PageExportService({
    accountRepository: repositories.accountRepository,
    rootDir: config.rootDir,
    config,
  });

  const accountService = new AccountService({
    accountRepository: repositories.accountRepository,
    auditRepository: repositories.auditRepository,
    logger,
  });

  const services = {
    authService: new AuthService({
      accountRepository: repositories.accountRepository,
      adminRepository: repositories.adminRepository,
      tokenService,
      logger,
      config,
    }),
    accountService,
    avatarService: new AvatarService({
      publicDir: config.publicDir,
      logger,
    }),
    pageExportService,
    githubSyncService: new GithubSyncService({
      config,
      pageExportService,
      accountService,
      dataDir: config.dataDir,
      logger,
    }),
  };

  // 头像目录提前建好，避免首次上传时才创建
  services.avatarService.ensureDir();

  // ---- 5. 启动引导：管理员账号 + 历史数据迁移 ----
  const bootstrap = await runBootstrap({ ...repositories, config, logger });

  // ---- 6. 组装并监听 ----
  const app = createApp({ config, repositories, services, logger });

  const server = app.listen(config.port, config.host, () => {
    const banner = [
      '',
      '  护士电子化注册信息系统 · 演示项目',
      '  ------------------------------------------',
      `  运行环境    : ${config.nodeEnv}`,
      `  本地访问    : http://localhost:${config.port}/login.html`,
      `  后台管理    : http://localhost:${config.port}/admin`,
      `  健康检查    : http://localhost:${config.port}/health`,
      `  数据文件    : ${path.join(config.dataDir, 'db.json')}`,
      '  ------------------------------------------',
      `  后台账号    : ${config.bootstrap.adminUsername}`,
    ];

    if (bootstrap.admin.password) {
      const label = bootstrap.admin.reset
        ? '密码已重置为'
        : bootstrap.admin.generated
          ? '初始密码（随机生成，请尽快修改）:'
          : '初始密码    :';
      banner.push(`  ${label} ${bootstrap.admin.password}`);
    } else {
      banner.push('  初始密码    : 沿用已有配置（未改动）');
    }

    if (bootstrap.importedAccounts > 0) {
      banner.push(`  已迁移账号  : ${bootstrap.importedAccounts} 条（来自 public/config.js）`);
    }

    banner.push('  ------------------------------------------');
    banner.push('');
    process.stdout.write(`${banner.join('\n')}\n`);

    for (const warning of config.warnings) {
      logger.warn(warning);
    }
  });

  // ---- 7. 优雅停机 ----
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('收到停机信号，开始优雅关闭', { signal });

    // 停止接收新连接，等待在途请求完成
    server.close(async () => {
      try {
        await db.flush();
        logger.info('数据已保存，进程退出');
        process.exit(0);
      } catch (error) {
        logger.error('停机时保存数据失败', { message: error.message });
        process.exit(1);
      }
    });

    // 超时兜底：10 秒内没关完就强制退出，避免卡死
    setTimeout(() => {
      logger.error('优雅关闭超时，强制退出');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常，进程即将退出', {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  return server;
}

main().catch((error) => {
  logger.error('服务启动失败', { message: error.message, stack: error.stack });
  process.exit(1);
});
