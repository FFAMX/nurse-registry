/**
 * 后台管理控制台
 *
 * 职责：视图状态、表单收集与回填、列表渲染、用户反馈。
 * 所有数据操作都走 AdminApi（api.js），不在本文件直接写 fetch。
 */
(function () {
  'use strict';

  var Api = window.AdminApi;

  /* ================= 全局状态 ================= */

  var state = {
    admin: null,
    page: 1,
    pageSize: 10,
    keyword: '',
    status: '',
    sort: 'created_at',
    order: 'desc',
    items: [],
    pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
    selected: {},          // id -> true
    editingId: null,       // null 表示新增
    fieldOptions: {        // 由后端 /profile-fields 提供，失败时用默认值兜底
      性别: ['男', '女', '其他'],
      执业注册状态: ['在册', '注销', '变更中', '暂停'],
    },
    profileFields: [],
    github: null,          // GitHub 推送状态（由 /github/status 提供）
  };

  /* ================= DOM 快捷方法 ================= */

  function $(id) {
    return document.getElementById(id);
  }

  /** 文本转义，防止资料字段里的内容被当作 HTML 执行 */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '-';
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      date.getFullYear() +
      '-' + pad(date.getMonth() + 1) +
      '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) +
      ':' + pad(date.getMinutes())
    );
  }

  /* ================= 用户反馈 ================= */

  function toast(message, type) {
    var area = $('toast-area');
    var node = document.createElement('div');
    node.className = 'toast toast-' + (type || 'info');
    var icon = type === 'error' ? 'fa-exclamation-circle'
      : type === 'success' ? 'fa-check-circle' : 'fa-info-circle';
    node.innerHTML = '<i class="fa ' + icon + '"></i><span>' + esc(message) + '</span>';
    area.appendChild(node);

    setTimeout(function () {
      node.classList.add('is-out');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 260);
    }, type === 'error' ? 4800 : 2600);
  }

  /**
   * 把 API 错误转成用户可读提示。
   * 校验类错误会展开字段级明细，便于定位问题。
   */
  function reportError(error, inlineContainer) {
    var lines = [error.message || '操作失败'];

    if (Array.isArray(error.details) && error.details.length) {
      lines = error.details.map(function (item) {
        return item.field + '：' + item.message;
      });
    }

    var text = lines.join('；');

    if (inlineContainer) {
      inlineContainer.textContent = text;
      inlineContainer.hidden = false;
    }
    toast(text, 'error');

    // 便于学习者排查：把请求 ID 打到控制台
    if (error.requestId) {
      console.warn('[API]', error.code, 'request_id=' + error.requestId);
    }
  }

  function clearInline(node) {
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
  }

  /* ================= 视图切换 ================= */

  function showConsole(admin) {
    state.admin = admin;
    $('view-login').hidden = true;
    $('view-console').hidden = false;
    $('admin-name').textContent = admin.display_name || admin.username;
    // 非超级管理员禁用新增管理员入口，保持前端与后端权限一致
    var isSuper = admin.role === 'superadmin';
    $('btn-create-admin').disabled = !isSuper;
    $('btn-create-admin').title = isSuper ? '' : '仅超级管理员可新增管理员';
  }

  function showLogin() {
    state.admin = null;
    $('view-console').hidden = true;
    $('view-login').hidden = false;
    $('login-password').value = '';
  }

  /* ================= 账号列表 ================= */

  function renderStats(stats) {
    $('stat-total').textContent = stats.total;
    $('stat-active').textContent = stats.active;
    $('stat-registered').textContent = stats.registered;
  }

  function renderAccounts(payload) {
    state.items = payload.items;
    state.pagination = payload.pagination;
    renderStats(payload.stats);

    var tbody = $('account-tbody');

    if (!payload.items.length) {
      tbody.innerHTML =
        '<tr><td colspan="10" class="empty">' +
        (state.keyword || state.status ? '没有符合条件的账号' : '暂无账号，点击右上角「新增账号」创建') +
        '</td></tr>';
    } else {
      tbody.innerHTML = payload.items
        .map(function (account) {
          var profile = account.profile || {};
          var active = account.is_active !== false;
          var checked = state.selected[account.id] ? ' checked' : '';

          return (
            '<tr class="' + (checked ? 'is-selected' : '') + '" data-account-id="' + esc(account.id) + '">' +
            '<td class="col-check"><input type="checkbox" class="row-check" data-id="' +
              esc(account.id) + '"' + checked + ' /></td>' +
            '<td><span class="mono">' + esc(account.username) + '</span></td>' +
            '<td><b>' + esc(profile['姓名'] || account.display_name || '-') + '</b></td>' +
            '<td><span class="mono dim">' + esc(profile['身份证号'] || '-') + '</span></td>' +
            '<td>' + esc(profile['执业机构'] || '-') + '</td>' +
            '<td>' + badge(profile['执业注册状态'], 'state') + '</td>' +
            '<td>' + (active
              ? '<span class="tag tag-green">启用</span>'
              : '<span class="tag tag-gray">停用</span>') + '</td>' +
            '<td class="dim">' + esc(fmtTime(account.created_at)) + '</td>' +
            '<td class="col-repo">' + repoCell(account) + '</td>' +
            '<td class="col-actions">' +
              '<button class="icon-btn" data-action="preview" data-id="' + esc(account.id) + '" title="预览信息页（新窗口打开）"><i class="fa fa-external-link"></i></button>' +
              '<button class="icon-btn" data-action="edit" data-id="' + esc(account.id) + '" title="编辑"><i class="fa fa-pencil"></i></button>' +
              '<button class="icon-btn" data-action="toggle" data-id="' + esc(account.id) + '" title="' +
                (active ? '停用' : '启用') + '"><i class="fa ' + (active ? 'fa-ban' : 'fa-check') + '"></i></button>' +
              '<button class="icon-btn danger" data-action="delete" data-id="' + esc(account.id) +
                '" data-name="' + esc(profile['姓名'] || account.username) + '" title="删除"><i class="fa fa-trash-o"></i></button>' +
            '</td>' +
            '</tr>'
          );
        })
        .join('');
    }

    renderPager();
    syncSelectionUi();
  }

  /**
   * 「推送仓库」单元格：状态标记 + 单个账号的推送/撤回按钮。
   * 状态取自后端与远端仓库的实时比对结果。
   */
  function repoCell(account) {
    var gh = state.github;
    var name = esc((account.profile || {})['姓名'] || account.username);
    var id = esc(account.id);

    // 未配置令牌 / 断网时，状态未知
    if (!gh || !gh.configured || !gh.remoteChecked) {
      var reason = !gh || !gh.configured
        ? '尚未配置 GITHUB_TOKEN'
        : '网络不可用，无法确认仓库状态';
      return '<span class="tag tag-gray" title="' + esc(reason) + '">未知</span>' +
        '<button class="icon-btn" disabled title="' + esc(reason) + '"><i class="fa fa-cloud-upload"></i></button>' +
        '<button class="icon-btn" disabled title="' + esc(reason) + '"><i class="fa fa-undo"></i></button>';
    }

    var st = (gh.accountsState || {})[account.id] || 'unpublished';
    var tag;
    if (st === 'published') tag = '<span class="tag tag-green">已推送</span>';
    else if (st === 'modified') tag = '<span class="tag tag-orange">有改动</span>';
    else tag = '<span class="tag tag-gray">未推送</span>';

    var pushTitle = st === 'unpublished'
      ? '把这个账号推送到 GitHub 仓库'
      : st === 'modified' ? '本地有改动，重新推送到 GitHub 仓库' : '重新推送到 GitHub 仓库（内容已最新）';
    var revertTitle = st === 'unpublished'
      ? '该账号尚未推送，无需撤回'
      : '把这个账号从 GitHub 仓库撤回（本地数据不动）';

    return tag +
      '<button class="icon-btn" data-action="gh-push" data-id="' + id + '" data-name="' + name +
        '" title="' + esc(pushTitle) + '"><i class="fa fa-cloud-upload"></i></button>' +
      '<button class="icon-btn danger" data-action="gh-revert" data-id="' + id + '" data-name="' + name +
        '" title="' + esc(revertTitle) + '"' + (st === 'unpublished' ? ' disabled' : '') +
        '><i class="fa fa-undo"></i></button>';
  }

  function badge(value, kind) {
    if (!value) return '<span class="dim">-</span>';
    var cls = 'tag';
    if (kind === 'state') {
      if (value === '在册') cls += ' tag-green';
      else if (value === '注销') cls += ' tag-gray';
      else cls += ' tag-orange';
    }
    return '<span class="' + cls + '">' + esc(value) + '</span>';
  }

  function renderPager() {
    var p = state.pagination;
    var start = p.total === 0 ? 0 : (p.page - 1) * p.pageSize + 1;
    var end = Math.min(p.page * p.pageSize, p.total);

    $('pager-info').textContent = '共 ' + p.total + ' 条，当前显示第 ' + start + ' - ' + end + ' 条';
    $('pager-current').textContent = p.page + ' / ' + p.totalPages;
    $('btn-prev').disabled = p.page <= 1;
    $('btn-next').disabled = p.page >= p.totalPages;
  }

  function syncSelectionUi() {
    var ids = Object.keys(state.selected).filter(function (id) {
      return state.selected[id];
    });
    $('selected-count').textContent = ids.length;
    $('btn-batch-delete').disabled = ids.length === 0;

    var allChecked =
      state.items.length > 0 &&
      state.items.every(function (account) {
        return !!state.selected[account.id];
      });
    $('check-all').checked = allChecked;
  }

  async function loadAccounts() {
    var tbody = $('account-tbody');
    tbody.innerHTML = '<tr><td colspan="10" class="empty">加载中…</td></tr>';

    try {
      var data = await Api.listAccounts({
        keyword: state.keyword,
        status: state.status,
        sort: state.sort,
        order: state.order,
        page: state.page,
        pageSize: state.pageSize,
      });
      // 后端会把越界页码收敛回有效范围，这里同步回来
      state.page = data.pagination.page;
      renderAccounts(data);
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty">加载失败</td></tr>';
      reportError(error);
    }

    // 列表刷新的同时也刷新推送状态，保证「有 N 项待推送」是准的
    loadGithubStatus();
  }

  /* ================= 表单：收集与回填 ================= */

  var FORM_PROFILE_FIELDS = [
    '姓名', '性别', '执业注册状态', '出生日期', '国籍', '民族', '身份证号',
    '护士执业证书编号', '注册有效期至', '通过考试时间', '健康状况', '参加工作时间',
    '执业机构', '工作科室', '工作类别', '职务', '技术职称', '审批机关', '审批时间', '头像',
  ];

  /**
   * 新增账号时的默认值。
   * 这几项在实务中几乎不变，预填好可以少点几次，避免每次重复选择。
   * 民族虽然预填「汉族」，但仍可在表单里改。
   */
  var DEFAULT_PROFILE = {
    执业注册状态: '在册',
    国籍: '中国',
    民族: '汉族',
    健康状况: '健康状况良好',
  };

  /** 按类型把表单值读取出来；日期字段的空值保持为空串 */
  function readProfileForm() {
    var profile = {};
    FORM_PROFILE_FIELDS.forEach(function (field) {
      var el = $('f-p-' + field);
      if (!el) return;
      profile[field] = (el.value || '').trim();
    });
    return profile;
  }

  function fillSelect(el, options, current) {
    el.innerHTML =
      '<option value="">未填写</option>' +
      options
        .map(function (option) {
          var selected = option === current ? ' selected' : '';
          return '<option value="' + esc(option) + '"' + selected + '>' + esc(option) + '</option>';
        })
        .join('');
  }

  function fillProfileForm(profile) {
    var data = profile || {};
    FORM_PROFILE_FIELDS.forEach(function (field) {
      var el = $('f-p-' + field);
      if (!el) return;
      var value = data[field] === undefined || data[field] === null ? '' : String(data[field]);

      if (el.tagName === 'SELECT') {
        fillSelect(el, state.fieldOptions[field] || [], value);
      } else {
        el.value = value;
      }
    });
  }

  /* ================= 头像：本地选图 → 压缩 → 上传 ================= */

  /** 头像预览图的最大边长（px）。等比缩放到这个尺寸，兼顾清晰度与体积 */
  var AVATAR_MAX_SIDE = 320;
  /** JPEG 压缩质量，0~1 */
  var AVATAR_QUALITY = 0.85;

  /** 根据当前头像地址刷新预览图与「清除」按钮的显隐 */
  function renderAvatarUI(url) {
    var preview = $('avatar-preview');
    var clearBtn = $('btn-clear-avatar');
    var value = (url || '').trim();

    if (value) {
      preview.src = value;
      preview.hidden = false;
      clearBtn.hidden = false;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
      clearBtn.hidden = true;
    }
  }

  /** 把选中的图片等比压缩成 JPEG Data URL，避免超大图拖慢上传 */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();

      reader.onerror = function () {
        reject(new Error('图片读取失败'));
      };

      reader.onload = function () {
        var image = new Image();

        image.onerror = function () {
          reject(new Error('这不是有效的图片文件'));
        };

        image.onload = function () {
          var scale = Math.min(1, AVATAR_MAX_SIDE / Math.max(image.width, image.height));
          var width = Math.max(1, Math.round(image.width * scale));
          var height = Math.max(1, Math.round(image.height * scale));

          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          var ctx = canvas.getContext('2d');
          // 头像多数是白底证件照，先铺白底避免透明区域转 JPEG 后变黑
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);

          try {
            resolve(canvas.toDataURL('image/jpeg', AVATAR_QUALITY));
          } catch (error) {
            reject(new Error('图片处理失败：' + error.message));
          }
        };

        image.src = reader.result;
      };

      reader.readAsDataURL(file);
    });
  }

  /** 处理文件选择：压缩 → 上传 → 回填表单 */
  async function handleAvatarFile(file) {
    if (!file) return;

    var tip = $('avatar-tip');
    var pickBtn = $('btn-pick-avatar');

    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      tip.textContent = '仅支持 JPG / PNG / WebP';
      toast('仅支持 JPG / PNG / WebP 图片', 'error');
      return;
    }

    pickBtn.disabled = true;
    tip.textContent = '压缩并上传中…';

    try {
      var dataUrl = await compressImage(file);
      var result = await Api.uploadAvatar(dataUrl);

      $('f-p-头像').value = result.url;
      renderAvatarUI(result.url);

      var kb = Math.round((result.bytes || 0) / 1024);
      tip.textContent = '已上传（' + kb + ' KB）';
      toast('头像已上传', 'success');
    } catch (error) {
      tip.textContent = '上传失败';
      reportError(error);
    } finally {
      pickBtn.disabled = false;
      // 清空 file input，保证再次选择同一张图也能触发 change
      $('f-avatar-file').value = '';
    }
  }

  /* ================= 随机生成（测试样本） ================= */

  /** 拉取一份测试样本并填充表单（新增模式下使用） */
  async function fillRandomSample() {
    var btn = $('btn-random');
    btn.disabled = true;
    btn.classList.add('is-loading');

    try {
      var data = await Api.randomSample();
      var sample = data && data.items && data.items[0];

      if (!sample) {
        toast('未取到样本数据', 'error');
        return;
      }

      // 账号字段
      $('f-username').value = sample.身份证号 || '';
      $('f-display_name').value = sample.姓名 || '';

      // 资料字段
      fillProfileForm(sample);
      renderAvatarUI(sample.头像 || '');

      // 新增场景下密码必填，给一个符合规则（≥6 位）的默认口令
      if (state.editingId === null) {
        $('f-password').value = 'Nurse@' + String(Date.now()).slice(-6);
      }

      toast('已用测试样本填充表单', 'success');
    } catch (error) {
      reportError(error);
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }

  function openDrawer(account) {
    state.editingId = account ? account.id : null;
    clearInline($('form-error'));

    $('drawer-title').textContent = account ? '编辑账号' : '新增账号';
    $('f-username').value = account ? account.username : '';
    $('f-display_name').value = account ? account.display_name || '' : '';
    $('f-password').value = '';
    $('f-is_active').value = account ? String(account.is_active !== false) : 'true';

    // 新增时密码必填，编辑时留空表示不修改
    $('label-password').innerHTML = account ? '密码 <span class="dim">（留空不修改）</span>' : '密码 <em>*</em>';
    $('f-password').placeholder = account ? '留空则保持原密码不变' : '至少 6 位';

    // 新增：套用默认值（在册 / 中国 / 汉族 / 健康状况良好）
    // 编辑：用账号原有资料
    fillProfileForm(account ? account.profile : DEFAULT_PROFILE);
    renderAvatarUI($('f-p-头像').value);

    $('drawer-mask').hidden = false;
    $('account-drawer').hidden = false;
    document.body.classList.add('no-scroll');
    $('f-username').focus();
  }

  function closeDrawer() {
    $('drawer-mask').hidden = true;
    $('account-drawer').hidden = true;
    document.body.classList.remove('no-scroll');
    state.editingId = null;
  }

  function collectAccountPayload() {
    var profile = readProfileForm();
    var payload = {
      username: ($('f-username').value || '').trim(),
      display_name: ($('f-display_name').value || '').trim(),
      is_active: $('f-is_active').value === 'true',
      profile: profile,
    };

    var password = $('f-password').value;
    if (password) payload.password = password;

    return payload;
  }

  /** 提交前的前端预校验：尽早给反馈，减少一次无效请求 */
  function validateBeforeSubmit(payload) {
    if (!payload.username) return '用户名不能为空';
    if (!/^[A-Za-z0-9._@-]+$/.test(payload.username)) {
      return '用户名只能包含字母、数字及 . _ - @';
    }
    if (state.editingId === null && !payload.password) return '新增账号时必须设置密码';
    if (payload.password && payload.password.length < 6) return '密码长度不能少于 6 位';
    return null;
  }

  async function saveAccount() {
    var button = $('btn-save');
    clearInline($('form-error'));

    var payload = collectAccountPayload();
    var problem = validateBeforeSubmit(payload);
    if (problem) {
      $('form-error').textContent = problem;
      $('form-error').hidden = false;
      toast(problem, 'error');
      return;
    }

    button.disabled = true;

    try {
      if (state.editingId) {
        await Api.updateAccount(state.editingId, payload);
        toast('账号已更新', 'success');
      } else {
        await Api.createAccount(payload);
        toast('账号已创建', 'success');
        state.page = 1;
      }
      closeDrawer();
      await loadAccounts();
    } catch (error) {
      reportError(error, $('form-error'));
    } finally {
      button.disabled = false;
    }
  }

  /* ================= 删除与确认 ================= */

  var confirmState = { onOk: null };

  function openConfirm(options) {
    $('confirm-title').textContent = options.title || '确认操作';
    $('confirm-message').textContent = options.message || '';
    $('confirm-ok').textContent = options.okText || '确认';
    confirmState.onOk = options.onOk;
    $('confirm-modal').hidden = false;
  }

  function closeConfirm() {
    $('confirm-modal').hidden = true;
    confirmState.onOk = null;
  }

  async function removeAccount(id, name) {
    await Api.deleteAccount(id);
    delete state.selected[id];
    toast('已删除 ' + name, 'success');
    // 删掉当前页最后一条时回退一页，避免停留在空页
    if (state.items.length === 1 && state.page > 1) state.page -= 1;
    await loadAccounts();
  }

  async function batchRemove(ids) {
    var result = await Api.batchDeleteAccounts(ids);
    state.selected = {};
    toast('已删除 ' + result.deleted + ' 个账号', 'success');
    state.page = 1;
    await loadAccounts();
  }

  /* ================= 操作日志 ================= */

  async function loadAudit() {
    var tbody = $('audit-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';

    try {
      var data = await Api.auditLogs(100);
      if (!data.items.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无操作记录</td></tr>';
        return;
      }
      tbody.innerHTML = data.items
        .map(function (log) {
          return (
            '<tr>' +
            '<td class="dim">' + esc(fmtTime(log.at)) + '</td>' +
            '<td><b>' + esc(log.operator) + '</b></td>' +
            '<td><span class="mono">' + esc(log.action) + '</span></td>' +
            '<td class="mono dim">' + esc(log.target_id || '-') + '</td>' +
            '<td>' + esc(log.detail || '-') + '</td>' +
            '</tr>'
          );
        })
        .join('');
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">加载失败</td></tr>';
      reportError(error);
    }
  }

  /* ================= 管理员 ================= */

  async function loadAdmins() {
    var tbody = $('admin-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="empty">加载中…</td></tr>';

    try {
      var data = await Api.listAdmins();
      var isSuper = state.admin && state.admin.role === 'superadmin';

      tbody.innerHTML = data.items
        .map(function (admin) {
          var isSelf = state.admin && admin.id === state.admin.id;
          var canDelete = isSuper && !isSelf;

          return (
            '<tr>' +
            '<td><span class="mono">' + esc(admin.username) + '</span></td>' +
            '<td><b>' + esc(admin.display_name) + '</b></td>' +
            '<td>' + (admin.role === 'superadmin'
              ? '<span class="tag tag-blue">超级管理员</span>'
              : '<span class="tag">普通管理员</span>') + '</td>' +
            '<td>' + (admin.is_active
              ? '<span class="tag tag-green">启用</span>'
              : '<span class="tag tag-gray">停用</span>') + '</td>' +
            '<td class="dim">' + esc(fmtTime(admin.last_login_at)) + '</td>' +
            '<td class="col-actions">' +
              (isSelf
                ? '<span class="dim">当前登录</span>'
                : canDelete
                  ? '<button class="icon-btn danger" data-admin-delete="' + esc(admin.id) +
                    '" data-name="' + esc(admin.username) + '" title="删除"><i class="fa fa-trash-o"></i></button>'
                  : '<span class="dim">-</span>') +
            '</td>' +
            '</tr>'
          );
        })
        .join('');
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">加载失败</td></tr>';
      reportError(error);
    }
  }

  async function saveAdmin() {
    clearInline($('admin-form-error'));

    var payload = {
      username: ($('a-username').value || '').trim(),
      display_name: ($('a-display_name').value || '').trim(),
      password: $('a-password').value,
      role: $('a-role').value,
    };

    if (!payload.username) {
      $('admin-form-error').textContent = '用户名不能为空';
      $('admin-form-error').hidden = false;
      return;
    }
    if (!payload.password || payload.password.length < 8) {
      $('admin-form-error').textContent = '管理员密码长度不能少于 8 位';
      $('admin-form-error').hidden = false;
      return;
    }

    try {
      await Api.createAdmin(payload);
      toast('管理员已创建', 'success');
      $('admin-modal').hidden = true;
      ['a-username', 'a-display_name', 'a-password'].forEach(function (id) {
        $(id).value = '';
      });
      $('a-role').value = 'admin';
      await loadAdmins();
    } catch (error) {
      reportError(error, $('admin-form-error'));
    }
  }

  /* ================= 视图导航 ================= */

  var VIEW_META = {
    accounts: { title: '账号管理', subtitle: '对前台登录账号进行增删改查' },
    audit: { title: '操作日志', subtitle: '记录后台的关键写操作' },
    admins: { title: '管理员', subtitle: '管理后台登录账号与角色' },
  };

  function switchView(view) {
    Object.keys(VIEW_META).forEach(function (key) {
      $('panel-' + key).hidden = key !== view;
    });

    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (item) {
      item.classList.toggle('is-active', item.getAttribute('data-view') === view);
    });

    $('page-title').textContent = VIEW_META[view].title;
    $('page-subtitle').textContent = VIEW_META[view].subtitle;

    if (view === 'audit') loadAudit();
    else if (view === 'admins') loadAdmins();
  }

  /* ================= GitHub 私有仓库同步 ================= */

  /** 时间格式化：统一按北京时间展示 */
  function ghFormatTime(value) {
    if (!value) return '-';
    var date = new Date(value);
    if (isNaN(date.getTime())) return String(value);
    var bj = new Date(date.getTime() + 8 * 3600 * 1000);
    function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
    return bj.getUTCFullYear() + '-' + pad(bj.getUTCMonth() + 1) + '-' + pad(bj.getUTCDate()) +
      ' ' + pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes());
  }

  function renderGithubStatus() {
    var el = $('github-status');
    if (!el) return;

    var data = state.github;
    if (!data) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    if (!data.configured) {
      el.className = 'gh-status is-warn';
      el.innerHTML =
        '<i class="fa fa-exclamation-triangle"></i>' +
        '<span>尚未配置 GitHub 推送：请在项目根目录的 <b>.env</b> 中填写 <b>GITHUB_TOKEN</b>' +
        '（并确认 <b>GITHUB_OWNER</b> / <b>GITHUB_REPO</b> 指向你的私有仓库），' +
        '保存后重启服务即可使用列表里每个账号后面的推送按钮。</span>';
      return;
    }

    var html = '<i class="fa fa-github"></i><span>';
    html += '仓库 <a href="' + esc(data.repoUrl) + '" target="_blank" rel="noopener">' +
      esc(data.owner + '/' + data.repo) + '</a>';
    html += '　|　共 <b>' + data.totalAccounts + '</b> 个账号：';
    html += '已推送 <b>' + data.publishedCount + '</b>';
    if (data.modifiedCount) html += '、有改动 <b>' + data.modifiedCount + '</b>';
    if (data.unpublishedCount) html += '、未推送 <b>' + data.unpublishedCount + '</b>';

    if (data.lastSync) {
      html += '　|　上次同步 ' + esc(ghFormatTime(data.lastSync.at)) +
        '（' + (data.lastSync.action === 'revert' ? '撤回' : '推送') + '「' +
        esc(data.lastSync.accountName || '') + '」' +
        (data.lastSync.url
          ? ' <a href="' + esc(data.lastSync.url) + '" target="_blank" rel="noopener">' +
            esc(data.lastSync.shortSha) + '</a>)'
          : '）');
    }
    html += '</span>';

    if (data.remoteChecked === false) {
      html += '<span class="dim">（网络不可用，无法确认仓库状态）</span>';
    }

    var allSynced = data.unpublishedCount === 0 && data.modifiedCount === 0;
    el.className = 'gh-status ' + (allSynced ? 'is-ok' : 'is-warn');
    el.innerHTML = html;
  }

  function githubErrorText(error) {
    if (!error) return '操作失败';
    var map = {
      GITHUB_NOT_CONFIGURED: '尚未配置 GitHub 令牌：请在项目根目录 .env 中填写 GITHUB_TOKEN 后重启服务',
      GITHUB_ACCOUNT_NOT_PUBLISHED: '该账号尚未推送到仓库，无需撤回',
      GITHUB_UNAUTHORIZED: 'GitHub 令牌无效或已过期，请重新生成并更新 .env',
      GITHUB_FORBIDDEN: 'GitHub 拒绝操作：令牌权限不足（需 Contents: Read and write）',
      GITHUB_NOT_FOUND: '找不到该仓库或令牌无权访问，请确认仓库已创建并授权',
      GITHUB_UNREACHABLE: '连接 GitHub 失败，请检查本机网络能否访问 api.github.com',
      GITHUB_CONFLICT: '仓库还没有任何提交，请先推送一次',
    };
    return map[error.code] || error.message || '操作失败';
  }

  async function loadGithubStatus() {
    if (!Api.tokenStore.get()) return;
    try {
      state.github = await Api.githubStatus();
      renderGithubStatus();
      refreshRepoCells();
    } catch (error) {
      // 状态查询失败不应打断主流程；401 交给 api.js 统一处理
      if (error.status !== 401) {
        state.github = null;
        renderGithubStatus();
        refreshRepoCells();
      }
    }
  }

  /** 状态是异步到达的：列表先渲染，状态回来后再只更新「推送仓库」那一列 */
  function refreshRepoCells() {
    var rows = document.querySelectorAll('#account-tbody tr[data-account-id]');
    Array.prototype.forEach.call(rows, function (tr) {
      var id = tr.getAttribute('data-account-id');
      var cell = tr.querySelector('.col-repo');
      if (!cell) return;
      var account = state.items.filter(function (a) { return a.id === id; })[0];
      if (account) cell.innerHTML = repoCell(account);
    });
  }

  /** 推送单个账号 */
  async function pushAccountToGithub(id, name) {
    toast('正在推送「' + name + '」到 GitHub…', 'info');
    try {
      var result = await Api.githubPushAccount(id);
      await loadGithubStatus();
      if (result.unchanged) {
        toast('「' + name + '」的内容已是最新，仓库无需更新', 'info');
      } else {
        toast('已推送「' + name + '」到 GitHub（提交 ' + result.shortSha + '）', 'success');
      }
    } catch (error) {
      toast(githubErrorText(error), 'error');
    }
  }

  /** 撤回单个账号（从仓库中撤下来，本地数据不动） */
  function revertAccountFromGithub(id, name) {
    var gh = state.github || {};
    openConfirm({
      title: '撤回账号',
      message: '将把「' + name + '」的信息页从仓库 ' + (gh.owner || '') + '/' + (gh.repo || '') +
        ' 中撤下来（删除该账号的页面）。本地数据不会改动。',
      okText: '确认撤回',
      onOk: async function () {
        toast('正在从 GitHub 撤回「' + name + '」…', 'info');
        try {
          var result = await Api.githubRevertAccount(id);
          await loadGithubStatus();
          toast('已从仓库撤回「' + name + '」（提交 ' + result.shortSha + '）', 'success');
        } catch (error) {
          toast(githubErrorText(error), 'error');
        }
      },
    });
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    /* ---- 登录 ---- */
    $('login-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      clearInline($('login-error'));

      var username = ($('login-username').value || '').trim();
      var password = $('login-password').value;
      var submit = $('login-submit');

      if (!username || !password) {
        $('login-error').textContent = '请输入管理员账号和密码';
        $('login-error').hidden = false;
        return;
      }

      submit.disabled = true;
      try {
        var data = await Api.login(username, password);
        Api.tokenStore.save(data.access_token, data.expires_in);
        showConsole(data.admin);
        switchView('accounts');
        await loadAccounts();
      } catch (error) {
        reportError(error, $('login-error'));
      } finally {
        submit.disabled = false;
      }
    });

    $('toggle-password').addEventListener('click', function () {
      var input = $('login-password');
      var toText = input.type === 'password';
      input.type = toText ? 'text' : 'password';
      this.querySelector('i').className = toText ? 'fa fa-eye-slash' : 'fa fa-eye';
    });

    $('btn-logout').addEventListener('click', function () {
      Api.tokenStore.clear();
      state.selected = {};
      showLogin();
      toast('已退出登录', 'info');
    });

    /* ---- 导航 ---- */
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (item) {
      item.addEventListener('click', function () {
        switchView(this.getAttribute('data-view'));
      });
    });

    /* ---- 搜索与筛选 ---- */
    var searchTimer = null;
    $('search-keyword').addEventListener('input', function () {
      var value = this.value;
      clearTimeout(searchTimer);
      // 防抖：避免每敲一个字都打一次请求
      searchTimer = setTimeout(function () {
        state.keyword = value.trim();
        state.page = 1;
        loadAccounts();
      }, 300);
    });

    $('filter-status').addEventListener('change', function () {
      state.status = this.value;
      state.page = 1;
      loadAccounts();
    });

    $('select-page-size').addEventListener('change', function () {
      state.pageSize = Number(this.value) || 10;
      state.page = 1;
      loadAccounts();
    });

    /* ---- 排序 ---- */
    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      th.addEventListener('click', function () {
        var key = this.getAttribute('data-sort');
        if (state.sort === key) {
          state.order = state.order === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = key;
          state.order = 'asc';
        }

        Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (node) {
          node.classList.remove('sort-asc', 'sort-desc');
        });
        this.classList.add(state.order === 'asc' ? 'sort-asc' : 'sort-desc');

        state.page = 1;
        loadAccounts();
      });
    });

    /* ---- 刷新与分页 ---- */
    $('btn-refresh').addEventListener('click', function () {
      loadAccounts();
      toast('已刷新', 'info');
    });

    $('btn-prev').addEventListener('click', function () {
      if (state.page > 1) {
        state.page -= 1;
        loadAccounts();
      }
    });

    $('btn-next').addEventListener('click', function () {
      if (state.page < state.pagination.totalPages) {
        state.page += 1;
        loadAccounts();
      }
    });

    /* ---- 表格内的行选择与行操作（事件委托）---- */
    $('account-tbody').addEventListener('change', function (event) {
      var target = event.target;
      if (!target.classList.contains('row-check')) return;

      var id = target.getAttribute('data-id');
      state.selected[id] = target.checked;
      target.closest('tr').classList.toggle('is-selected', target.checked);
      syncSelectionUi();
    });

    $('account-tbody').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-action]');
      if (!button) return;

      var id = button.getAttribute('data-id');
      var action = button.getAttribute('data-action');
      var account = state.items.filter(function (item) {
        return item.id === id;
      })[0];

      if (!account) return;

      if (action === 'preview') {
        // 新窗口打开该账号的前台信息展示页
        window.open('../index.html?preview=' + encodeURIComponent(id), '_blank');
      } else if (action === 'edit') {
        openDrawer(account);
      } else if (action === 'gh-push') {
        pushAccountToGithub(id, button.getAttribute('data-name') || account.username);
      } else if (action === 'gh-revert') {
        revertAccountFromGithub(id, button.getAttribute('data-name') || account.username);
      } else if (action === 'toggle') {
        Api.toggleAccountActive(id)
          .then(function () {
            toast('账号状态已更新', 'success');
            loadAccounts();
          })
          .catch(reportError);
      } else if (action === 'delete') {
        openConfirm({
          title: '删除账号',
          message:
            '确定要删除账号「' + (account.profile['姓名'] || account.username) +
            '（' + account.username + '）」吗？此操作不可撤销。',
          okText: '确认删除',
          onOk: function () {
            removeAccount(id, account.username).catch(reportError);
          },
        });
      }
    });

    $('check-all').addEventListener('change', function () {
      var checked = this.checked;
      state.items.forEach(function (account) {
        state.selected[account.id] = checked;
      });
      loadAccounts();
    });

    $('btn-batch-delete').addEventListener('click', function () {
      var ids = Object.keys(state.selected).filter(function (id) {
        return state.selected[id];
      });
      if (!ids.length) return;

      openConfirm({
        title: '批量删除账号',
        message: '确定要删除选中的 ' + ids.length + ' 个账号吗？此操作不可撤销。',
        okText: '确认删除 ' + ids.length + ' 条',
        onOk: function () {
          batchRemove(ids).catch(reportError);
        },
      });
    });

    /* ---- 抽屉 ---- */
    $('btn-create').addEventListener('click', function () {
      openDrawer(null);
    });
    $('drawer-close').addEventListener('click', closeDrawer);
    $('btn-cancel').addEventListener('click', closeDrawer);
    $('drawer-mask').addEventListener('click', closeDrawer);
    $('btn-save').addEventListener('click', saveAccount);

    /* ---- 头像本地上传 ---- */
    $('btn-pick-avatar').addEventListener('click', function () {
      $('f-avatar-file').click();
    });

    $('f-avatar-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) handleAvatarFile(file);
    });

    $('btn-clear-avatar').addEventListener('click', function () {
      $('f-p-头像').value = '';
      $('avatar-tip').textContent = '';
      renderAvatarUI('');
    });

    // 手改头像地址时同步刷新预览
    $('f-p-头像').addEventListener('input', function () {
      renderAvatarUI(this.value);
      $('avatar-tip').textContent = '';
    });

    /* ---- 随机生成测试样本 ---- */
    $('btn-random').addEventListener('click', fillRandomSample);

    /* ---- 确认弹窗 ---- */
    $('confirm-ok').addEventListener('click', async function () {
      var handler = confirmState.onOk;
      closeConfirm();
      if (handler) handler();
    });
    $('confirm-cancel').addEventListener('click', closeConfirm);
    $('confirm-close').addEventListener('click', closeConfirm);

    /* ---- 管理员弹窗 ---- */
    $('btn-create-admin').addEventListener('click', function () {
      clearInline($('admin-form-error'));
      $('admin-modal').hidden = false;
      $('a-username').focus();
    });
    $('admin-modal-close').addEventListener('click', function () {
      $('admin-modal').hidden = true;
    });
    $('admin-modal-cancel').addEventListener('click', function () {
      $('admin-modal').hidden = true;
    });
    $('admin-modal-save').addEventListener('click', saveAdmin);

    $('admin-tbody').addEventListener('click', function (event) {
      var button = event.target.closest('button[data-admin-delete]');
      if (!button) return;

      var id = button.getAttribute('data-admin-delete');
      var name = button.getAttribute('data-name');

      openConfirm({
        title: '删除管理员',
        message: '确定要删除管理员「' + name + '」吗？该账号将无法再登录后台。',
        okText: '确认删除',
        onOk: function () {
          Api.deleteAdmin(id)
            .then(function () {
              toast('管理员已删除', 'success');
              loadAdmins();
            })
            .catch(reportError);
        },
      });
    });

    $('btn-refresh-audit').addEventListener('click', loadAudit);
    $('btn-refresh-admins').addEventListener('click', loadAdmins);

    /* ---- 全局快捷键 ---- */
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!$('account-drawer').hidden) closeDrawer();
      else if (!$('confirm-modal').hidden) closeConfirm();
      else if (!$('admin-modal').hidden) $('admin-modal').hidden = true;
    });
  }

  /* ================= 启动 ================= */

  /**
   * 直接双击 HTML 文件（file:// 协议）打开时，浏览器不允许网页访问后端接口，
   * 页面会一直停在「加载中…」，看起来就像卡死。
   * 这里直接给出明确指引，而不是让用户对着转圈的表格干等。
   */
  function showProtocolHint() {
    var box = document.createElement('div');
    box.setAttribute(
      'style',
      [
        'position:fixed',
        'inset:0',
        'z-index:99999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:#eef2f7',
        'padding:24px',
        'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif',
      ].join(';')
    );

    box.innerHTML = [
      '<div style="max-width:600px;background:#fff;border-radius:14px;padding:32px 34px;box-shadow:0 10px 40px rgba(15,23,42,.14);line-height:1.85;color:#334155;">',
      '<h2 style="margin:0 0 14px;font-size:21px;color:#0f172a;">请通过本地服务地址访问后台</h2>',
      '<p style="margin:0 0 14px;">检测到你是<b>直接双击 HTML 文件</b>打开的页面（<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">file://</code> 协议）。' +
        '这种方式下浏览器不允许网页访问后台接口，数据会一直停在「加载中…」，看起来就像卡死。</p>',
      '<p style="margin:0 0 6px;font-weight:600;color:#0f172a;">正确做法：</p>',
      '<ol style="margin:0 0 18px;padding-left:22px;">',
      '<li>回到项目文件夹，双击 <b>一键启动.bat</b>（会弹出黑色窗口，不要关）</li>',
      '<li>在浏览器地址栏输入 <b>http://localhost:3000/admin</b></li>',
      '</ol>',
      '<a href="http://localhost:3000/admin" style="display:inline-block;background:#2563eb;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;">前往 http://localhost:3000/admin</a>',
      '<p style="margin:14px 0 0;font-size:13px;color:#94a3b8;">若上面的按钮点不开，说明服务还没启动，请先双击「一键启动.bat」。</p>',
      '</div>',
    ].join('');

    document.body.appendChild(box);
  }

  async function init() {
    // file:// 协议下接口不可能工作，直接给出指引，避免「假死」
    if (window.location.protocol === 'file:') {
      showProtocolHint();
      return;
    }

    bindEvents();
    fillSelect($('f-p-性别'), state.fieldOptions['性别'], '');
    fillSelect($('f-p-执业注册状态'), state.fieldOptions['执业注册状态'], '');

    // 若已持有有效令牌，直接进入控制台，避免刷新后重复登录
    if (Api.tokenStore.get()) {
      try {
        var data = await Api.me();
        showConsole(data.admin);
        switchView('accounts');
        await loadAccounts();
      } catch (error) {
        // 令牌失效：静默回到登录页（api.js 已清理令牌）
        showLogin();
      }
    } else {
      showLogin();
    }

    // 字段枚举以后端为准，失败时沿用前端默认值
    Api.profileFields()
      .then(function (data) {
        if (data && data.options) {
          state.fieldOptions = Object.assign({}, state.fieldOptions, data.options);
          fillSelect($('f-p-性别'), state.fieldOptions['性别'], $('f-p-性别').value);
          fillSelect(
            $('f-p-执业注册状态'),
            state.fieldOptions['执业注册状态'],
            $('f-p-执业注册状态').value
          );
        }
      })
      .catch(function () {
        /* 静默降级 */
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
