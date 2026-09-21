# cline-register

Cline 账号注册机。驱动 **Cline 官方**的 WorkOS OAuth 登录链路，把拿到的 Cline 凭据落盘，并可选地**推送到远程 cline2api 网关**。

- 零外部项目依赖：邮箱库存、接码逻辑、浏览器驱动全部在本目录内。
- 自动过风控：微软「添加安全备用邮箱」用自带 Graph API 的 Outlook 静默接码，FIDO/Passkey 自动跳过。
- 不碰人机验证：本工具**不**绕过 CAPTCHA / WAF / 短信验证。如果账号被要求手机号或人机验证，会明确报错停下。

> 本工具用于你**自己有权管理**的账号。请遵守 Cline 服务条款。

---

## 目录结构

```text
cline-register/
├── web.mjs                   本地 Web 控制台（并发滑块 + 实时日志 + 一键停止）
├── web.cmd                   双击启动 Web 控制台
├── start.mjs                 交互式命令行启动器
├── start.cmd                 双击启动命令行版
├── register.mjs              命令行入口（参数式）
├── paths.mjs                 路径与环境变量解析
├── lib/
│   ├── batch.mjs             可复用批处理引擎（并发 / 落盘 / 推送 / 事件回调）
│   ├── cline_engine.mjs      登录核心引擎（两条 OAuth 链路 + Graph 接码）
│   ├── webpage.mjs           Web 控制台的页面（HTML/CSS/JS）
│   └── push.mjs              推送到远程 cline2api
├── config/
│   ├── mail/                 邮箱库存（见下）
│   └── proxy/                可选代理池
└── data/
    ├── accounts_cline.json   账号池（含已拿到 / 失败的凭据）
    ├── last-token.json       最近一次成功的凭据快照
    └── logs/                 运行日志与失败截图
```

### 邮箱库存格式

仓库里只提供**格式模板**，真实库存请自己填，填好后不会进版本库（`config/mail/*.txt` 已加入 `.gitignore`）：

| 模板 | 复制成 | 用途 |
|---|---|---|
| `config/mail/all_web_mail.example.txt` | `config/mail/all_web_mail.txt` | **待登录的目标账号** |
| `config/mail/new_mail.example.txt` | `config/mail/new_mail.txt` | **辅助接码邮箱** |

`all_web_mail.txt` 每行：

```text
邮箱----密码
```

`new_mail.txt` 每行：

```text
邮箱----密码----clientId----refreshToken----辅助邮箱----辅助邮箱密码
```

辅助邮箱用来接收微软在「异地登录保护」时下发的 6 位安全代码。接码走 Graph API 直连，无需打开邮件网页。

> **安全提醒**：这两个文件含真实账号密码，`data/` 下的账号池文件含 Cline 令牌。它们都已被 `.gitignore` 忽略，**不要**用 `git add -f` 强行提交。

---

## 安装

```bash
cd cline-register
npm install
```

浏览器复用本机已安装的 Chrome（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`，可用 `CHROME_PATH` 覆盖）。
如果本机没有 Chrome，可以装 Playwright 自带的 Chromium：

```bash
npm run install:browser
# 然后设 CHROME_PATH 留空即可让 Playwright 用内置浏览器
```

配置：

```bash
cp .env.example .env
# 至少填好库存文件路径（默认已指向 config/mail/）与可选的目标网关
```

---

## 登录链路说明

引擎支持 Cline 官方的两条 OAuth 流程，**默认走回调流程**（更稳，不受设备码风控影响）：

| | 回调流程（默认） | 设备码流程（`--device`） |
|---|---|---|
| 开关 | 默认 | 加 `--device` |
| 端点 | `GET {CLINE_API_BASE_URL}/api/v1/auth/authorize` | `POST {WORKOS_API_BASE_URL}/user_management/authorize/device` |
| 授权 | 浏览器跳转登录，回调到本地端口 | 显示 8 位 user code，浏览器输入 |
| 端口 | 从 `48801` 起试 6 个，路径 `/auth` | 无 |
| 换令牌 | `POST /api/v1/auth/token`（`grant_type=authorization_code`） | `POST /user_management/authenticate`（`grant_type=...:device_code`） |
| 最后一步 | `POST /api/v1/auth/register` 换成 Cline 令牌 | 同左 |

两条链路在登录过程中都会经过：

1. 微软账号密码登录；
2. 若触发「帮助保护你的帐户 → 添加电子邮件」，自动从 `new_mail.txt` 取一个辅助邮箱填入；
3. 用 Graph API 拉取 6 位安全代码并自动填入；
4. 自动跳过 Windows Hello / Passkey 录入；
5. 在 Cline 授权页点 `Authorize`（回调流程）。

---

## 启动方式

### 方式 1：Web 控制台（推荐，能调并发、看实时日志）

Windows 上**双击 `web.cmd`**，或者：

```bash
npm run web
```

浏览器会自动打开 <http://127.0.0.1:8788/>。控制台里可以：

- 看到库存 / 已成功 / 失败 / 剩余 / 已推送 / 远端配置
- 用滑块选**并发数**（1–8），填**跑多少个**（0 = 全部剩余）
- 选范围（未处理 / 仅失败的 / 全部库存）和链路（回调 / 设备码）
- 勾选「成功即推送远端」
- 点开始后实时看每个账号的进度和日志，随时点停止
- 底部展开已成功账号列表（含是否已推送）

只监听 `127.0.0.1`，不对局域网/公网开放。

### 方式 2：交互式命令行

Windows 上双击 `start.cmd`，或者：

```bash
npm start          # 等价于 node start.mjs
```

它会先打印状态，然后问两个问题：

```
这次要跑多少个账号 [1]: 20
并发数（同时开几个浏览器） [1]: 3
```

### 方式 3：命令行直接给参数

```bash
# 跑 20 个，并发 3
node register.mjs --count 20 --concurrency 3

# 跑完全部未完成账号，并发 2
node register.mjs --all --concurrency 2

# 并发也可以走环境变量
REGISTER_CONCURRENCY=3 node register.mjs --count 50
```

## 并发控制

`--concurrency N`（或环境变量 `REGISTER_CONCURRENCY`）决定**同时处理几个账号**。

并发上限由 `REGISTER_MAX_CONCURRENCY` 控制，**默认 64**。内存充足可以往上调：

```env
REGISTER_MAX_CONCURRENCY=128
```

| 并发 | 适用场景 |
|---|---|
| `1` | 默认，最稳 |
| `2–4` | 推荐区间，速度与内存平衡 |
| `8–16` | 机器好、急灌号；界面会提示预估内存 |
| `>16` | 界面标红警告，渲染进程会抢 CPU |

### 浏览器复用

默认**一个 Chromium + N 个隔离 context**（每个账号独立 cookie/storage，等价于独立无痕窗口）：

```env
REGISTER_SHARED_BROWSER=true    # 默认
```

省掉的是浏览器外壳（主进程 / GPU / 网络服务），但**每个页面仍是独立渲染进程**，所以内存不是线性下降——微软登录页 JS 很重，一个渲染进程约 200–300 MB。

想退回「每账号独立 Chrome」（内存换隔离，但指纹和 IP 其实一样）：

```env
REGISTER_SHARED_BROWSER=false
```

### 几点注意

- **设备码链路建议并发 1–2**，它更容易触发风控。
- **回调链路**每个账号占一个端口，端口用完会自动归还复用（不会泄漏）。
- 日志带 `[3/20]` 序号前缀，并发时能分清哪个账号在干什么。
- 账号池写入串行互斥，多 worker 同时落盘不会互相覆盖。
- 中途 Ctrl+C：已成功的账号已写盘，不会丢；下次跑会跳过。

## 常用命令

全部在 `cline-register/` 目录下执行：

| 命令 | 作用 |
|---|---|
| `npm run web` | 启动 Web 控制台（推荐，带并发滑块与实时日志） |
| `npm start` | 交互式命令行启动（问数量 + 并发） |
| `npm run status` | 查看账号池（成功 / 失败 / 已推送） |
| `npm run login` | 登录下一个待处理账号 |
| `npm run login:device` | 强制走设备码流程 |
| `npm run batch` | 连续登录 5 个 |
| `npm run batch:parallel` | 并发 3 跑 20 个 |
| `npm run all` | 跑完全部未完成账号 |
| `npm run all:parallel` | 并发 2 跑完全部 |
| `npm run retry` | 重试之前失败的账号 |
| `npm run push` | 手动把凭据推到远程网关 |
| `npm run push:dry` | 只预览，不发请求 |
| `npm run push:all` | 连已推送过的也重推一遍 |
| `npm run probe` | 探测远程网关是否可达 |

指定单个邮箱：

```bash
node register.mjs --email someone@outlook.com
```

**自动推送**：每成功登录一个账号，会**立刻**推送到远程网关（前提是 `.env` 里配了 `CLINE2API_REMOTE_URL` + `CLINE2API_ADMIN_TOKEN`）。
不想推就加 `--no-push`，只写本地。
---

## 推送到远程 cline2api

注册机通过网关的管理接口 `POST /admin/api/accounts/import` 推送凭据。

在 `.env` 里配置：

```env
CLINE2API_REMOTE_URL=https://cline.example.com
CLINE2API_ADMIN_TOKEN=<网关的 ADMIN_TOKEN>
```

推送的记录会从注册机的字段自动映射到网关的存储格式：

| 注册机字段 | 网关字段 | 说明 |
|---|---|---|
| `email` | `email` | |
| `accessToken` | `access` | Cline access token，不加 `workos:` 前缀 |
| `refreshToken` | `refresh` | 用于自动续期 |
| `expiresAt` | `expires` | 秒级会自动换算成毫秒 |

推送是**幂等**的：网关按 `accountId` 再按 `email` 去重。重复推送同一批会显示 `新增 0 / 覆盖 N`。

推送成功后，注册机会在本地记录 `pushedAt`，下次 `--push` 默认只推没推过的。

---

## 环境变量

| 变量 | 必填 | 默认 | 作用 |
|---|---|---|---|
| `CLINE_API_BASE_URL` | 否 | `https://api.cline.bot` | Cline 上游地址 |
| `WORKOS_API_BASE_URL` | 否 | `https://api.workos.com` | WorkOS 地址 |
| `WORKOS_CLIENT_ID` | 否 | Cline 官方生产的 client id | OAuth 客户端 |
| `CHROME_PATH` | 否 | Windows Chrome 路径 | 浏览器可执行文件 |
| `REGISTER_HEADLESS` | 否 | `true` | 设 `false` 可看着浏览器跑 |
| `CLINE2API_REMOTE_URL` | 推送时必填 | 空 | 远程网关地址 |
| `CLINE2API_ADMIN_TOKEN` | 推送时必填 | 空 | 远程网关管理令牌 |
| `CLINE2API_IMPORT_PATH` | 否 | `/admin/api/accounts/import` | 导入接口路径 |
| `CLINE2API_PUSH_TIMEOUT_MS` | 否 | `30000` | 推送超时 |
| `CLINE2API_PROXY` | 否 | 空 | 推送/探测走的 HTTP 代理；留空则直连，缺省会依次回落到 `HTTPS_PROXY`、`HTTP_PROXY` |
| `REGISTER_CONCURRENCY` | 否 | `1` | 并发数，等价于 `--concurrency N` |
| `REGISTER_MAX_CONCURRENCY` | 否 | `64` | 并发上限；内存充足可调高，例如 `128` |
| `REGISTER_SHARED_BROWSER` | 否 | `true` | `true`=一个 Chrome 开多个隔离标签（省内存）；`false`=每账号独立 Chrome |
| `REGISTER_WEB_PORT` | 否 | `8788` | Web 控制台端口 |
| `REGISTER_WEB_HOST` | 否 | `127.0.0.1` | Web 控制台监听地址（默认只本机） |

环境变量按 `cline-register/.env` → 仓库根 `.env` → `cline2api/cline2api/.env` 的顺序加载，后者只补前者没设的键。

---

## 排障

**卡在「帮助保护你的帐户」**
说明该账号被微软要求补绑安全邮箱。确认 `new_mail.txt` 里的辅助邮箱 refresh token 还有效（可用 `node -e` 直接换一次 Graph token 验证），并确认辅助邮箱没被风控。

**报 `被要求手机号验证（Radar）`**
这是 Cline 侧的风控，针对设备码链路。换用默认的回调流程（去掉 `--device`）通常可以绕过；本工具**不会**尝试绕过手机验证。

**浏览器起不来**
检查 `CHROME_PATH` 是否指向真实存在的 Chrome；或 `npm run install:browser` 后用 Playwright 自带 Chromium。

**推送报 401**
`CLINE2API_ADMIN_TOKEN` 和网关 `.env` 里的 `ADMIN_TOKEN` 不一致，或网关没设 `ADMIN_TOKEN`（此时只允许本机 loopback 访问）。

**推送报 404**
远程网关版本太旧，没有 `/admin/api/accounts/import`。升级网关到包含该接口的版本。

**推送报 413**
单批记录太多（网关默认上限 2 MB / 5000 条）。注册机已自动按 500 条分批，正常不会触发。




