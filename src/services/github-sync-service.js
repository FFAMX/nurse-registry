'use strict';

/**
 * GitHub 同步服务（按账号逐个推送 / 撤回）。
 *
 * 语义：
 *   pushAccount(id)   把这个账号的**加密页面**提交到仓库（若已存在则更新）
 *   revertAccount(id) 把这个账号从仓库撤下来（删除其页面，本地数据不动）
 *   prune()           全量重建并清掉仓库里多余的受管理文件（迁移/排障用）
 *
 * 仓库里"已推送的账号" = `docs/accounts/*.html` 里实际存在的页面，
 * 直接以远端内容为准，因此本服务不依赖本地记录判断发布状态。
 *
 * 页面内容是加密的（见 lib/page-crypto.js），所以仓库即使公开也不泄露数据；
 * 同时因为**只有目标账号的文件被写进本次提交**，其他账号的远端页面
 * 由 base_tree 原样保留 —— 推送 A 绝不会顺手改动 B。
 *
 * 提交走 REST Git Data API + Node 内置 fetch，运行时不依赖本地 git：
 *   读远端 HEAD/树 → 建 tree（删除项用 sha:null）→ 建 commit → 移动 ref
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError, NotFoundError } = require('../lib/errors');

const { ACCOUNTS_DIR, INDEX_PATH, ACCOUNT_EXT } = require('./page-export-service');

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30 * 1000;

class GithubNotConfiguredError extends AppError {
  constructor(message) {
    super(message, { status: 400, code: 'GITHUB_NOT_CONFIGURED' });
  }
}

/**
 * 计算文件的 git blob SHA：sha1("blob <字节数>\0" + 内容)
 * 有了它就能在不下载远端文件的前提下，用 Git Trees API 返回的 sha 直接比对内容。
 */
function gitBlobSha(file) {
  const buf =
    file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : Buffer.from(file.content, 'utf8');
  return crypto
    .createHash('sha1')
    .update(Buffer.from(`blob ${buf.length}\0`, 'utf8'))
    .update(buf)
    .digest('hex');
}

/**
 * 由本服务管理的路径前缀：只有这些目录下的文件参与比对与删除清理。
 * 含遗留的 pages/（旧的明文 Markdown 页面），这样一次 prune 就能把它们清干净。
 */
const MANAGED_PREFIXES = ['docs/', 'pages/'];
const isManaged = (filePath) =>
  MANAGED_PREFIXES.some((prefix) => filePath.startsWith(prefix)) && !filePath.endsWith('.gitkeep');

class GithubSyncService {
  /**
   * @param {object} deps
   * @param {object} deps.config         完整配置（读取 config.github / config.publicPage）
   * @param {object} deps.pageExportService
   * @param {object} deps.accountService 用于自动生成页面密码
   * @param {string} deps.dataDir        同步历史存放目录
   * @param {object} deps.logger
   */
  constructor({ config, pageExportService, accountService, dataDir, logger }) {
    const github = (config && config.github) || {};
    this.token = github.token || '';
    this.owner = github.owner || '';
    this.repo = github.repo || '';
    this.branch = github.branch || 'main';
    this.pagesBaseUrl = ((config && config.publicPage) || {}).pagesBaseUrl || '';
    this.pageExportService = pageExportService;
    this.accountService = accountService || null;
    this.logger = logger;
    this.historyPath = path.join(dataDir, 'github-sync.json');
  }

  /** GitHub Pages 站点根地址；未配置时返回 null */
  siteUrl() {
    return this.pagesBaseUrl || null;
  }

  isConfigured() {
    return Boolean(this.token && this.owner && this.repo);
  }

  _assertConfigured() {
    if (this.isConfigured()) return;
    const missing = [];
    if (!this.token) missing.push('GITHUB_TOKEN');
    if (!this.owner) missing.push('GITHUB_OWNER');
    if (!this.repo) missing.push('GITHUB_REPO');
    throw new GithubNotConfiguredError(
      `尚未配置 GitHub 推送：缺少 ${missing.join('、')}。请在项目根目录的 .env 文件中补齐后重启服务。`
    );
  }

  // ---------- 本地同步记录（仅用于界面展示「上次同步」） ----------

  _history() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
      if (!Array.isArray(parsed.actions)) parsed.actions = [];
      return parsed;
    } catch {
      return { actions: [] };
    }
  }

  _saveHistory(history) {
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(history, null, 2), 'utf8');
    } catch (error) {
      // 记录写失败不应让推送本身失败
      this.logger?.warn?.(`同步记录写入失败：${error.message}`);
    }
  }

  _record(action, account, extra) {
    const history = this._history();
    history.actions.push({
      at: new Date().toISOString(),
      action,
      accountId: account ? account.id : null,
      accountName: account ? (account.profile || {})['姓名'] || account.display_name : '',
      ...extra,
    });
    if (history.actions.length > 200) history.actions = history.actions.slice(-200);
    this._saveHistory(history);
  }

  // ---------- GitHub API ----------

  async _request(method, apiPath, body) {
    let response;
    try {
      response = await fetch(`${API_BASE}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nurse-registry-sync',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? '请求超时' : error.message;
      throw new AppError(`连接 GitHub 失败：${reason}。请检查本机网络能否访问 api.github.com。`, {
        status: 502,
        code: 'GITHUB_UNREACHABLE',
      });
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (response.ok) return payload;

    const detail =
      (payload && (payload.message || payload.error)) || text.slice(0, 200) || '无返回内容';
    const map = {
      401: ['GitHub 令牌无效或已过期，请重新生成并更新 .env 中的 GITHUB_TOKEN。', 'GITHUB_UNAUTHORIZED'],
      403: ['GitHub 拒绝了本次操作：令牌权限不足或触发了速率限制。请确认令牌具备 Contents: Read and write 权限。', 'GITHUB_FORBIDDEN'],
      404: [`找不到仓库 ${this.owner}/${this.repo}，或当前令牌无权访问它。请确认仓库已创建、且令牌已授权该仓库。`, 'GITHUB_NOT_FOUND'],
      409: ['GitHub 报告仓库状态冲突（通常是仓库还没有任何提交）。', 'GITHUB_CONFLICT'],
      422: ['GitHub 拒绝了提交内容（通常是被删除的分支或非法路径）。', 'GITHUB_UNPROCESSABLE'],
    };
    const [message, code] = map[response.status] || [
      `GitHub 返回 ${response.status}：${detail}`,
      'GITHUB_API_ERROR',
    ];
    throw new AppError(`${message}（原始信息：${detail}）`, { status: 502, code });
  }

  /** 读取远端当前状态：HEAD、树、以及受管理文件的 blob sha 表 */
  async _remoteState() {
    const repoPath = `/repos/${this.owner}/${this.repo}`;

    let head = null;
    try {
      head = await this._request('GET', `${repoPath}/commits/${this.branch}`);
    } catch (error) {
      // 空仓库（还没有任何提交）不是错误，按"什么都没有"处理
      if (error.code === 'GITHUB_CONFLICT' || error.code === 'GITHUB_NOT_FOUND') {
        return { headSha: null, baseTreeSha: null, blobs: {}, headMessage: '' };
      }
      throw error;
    }

    const tree = await this._request(
      'GET',
      `${repoPath}/git/trees/${head.commit.tree.sha}?recursive=1`
    );

    const blobs = {};
    for (const node of tree.tree || []) {
      if (node.type !== 'blob' || !isManaged(node.path)) continue;
      blobs[node.path] = node.sha;
    }

    return {
      headSha: head.sha,
      baseTreeSha: head.commit.tree.sha,
      blobs,
      headMessage: String(head.commit.message || '').split('\n')[0],
    };
  }

  /** 远端已推送的账号 id 集合（以 docs/accounts/*.html 实际存在为准） */
  _publishedIds(blobs) {
    const nameMap = this.pageExportService.fileNameMap();
    const ids = new Set();
    for (const account of this.pageExportService.listAccounts()) {
      const pagePath = `${ACCOUNTS_DIR}/${nameMap[account.id]}${ACCOUNT_EXT}`;
      if (blobs[pagePath]) ids.add(account.id);
    }
    return ids;
  }

  /** 与远端对比，得出内容有变化的文件 */
  _changedFiles(built, blobs) {
    return built.files.filter((file) => blobs[file.path] !== gitBlobSha(file));
  }

  /** 把改动提交到远端 */
  async _commit({ built, changed, deleted, parentSha, baseTreeSha, message }) {
    const repoPath = `/repos/${this.owner}/${this.repo}`;

    const treeEntries = [];
    for (const filePath of deleted) {
      treeEntries.push({ path: filePath, mode: '100644', type: 'blob', sha: null });
    }
    for (const file of changed) {
      if (file.encoding === 'base64') {
        // 二进制必须先建 blob 才能被 tree 引用
        const blob = await this._request('POST', `${repoPath}/git/blobs`, {
          content: file.content,
          encoding: 'base64',
        });
        treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      } else {
        treeEntries.push({ path: file.path, mode: '100644', type: 'blob', content: file.content });
      }
    }

    const tree = await this._request('POST', `${repoPath}/git/trees`, {
      base_tree: baseTreeSha,
      tree: treeEntries,
    });

    const commit = await this._request('POST', `${repoPath}/git/commits`, {
      message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
    });

    await this._request('PATCH', `${repoPath}/git/refs/heads/${this.branch}`, {
      sha: commit.sha,
      force: false,
    });

    return { commitSha: commit.sha, treeSha: tree.sha };
  }

  _commitUrl(sha) {
    return `https://github.com/${this.owner}/${this.repo}/commit/${sha}`;
  }

  /** 组装返回给前端的提交结果 */
  _commitResult(commitSha, extra) {
    const siteUrl = this.siteUrl();
    return {
      sha: commitSha,
      shortSha: commitSha.slice(0, 7),
      url: this._commitUrl(commitSha),
      repoUrl: `https://github.com/${this.owner}/${this.repo}`,
      // 已配置 Pages 地址时优先给出公网站点，否则退回仓库里的落地页
      siteUrl,
      pagesUrl:
        siteUrl || `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${INDEX_PATH}`,
      ...extra,
    };
  }

  _findAccount(accountId) {
    const account = this.pageExportService.listAccounts().find((a) => a.id === accountId);
    if (!account) throw new NotFoundError('账号不存在');
    return account;
  }

  /** 取含页面密码的原始账号记录（生成加密页面必须用到密码） */
  _findRawAccount(accountId) {
    const account = this.pageExportService
      .listAccountsWithSecrets()
      .find((a) => a.id === accountId);
    if (!account) throw new NotFoundError('账号不存在');
    return account;
  }

  /** 账号页面的公开链接（未配置 Pages 地址时返回 null） */
  pageUrlOf(account) {
    return this.pageExportService.pageUrlOf(account, this.pagesBaseUrl);
  }

  /** 按账号 id 取公开链接，取不到时返回 null（供后台界面展示用） */
  pageUrlFor(accountId) {
    const account = this.pageExportService.listAccounts().find((item) => item.id === accountId);
    return account ? this.pageUrlOf(account) : null;
  }

  /** 确保账号有页面密码；没有就自动生成一个并落库 */
  async _ensurePagePassword(account, { actor } = {}) {
    if (account.page_password) return account;
    if (!this.accountService) {
      throw new AppError('账号缺少页面密码，且当前无法自动生成，请先在后台生成页面密码。', {
        status: 400,
        code: 'PAGE_PASSWORD_MISSING',
      });
    }
    const password = await this.accountService.ensurePagePassword(account.id, { operator: actor || 'system' });
    return { ...account, page_password: password };
  }

  // ---------- 对外：状态 ----------

  /**
   * 返回同步状态与每个账号的推送状态。
   * 断网时退回「全部未知」，前端会据此提示。
   */
  async status() {
    const configured = this.isConfigured();
    const accounts = this.pageExportService.listAccountsWithSecrets();
    const history = this._history();
    const lastAction = history.actions[history.actions.length - 1] || null;

    const siteUrl = this.siteUrl();
    const baseMeta = {};
    for (const account of accounts) {
      baseMeta[account.id] = {
        slug: this.pageExportService.slugOf(account),
        pageUrl: this.pageUrlOf(account),
        hasPagePassword: Boolean(account.page_password),
      };
    }

    if (!configured) {
      return {
        configured: false,
        owner: this.owner || null,
        repo: this.repo || null,
        branch: this.branch,
        repoUrl: this.owner && this.repo ? `https://github.com/${this.owner}/${this.repo}` : null,
        siteUrl,
        totalAccounts: accounts.length,
        publishedCount: 0,
        unpublishedCount: accounts.length,
        modifiedCount: 0,
        accountsState: {},
        accountsMeta: baseMeta,
        remoteChecked: false,
        lastSync: null,
      };
    }

    let blobs = null;
    let headSha = null;
    let remoteChecked = false;
    try {
      const state = await this._remoteState();
      blobs = state.blobs;
      headSha = state.headSha;
      remoteChecked = true;
    } catch (error) {
      this.logger?.warn?.(`读取远端状态失败：${error.message}`);
    }

    const accountsState = {};
    let publishedCount = 0;
    let unpublishedCount = 0;
    let modifiedCount = 0;

    if (remoteChecked) {
      const nameMap = this.pageExportService.fileNameMap();
      for (const account of accounts) {
        const pagePath = `${ACCOUNTS_DIR}/${nameMap[account.id] || account.id}${ACCOUNT_EXT}`;
        const remoteSha = blobs[pagePath];
        if (!remoteSha) {
          accountsState[account.id] = 'unpublished';
          unpublishedCount += 1;
          continue;
        }
        let state = 'modified';
        try {
          const file = this.pageExportService.accountFile(account.id);
          state = file && gitBlobSha(file) === remoteSha ? 'published' : 'modified';
        } catch (error) {
          // 缺页面密码等情况：视为「有改动」，界面上会提示需要先生成密码
          this.logger?.warn?.(`比对账号 ${account.id} 失败：${error.message}`);
        }
        accountsState[account.id] = state;
        if (state === 'published') publishedCount += 1;
        else modifiedCount += 1;
      }
    }

    return {
      configured: true,
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      repoUrl: `https://github.com/${this.owner}/${this.repo}`,
      pagesUrl: `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${INDEX_PATH}`,
      siteUrl,
      totalAccounts: accounts.length,
      publishedCount,
      unpublishedCount,
      modifiedCount,
      accountsState,
      accountsMeta: baseMeta,
      remoteChecked,
      head: headSha ? { sha: headSha, shortSha: headSha.slice(0, 7) } : null,
      lastSync: lastAction
        ? {
            at: lastAction.at,
            action: lastAction.action,
            accountName: lastAction.accountName,
            shortSha: extraShort(lastAction.sha),
            url: lastAction.sha ? this._commitUrl(lastAction.sha) : null,
          }
        : null,
    };
  }

  // ---------- 对外：推送单个账号 ----------

  async pushAccount(accountId, { actor } = {}) {
    this._assertConfigured();

    const raw = this._findRawAccount(accountId);
    const passwordGenerated = !raw.page_password;
    const account = await this._ensurePagePassword(raw, { actor });
    const displayName = (account.profile || {})['姓名'] || account.display_name || account.username;
    const pageUrl = this.pageUrlOf(account);
    const siteUrl = this.siteUrl();

    const state = await this._remoteState();
    // 只生成目标账号的页面（外加固定的落地页），其余文件由 base_tree 原样保留，
    // 因此推送 A 不会顺带把 B 尚未推送的本地改动带到仓库里。
    const built = this.pageExportService.build({ accountIds: [accountId] });
    const changed = this._changedFiles(built, state.blobs);

    if (changed.length === 0) {
      return {
        unchanged: true,
        accountId,
        accountName: displayName,
        message: '该账号的页面已是最新，仓库无需更新。',
        repoUrl: `https://github.com/${this.owner}/${this.repo}`,
        siteUrl,
        pageUrl,
        pagePassword: account.page_password,
        passwordGenerated,
      };
    }

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const message = `推送账号「${displayName}」 ${stamp}${actor ? `\n\n操作人：${actor}` : ''}`;

    const { commitSha } = await this._commit({
      changed,
      deleted: [],
      parentSha: state.headSha,
      baseTreeSha: state.baseTreeSha,
      message,
    });

    // 写回本地，保证本地 docs/ 与仓库内容一致
    this.pageExportService.writeToDisk(built);
    this._record('push', account, { sha: commitSha });

    this.logger?.info?.(
      `已推送账号 ${account.username} 的加密页面到 ${this.owner}/${this.repo}（${commitSha.slice(0, 7)}）`
    );

    return this._commitResult(commitSha, {
      unchanged: false,
      accountId,
      accountName: displayName,
      changed: changed.length,
      deleted: 0,
      siteUrl,
      pageUrl,
      pagePassword: account.page_password,
      passwordGenerated,
    });
  }

  // ---------- 对外：撤回单个账号 ----------

  async revertAccount(accountId, { actor } = {}) {
    this._assertConfigured();
    const account = this._findAccount(accountId);

    const state = await this._remoteState();
    const targetPath = this.pageExportService.detailPathOf(accountId);

    if (!targetPath || !state.blobs[targetPath]) {
      throw new AppError('该账号尚未推送到仓库，无需撤回。', {
        status: 400,
        code: 'GITHUB_ACCOUNT_NOT_PUBLISHED',
      });
    }

    const displayName = (account.profile || {})['姓名'] || account.display_name || account.username;
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const message = `撤回账号「${displayName}」 ${stamp}${actor ? `\n\n操作人：${actor}` : ''}`;

    // 只删除这一个文件，其他账号的远端页面不受影响
    const { commitSha } = await this._commit({
      changed: [],
      deleted: [targetPath],
      parentSha: state.headSha,
      baseTreeSha: state.baseTreeSha,
      message,
    });

    this.pageExportService.removeLocalPage(accountId);
    this._record('revert', account, { sha: commitSha });

    this.logger?.info?.(
      `已从 ${this.owner}/${this.repo} 撤回账号 ${account.username}（${commitSha.slice(0, 7)}）`
    );

    return this._commitResult(commitSha, {
      unchanged: false,
      accountId,
      accountName: displayName,
      changed: 0,
      deleted: 1,
      siteUrl: this.siteUrl(),
    });
  }

  // ---------- 对外：全量重建并清理冗余文件（迁移 / 排障） ----------

  async prune({ actor } = {}) {
    this._assertConfigured();

    const accounts = this.pageExportService.listAccountsWithSecrets();
    const missing = accounts.filter((account) => !account.page_password);
    if (missing.length) {
      const names = missing
        .map((account) => (account.profile || {})['姓名'] || account.display_name || account.username)
        .join('、');
      throw new AppError(
        `以下账号还没有页面密码，无法生成加密页面：${names}。请先在后台为它们生成页面密码。`,
        { status: 400, code: 'PAGE_PASSWORD_MISSING' }
      );
    }

    const state = await this._remoteState();
    const built = this.pageExportService.build();
    const changed = this._changedFiles(built, state.blobs);
    const builtPaths = new Set(built.files.map((file) => file.path));
    // 受管理目录里所有不在本次产物清单中的文件都要清掉，
    // 包括历史遗留的明文 pages/*.md（仓库公开前必须清干净）
    const deleted = Object.keys(state.blobs).filter((filePath) => !builtPaths.has(filePath));

    if (changed.length === 0 && deleted.length === 0) {
      return {
        unchanged: true,
        changed: 0,
        deleted: 0,
        message: '仓库内容已与本地一致，无需重建。',
        repoUrl: `https://github.com/${this.owner}/${this.repo}`,
        siteUrl: this.siteUrl(),
      };
    }

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const message = `重建加密信息站点 ${stamp}${actor ? `\n\n操作人：${actor}` : ''}`;

    const { commitSha } = await this._commit({
      changed,
      deleted,
      parentSha: state.headSha,
      baseTreeSha: state.baseTreeSha,
      message,
    });

    this.pageExportService.writeToDisk(built, { prune: true });
    this._record('prune', null, { sha: commitSha, changed: changed.length, deleted: deleted.length });

    this.logger?.info?.(
      `已重建站点：写入 ${changed.length} 个文件、删除 ${deleted.length} 个文件（${commitSha.slice(0, 7)}）`
    );

    return this._commitResult(commitSha, {
      unchanged: false,
      changed: changed.length,
      deleted: deleted.length,
      accounts: accounts.length,
      siteUrl: this.siteUrl(),
    });
  }
}

/** 取 sha 前 7 位（允许为空） */
function extraShort(sha) {
  return sha ? String(sha).slice(0, 7) : null;
}

module.exports = { GithubSyncService };
