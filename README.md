# cline2api

自托管的 Cline 反代：把 `api.cline.bot` 的 Cline 账号能力暴露成 **OpenAI 兼容** 与 **Anthropic Messages** 两套 API，供 Cursor / NextChat / Claude Code / 任意 OpenAI SDK 使用。

- **官方登录链路**：WorkOS OAuth Device Code Flow（RFC 8628），服务器无需浏览器。
- **自动续期**：提前 5 分钟续期，单飞控制 + 刷新令牌轮换落盘。
- **静默重试**：上游返回 401 时自动强刷一次令牌并重放请求，客户端无感。
- **多账号故障转移**：轮询选择账号，某个账号失效自动切换。
- **动态模型目录**：实时拉取上游目录（当前 444 个模型），不写死。

---

## 一、上游契约（已核实）

这些常量不是猜的，来自官方仓库源码 + 官方回归测试里的真实录制 + 本机实测：

| 项目 | 值 | 依据 |
|---|---|---|
| API Base | `https://api.cline.bot` | `@cline/shared` → `CLINE_ENVIRONMENTS.production` |
| Chat 端点 | `POST /api/v1/chat/completions` | `@cline/llms` provider 默认 `baseUrl` |
| 模型目录 | `GET /api/v1/models`（**公开、免鉴权**） | 实测 200，返回 444 个模型 |
| 鉴权头 | `Authorization: Bearer workos:<access_token>` | `formatAccessToken` 加 `workos:` 前缀 |
| 流式响应 | **原生 OpenAI SSE，无外层包裹** | VCR 录制 `cline-anthropic-sonnet.json` |
| 设备码 | `POST https://api.workos.com/user_management/authorize/device` | 实测 200，拿到真实 user code |
| 轮询令牌 | `POST /user_management/authenticate`（form-urlencoded） | `pollWorkOSTokens` |
| 注册凭证 | `POST /api/v1/auth/register`，body `{accessToken, refreshToken}` | `registerWorkOSTokens` |
| 续期 | `POST /api/v1/auth/refresh`，body `{refreshToken, grantType:"refresh_token"}` | `refreshClineToken` |
| WorkOS Client ID | `client_01K3A541FN8TA3EPPHTD2325AR` | 官方生产环境配置 |
| 必需请求头 | `X-CLIENT-VERSION` / `X-CORE-VERSION` / `X-CLIENT-TYPE` / `X-IS-MULTIROOT` / `HTTP-Referer` / `X-Title` / `X-Task-ID` | `request-headers.ts` |

> 两个常见误区已被证伪：
> 1. **不需要** `cline-pass/` 前缀，模型 ID 直接使用目录里的值（如 `anthropic/claude-sonnet-4.6`）。
> 2. **不存在** `{success,data}` 外层包裹；那种解包只对 OpenRouter 的 `/images` 生效。本网关仍对非流式响应做一次防御性解包，以防上游将来变更。

---

## 二、快速开始

### 本地运行

```bash
npm install
cp .env.example .env      # 填入 PROXY_API_KEY
npm run dev               # 开发模式（热重载）
# 或
npm run build && npm run serve   # 编译产物运行
```

启动后：

- 管理台：<http://127.0.0.1:8787/>
- OpenAI Base URL：`http://127.0.0.1:8787/v1`
- 健康检查：<http://127.0.0.1:8787/healthz>

未设置 `PROXY_API_KEY` 时会自动生成一个，写入 `$DATA_DIR/proxy-api-key.txt`（不会打印到日志）：

```bash
cat data/proxy-api-key.txt
```

### Docker

```bash
echo "PROXY_API_KEY=sk-your-key" > .env
docker compose up -d --build
```

---

## 三、登录账号

### 方式 1：管理台（推荐）

打开 <http://127.0.0.1:8787/> → 点「登录新账号」→ 用手机扫码或打开链接 → 浏览器确认。页面会自动轮询并在成功后保存账号。

### 方式 2：终端（无头服务器）

```bash
npm run login
```

输出设备码与链接，在任意设备上打开确认即可。

```bash
npm run accounts   # 查看已存账号（不显示任何令牌）
```

> **一次只登录一个账号，且必须由账号本人在浏览器确认。** 本仓库只做协议转换与凭证托管，不包含批量开户或绕过验证。

---

## 四、客户端接入

### curl

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4.6","stream":true,
       "messages":[{"role":"user","content":"你好"}]}'
```

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-your-key")
stream = client.chat.completions.create(
    model="anthropic/claude-sonnet-4.6",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### Claude Code（Anthropic 协议）

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=sk-your-key
# 注意：不要带 /v1，客户端会自己拼 /v1/messages
```

### Cursor / NextChat / Cherry Studio

- Base URL：`http://127.0.0.1:8787/v1`
- API Key：`PROXY_API_KEY` 的值
- 模型名：填 `/v1/models` 返回的任意 ID

---

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 上游实时模型目录（OpenAI 格式） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions，支持 `stream` |
| POST | `/v1/messages` | Anthropic Messages，支持 `stream`（含 tool_use / thinking） |
| GET | `/healthz` | 存活探针 |
| GET | `/` | 管理台（默认仅本机可访问） |
| GET | `/admin/api/*` | 管理接口（登录编排、账号列表） |

透传保留的上游特性：`reasoning_content`（DeepSeek/GLM 思考过程）、`cache_control`、工具调用。

---

## 六、令牌生命周期

```
请求 → TokenManager
        ├─ 未过期（距到期 > 5 分钟）→ 直接使用
        ├─ 即将/已过期 → 单飞续期
        │     ├─ 成功 → 轮换后的 refresh_token 立刻原子落盘
        │     ├─ invalid_grant → 账号标记「需重新登录」，不抛异常
        │     └─ 网络/5xx 且旧令牌仍可用 → 保留旧令牌继续用
        └─ 上游 401/403 → 强制刷新一次 → 重放；仍失败则切换下一个账号
```

关键设计（与官方 `getValidClineCredentials` 语义一致）：

- **`null` 只有一个含义**：refresh token 被拒，必须重新登录。网络抖动不会被误判为登出。
- **单飞（single-flight）**：并发请求只会触发一次刷新，避免刷新令牌轮换互相作废。
- **原子写**：临时文件 + `fsync` + `rename`，崩溃也不会读到半截文件。

---

## 七、安全模型

- `data/accounts.json` 含真实凭证，权限 `0600`，已加入 `.gitignore`。**请务必备份并妥善保管。**
- 日志全程脱敏：邮箱只保留前两位、`workos:`/`sk-`/JWT/Bearer 一律替换为 `<REDACTED>`。
- 客户端密钥与 `ADMIN_TOKEN` 走环境变量，不写入仓库。
- 管理台默认只允许本机访问；对外暴露时必须设置 `ADMIN_TOKEN`。
- 服务默认监听 `127.0.0.1`，对外请放在 nginx/Caddy 之后并启用 TLS。

---

## 八、反向代理（重要）

SSE 必须关闭缓冲，否则打字机效果消失、长响应会超时。仓库内提供 `nginx/cline2api.conf`，核心片段：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_request_buffering off;
chunked_transfer_encoding on;
proxy_read_timeout 600s;
gzip off;
```

---

## 九、项目结构

```
src/
  index.ts               入口：装配服务
  config.ts              环境变量 → 配置
  logger.ts              脱敏日志
  store.ts               账号存储（原子写）
  cline/
    constants.ts         已核实的端点 / 请求头 / 环境常量
    types.ts             凭证与账号类型
    auth.ts              设备码、注册、续期、凭证解析契约
    tokenManager.ts      单飞续期 + 轮换落盘
    models.ts            模型目录（带缓存与兜底）
    upstream.ts          上游请求与请求头构造
  services/
    accountPool.ts       多账号轮询
    proxyChat.ts         失败转移 + 静默重试
    loginService.ts      管理台登录会话编排
  api/
    openai.ts            /v1/models、/v1/chat/completions
    anthropic.ts         /v1/messages 双向转换
    admin.ts             管理接口
    http.ts              SSE 头、错误体、常量时间比较
  cli/                   login.ts / accounts.ts
tests/                   单元 + 集成测试（含 mock 上游）
```

---

## 十、测试

```bash
npm test        # 31 项：单元 + 集成
npm run typecheck
```

集成测试用本地 mock 上游覆盖了：流式逐字节透传、官方请求头、`{success,data}` 解包、401 → 静默续期 → 重放、refresh 被拒 → 账号禁用、Anthropic 流式事件转换、鉴权拦截。

---

## 十一、排障

| 现象 | 原因与处理 |
|---|---|
| `401 Missing or invalid API key` | 客户端没带 `Authorization: Bearer <PROXY_API_KEY>` |
| `503 no_accounts` | 还没登录，或所有账号都需重新登录 → 打开管理台登录 |
| 上游返回 `Unauthorized: ... latest version of Cline` | 凭证失效 → 重新登录；也可能是 `CLINE_CLIENT_VERSION` 过旧，可调高 |
| 有响应但无打字机效果 | 前面的 nginx 没关 `proxy_buffering` |
| 账号显示「需重新登录」 | refresh token 被撤销/过期，属于正常失效，重新登录即可 |
| 模型名 404 | 用 `/v1/models` 返回的 ID，不要自己拼前缀 |

---

## 十二、说明与边界

- 本项目只做**协议转换与凭证托管**，不修改、不绕过上游任何验证；登录始终由账号本人在官方页面确认。
- 使用前请确认符合 Cline 的服务条款；账号风险由使用者自行承担。
- 建议只登录你本人有权使用的账号，并为 `data/` 目录做好权限与备份管理。

