# 护士电子化注册信息系统（学习 / 测试演示项目）

前台账户绑定登录与职业信息展示，配合一个带完整**增删改查**的后台管理系统。  
纯 Node.js + Express 实现，数据存本地 JSON 文件，**无需安装数据库**。

> ⚠️ **重要声明**  
> 本项目为**学习与测试**用途的演示程序，页面内容与账号资料均为虚构示例数据，  
> **与任何真实机构、真实人员无关**。请勿用于任何生产环境或对外提供公共服务。

---

## 受保护的执业信息页（GitHub Pages + 内容加密）

本仓库是**公开仓库**，托管着一份给护士本人查看的信息页。页面采用
**「一账号一链接 + 页面密码 + 内容加密」**的方式发布：

- 站点根目录：<https://ffamx.github.io/nurse-registry/>
- 每个账号一条独立链接：`.../accounts/<10位短码>.html`
- 打开链接要先输入**该账号专属的页面密码**，密码正确才在**浏览器本地**解密出内容。

### 为什么是这样设计的

GitHub Pages 是纯静态托管，**没有任何服务端**，做不了真正的登录鉴权。
所以这里不是"登录后返回内容"，而是**把内容本身加密**后再发布：

- 仓库里的 `docs/accounts/*.html` 全部是**密文**（只有盐值、IV 和密文）；
- 没有页面密码就只是一堆乱码，因此仓库公开也不泄露数据；
- 头像以 data URL 内嵌进密文，仓库里**看不到任何照片文件**；
- 文件名是账号 id 派生的 10 位短码，**不含身份证号**；
- 身份证号在页面内也做了打码（保留前 4 位与后 4 位）。

### 日常怎么用

1. 打开后台 <http://localhost:3000/admin> → 账号列表 → 「推送仓库」列；
2. 每个账号都有独立的**推送 / 撤回**按钮：推送该账号＝生成它的加密页面并提交到
   仓库的 `docs/`；撤回＝从仓库里删掉它的页面。**推送单个账号不会影响其他账号**；
3. 推送成功后，列表里会显示该账号的**页面链接与页面密码**，复制发给本人即可；
   页面密码也可以在「页面密码」那里重新生成或手动指定。

> **请勿手动修改 `docs/` 下的文件**，改动会在下次推送该账号时被覆盖。

---

## 一、快速启动（一键部署）

### 前置条件

**已经不需要你装任何东西了。** 项目目录里自带了一份便携版 Node.js（`portable-node/`），  
启动脚本会优先使用它，所以即使你的电脑完全没装 Node，也能直接跑起来。

> 如果你想用自己系统里装的 Node，也可以——脚本会按「项目自带 → 系统 PATH → 常见安装位置」的顺序自动寻找。

### 启动方式

| 系统                | 操作                           | 说明                       |
| ----------------- | ---------------------------- | ------------------------ |
| **Windows（推荐）**   | 双击 **`一键启动.bat`**            | 保留窗口，能看到实时日志             |
| **Windows（后台静默）** | 双击 **`运行服务.vbs`**            | 不弹黑窗口，启动成功/失败都会明确提示      |
| **Windows（详细过程）** | 双击 **`start.bat`**           | 分 5 步显示进度，排查问题用          |
| **macOS / Linux** | 终端执行 `./start.sh`            | 首次需先 `chmod +x start.sh` |
| **任意系统（手动）**      | `npm install` 然后 `npm start` | 需要系统已装 Node              |

脚本会自动完成：定位 Node → 生成 `.env` → 检查依赖 → 检查端口 → 启动服务。

**停止服务**：双击 `停止服务.bat`。

**遇到问题**：双击 `诊断.bat`，它会把 Node 位置、文件完整性、端口占用、启动实测  
全部检查一遍。把窗口内容截图发出来即可定位问题。

### 访问地址

服务启动后，命令行会打印如下信息：

```
  ==========================================================
    护士电子化注册信息系统 · 演示项目
  ----------------------------------------------------------
    本地访问    : http://localhost:3000/login.html
    后台管理    : http://localhost:3000/admin
    健康检查    : http://localhost:3000/health
  ----------------------------------------------------------
    后台账号    : admin
    初始密码    : 沿用已有配置（未改动）
  ==========================================================
```

| 入口       | 地址                                 | 说明        |
| -------- | ---------------------------------- | --------- |
| 前台登录     | <http://localhost:3000/login.html> | 原「账户绑定」页面 |
| 信息展示     | <http://localhost:3000/index.html> | 原「职业信息」页面 |
| **后台管理** | <http://localhost:3000/admin>      | 账号增删改查    |
| 健康检查     | <http://localhost:3000/health>     | 进程存活探针    |

> 如果 `localhost` 打不开，可改用 <http://127.0.0.1:3000/admin>。

### 默认账号

| 角色    | 账号        | 密码                              | 来源          |
| ----- | --------- | ------------------------------- | ----------- |
| 后台管理员 | `admin`   | 见本地 `.env` 的 `ADMIN_PASSWORD`   | 首次启动自动创建    |
| 前台用户  | 见后台「账号管理」 | 新增账号时自己设置的                      | 早期由 `config.js` 迁移 |

> 本仓库是**公开仓库**，因此文档里不写任何真实口令与身份证号。
> 初始管理员密码在首次启动时打印于启动日志，也可在 `.env` 中指定。
>
> 后台密码想改的话，编辑 `.env` 里的 `ADMIN_PASSWORD`，  
> 再把 `RESET_ADMIN_PASSWORD` 改成 `1`，重启一次服务即可生效。

---

## 二、功能说明

### 前台（保持原有逻辑与样式）

- **`login.html`** —— 原有的账户绑定登录页，样式、结构、交互完全保持原样，账号仍从 `public/config.js` 读取，登录成功后写入 `localStorage`。
- **`index.html`** —— 原有的职业信息展示页，展示基本信息与工作单位两块内容。

原页面唯一改动是**把 5 个外部 CDN 引用改成本地路径**（`./assets/...`），  
使网站在**完全离线**的环境下也能正常显示，其余 HTML/CSS/JS 一字未改。

### 后台管理（本次新增）

访问 <http://localhost:3000/admin>，用管理员账号登录后可使用：

| 功能          | 说明                                     |
| ----------- | -------------------------------------- |
| **列表查询**    | 分页展示，支持按用户名 / 姓名 / 身份证号 / 执业机构**模糊搜索** |
| **筛选排序**    | 按启用状态筛选；点击表头按用户名、姓名、创建时间排序             |
| **新增账号**    | 抽屉式表单，含账号信息 + 20 个资料字段，密码自动散列入库        |
| **编辑账号**    | 回填全部字段；密码留空即不修改                        |
| **删除账号**    | 单个删除，带二次确认弹窗                           |
| **批量删除**    | 勾选多条后一键删除                              |
| **启用 / 停用** | 停用后该账号无法再登录前台                          |
| **操作日志**    | 自动记录新增 / 修改 / 删除等关键操作                  |
| **管理员管理**   | 超级管理员可新增、删除后台账号                        |

**后台改动与前台的关系**：后台的数据存于服务端数据库，前台页面仍读 `public/config.js`。  
若希望「后台改完、前台立刻可见」，见下方「常见问题」第 3 条。

---

## 三、项目结构

```
nurse-registry/
├── 一键启动.bat                  # 【推荐】双击即用，自动找 Node
├── start.bat                     # 详细版启动（分 5 步显示进度）
├── 运行服务.vbs                  # 后台静默启动，无黑窗口
├── 停止服务.bat                  # 停止服务并释放端口
├── 诊断.bat                      # 环境自检（排查问题用）
├── start.sh                      # macOS / Linux 启动脚本
│
├── portable-node/                # 项目自带的便携版 Node.js（免安装）
│   ├── node.exe
│   └── npm / npx
│
├── package.json                  # 依赖与命令
├── .env.example                  # 环境变量模板（可安全提交）
├── .gitignore                    # 已忽略 .env、data/*.json、portable-node/
│
├── data/
│   └── db.json                   # 运行时数据（账号 / 管理员 / 日志），首次启动自动生成
│
├── public/                       # 静态资源（不需要构建，直接可访问）
│   ├── login.html                # 原登录页
│   ├── index.html                # 原信息展示页
│   ├── config.js                 # 原前台账号配置
│   ├── ns-favicon.ico
│   ├── assets/                   # 原项目本地化的第三方库
│   │   ├── css/{bootstrap.min.css, font-awesome.min.css, bind-account.css}
│   │   ├── js/{bootstrap.min.js, ery.custom.min.js, modernizr.min.js}
│   │   └── img/avatar.png        # 占位头像
│   └── admin/                    # 后台管理界面
│       ├── index.html
│       ├── admin.css
│       ├── api.js                # API 客户端（统一错误处理 / 令牌 / 重试）
│       └── app.js                # 控制台逻辑
│
├── src/
│   ├── server.js                 # 入口：初始化 → 装配 → 监听 → 优雅停机
│   ├── app.js                    # 组合根：中间件顺序与路由挂载
│   ├── config.js                 # 集中配置 + 启动时校验
│   │
│   ├── lib/                      # 基础设施
│   │   ├── json-db.js            # JSON 文件数据库（原子写 + 写队列）
│   │   ├── errors.js             # 类型化错误体系
│   │   ├── logger.js             # 结构化 JSON 日志（自动脱敏）
│   │   ├── passwords.js          # scrypt 口令散列
│   │   └── validate.js           # 输入校验与清洗
│   │
│   ├── middleware/
│   │   ├── request-context.js    # 请求 ID 与访问日志
│   │   ├── security.js           # 安全响应头 + 显式来源 CORS
│   │   ├── auth.js               # JWT 鉴权 + 限流
│   │   └── error-handler.js      # 全局错误处理 + 404
│   │
│   ├── repositories/index.js     # 仓储层：账号 / 管理员 / 日志
│   ├── services/                 # 服务层：业务规则
│   │   ├── auth-service.js       # 登录、限流、改密
│   │   ├── account-service.js    # 账号增删改查、搜索分页
│   │   └── token-service.js      # JWT 签发与校验
│   ├── routes/                   # 控制器层：只处理 HTTP
│   │   ├── auth-routes.js
│   │   └── admin-routes.js
│   └── bootstrap/seed.js         # 初始管理员 + 历史账号迁移
│
└── scripts/
    ├── smoke-test.js             # 冒烟测试（38 项断言）
    └── reset-data.js             # 重置数据库
```

**分层约定**：`路由（控制器）` 只解析请求与格式化响应 → `服务层` 承载业务规则 →  
`仓储层` 负责数据读写。控制器不含业务逻辑，服务层不依赖任何 HTTP 对象，因此可独立测试。

---

## 四、API 接口

所有接口统一返回 `{ ok, data | error, request_id }` 结构，便于前端统一处理。

### 认证

| 方法     | 路径                      | 说明       |
| ------ | ----------------------- | -------- |
| `POST` | `/api/auth/login`       | 前台账号登录   |
| `POST` | `/api/auth/admin/login` | 后台管理员登录  |
| `GET`  | `/api/auth/me`          | 当前前台用户信息 |
| `GET`  | `/api/auth/admin/me`    | 当前管理员信息  |

### 后台管理（均需 `Authorization: Bearer <token>`）

| 方法       | 路径                                      | 说明                                                      |
| -------- | --------------------------------------- | ------------------------------------------------------- |
| `GET`    | `/api/admin/accounts`                   | 列表（`keyword`/`status`/`sort`/`order`/`page`/`pageSize`） |
| `POST`   | `/api/admin/accounts`                   | **新增**                                                  |
| `GET`    | `/api/admin/accounts/:id`               | 详情                                                      |
| `PATCH`  | `/api/admin/accounts/:id`               | **修改**                                                  |
| `DELETE` | `/api/admin/accounts/:id`               | **删除**                                                  |
| `POST`   | `/api/admin/accounts/batch-delete`      | **批量删除**                                                |
| `POST`   | `/api/admin/accounts/:id/toggle-active` | 启用 / 停用                                                 |
| `GET`    | `/api/admin/profile-fields`             | 字段与枚举定义                                                 |
| `GET`    | `/api/admin/audit-logs`                 | 操作日志                                                    |
| `GET`    | `/api/admin/admins`                     | 管理员列表                                                   |
| `POST`   | `/api/admin/admins`                     | 新增管理员（仅超级管理员）                                           |
| `DELETE` | `/api/admin/admins/:id`                 | 删除管理员（仅超级管理员）                                           |

### 命令行验证示例

```bash
# 1. 登录拿令牌（Windows 下注意去掉 --noproxy '*' 或按需保留）
curl -X POST http://localhost:3000/api/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}'

# 2. 用令牌查列表
curl http://localhost:3000/api/admin/accounts \
  -H "Authorization: Bearer <上一步返回的 access_token>"
```

### 错误结构

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数校验未通过",
    "details": [{ "field": "username", "message": "用户名不能为空" }]
  },
  "request_id": "0f1c2a3b-..."
}
```

常见错误码：`VALIDATION_ERROR`(400)、`UNAUTHORIZED`(401)、`FORBIDDEN`(403)、  
`NOT_FOUND`(404)、`CONFLICT`(409)、`RATE_LIMITED`(429)、`INTERNAL_ERROR`(500)。

---

## 五、命令速查

```bash
npm start             # 启动服务
npm run dev           # 开发模式（改动自动重启）
npm run smoke         # 冒烟测试：自动拉起服务并验证 38 项断言
npm run reset-data    # 清空数据库（会二次确认）
```

---

## 六、环境变量

复制 `.env.example` 为 `.env` 后按需修改。一键启动脚本会自动完成这一步。

| 变量                     | 默认值           | 说明                                  |
| ---------------------- | ------------- | ----------------------------------- |
| `NODE_ENV`             | `development` | 设为 `production` 会强制校验 `JWT_SECRET`  |
| `PORT`                 | `3000`        | 监听端口                                |
| `HOST`                 | `0.0.0.0`     | 监听地址                                |
| `JWT_SECRET`           | 开发兜底值         | **生产环境必须设置为 ≥32 位随机串**              |
| `ACCESS_TOKEN_TTL_SEC` | `7200`        | 前台令牌有效期（秒）                          |
| `ADMIN_TOKEN_TTL_SEC`  | `28800`       | 后台令牌有效期（秒）                          |
| `ADMIN_USERNAME`       | `admin`       | 初始管理员用户名                            |
| `ADMIN_PASSWORD`       | 随机生成          | 留空则随机生成并打印在启动日志                     |
| `RESET_ADMIN_PASSWORD` | `0`           | 设为 `1` 可重置管理员密码                     |
| `DATA_DIR`             | `./data`      | 数据文件目录                              |
| `MAX_LOGIN_ATTEMPTS`   | `8`           | 登录失败次数上限                            |
| `LOGIN_WINDOW_MS`      | `300000`      | 限流统计窗口（毫秒）                          |
| `CORS_ALLOWED_ORIGINS` | 空             | 跨域白名单，逗号分隔                          |
| `LOG_LEVEL`            | `info`        | `debug` / `info` / `warn` / `error` |

生成一个安全密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## 七、安全设计说明

作为学习项目，这里刻意实现了较完整的安全实践，便于对照理解：

| 项目         | 实现方式                                                               |
| ---------- | ------------------------------------------------------------------ |
| **口令存储**   | Node 内置 `scrypt` + 16 字节随机盐，**绝不存明文**                              |
| **口令校验**   | `crypto.timingSafeEqual` 恒定时间比较，防时序侧信道                             |
| **登录防爆破**  | 按「用户名 + IP」滑动窗口限流，超限返回 429                                         |
| **账号枚举防护** | 用户不存在与密码错误返回**完全相同**的提示，且都执行一次散列运算抹平时延                             |
| **令牌**     | 自实现 HS256 JWT；先验签后解析载荷；校验 `exp` 与 `iss`                            |
| **令牌类型隔离** | 前台令牌 `typ=account`、后台令牌 `typ=admin`，互相不能越权                         |
| **令牌存储**   | 前端存 `sessionStorage` + 内存，**不用 localStorage**                      |
| **越权删除防护** | 管理员不能删除自己；非超级管理员不能管理管理员                                            |
| **输入校验**   | 所有入口在边界处校验；资料字段走键名白名单，未知键一律丢弃                                      |
| **协议注入防护** | 头像等 URL 字段强制 `http/https`，拦截 `javascript:` / `data:`               |
| **XSS 防护** | 前端渲染统一走 `esc()` 转义；配合严格 CSP                                        |
| **安全响应头**  | CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 等 |
| **CORS**   | 显式来源白名单，**不使用通配符**                                                 |
| **错误处理**   | 类型化错误 + 全局处理器；5xx 只记日志，对外统一文案，不泄露堆栈                                |
| **日志脱敏**   | 结构化 JSON 日志，`password`/`token` 等字段自动替换为 `[redacted]`               |
| **数据完整性**  | 写盘先写临时文件再 `rename` 原子替换；写入串行化，避免并发覆盖                               |
| **数据损坏**   | 解析失败时**明确报错并退出**，绝不静默用空数据覆盖                                        |
| **优雅停机**   | 收到 `SIGINT`/`SIGTERM` 先停收新连接、等待在途请求，再落盘退出（10 秒兜底）                  |
| **配置校验**   | 启动时集中校验，缺少关键配置直接失败退出（快速失败）                                         |

---

## 八、常见问题

> **遇到问题时，先双击 `诊断.bat`。** 它会把 Node 位置、文件完整性、端口占用、  
> 启动实测全部检查一遍，多数问题看输出就能定位。

**1. 双击启动脚本后浏览器打不开页面？**

按顺序排查：

1. **启动窗口是不是被关了？** `一键启动.bat` 的窗口必须保持打开，关掉窗口服务就停了。  
   想让它后台跑，改用 `运行服务.vbs`。
2. **窗口里有没有报错？** 如果有红字或 `[错误]`，按提示处理。
3. **换个地址试试**：<http://127.0.0.1:3000/admin>（有些环境 `localhost` 解析异常）。
4. **确认端口在监听**：双击 `诊断.bat`，看第 4 节。
5. **确实起不来就跑 `诊断.bat`**，把输出发出来。

**2. 提示「未检测到 Node.js」**  
理论上不会出现——项目自带 `portable-node/node.exe`。  
如果真遇到了，说明 `portable-node/` 目录被删了。两种解决办法：

- 从原始压缩包里把 `portable-node/` 目录拷回来；
- 或者自己装一个 Node（<https://nodejs.org/zh-cn/download>），装完**重启电脑**。

**3. 双击脚本一闪就退，什么都没看到？**  
说明脚本在执行早期就失败了。改用 `start.bat`（分步显示，不会一闪而过），  
或者直接双击 `诊断.bat` 看完整信息。

**4. `npm install` 很慢或失败**  
切换国内镜像后重试：

```bash
npm config set registry https://registry.npmmirror.com
```

> 依赖其实已经装好随项目分发了（`node_modules/`），正常情况不需要联网安装。

**5. 后台改了数据，前台页面没变化？**  
这是**刻意保留的原有行为**：前台按你的要求仍从 `public/config.js` 读取账号。

如果需要「后台改完前台立刻可见」，只需把 `login.html` 里的登录校验改为调用后端接口，  
再让 `index.html` 从接口取资料即可。核心改动大致是：

```js
// login.html 中原来的写法（读本地配置）
const account = (window.WEB003_CONFIG.accounts || {})[username];
if (!account || account.password !== password) { ... }

// 改为调用后端
const res = await fetch('./api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
}).then((r) => r.json());

if (!res.ok) { showError(res.error.message); return; }
localStorage.setItem('web003_user', JSON.stringify(res.data.user));
navigate('./index.html');
```


```

后端接口 **已经全部就绪**，无需改动服务端。

**6. 忘记后台密码了怎么办？**
初始是 `admin`，密码在 `.env` 的 `ADMIN_PASSWORD` 里（仓库是公开仓库，
因此文档里不写实际口令）。想改成别的，在 `.env` 中设置
`ADMIN_PASSWORD=新密码` 和 `RESET_ADMIN_PASSWORD=1`，重启服务后生效，
之后把 `RESET_ADMIN_PASSWORD` 改回 `0`。

**7. 想清空所有数据重新开始？**
```bash
npm run reset-data
```
会删除 `data/db.json`，下次启动重新创建并再次迁移 `config.js` 中的账号。

**8. 端口 3000 被占用？**
先双击 `停止服务.bat` 释放；要换端口就改 `.env` 里的 `PORT`。

**9. 局域网内其他设备能访问吗？**
可以。服务默认监听 `0.0.0.0`，用 `http://<你的内网IP>:3000` 即可访问。
若系统防火墙拦截，需放行对应端口。

**10. 数据存在哪里？备份方便吗？**
全部在 `data/db.json` 单个文件里，直接复制该文件即可完成备份。

**11. 这个项目能直接拷到别的电脑上跑吗？**
可以。把整个 `nurse-registry/` 目录拷过去（含 `portable-node/` 和 `node_modules/`），
双击 `一键启动.bat` 即可，目标电脑**不需要装任何东西**。

---

## 九、后续可练习的方向

1. 把前台 `login.html` 改为走后端接口，实现前后台数据完全打通（见常见问题 3）
2. 给令牌加上**刷新令牌**机制，缩短访问令牌有效期
3. 把内存限流换成 Redis，支持多实例部署
4. 把 JSON 文件换成 SQLite / PostgreSQL，并引入迁移脚本
5. 补充接口的单元测试与集成测试（`scripts/smoke-test.js` 已有集成测试雏形）
6. 加入头像**文件上传**（替代填写 URL）
7. 给列表加 Excel 导出功能

---

## 十、许可与用途

本项目仅供**个人学习、教学演示与本地测试**使用。
页面文案与数据结构参考自公开的行业信息表格式样，账号资料为虚构示例，
**不涉及任何真实个人信息**，请勿用于生产环境或对外提供公共服务。
