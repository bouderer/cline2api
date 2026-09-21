# cline2api

自托管的 Cline 反代：把 `api.cline.bot` 的 Cline 账号能力暴露成 **OpenAI 兼容** 与 **Anthropic Messages** 两套 API，供 Cursor / NextChat / Claude Code / 任意 OpenAI SDK 使用。

- **官方登录链路**：默认 WorkOS Device Code Flow（RFC 8628）；可选 localhost 回调流程，适配本机浏览器授权。
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
| localhost 授权 | `GET /api/v1/auth/authorize` -> WorkOS -> `http://127.0.0.1:PORT/auth` | 可选回调流程，端口 48801-48811 |
| 回调换码 | `POST /api/v1/auth/token`，body `{grant_type,code,client_type,redirect_uri}` | 仅回调模式 |
| 轮询令牌 | `POST /user_management/authenticate`（form-urlencoded） | `pollWorkOSTokens` |
| 注册凭证 | `POST /api/v1/auth/register`，body `{accessToken, refreshToken}` | `registerWorkOSTokens` |
| 续期 | `POST /api/v1/auth/refresh`，body `{refreshToken, grantType:"refresh_token"}` | `refreshClineToken` |
| WorkOS Client ID | `client_01K3A541FN8TA3EPPHTD2325AR` | 官方生产环境配置 |
| 必需请求头 | `X-CLIENT-VERSION` / `X-CORE-VERSION` / `X-CLIENT-TYPE` / `X-IS-MULTIROOT` / `HTTP-Referer` / `X-Title` / `X-Task-ID` | `request-headers.ts` |

> 两个容易踩的点：
> 1. **两套模型 ID 并存**。`anthropic/claude-sonnet-4.6` 这类走 **Cline Credits** 计费；订阅（Cline Pass）只覆盖 `cline-pass/*` 前缀的那批 ID（`cline-pass/kimi-k3`、`cline-pass/glm-5.3` …）。用只有订阅、没有 Credits 的账号调不带前缀的名字会报 `Insufficient balance`。本网关把两套目录合并进 `/v1/models`，并用 `/admin/api/models` 的 `bucket` 字段标明每个模型走哪条计费（见第五节）。
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

未设置任何密钥时首次启动会自动生成一个（存 `$DATA_DIR/apikeys.json`，明文只在启动日志出现一次）。
之后在管理台「密钥」页新建、轮换、停用；用到的 `PROXY_API_KEY` 会被导入密钥表：

```bash
# 明文只在返回里出现一次，列表页永远不回显
curl -X POST http://127.0.0.1:8787/admin/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"label":"给 Cursor 的"}'
```

### Docker

```bash
echo "PROXY_API_KEY=sk-your-key" > .env
docker compose up -d --build
```

---

## 三、登录账号

### 方式 1：设备码（管理台/无头环境，默认）

打开 <http://127.0.0.1:8787/> → 点「登录新账号」→ 用手机扫码或打开链接 → 浏览器确认。页面会自动轮询并在成功后保存账号。

### 方式 2：localhost 回调（可选）

要求浏览器能访问网关所在机器的 `127.0.0.1:48801-48811`。适合本机运行；远程服务器优先继续用设备码。管理 API：

```bash
curl -X POST http://127.0.0.1:8787/admin/api/login/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"callback"}'
```

返回的 `verificationUri` 是已把 provider 切到 `MicrosoftOAuth` 的 WorkOS URL。浏览器完成授权并点击 Authorize 后，网关会收到 `code`、换令牌并自动落盘。`GET /admin/api/login/modes` 可查询可用模式。

Docker 默认没有映射回调端口；确实要在容器里使用回调模式时，需要只映射到宿主机 loopback：

```yaml
ports:
  - "127.0.0.1:48801-48811:48801-48811"
```
### 方式 3：终端（设备码）

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
export ANTHROPIC_AUTH_TOKEN=sk-your-key
# 注意 1：不要带 /v1 后缀，客户端会自己拼 /v1/messages
# 注意 2：AUTH_TOKEN 与 API_KEY 都能用——网关同时接受
#         `Authorization: Bearer` 和 `x-api-key` 两种头
```

模型名建议直接用 `cline-pass/*`（订阅覆盖，不吃 Credits），例如
`cline-pass/kimi-k3`、`cline-pass/glm-5.3`。

### Codex / Responses API

网关**原生**讲 Responses 协议（不是把它降级成 chat completions）：`instructions`、`input` 里的
`function_call` / `function_call_output` 往返、`tools`（Responses 方言）、`max_output_tokens`、
流式事件（`response.output_text.delta`、`response.function_call_arguments.delta`、`response.completed` …）
都会正确转换，思考过程以 `reasoning` item 返回。

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=sk-your-key
# Codex 走 /v1/responses，模型名同样填 /v1/models 里的 ID
```

> 注意与 new-api 的接入配置区分（见下文「new-api 接入配置」）：那里是让 **new-api 自己**把
> Responses 请求降级成 chat completions 再打给本网关，本网关收到的是 chat 请求；而直连本网关时
> `/v1/responses` 是原生转换，两者不要混。

### Cursor / NextChat / Cherry Studio

- Base URL：`http://127.0.0.1:8787/v1`
- API Key：`PROXY_API_KEY` 的值
- 模型名：填 `/v1/models` 返回的任意 ID

---

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 上游实时模型目录（OpenAI 格式）。合并两个来源：`/api/v1/models`（计费模型）+ `/api/v1/ai/cline/recommended-models` 的 `free` / `clinePass` 桶（订阅与免费模型），按 ID 去重；计费桶信息只在 `/admin/api/models` 暴露，不污染 OpenAI 结构 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions，支持 `stream` |
| POST | `/v1/responses` | OpenAI Responses，支持 `stream`。请求侧 `instructions` / `input`（含 `function_call`、`function_call_output`）/ `tools` / `max_output_tokens` 翻译成 chat completions，响应再翻回 Responses 结构 |
| POST | `/v1/messages` | Anthropic Messages，支持 `stream`（含 tool_use / thinking） |
| GET | `/healthz` | 存活探针 |
| GET | `/` | 管理台（默认仅本机可访问） |
| GET | `/admin/api/*` | 管理接口（登录编排、账号、模型分桶、订阅、请求日志、试聊） |
| GET | `/admin/api/login/modes` | 返回 `["device","callback"]` 与默认模式 |
| POST | `/admin/api/login/start` | body 可选 `{"mode":"device"|"callback"}`；省略时默认 `device` |
| POST | `/admin/api/accounts/import` | 批量导入注册机凭据，最多 5000 条 / 2 MB |

### 账号导入接口

独立注册机可以通过管理令牌向 `POST /admin/api/accounts/import` 推送凭据。单次最多 5000 条、请求体最大 2 MB；接口逐条校验，合法条目走 `AccountStore` 的 `accountId` → `email` 去重，非法条目不会导致整批失败。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `email` | 是 | string | 必须包含 `@`，作为无 `accountId` 时的去重键 |
| `access` | 是 | string | Cline access token 原文，不要带 `workos:` |
| `refresh` | 是 | string | Cline refresh token |
| `expires` | 是 | number | epoch 毫秒；小于 `1e12` 时按秒自动乘 1000 |
| `tokenType` | 否 | string | 默认 `Bearer` |
| `provider` | 否 | string | 默认 `cline` |
| `label` | 否 | string/null | 账号标签，默认 `null` |

响应：
```json
{"imported":1,"updated":1,"skipped":1,"total":3,"errors":[{"index":2,"email":"bad","reason":"email must be a string containing @"}]}
```
`errors` 最多返回 20 条；`skipped` 仍是完整跳过数量。合法条目在整批最后统一原子写盘一次，避免逐条 fsync。
透传保留的上游特性：`reasoning` / `reasoning_content`（DeepSeek/GLM 思考过程，两种字段名都认）、工具调用。

### 提示缓存（prompt cache）

缓存由上游按前缀自动命中，不需要客户端打 `cache_control` 标记；本网关**不转发**该标记，只负责把上游的命中量如实报出来：

| 上游字段 | Anthropic（`/v1/messages`） | Responses（`/v1/responses`） |
|---|---|---|
| `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` | `input_tokens_details.cached_tokens` |
| `cache_creation_input_tokens` | `cache_creation_input_tokens` | —（Responses 无对应字段） |
| `prompt_tokens` | **减去**上面两项后作为 `input_tokens` | 原样作为 `input_tokens` |

两者对 `input_tokens` 的口径不同：Anthropic 的 `input_tokens` **不含**缓存读/写（总量 = `input_tokens` + `cache_read` + `cache_creation`），OpenAI/Responses 的 `input_tokens` **含**缓存读（`cached_tokens` 是它的子集）。不按各自口径报会让计费方重复计算缓存前缀 —— 例如 new-api 用 `总量 - input_tokens - cached_tokens` 反推缓存写入量，混用口径会算出负数。

`/v1/chat/completions` 是逐字节透传，缓存字段本来就带着，无需转换。

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
- 管理台和 `/admin/*` 默认只允许本机访问；**只要可能从公网或本机反代访问，就必须设置高强度 `ADMIN_TOKEN`**。本机反代应写入 `X-Forwarded-For`，网关会在代理 peer 为 loopback 时按右侧最近一跳判断真实来源。
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
    auth.ts              设备码/回调换码、注册、续期、凭证解析契约
    callbackServer.ts    localhost OAuth 回调监听器（48801-48811）
    tokenManager.ts      单飞续期 + 轮换落盘
    models.ts            模型目录（带缓存与兜底）
    upstream.ts          上游请求与请求头构造
  services/
    accountPool.ts       多账号轮询
    proxyChat.ts         失败转移 + 静默重试
    loginService.ts      管理台登录会话编排
  api/
    openai.ts            /v1/models、/v1/chat/completions
    responses.ts         /v1/responses 双向转换（含流式事件）
    anthropic.ts         /v1/messages 双向转换
    admin.ts             管理接口
    http.ts              SSE 头、错误体、常量时间比较、思考字段识别
  cli/                   login.ts / accounts.ts
tests/                   单元 + 集成测试（含 mock 上游）
```

---

## 十、测试

```bash
npm test        # 38 项：单元 + 集成
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
| 调用返回 `empty response content` | 上游推理型模型在小 `max_tokens` 下把预算烧在思考上，正文为空。实测 `max_tokens: 16` 时 `cline-pass/glm-5.3`、`kimi-k3`、`deepseek-*`、`muse-spark` 都会这样，`qwen3.7-plus`、`minimax-m3`、`solar-pro4` 不会。调大 `max_tokens`（≥256）即可；关思考的开关（`reasoning_effort` / `thinking` / `enable_thinking`）实测都无效 |
| new-api 渠道「测试」失败但实际能用 | new-api 的渠道测试固定发 `max_tokens: 16`，撞上上一条。把渠道的「测试模型」设成 `cline-pass/minimax-m3` 这类不吃预算的模型即可 |
| new-api「获取模型列表」报 advanced custom 相关错误 | 渠道类型被设成了「高级自定义」（该分叉里 type=58）。这种类型必须自己配 `/v1/models` 路由，普通 OpenAI 兼容渠道用 type=1 就行 |

---

## 十二、说明与边界

- 本项目只做**协议转换与凭证托管**，不修改、不绕过上游任何验证；登录始终由账号本人在官方页面确认。
- 使用前请确认符合 Cline 的服务条款；账号风险由使用者自行承担。
- 建议只登录你本人有权使用的账号，并为 `data/` 目录做好权限与备份管理。

---

## 十三、管理台

`http://127.0.0.1:8787/?token=<ADMIN_TOKEN>`（未设 `ADMIN_TOKEN` 时仅本机可访问；公网/反代环境必须设置）。
左侧栏五个视图，地址栏带 hash（如 `#models`）可直接分享到某一页：

| 视图 | 内容 |
|---|---|
| 概览 | 账号 / 模型统计磁贴、**账号配额**（`GET /admin/api/usage`：每个账号一行，5 小时 / 周 / 月三条进度条 + 重置时间）、OpenAI 与 Claude Code 接入片段（一键复制）、最近请求 |
| 模型 | 全量目录，分桶筛选芯片 + 搜索，每条可复制 ID 或**就地测活**（显示可用/失败与耗时） |
| 试聊 | 选模型 → SSE 流式对话（气泡视图、首字耗时、tokens/cost），走 `/admin/api/chat`；Ctrl/⌘+Enter 发送 |
| 账号 | 设备码登录（二维码 + 链接 + 设备码）、账号列表、删除；回调模式通过 `/admin/api/login/start` 的 `mode` 参数启用 |
| 日志 | 最近 200 条请求（模型、状态、耗时、账号、错误），按成功/失败筛选，可 5 秒自动刷新；仅内存，重启清空 |

令牌两种传法：URL 带 `?token=`（会存进本浏览器 localStorage，下次直接开），或首次打开时在页面上粘贴一次。

对应管理接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/models` | 目录 + `bucket`（`pass` / `free` / `credits`）与三项计数 |
| GET | `/admin/api/usage` | **每个账号**的套餐 + 5 小时 / 周 / 月 三个窗口的用量百分比与重置时间（每账号 60 秒缓存） |
| GET | `/admin/api/subscription` | 首个可用账号的套餐状态（名称/周期/是否生效/到期日） |
| GET | `/admin/api/requests?limit=100` | 最近请求 + 统计 |
| POST | `/admin/api/chat` | 与 `/v1/chat/completions` 同一条链路，用管理令牌鉴权 |
| GET | `/admin/api/login/modes` | 登录模式列表；默认 `device`，可选 `callback` |
| POST | `/admin/api/login/start` | 启动登录；body 可传 `{"mode":"callback"}` |
| POST | `/admin/api/accounts/import` | 批量 upsert 账号；逐条跳过非法条目，响应 imported/updated/skipped/total/errors |

### 免费模型

上游 `GET /api/v1/ai/cline/recommended-models` 的 `free` 桶（Cline 客户端「Free」页签渲染的就是它，
不消耗 Cline Credits，也不占订阅额度）当前是这 6 个：

```
cline-free/deepseek-v4.1-flash        cline-free/muse-spark-1.3-contributor
cline-free/solar-pro4                 z-ai/glm-5.3-flash
stealth/union-alpha                   poolside/laguna-s-2.1:free
```

注意两点：

1. **免费桶不都叫 `cline-free/` 前缀**。`z-ai/glm-5.3-flash`、`stealth/union-alpha`、
   `poolside/laguna-s-2.1:free` 同时也在计价目录 `/api/v1/models` 里，靠名字猜会误判成要 Credits。
   所以网关把**目录声明的桶**一路带下来（`/admin/api/models` 的 `bucket` 字段），不做启发式判断。
2. 计价目录里另有约 20 个带 `:free` 后缀的模型（如 `google/gemma-4-31b-it:free`）——那是 OpenRouter
   的免费档，**不在** Cline 的 free 桶里，网关按 Credits 归类，别混为一谈。

实测（余额为负 `-$0.02` 的账号）：上面 6 个照常返回，且调用前后 `insufficient_credits` 错误里回显的
`current_balance` / `total_spent` 完全没变。响应里的 `usage.cost` 是上游 provider 成本透传，不向本账号计费。

> 免费桶与订阅桶常是**同一模型的两种 ID**（`cline-free/deepseek-v4.1-flash` 与
> `cline-pass/deepseek-v4.1-flash`）。免费 ID 走共享池、易 429；要稳定就用订阅 ID。

### 多账号与混合账号池

管理台每点一次「登录新账号」就追加一个账号（同一账号重复登录只更新不重复）。请求按
`AccountPool.candidates()` 轮询，401/403 静默续期并重放，仍失败则切换下一个账号。
每个账号都必须由账号本人在官方页面确认一次，仓库不含批量开户。

**账号能力并不一致**：一个号有 Cline Credits、另一个只有 Cline Pass 时，
`anthropic/claude-*` 这类计费模型在前者成功、在后者返回 `insufficient_credits`。网关对此做了两件事：

1. **计费类失败会转移**：上游返回 402（或错误体含 `insufficient_credits`）时，不把错误抛给客户端，
   而是换下一个账号重试，全部失败才回报。
2. **按「账号 + 模型」冷却 90 秒**：失败过的组合排到候选队列末尾，后续同类请求直接走能付钱的账号，
   不会每次都在坏账号上白撞一次。

### 混合账号池的失败转移规则（重要）

账号池里各账号能力不同，所以「上游报错」要分两类看：

| 类别 | 例子 | 处理 |
|---|---|---|
| **账号级**（换号可能成功） | `insufficient_credits`（没 Credits）、`INFERENCE_CAP_ERROR`、`Daily free limit reached` | 记入「账号+模型」冷却 90 秒，**自动换下一个账号重试** |
| 请求级 / 供应商级 | 参数错误、共享池 429、上游 5xx | 直接返回，不换号（换号只是白等） |

关键点：**免费桶的日限是按账号算的**。同一个免费模型如果池里每个账号当天都用过，轮询也救不了 ——
这时要么等日限重置（错误里会带 `Try again in Xh`），要么改用 `cline-pass/*` 订阅版。

### 上下文长度与 `max_tokens`

上游目录（`/api/v1/models`、`recommended-models`）**不发布上下文长度**，new-api 的定价数据里也没有这些模型。实测（`cline-pass/kimi-k3`，用重复填充文本逐档加压，读返回里的 `prompt_tokens` 为准）：

| 输入规模 | 结果 |
|---|---|
| 4,538 tok | OK |
| 22,316 tok | OK |
| 66,760 tok | OK |
| 133,428 tok | OK |
| 266,762 tok | OK |
| **444,541 tok** | **OK** |

即**至少 44 万 tokens 的输入可以正常处理**（读返回里的 `prompt_tokens` 为准），实际窗口大概率是 512k 或 1M。上游两个目录都不发布这个数字，所以只能实测；继续往上加压每次都要吃掉可观的订阅额度，就没再往上探了。

**注意网关的上游超时**：`REQUEST_TIMEOUT_MS` 默认 30 秒，几万 tokens 的请求可能超过它而被中断（表现为连接被直接关闭，没有错误体）。需要长上下文时把它调大，例如 `REQUEST_TIMEOUT_MS=180000`。

### new-api 接入配置（本机现网）

两个渠道都指向本网关，各自暴露不同的模型集合：

| 渠道 | 名称 | 类型 | 分组 | 模型 |
|---|---|---|---|---|
| 54 | `cline2api` | 高级自定义 (58) | `vip` | 22 个真名（16 × `cline-pass/*` + 6 × 免费桶原名） |
| 55 | `cline2api_free` | 高级自定义 (58) | `vip,default` | 6 个短别名，靠 `model_mapping` 映射到免费桶真名 |

两种渠道类型都试过，结论是**高级自定义 (58) 才是对的**，因为它能用 `advanced_routes` 显式声明三种协议：

```json
{"advanced_custom": {"advanced_routes": [
  {"incoming_path": "/v1/chat/completions", "upstream_path": "/v1/chat/completions", "converter": "none",
   "auth": {"type": "header", "name": "Authorization", "value": "Bearer {api_key}"}},
  {"incoming_path": "/v1/responses", "upstream_path": "/v1/chat/completions",
   "converter": "openai_responses_to_openai_chat_completions", "auth": {"...": "同上"}},
  {"incoming_path": "/v1/messages", "upstream_path": "/v1/messages", "converter": "none", "auth": {"...": "同上"}},
  {"incoming_path": "/v1/models", "upstream_path": "/v1/models", "converter": "none", "auth": {"...": "同上"}}
]}}
```

要点：

- 少了 `/v1/models` 这条路由，「获取模型列表」按钮会报 `advanced custom channel does not configure a /v1/models route`。
- 少了 `/v1/messages` 这条路由，Claude Code / Anthropic SDK 走不通。
- `/v1/responses` 用 `openai_responses_to_openai_chat_completions` 转换器，让 new-api 把 Responses 请求降级成 chat completions 打到本网关（本网关原生只讲 chat + messages）。
- 路由里的 `auth` 必须显式写 `Bearer {api_key}`，否则 new-api 不一定带上渠道密钥。
- 配好后 `GET /v1/models` 会给这些模型标注 `supported_endpoint_types: ["openai","openai-response","anthropic"]`（有 1 分钟定价缓存，改完稍等再刷）。
- **别把渠道类型从「高级自定义」改回「OpenAI 兼容」**：换了类型 `advanced_routes` 直接失效，`/v1/responses` 会 404 `Unknown route`。
- 渠道「测试」按钮固定发 `max_tokens: 16`，对推理型模型会返回空内容而判失败 —— 把渠道的「测试模型」设成 `cline-pass/minimax-m3` / `solar-pro4` 这类不吃预算的模型即可（见排障表）。

### 反向代理部署

网关本身只监听本机端口（默认 `127.0.0.1:8787`）。放到公网时，建议用 Caddy / Nginx 之类的反向代理做 TLS 终止。

Caddy 示例：

```caddy
your-gateway.example.com {
	@stream path /v1/* /admin/api/chat
	handle @stream {
		reverse_proxy 127.0.0.1:8787 {
			flush_interval -1     # SSE 必须写入即 flush
		}
	}
	handle {
		encode gzip zstd
		reverse_proxy 127.0.0.1:8787
	}
}
```

Nginx 示例见本仓库 `nginx/cline2api.conf`。

要点：

- `flush_interval -1`（Nginx 对应 `proxy_buffering off;` + `proxy_set_header X-Accel-Buffering no;`）是流式的关键：不关掉写入缓冲，打字机效果会消失、长响应可能被缓冲到超时。
- 流式路径不要进 gzip/zstd，避免压缩干扰分块传输。
- 上游 CDN / WAF 若对空闲连接有超时（例如 100 秒无数据即断开），正常持续输出的 SSE 不受影响，但长时间静默的请求可能被切断。
- **暴露到公网前必须设置 `PROXY_API_KEY` 和 `ADMIN_TOKEN`**；否则管理接口在未设 `ADMIN_TOKEN` 时虽只放行 loopback，但一旦反代把来源地址改写成 `127.0.0.1`（例如没正确传 `X-Forwarded-For`），保护就会失效。请确认反代把真实客户端地址透传并在网关侧正确识别。
