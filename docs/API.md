# Cline2API 接口文档

> 网关源码：仓库 `cline2api/` 子目录，具体为 `cline2api/src/...`（TypeScript + Hono）。  
> 注册机源码：仓库 `cline-register/`。  
> 上游：`https://api.cline.bot`；登录授权：WorkOS。  
> 本文档以当前源码为准。字段、状态码、默认值和路由若与 README 不一致，以本文末尾“源码核对差异”以及实际代码为准。

## 目录

- [1. 概览](#1-概览)
- [2. 快速开始](#2-快速开始)
- [3. 鉴权](#3-鉴权)
- [4. OpenAI 兼容 API](#4-openai-兼容-api)
  - [4.1 GET /v1/models](#41-get-v1models)
  - [4.2 POST /v1/chat/completions](#42-post-v1chatcompletions)
- [5. Anthropic Messages API](#5-anthropic-messages-api)
  - [5.1 POST /v1/messages](#51-post-v1messages)
  - [5.2 Claude Code 接入](#52-claude-code-接入)
  - [5.3 OpenAI 与 Anthropic 消息转换](#53-openai-与-anthropic-消息转换)
- [6. 管理台 API](#6-管理台-api)
- [7. 登录与账号生命周期](#7-登录与账号生命周期)
- [8. 模型与计费](#8-模型与计费)
- [9. 错误码参考](#9-错误码参考)
- [10. 环境变量完整表](#10-环境变量完整表)
- [11. 部署注意](#11-部署注意)
- [12. 源码核对差异](#12-源码核对差异)

---

## 1. 概览

Cline2API 是一个自托管反代网关：客户端只访问本网关，网关使用池中的 Cline 账号凭证访问 `https://api.cline.bot`，把上游能力暴露为两套兼容 API：

1. **OpenAI 兼容 API**：给 Cursor、NextChat、OpenAI SDK 以及其他 OpenAI Chat Completions 客户端使用。
2. **Anthropic Messages API**：给 Claude Code、Anthropic SDK 或其他 Anthropic Messages 客户端使用。

网关不创建 Cline 账户，也不替用户完成浏览器确认。管理员可以发起默认的 WorkOS 设备码登录，也可以显式选择 localhost 回调登录；用户在浏览器确认后，网关换得 Cline 凭证并保存到 `$DATA_DIR/accounts.json`。独立注册机还可以通过 `POST /admin/api/accounts/import` 批量推送已生成的凭据。客户端永远只看到 `PROXY_API_KEY`，看不到上游 access token / refresh token。

### 1.1 架构

```text
+-------------------+        +----------------------+        +----------------------+
| OpenAI SDK        |        | Anthropic SDK        |        | 管理台 / 管理脚本    |
| Cursor/NextChat   |        | Claude Code          |        | curl / 自动化        |
+---------+---------+        +----------+-----------+        +----------+-----------+
          |                             |                               |
          | Authorization: Bearer       | x-api-key: <PROXY_KEY>        | Bearer ADMIN_TOKEN
          | <PROXY_API_KEY>             | 或 Authorization: Bearer      | 或 ?token=<ADMIN_TOKEN>
          v                             v                               v
+------------------------------------------------------------------------------------------+
|                              Cline2API (Hono, 默认 127.0.0.1:8787)                      |
|                                                                                          |
|  /v1/models                         OpenAI 模型目录（实时上游目录）                         |
|  /v1/chat/completions               OpenAI Chat Completions 透传 + 账号池故障转移         |
|  /v1/messages                       Anthropic <-> OpenAI 请求/响应/SSE 双向转换            |
|  /admin/api/*                       登录编排、账号、模型分桶、订阅、用量、请求日志、试聊    |
|  /healthz                           存活检查                                              |
|                                                                                          |
|  AccountPool  ->  轮询 + 故障转移                                                         |
|  TokenManager ->  提前续期、单飞刷新、Refresh Token 轮换落盘、401 自动强刷重放            |
|  AccountStore ->  $DATA_DIR/accounts.json（原子写，0600）                                |
|  LoginService ->  device 或 callback（callback 仅 127.0.0.1:48801-48811）                 |
+-----------------------------+------------------------------------+-----------------------+
                              |                                    |
                              | Authorization: Bearer workos:<token> |
                              v                                    v
                 +--------------------------+          +-----------------------------+
                 | api.cline.bot            |          | api.workos.com               |
                 | /api/v1/chat/completions |          | /user_management/...         |
                 | /api/v1/models            |          | 设备码 / callback authorize |
                 | 登录注册与刷新 API         |          +-----------------------------+
                 +--------------------------+
```

### 1.2 两套 API 的区别

| 项目 | OpenAI 兼容 API | Anthropic Messages API |
|---|---|---|
| 典型客户端 | Cursor、NextChat、OpenAI SDK | Claude Code、Anthropic SDK |
| 模型列表 | `GET /v1/models` | 使用同一份模型 ID，通常由客户端配置或读取 OpenAI 目录 |
| 对话接口 | `POST /v1/chat/completions` | `POST /v1/messages` |
| 客户端鉴权头 | `Authorization: Bearer <PROXY_API_KEY>` | `x-api-key: <PROXY_API_KEY>`（也兼容 Bearer） |
| Base URL | `http://<host>:8787/v1` | `http://<host>:8787`，不要带 `/v1`，客户端会自行拼 `/v1/messages` |
| 请求体 | OpenAI Chat Completions 形状 | Anthropic Messages 形状，网关转换为 OpenAI 后调用上游 |
| 流式格式 | 原生 OpenAI SSE：`data: {...}`、`data: [DONE]` | Anthropic SSE：`message_start`、`content_block_delta`、`message_stop` 等 |
| 工具调用 | `tool_calls` | `tool_use` / `tool_result` |

### 1.3 路由总览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/healthz` | 无 | 存活检查，返回 `{"ok":true}` |
| `GET` | `/` | 管理台鉴权 | 管理台 HTML |
| `GET` | `/v1/models` | 客户端 API Key | OpenAI 模型列表 |
| `POST` | `/v1/chat/completions` | 客户端 API Key | OpenAI Chat Completions |
| `POST` | `/v1/messages` | 客户端 API Key | Anthropic Messages |
| `GET` | `/admin/api/status` | 管理令牌 | 网关状态 |
| `GET` | `/admin/api/accounts` | 管理令牌 | 账号列表 |
| `DELETE` | `/admin/api/accounts/:id` | 管理令牌 | 删除账号 |
| `POST` | `/admin/api/accounts/import` | 管理令牌 | 批量导入注册机账号凭据 |
| `GET` | `/admin/api/login/modes` | 管理令牌 | 查询可用登录模式 |
| `POST` | `/admin/api/login/start` | 管理令牌 | 启动 device 或 callback 登录 |
| `GET` | `/admin/api/login/:id` | 管理令牌 | 查询登录会话 |
| `POST` | `/admin/api/login/:id/cancel` | 管理令牌 | 取消登录会话 |
| `GET` | `/admin/api/models` | 管理令牌 | 模型目录与 `bucket` 分桶 |
| `GET` | `/admin/api/subscription` | 管理令牌 | 首个可用账号的订阅状态 |
| `GET` | `/admin/api/usage` | 管理令牌 | 每个账号的套餐与用量窗口 |
| `GET` | `/admin/api/requests` | 管理令牌 | 最近请求日志 |
| `POST` | `/admin/api/chat` | 管理令牌 | 管理台试聊，与 OpenAI 对话链路相同 |

---

## 2. 快速开始

### 2.1 运行环境

- Node.js `>= 20.11`（`package.json` 的 `engines`）。
- 默认监听地址：`HOST=127.0.0.1`。
- 默认端口：`PORT=8787`。
- 默认数据目录：`./data`。

### 2.2 安装与启动

在 `cline2api/` 目录执行：

```bash
npm install
cp .env.example .env
npm run dev
```

生产式运行：

```bash
npm run build
npm run serve
```

其他脚本：

```bash
npm run start       # 直接用 tsx 运行 src/index.ts
npm run typecheck   # TypeScript 类型检查
npm test            # 运行测试
npm run login       # 终端设备码登录
npm run accounts    # 查看已保存账号（不显示令牌）
```

### 2.3 配置 `.env`

最小配置示例：

```dotenv
HOST=127.0.0.1
PORT=8787
DATA_DIR=./data
PROXY_API_KEY=sk-your-client-key
ADMIN_TOKEN=replace-with-a-long-random-token
```

`PROXY_API_KEY` 支持逗号分隔多个 key：

```dotenv
PROXY_API_KEY=sk-key-for-cursor,sk-key-for-nextchat
```

如果未设置 `PROXY_API_KEY`，网关首次启动时会生成一个 key，并保存到：

```text
$DATA_DIR/proxy-api-key.txt
```

文件权限按 `0600` 创建，日志不会打印生成出来的 key。查看方式：

```bash
cat data/proxy-api-key.txt
```

### 2.4 第一条请求

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cline-pass/minimax-m3",
    "messages": [
      {"role": "user", "content": "你好，请用一句话介绍你自己。"}
    ],
    "stream": false
  }'
```

健康检查不需要鉴权：

```bash
curl http://127.0.0.1:8787/healthz
```

成功响应：

```json
{"ok":true}
```

### 2.5 登录账号

管理台登录接口支持两种模式：

- 默认 `device`：不需要任何入向端口，适合 Docker 和远程服务器。
- 可选 `callback`：需要浏览器访问网关所在机器的 `127.0.0.1:48801-48811`，适合本机或已配置 SSH/端口转发的环境。

```bash
# 查询模式
curl http://127.0.0.1:8787/admin/api/login/modes \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 启动默认设备码
curl -X POST http://127.0.0.1:8787/admin/api/login/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"device"}'

# 启动 localhost 回调
curl -X POST http://127.0.0.1:8787/admin/api/login/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"callback"}'
```

---

## 3. 鉴权

网关有三类凭证，职责不同：

### 3.1 客户端调用 `/v1/*`

使用 `PROXY_API_KEY` 或其逗号分隔列表中的任意一个 key。支持两种请求头：

| 请求头 | 适用客户端 | 格式 |
|---|---|---|
| `Authorization` | OpenAI SDK、curl、大部分 OpenAI 兼容客户端 | `Authorization: Bearer <PROXY_API_KEY>` |
| `x-api-key` | Anthropic 原生客户端、Claude Code、Anthropic SDK | `x-api-key: <PROXY_API_KEY>` |

两种头同时存在时，`Authorization: Bearer` 优先。缺失或不匹配时，`/v1/*` 返回：

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "error": {
    "message": "Missing or invalid API key.",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

缺失 key、错误的 Bearer key、错误的 `x-api-key` 都返回同一个 401 响应体。当前 `createApp()` 还为整个 `/v1/*` 命名空间注册了前置中间件，因此即使请求的是未知 `/v1/...` 路径，只要没有通过客户端 key 校验，也会先返回上面的 401，而不是 404。

### 3.2 管理台与管理 API

使用 `ADMIN_TOKEN`。支持：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

或：

```text
?token=<ADMIN_TOKEN>
```

管理 API 鉴权失败返回：

```json
{"error":"unauthorized"}
```

状态码为 `401`。管理台首页 `/` 在非 loopback 且校验失败时返回纯文本：

```text
Admin UI is not exposed here. Set ADMIN_TOKEN or use localhost.
```

状态码为 `403`。

**安全警告：未设置 `ADMIN_TOKEN` 时，管理台和管理 API 仅允许 loopback 访问。源码接受 `127.0.0.1`、任意 `127.*`、`::1`、`::ffff:127.0.0.1`，并在 remoteAddress 缺失时按本地处理；当存在 `X-Forwarded-For` 时，只有 TCP peer 和最右侧 XFF 都是 loopback 才放行。非 loopback peer 不能靠伪造 XFF 获得管理权限。只要服务暴露到公网、容器端口映射到外部或经过不受信代理，就必须设置强随机 `ADMIN_TOKEN`。**

### 3.3 上游凭证

WorkOS access token、refresh token、过期时间和 Cline 账号信息保存在：

```text
$DATA_DIR/accounts.json
```

文件权限为 `0600`，通过临时文件、`fsync`、原子 rename 持久化。网关每账号执行：

- 到期前默认 5 分钟续期；
- 单飞刷新，避免并发刷新导致 WorkOS refresh token 轮换互相失效；
- 保存轮换后的 refresh token；
- 上游返回 `401` / `403` 时强制刷新一次并重放；
- refresh token 被判定为无效时，将该账号标记为 disabled，并记录 `invalid_grant: re-login required`。

客户端请求中不需要、也不应该携带任何 WorkOS/Cline token。

---

## 4. OpenAI 兼容 API

OpenAI Base URL：

```text
http://127.0.0.1:8787/v1
```

下文所有 `/v1/*` 接口都接受：

- `Authorization: Bearer <PROXY_API_KEY>`
- `x-api-key: <PROXY_API_KEY>`

建议使用 `Content-Type: application/json`。鉴权失败统一为 401 + OpenAI 风格错误体。

### 4.1 `GET /v1/models`

返回网关实时合并后的模型目录，数据来自：

- `GET https://api.cline.bot/api/v1/models`
- `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` 的 `free` 与 `clinePass` 桶

#### 请求

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/v1/models` |
| 鉴权 | `Authorization: Bearer <PROXY_API_KEY>` 或 `x-api-key: <PROXY_API_KEY>` |
| 请求体 | 无 |
| Content-Type | 无请求体，可不设置 |

#### curl

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

#### 成功响应

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "cline-pass/kimi-k3",
      "object": "model",
      "created": 0,
      "owned_by": "cline-pass"
    },
    {
      "id": "anthropic/claude-sonnet-4.6",
      "object": "model",
      "created": 0,
      "owned_by": "anthropic"
    }
  ]
}
```

响应字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `object` | string | 固定为 `list` |
| `data` | array | 模型列表 |
| `data[].id` | string | 调用 Chat Completions 时使用的模型 ID |
| `data[].object` | string | 通常为 `model` |
| `data[].created` | number | 来自上游目录，缺失时为 `0` |
| `data[].owned_by` | string | 来自上游目录，缺失时为 `cline` |

**注意：当前实现的 `/v1/models` 会主动移除内部 `bucket` 字段，保持纯 OpenAI shape。** 计费桶只在 `GET /admin/api/models` 返回。

#### 典型错误

```bash
curl -i http://127.0.0.1:8787/v1/models
```

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "error": {
    "message": "Missing or invalid API key.",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

模型目录上游不可用时，网关会先使用进程内缓存；如果没有任何缓存，则返回内置 fallback 列表。此路径不会因为上游目录临时失败而直接向客户端返回 5xx。

---

### 4.2 `POST /v1/chat/completions`

OpenAI Chat Completions 兼容入口。网关强制使用账号池中的 Cline 凭证访问上游 `POST /api/v1/chat/completions`。

#### 请求

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/v1/chat/completions` |
| 鉴权 | `Authorization: Bearer <PROXY_API_KEY>` 或 `x-api-key: <PROXY_API_KEY>` |
| 必需请求头 | `Content-Type: application/json` |
| 成功响应头 | `x-account`: 实际服务请求的账号内部 ID |

#### 请求体字段

网关本地只强制校验 `model` 和 `messages`。其余字段通过对象展开原样转发给上游，因此是否支持、支持到什么程度由 `api.cline.bot` 决定；网关不做本地 schema 校验。

| 字段 | 类型 | 必填 | 网关行为 |
|---|---|---|---|
| `model` | string | 是 | 必须是非空字符串；否则 400 `missing_model` |
| `messages` | array | 是 | 必须是数组；否则 400 `invalid_messages` |
| `stream` | boolean | 否 | 仅当严格等于 `true` 时走流式响应 |
| `stream_options` | object | 否 | 流式时默认为 `{"include_usage":true}`；调用方提供的键会覆盖默认值 |
| `tools` | array | 否 | 原样透传，上游决定支持情况 |
| `tool_choice` | string/object | 否 | 原样透传 |
| `temperature` | number | 否 | 原样透传 |
| `top_p` | number | 否 | 原样透传 |
| `max_tokens` | number | 否 | 原样透传 |
| `max_completion_tokens` | number | 否 | 原样透传 |
| `stop` | string/array | 否 | 原样透传 |
| `n` | number | 否 | 原样透传 |
| `presence_penalty` | number | 否 | 原样透传 |
| `frequency_penalty` | number | 否 | 原样透传 |
| `response_format` | object | 否 | 原样透传 |
| `seed` | number | 否 | 原样透传 |
| 其他字段 | any | 否 | 因使用对象展开，会原样转发；不要依赖网关提供本地校验 |

#### 消息清洗行为

在转发前，网关会运行 `sanitizeOpenAIMessages`：

- 空字符串、空数组或 `null` 内容会被替换，避免上游以“content must not be empty”拒绝。
- `tool` 角色空内容替换为 `(tool returned no text output)`。
- 普通空消息替换为 `(empty content)`。
- 带 `tool_calls` 的 assistant 消息若没有正文，则 `content` 保持 `null`。
- 若 assistant 的某个 `tool_call_id` 没有对应 tool 回复，网关会补一条 `(no tool output returned)`。
- 若 tool 回复与原 assistant 消息不相邻，网关会把回复移动到对应 assistant 消息后面。

这些处理是为了兼容工具调用客户端和 OpenClaude/Claude Code 类工作流。

#### 非流式 curl

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cline-pass/minimax-m3",
    "messages": [
      {"role": "system", "content": "你是一个简洁的助手。"},
      {"role": "user", "content": "用三点说明什么是 SSE。"}
    ],
    "temperature": 0.7,
    "stream": false
  }'
```

#### 非流式成功响应

上游是 OpenAI Chat Completions 形状或 `{success:true,data:...}`；后者会被网关拆掉外层 envelope。典型成功响应：

```http
HTTP/1.1 200 OK
Content-Type: application/json
x-account: 6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801
```

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "cline-pass/minimax-m3",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "SSE 是一种基于 HTTP 的单向流式传输格式……"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 80,
    "total_tokens": 105
  }
}
```

> 上游返回的其他字段会尽量保持；上面的 `id`、`created`、token 数是字段形状示例，不是固定值。

#### 流式 curl

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cline-pass/minimax-m3",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

网关对 OpenAI 流采取透传。响应头：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
x-account: 6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801
```

真实分片形状：

```text
data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}

data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}

data: [DONE]

```

注意：

- 每个 SSE 数据块之间有空行。
- 最后是字面量 `data: [DONE]`。
- `stream_options.include_usage` 默认为 `true`，因此通常会有 usage 分片；调用方显式传入 `stream_options` 可覆盖该默认。
- 客户端断开时，网关会把连接的 `AbortSignal` 传给上游。

#### 多账号轮询、故障转移与 401 重放

网关对每个请求按以下顺序处理：

1. `AccountPool` 以 round-robin 方式生成候选账号列表。
2. 每个账号先尝试正常取 token；若上游返回 `401` 或 `403`，第二个 attempt 使用 `forceRefresh: true` 强制刷新一次并重放。
3. 若仍失败，换下一个账号。
4. 若错误属于账号级计费/额度错误，则将该账号与当前模型的组合加入 90 秒冷却，然后换账号：
   - `402` 且文本匹配 `insufficient_credits`、`insufficient balance`、`credit balance`；
   - `400` 且文本匹配 `INFERENCE_CAP_ERROR`、`daily free limit`、`free limit reached`；
   - `429` 且文本匹配配额关键词。
5. 所有账号都失败后，返回 `502` + `all_accounts_failed`。

若没有任何可用账号，返回 `503` + `no_accounts`。

#### 典型错误响应

缺少模型：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "message": "`model` is required.",
    "type": "invalid_request_error",
    "code": "missing_model"
  }
}
```

没有账号或全部账号需要重新登录：

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
```

```json
{
  "error": {
    "message": "No Cline account is registered or all accounts need re-login. Open the admin UI and sign in.",
    "type": "server_error",
    "code": "no_accounts"
  }
}
```

所有注册账号都失败：

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json
```

```json
{
  "error": {
    "message": "All registered Cline accounts failed: ...",
    "type": "upstream_error",
    "code": "all_accounts_failed"
  }
}
```

---

## 5. Anthropic Messages API

Anthropic Base URL：

```text
http://127.0.0.1:8787
```

**不要给 `ANTHROPIC_BASE_URL` 加 `/v1` 后缀。** Anthropic 客户端、Claude Code 会自己拼接 `/v1/messages`。

### 5.1 `POST /v1/messages`

#### 请求

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/v1/messages` |
| 鉴权 | 优先 `Authorization: Bearer <PROXY_API_KEY>`，也支持 `x-api-key: <PROXY_API_KEY>` |
| 内容类型 | `Content-Type: application/json` |
| 成功响应头 | `x-account`: 实际服务请求的账号内部 ID |
| 流式响应头 | 与 OpenAI SSE 相同，包含 `X-Accel-Buffering: no` |

`anthropic-version` 是 Anthropic 官方客户端常见的协议版本头，但当前网关不读取、不校验、也不转发该头。Claude Code 仍可正常发送它；网关的兼容性不依赖该头。若客户端或反向代理要求该头，按客户端默认值发送即可。

#### 请求体字段

| 字段 | 类型 | 必填 | 网关转换行为 |
|---|---|---|---|
| `model` | string | 是 | 转为 OpenAI `model`；必须是非空字符串 |
| `messages` | array | 是 | 必须是数组；逐条转换为 OpenAI messages |
| `max_tokens` | number | 否 | 转为 OpenAI `max_tokens`；不传时网关默认 `8192` |
| `system` | string 或 text block 数组 | 否 | 转为 OpenAI `system` message；数组只取 `text` block |
| `stream` | boolean | 否 | 严格等于 `true` 时输出 Anthropic SSE |
| `temperature` | number | 否 | 有值时转成 OpenAI `temperature` |
| `top_p` | number | 否 | 有值时转成 OpenAI `top_p` |
| `stop_sequences` | string[] | 否 | 非空数组转为 OpenAI `stop` |
| `tools` | AnthropicTool[] | 否 | 转为 OpenAI `tools[].function` |
| `tool_choice` | object | 否 | `auto` -> `auto`；`any` -> `required`；`none` -> `none`；`tool` + `name` -> OpenAI function 选择 |
| 其他字段 | any | 否 | **不会自动透传**；当前转换器只显式处理上表字段 |

`messages[].content` 既可以是字符串，也可以是 content block 数组：

| block 类型 | 支持情况 |
|---|---|
| `text` | 转为 OpenAI text part 或普通文本 |
| `image`，source 为 base64 | 转为 `image_url` data URL |
| `image`，source 为 url | 转为 `image_url` URL |
| `tool_use` | 转为 OpenAI assistant `tool_calls` |
| `tool_result` | 转为 OpenAI `role:"tool"` + `tool_call_id` |
| 未知 block | 忽略 |

`tool_result.content` 支持字符串或 text/image block 数组；当前转换到 OpenAI 时只拼接其中的 text，`is_error` 且没有文本时使用 `(tool error)` 占位。

#### 非流式 curl

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cline-pass/minimax-m3",
    "max_tokens": 1024,
    "system": "You are a concise assistant.",
    "messages": [
      {"role": "user", "content": "Please introduce Anthropic Messages API in one sentence."}
    ],
    "stream": false
  }'
```

#### 非流式成功响应

```http
HTTP/1.1 200 OK
Content-Type: application/json
x-account: 6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801
```

```json
{
  "id": "msg_0123456789abcdef01234567",
  "type": "message",
  "role": "assistant",
  "model": "cline-pass/minimax-m3",
  "content": [
    {
      "type": "text",
      "text": "Anthropic Messages API 是一个面向对话、系统提示、工具调用和流式事件的结构化消息接口。"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 31,
    "output_tokens": 42
  }
}
```

响应字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 优先使用上游 completion ID；缺失时生成 `msg_<24位>` |
| `type` | string | 固定为 `message` |
| `role` | string | 固定为 `assistant` |
| `model` | string | 上游返回的模型，缺失时使用请求 model |
| `content` | array | `thinking`、`text`、`tool_use` blocks |
| `stop_reason` | string | `length` -> `max_tokens`；`tool_calls` 或 `function_call` -> `tool_use`；`content_filter` -> `stop_sequence`；其余 -> `end_turn` |
| `stop_sequence` | null | 当前实现固定返回 `null` |
| `usage.input_tokens` | number | 映射上游 `prompt_tokens`，缺失为 0 |
| `usage.output_tokens` | number | 映射上游 `completion_tokens`，缺失为 0 |

当上游响应包含 `reasoning_content` 时，非流式响应会在正文前增加：

```json
{"type":"thinking","thinking":"..."}
```

### 流式请求

```bash
curl -N http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cline-pass/minimax-m3",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Say hello in two chunks."}],
    "stream": true
  }'
```

流式响应由网关把上游 OpenAI SSE 转成 Anthropic SSE。事件顺序：

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","type":"message","role":"assistant","model":"...","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}

```

支持的事件与 block：

| 事件/block | 说明 |
|---|---|
| `message_start` | 一个流最多一次，在第一个有效 chunk 前发出 |
| `content_block_start` | text、thinking 或 tool_use block 开始 |
| `content_block_delta` | `text_delta`、`thinking_delta`、`input_json_delta` |
| `content_block_stop` | 当前 block 关闭 |
| `message_delta` | 携带最终 `stop_reason` 与 usage |
| `message_stop` | 流结束 |
| `error` | 转换过程中发生异常时，事件名为 `error`，data 为 `{"type":"error","error":{"type":"api_error","message":"..."}}` |

当前实现不会合成 Anthropic `ping` 事件。

### 5.2 Claude Code 接入

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=$PROXY_API_KEY
```

注意：

- `ANTHROPIC_BASE_URL` 不要带 `/v1`。
- Claude Code 会自行请求 `${ANTHROPIC_BASE_URL}/v1/messages`。
- 如果客户端只支持 `ANTHROPIC_API_KEY`，也可以使用同一个 `PROXY_API_KEY`。
- 远端部署时把示例地址换成实际 HTTPS 域名，例如 `https://cline.example.com`。

远端示例：

```bash
export ANTHROPIC_BASE_URL=https://your-gateway.example.com
export ANTHROPIC_AUTH_TOKEN=$PROXY_API_KEY
```

### 5.3 OpenAI 与 Anthropic 消息转换

#### 请求方向：Anthropic -> OpenAI

| Anthropic | OpenAI | 说明 |
|---|---|---|
| `system` | `messages[0].role=system` | 非空 system 放在最前面 |
| `messages[].role=user/assistant` | 同名 OpenAI role | 保持角色 |
| `text` block | text part 或字符串 | 单一 text part 可压成字符串 |
| `image` block | `image_url` part | base64 或 URL |
| assistant `tool_use` | assistant `tool_calls` | `input` 通过 `JSON.stringify` 写入 `function.arguments` |
| user `tool_result` | `role:"tool"` | `tool_use_id` -> `tool_call_id` |
| `tools[]` | OpenAI `tools[].function` | `input_schema` -> `parameters` |
| `tool_choice.any` | `tool_choice:"required"` | 其他选择按代码映射 |
| `stop_sequences` | `stop` | 仅非空数组 |
| `max_tokens` 缺失 | `max_tokens:8192` | 网关默认值 |

#### 响应方向：OpenAI -> Anthropic

| OpenAI | Anthropic | 说明 |
|---|---|---|
| `choices[0].message.reasoning_content` | `thinking` block | 保留推理内容 |
| `choices[0].message.content` | `text` block | 空字符串不产生 block |
| `tool_calls[]` | `tool_use` blocks | arguments 会尝试 JSON.parse，失败则 input 为 `{}` |
| `finish_reason` | `stop_reason` | 见映射表 |
| `usage.prompt_tokens` | `usage.input_tokens` | 缺失为 0 |
| `usage.completion_tokens` | `usage.output_tokens` | 缺失为 0 |

#### 流式方向

- OpenAI `delta.content` -> Anthropic `content_block_delta` / `text_delta`。
- OpenAI `delta.reasoning_content` -> Anthropic `thinking` block + `thinking_delta`。
- OpenAI `delta.tool_calls` -> Anthropic `tool_use` + `input_json_delta`。
- OpenAI `finish_reason` -> Anthropic `message_delta.stop_reason`。
- OpenAI usage -> Anthropic `message_delta.usage`。
- 网关只解析以 `data:` 开头的行，遇到 `data: [DONE]` 结束。

#### 典型错误

鉴权失败、非法 JSON、缺少 model、messages 不是数组时的 HTTP 状态与 OpenAI 路径一致：`401`、`400`。上游非 JSON 非流式响应会返回：

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json
```

```json
{
  "error": {
    "message": "Upstream returned a non-JSON response: ...",
    "type": "upstream_error"
  }
}
```

---

## 6. 管理台 API

管理台首页和管理 API 都使用 `ADMIN_TOKEN`。所有 `/admin/api/*` 请求都支持：

```http
Authorization: Bearer $ADMIN_TOKEN
```

或：

```text
?token=$ADMIN_TOKEN
```

如果未设置 `ADMIN_TOKEN`，仅 loopback 可访问。当前 loopback 判断为：

- TCP peer 是 `127.0.0.1`、任意 `127.*`、`::1` 或 `::ffff:127.0.0.1`；源码会把 `::ffff:127.0.0.1` 归一化为 `127.0.0.1`。
- 如果请求带有 `X-Forwarded-For`，只有 TCP peer 和 XFF 最右侧一跳都是 loopback 才算本机；非 loopback peer 即使伪造 XFF 也不会被信任。
- 未设置 `ADMIN_TOKEN` 且请求不满足 loopback 时，管理 API 返回 401，管理台首页返回 403。

管理 API 鉴权失败统一返回：

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{"error":"unauthorized"}
```

管理台首页 `/` 未授权时返回：

```http
HTTP/1.1 403 Forbidden
Content-Type: text/plain; charset=utf-8

Admin UI is not exposed here. Set ADMIN_TOKEN or use localhost.
```

管理台不提供 OpenAPI 文件；以下是当前源码中的完整路由契约。

### 6.1 `GET /`：管理台 HTML

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/` |
| 鉴权 | `Authorization: Bearer <ADMIN_TOKEN>` 或 `?token=<ADMIN_TOKEN>`；未设置 token 时仅 loopback |
| 请求体 | 无 |
| 成功响应 | `text/html`，管理台页面 |
| 失败响应 | 非授权访问时 `403 text/plain` |

```bash
curl -L "http://127.0.0.1:8787/?token=$ADMIN_TOKEN" -o admin.html
```

成功响应：

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
```

```html
<!doctype html>
<html lang="zh-CN">
  ...
</html>
```

失败响应：

```http
HTTP/1.1 403 Forbidden
Content-Type: text/plain; charset=utf-8

Admin UI is not exposed here. Set ADMIN_TOKEN or use localhost.
```

### 6.2 `GET /healthz`：存活检查

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/healthz` |
| 鉴权 | 无 |
| 请求体 | 无 |
| 成功响应 | `200` JSON |
| 失败响应 | 正常服务不会返回业务错误；反向代理/容器层可能返回 `502`、`504` |

```bash
curl http://127.0.0.1:8787/healthz
```

```json
{"ok":true}
```

### 6.3 `GET /admin/api/status`：运行状态

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/status` |
| 鉴权 | 管理令牌 |
| 请求头 | `Authorization: Bearer <ADMIN_TOKEN>`，或使用 `?token=` |
| 请求体 | 无 |

```bash
curl http://127.0.0.1:8787/admin/api/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

成功响应字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `upstream` | string | 配置的 Cline API base URL |
| `workos` | string | 配置的 WorkOS API base URL |
| `accounts.total` | number | store 中的账号总数 |
| `accounts.active` | number | `disabled=false` 的账号数 |
| `accounts.disabled` | number | `disabled=true` 的账号数 |
| `models.count` | number | 当前目录模型数量 |
| `loginModes` | string[] | 当前支持的登录模式，固定为 `["device","callback"]` |
| `refreshBufferMs` | number | 提前刷新窗口，默认 `300000` |

```json
{
  "upstream": "https://api.cline.bot",
  "workos": "https://api.workos.com",
  "accounts": {"total": 2, "active": 1, "disabled": 1},
  "models": {"count": 444},
  "loginModes": ["device", "callback"],
  "refreshBufferMs": 300000
}
```

可能错误：`401 {"error":"unauthorized"}`。上游目录暂时不可用时，`models.count` 可能来自缓存或 fallback，不因此返回 5xx。

### 6.4 `GET /admin/api/accounts`：账号列表

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/accounts` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |

```bash
curl http://127.0.0.1:8787/admin/api/accounts \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

成功响应中每项字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 网关内部账号 ID |
| `email` | string/null | Cline 注册邮箱 |
| `label` | string/null | 标签；登录流程通常为 null，导入可设置 |
| `provider` | string | 设备码登录通常为 `cline`；回调登录为 `MicrosoftOAuth`；导入可自定义 |
| `disabled` | boolean | 是否需要重新登录 |
| `lastError` | string/null | 最近错误，例如 `invalid_grant: re-login required` |
| `expiresAt` | number | access token 到期时间（epoch ms） |
| `createdAt` | number | 记录创建时间（epoch ms） |
| `updatedAt` | number | 记录更新时间（epoch ms） |

```json
{
  "accounts": [
    {
      "id": "6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801",
      "email": "user@example.com",
      "label": null,
      "provider": "cline",
      "disabled": false,
      "lastError": null,
      "expiresAt": 1760000000000,
      "createdAt": 1759900000000,
      "updatedAt": 1759999000000
    }
  ]
}
```

接口不会返回 `access`、`refresh`、`tokenType` 等敏感字段。错误：401。

### 6.5 `DELETE /admin/api/accounts/:id`：删除账号

| 项目 | 值 |
|---|---|
| 方法 | `DELETE` |
| 路径 | `/admin/api/accounts/:id` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 成功响应 | `200 {"removed":true}`；ID 不存在时 `200 {"removed":false}` |

```bash
curl -X DELETE \
  "http://127.0.0.1:8787/admin/api/accounts/6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{"removed":true}
```

删除不存在的 ID 不返回 404，而是：

```json
{"removed":false}
```

错误：401。

---

### 6.6 `GET /admin/api/login/modes`：查询登录模式

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/login/modes` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 成功响应 | `200`，返回可用模式和默认模式 |
| 错误 | `401 {"error":"unauthorized"}` |

```bash
curl http://127.0.0.1:8787/admin/api/login/modes \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "modes": ["device", "callback"],
  "defaultMode": "device"
}
```

说明：

- `modes` 是当前代码编译支持的集合，不代表当前机器的 callback 端口一定空闲。
- `defaultMode` 固定为 `device`。
- 前端或自动化应先调用本接口，再按需要向 `/admin/api/login/start` 传 `mode`。

### 6.7 `POST /admin/api/login/start`：启动登录会话

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/admin/api/login/start` |
| 鉴权 | 管理令牌 |
| 请求头 | `Content-Type: application/json` 可选但建议发送 |
| 请求体 | 可选：`{"mode":"device"}` 或 `{"mode":"callback"}` |
| 默认值 | 不传 body、空 body、非法 JSON、`mode` 不是字符串时，默认 `device` |
| 成功响应 | `200` 登录会话对象 |
| 错误 | 非法 mode 为 `400 {"error":"mode must be device or callback"}`；启动上游或端口失败为 `502 {"error":"..."} ` |

请求体字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | string | 否 | `device` 或 `callback`；默认 `device` |

行为注意：

- `{"mode":"device"}` 与省略 `mode` 完全等价。
- `{"mode":"foo"}` 返回 400。
- `mode` 传入数字、数组、对象或 null 时不会报错，而是继续使用默认 `device`，因为源码只检查字符串。
- `callback` 模式要求网关进程能在 `127.0.0.1` 绑定端口；它不是默认模式。

#### 设备码模式

```bash
curl -X POST http://127.0.0.1:8787/admin/api/login/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"device"}'
```

设备码模式不需要任何入向端口。适合 Docker、远程服务器和无浏览器主机。返回示例：

```json
{
  "id": "7d1b2c3a-9f0e-4a11-8d22-abcdef123456",
  "mode": "device",
  "status": "pending",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://authkit.cline.bot/...",
  "verificationUriComplete": "https://authkit.cline.bot/...",
  "qrSvg": "<svg ...>...</svg>",
  "expiresAt": 1760000300000,
  "pollIntervalSeconds": 5,
  "email": null,
  "accountId": null,
  "error": null
}
```

#### 回调模式

```bash
curl -X POST http://127.0.0.1:8787/admin/api/login/start \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"callback"}'
```

回调模式会：

- 在当前网关进程内绑定 `127.0.0.1`；
- 从 `48801` 开始依次尝试到 `48811`，共 11 个端口；
- 回调路径固定为 `/auth`；
- 使用 Microsoft OAuth provider（WorkOS authorize URL 会显式带 `provider=MicrosoftOAuth`）；
- 会话超时为 5 分钟，`pollIntervalSeconds` 为 `2`。

返回示例：

```json
{
  "id": "8e2c3d4b-a0f1-4b22-9e33-bcdef1234567",
  "mode": "callback",
  "status": "pending",
  "userCode": "48801",
  "verificationUri": "https://authkit.cline.bot/...?provider=MicrosoftOAuth",
  "verificationUriComplete": "https://authkit.cline.bot/...?provider=MicrosoftOAuth",
  "qrSvg": "<svg ...>...</svg>",
  "expiresAt": 1760000300000,
  "pollIntervalSeconds": 2,
  "email": null,
  "accountId": null,
  "error": null
}
```

回调模式下 `userCode` 不是给用户输入的验证码，而是实际选中的端口字符串；真正的用户操作是打开 `verificationUri` 并在浏览器完成 Microsoft/WorkOS 授权。浏览器必须能够访问网关进程所在机器的 `127.0.0.1:48801-48811`；远程服务器要做 SSH 端口转发或只映射到宿主机 loopback，不能把该端口公开到公网。

错误示例：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{"error":"mode must be device or callback"}
```

所有回调端口被占用时：

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json
```

```json
{"error":"No local callback port is available"}
```

#### 登录会话字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 登录会话 UUID |
| `mode` | string | `device` 或 `callback` |
| `status` | string | `pending`、`approved`、`failed`、`expired`、`cancelled` |
| `userCode` | string | 设备码；callback 模式为选中的端口字符串 |
| `verificationUri` | string | 浏览器验证地址 |
| `verificationUriComplete` | string/null | device 模式下带 user code 的完整地址；上游没有则为 null；callback 模式等于 `verificationUri` |
| `qrSvg` | string | `verificationUri` / `verificationUriComplete` 的 SVG 二维码 |
| `expiresAt` | number | 会话过期时间（epoch ms） |
| `pollIntervalSeconds` | number | device 来自 WorkOS；callback 固定为 `2` |
| `email` | string/null | 批准前为 null，批准后为账号邮箱 |
| `accountId` | string/null | 批准前为 null，批准后为网关账号 ID |
| `error` | string/null | 失败/过期原因 |

---

### 6.8 `GET /admin/api/login/:id`：查询登录会话

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/login/:id` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 成功响应 | `200`，登录会话对象，字段与 `login/start` 相同 |
| 404 | 未知 session：`{"error":"unknown session"}` |
| 错误 | 401 管理鉴权失败 |

```bash
curl http://127.0.0.1:8787/admin/api/login/8e2c3d4b-a0f1-4b22-9e33-bcdef1234567 \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

设备码 pending 示例：

```json
{
  "id": "7d1b2c3a-9f0e-4a11-8d22-abcdef123456",
  "mode": "device",
  "status": "pending",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://authkit.cline.bot/...",
  "verificationUriComplete": "https://authkit.cline.bot/...",
  "qrSvg": "<svg ...>...</svg>",
  "expiresAt": 1760000300000,
  "pollIntervalSeconds": 5,
  "email": null,
  "accountId": null,
  "error": null
}
```

回调 approved 示例：

```json
{
  "id": "8e2c3d4b-a0f1-4b22-9e33-bcdef1234567",
  "mode": "callback",
  "status": "approved",
  "userCode": "48801",
  "verificationUri": "https://authkit.cline.bot/...?provider=MicrosoftOAuth",
  "verificationUriComplete": "https://authkit.cline.bot/...?provider=MicrosoftOAuth",
  "qrSvg": "<svg ...>...</svg>",
  "expiresAt": 1760000300000,
  "pollIntervalSeconds": 2,
  "email": "user@example.com",
  "accountId": "6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801",
  "error": null
}
```

状态行为：

- `pending`：仍在等待浏览器授权。
- `approved`：已完成 token exchange/register，并已写入 `$DATA_DIR/accounts.json`。
- `failed`：上游或 token exchange 失败。
- `expired`：device 模式错误为 `device code expired`；callback 模式错误为 `callback session expired`。
- `cancelled`：调用 cancel 或被主动中止。

客户端建议按 `pollIntervalSeconds` 轮询；管理台固定约 2 秒轮询。

### 6.9 `POST /admin/api/login/:id/cancel`：取消登录会话

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/admin/api/login/:id/cancel` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 成功响应 | `200 {"cancelled":true}`；不存在时 `{"cancelled":false}` |
| 错误 | 401 管理鉴权失败 |

```bash
curl -X POST \
  http://127.0.0.1:8787/admin/api/login/8e2c3d4b-a0f1-4b22-9e33-bcdef1234567/cancel \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{"cancelled":true}
```

取消不存在或已清理的会话：

```json
{"cancelled":false}
```

取消 device 会话会中止 WorkOS polling；取消 callback 会话会关闭本地回调服务器。

---

### 6.10 `POST /admin/api/accounts/import`：批量导入账号

该接口供独立注册机或其他受信服务通过管理令牌推送 Cline 凭据。整批合法条目会在最后统一原子写盘一次；非法条目逐条跳过，不会让整批失败。

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/admin/api/accounts/import` |
| 鉴权 | `Authorization: Bearer <ADMIN_TOKEN>` 或 `?token=<ADMIN_TOKEN>` |
| 必需请求头 | `Content-Type: application/json` |
| 请求体上限 | 2 MiB（2,097,152 bytes）；声明或实际 UTF-8 字节数超限返回 413 |
| 条目上限 | `accounts` 最多 5000 条 |
| 行级错误返回 | 最多 20 条 `errors`；`skipped` 仍统计全部跳过条目 |
| 持久化 | 合法条目一次性原子批量写盘；全部非法时不写盘 |

#### 顶层请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `accounts` | array | 是 | 账号对象数组；可以是空数组，但最多 5000 条 |

#### `accounts[]` 字段

| 字段 | 类型 | 必填 | 校验与写入行为 |
|---|---|---|---|
| `email` | string | 是 | 必须是 trim 后非空且包含 `@` 的字符串；保存时 trim |
| `access` | string | 是 | 非空字符串；保存前 trim；是 Cline access token 原文 |
| `refresh` | string | 是 | 非空字符串；保存前 trim；是 Cline refresh token |
| `expires` | number | 是 | 有限且大于 0 的 epoch 数值；`< 1e12` 按秒自动 ×1000，否则按毫秒 |
| `accountId` | string | 否 | trim 后非空时写入；**去重时优先级最高** |
| `tokenType` | string | 否 | trim 后非空时使用，否则 `Bearer` |
| `provider` | string | 否 | trim 后非空时使用，否则 `cline` |
| `label` | string/null | 否 | 字符串时作为 label；非字符串或未传时传 null，新建账号存 null，更新已有账号时因 `??` 逻辑会保留旧 label |

未列出的字段会被忽略。`expires` 不接受数字字符串，例如 `"1789989005"` 会校验失败。

#### 去重顺序

合法条目按输入数组顺序逐条 upsert：

1. 若该条的 `accountId` 非空，先查找已有账号中 `accountId` 相同的记录。
2. 若第 1 步没找到，且 `email` 非空，再按 `email` 查找。
3. 找到已有记录则更新，返回计数 `updated += 1`。
4. 没找到则新建，返回计数 `imported += 1`。
5. 同一次请求内后面的条目能看到前面条目刚写入的结果，因此重复数据可能表现为前一条 imported、后一条 updated。

当 `accountId` 命中而 email 不同，仍按 `accountId` 更新已有记录。更新时覆盖 `email`、`access`、`refresh`、`expires`，并因导入项的默认值而把 `provider`、`tokenType` 分别写为传入值或 `cline`/`Bearer`；若本项没有 `accountId`，已有 `accountId` 会保留；`label` 为空时保留旧 label。已有记录的内部 `id` 和 `createdAt` 不变，`updatedAt` 更新，`disabled` 清为 false，`lastError` 清为 null。

#### curl

```bash
curl -X POST http://127.0.0.1:8787/admin/api/accounts/import \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accounts": [
      {
        "email": "existing@outlook.com",
        "accountId": "cline-user-001",
        "access": "raw-access-001",
        "refresh": "raw-refresh-001",
        "expires": 1789989005,
        "tokenType": "Bearer",
        "provider": "cline",
        "label": "registrar-batch-1"
      },
      {
        "email": "new@outlook.com",
        "access": "raw-access-002",
        "refresh": "raw-refresh-002",
        "expires": 1789989005000,
        "provider": "MicrosoftOAuth"
      },
      {
        "email": "invalid-address",
        "access": "raw-access-003",
        "refresh": "raw-refresh-003",
        "expires": 1789989005
      }
    ]
  }'
```

#### 成功响应

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "imported": 1,
  "updated": 1,
  "skipped": 1,
  "total": 3,
  "errors": [
    {
      "index": 2,
      "email": "invalid-address",
      "reason": "email must be a string containing @"
    }
  ]
}
```

响应字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `imported` | number | 新建账号数量 |
| `updated` | number | 更新已有账号数量（含批内重复更新） |
| `skipped` | number | 校验失败并被跳过的条目总数 |
| `total` | number | 请求 `accounts` 的总条目数 |
| `errors` | array | 最多 20 条行级错误 |
| `errors[].index` | number | 在 `accounts` 数组中的 0-based 下标 |
| `errors[].email` | string/null | 输入 email 为 string 时为 trim 后的值，否则为 null |
| `errors[].reason` | string | 校验失败原因 |

行级错误 reason 的完整集合：

| reason | 触发条件 |
|---|---|
| `account must be an object` | 数组条目不是对象 |
| `email must be a string containing @` | email 非字符串、空白或不含 @ |
| `access must be a non-empty string` | access 不是非空字符串 |
| `refresh must be a non-empty string` | refresh 不是非空字符串 |
| `expires must be a positive epoch number` | expires 不是有限且大于 0 的 number |

#### 典型错误

请求体不是合法 JSON：

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{"error":"request body must be valid JSON"}
```

顶层不是对象或 `accounts` 不是数组：

```json
{"error":"accounts must be an array"}
```

超过 5000 条：

```json
{"error":"accounts must contain at most 5000 entries"}
```

请求体超过 2 MiB：

```http
HTTP/1.1 413 Payload Too Large
Content-Type: application/json
```

```json
{"error":"request body exceeds 2 MB"}
```

管理鉴权失败：`401 {"error":"unauthorized"}`。

---

### 6.11 `GET /admin/api/models`：模型目录与计费桶

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/models` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 成功响应 | 模型列表 + counts |

```bash
curl http://127.0.0.1:8787/admin/api/models \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "models": [
    {"id": "cline-pass/kimi-k3", "ownedBy": "cline-pass", "bucket": "pass"},
    {"id": "cline-free/deepseek-v4.1-flash", "ownedBy": "cline-free", "bucket": "free"},
    {"id": "anthropic/claude-sonnet-4.6", "ownedBy": "anthropic", "bucket": "credits"}
  ],
  "counts": {
    "total": 3,
    "pass": 1,
    "free": 1,
    "credits": 1
  }
}
```

`bucket` 取值：

- `pass`：Cline Pass 订阅覆盖。
- `free`：免费桶。
- `credits`：消耗 Cline Credits。

错误：401；上游目录失败时可能返回 fallback 列表，而不是单独的错误体。

### 6.12 `GET /admin/api/subscription`：首个可用账号的订阅状态

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/subscription` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 成功响应 | `plan` + `account`；无账号时包含 `error:"no_accounts"` |

```bash
curl http://127.0.0.1:8787/admin/api/subscription \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

有账号：

```json
{
  "plan": {
    "displayName": "Cline Pass",
    "interval": "month",
    "isActive": true,
    "clinePassEnabled": true,
    "currentPeriodStart": "2026-09-01T00:00:00.000Z",
    "currentPeriodEnd": "2026-10-01T00:00:00.000Z",
    "error": null
  },
  "account": {
    "id": "6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801",
    "email": "user@example.com"
  }
}
```

无账号：

```json
{"plan":null,"account":null,"error":"no_accounts"}
```

第一个候选账号无法解析 token：

```json
{
  "plan": null,
  "account": {"id": "...", "email": "..."},
  "error": "re-login required"
}
```

错误：401。该接口只查首个候选账号，不保证展示池中所有账号的订阅；要查全部账号请用 `/admin/api/usage`。

### 6.13 `GET /admin/api/usage`：每个账号的套餐和用量窗口

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/usage` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 缓存 | 每账号上游查询结果缓存 60 秒 |
| 成功响应 | `{"accounts":[...]}` |

```bash
curl http://127.0.0.1:8787/admin/api/usage \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "accounts": [
    {
      "id": "6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801",
      "email": "user@example.com",
      "disabled": false,
      "lastError": null,
      "plan": {
        "displayName": "Cline Pass",
        "interval": "month",
        "isActive": true,
        "clinePassEnabled": true,
        "currentPeriodStart": "2026-09-01T00:00:00.000Z",
        "currentPeriodEnd": "2026-10-01T00:00:00.000Z",
        "error": null
      },
      "limits": [
        {"type": "five_hour", "percentUsed": 12.5, "resetsAt": "2026-09-21T15:00:00.000Z"},
        {"type": "weekly", "percentUsed": 30, "resetsAt": "2026-09-28T00:00:00.000Z"},
        {"type": "monthly", "percentUsed": 44.2, "resetsAt": "2026-10-01T00:00:00.000Z"}
      ],
      "error": null
    }
  ]
}
```

字段类型：

| 字段 | 类型 | 说明 |
|---|---|---|
| `accounts[].id` | string | 内部账号 ID |
| `accounts[].email` | string/null | 邮箱 |
| `accounts[].disabled` | boolean | 是否禁用 |
| `accounts[].lastError` | string/null | 持久化的最后错误 |
| `accounts[].plan` | object/null | 订阅信息 |
| `accounts[].limits` | array | usage 窗口列表 |
| `accounts[].limits[].type` | string | `five_hour`、`weekly`、`monthly` 或上游值 |
| `accounts[].limits[].percentUsed` | number | 上游值，网关钳制到 0 到 100 |
| `accounts[].limits[].resetsAt` | string/null | 重置时间 |
| `accounts[].error` | string/null | `re-login required`、HTTP 状态或网络错误 |

如果某个账号 token resolve 失败，该行仍是 200，`limits` 为空、`error` 为 `re-login required`。错误：401。

---

### 6.14 `GET /admin/api/requests?limit=N`：最近请求

| 项目 | 值 |
|---|---|
| 方法 | `GET` |
| 路径 | `/admin/api/requests` |
| 查询参数 | `limit` 可选，默认 `100`，最大 `200`；非法或小于等于 0 时退回 `100` |
| 鉴权 | 管理令牌 |
| 请求体 | 无 |
| 数据来源 | 进程内滚动日志，重启后丢失 |

```bash
curl "http://127.0.0.1:8787/admin/api/requests?limit=50" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{
  "entries": [
    {
      "at": 1760000000000,
      "model": "cline-pass/minimax-m3",
      "stream": true,
      "status": 200,
      "durationMs": 842,
      "accountId": "6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801",
      "error": null
    }
  ],
  "stats": {
    "total": 12,
    "ok": 11,
    "failed": 1,
    "last5Minutes": 3
  }
}
```

`entries` 不是完整审计日志，不包含请求体、响应体或 token。没有请求日志依赖时返回：

```json
{"entries":[],"stats":{"total":0,"ok":0,"failed":0,"last5Minutes":0}}
```

错误：401。

### 6.15 `POST /admin/api/chat`：管理台试聊

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/admin/api/chat` |
| 鉴权 | 管理令牌；浏览器不暴露 `PROXY_API_KEY` |
| 请求体 | 与 `/v1/chat/completions` 完全相同 |
| 上游选择 | 使用与 `/v1/chat/completions` 相同的账号池、轮询、刷新和故障转移 |
| 成功响应 | 与 `/v1/chat/completions` 相同；支持 `stream:true` |
| 错误 | 管理鉴权失败 401；请求校验、账号不足和上游错误与 OpenAI 对话路径一致 |

```bash
curl http://127.0.0.1:8787/admin/api/chat \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cline-pass/minimax-m3",
    "messages": [{"role": "user", "content": "管理台测试"}],
    "stream": false
  }'
```

成功响应示例：

```json
{
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "管理台测试成功。"},
      "finish_reason": "stop"
    }
  ]
}
```

该接口使用管理令牌，不需要 `Authorization: Bearer $PROXY_API_KEY`。

---

## 7. 登录与账号生命周期

当前支持两种交互登录模式：

| 项目 | 设备码 | localhost 回调 |
|---|---|---|
| mode | `device` | `callback` |
| 是否默认 | 是 | 否，必须显式选择 |
| 入向端口 | 不需要 | 需要浏览器访问网关进程所在机器的 `127.0.0.1:48801-48811` |
| 授权提供方 | WorkOS Device Code Flow | Cline authorize 重定向到 WorkOS，provider 显式设为 `MicrosoftOAuth` |
| 典型场景 | Docker、远程服务器、无头环境 | 浏览器与网关在同一台机器，或已建立 SSH/端口转发 |
| 会话超时 | 使用 WorkOS 返回的 `expires_in` | 固定 5 分钟 |
| 建议轮询 | 使用 `pollIntervalSeconds` | 固定 `2` 秒 |
| 过期错误 | `device code expired` | `callback session expired` |
| 端口全部占用 | 不适用 | `502 {"error":"No local callback port is available"}` |

`GET /admin/api/login/modes` 返回的是代码支持的模式，不会探测 48801-48811 当前是否空闲。因此即使 `modes` 包含 `callback`，实际 start 仍可能因端口全部占用而返回 502。

### 7.1 设备码登录时序

设备码是稳定默认模式，遵循 WorkOS OAuth Device Code Flow（RFC 8628）。

```text
管理员/管理台
   |
   | POST /admin/api/login/start
   | body: {"mode":"device"} 或省略 mode
   v
Cline2API LoginService
   |
   | POST https://api.workos.com/user_management/authorize/device
   | form: client_id=<WORKOS_CLIENT_ID>
   v
WorkOS
   |
   | 返回 device_code、user_code、verification_uri、
   | verification_uri_complete、expires_in、interval
   v
LoginService 建立内存 session：
  mode=device, status=pending, qrSvg 已生成
   |
   | 管理员在任意设备打开 verification_uri / 扫码确认
   |
   | 后台循环 POST /user_management/authenticate
   | form: grant_type=urn:ietf:params:oauth:grant-type:device_code
   |       device_code=...
   |       client_id=...
   v
WorkOS 返回 access_token + refresh_token
   |
   | POST https://api.cline.bot/api/v1/auth/register
   | body: {"accessToken":"...","refreshToken":"..."}
   v
Cline 返回 accessToken / refreshToken / expiresAt / userInfo
   |
   | AccountStore.saveCredentials(..., provider="cline")
   v
$DATA_DIR/accounts.json（0600，原子写）
   |
   v
session.status=approved；返回 email + accountId
```

设备码轮询行为：

- `authorization_pending`：按 `interval` 等待后继续。
- `slow_down`：interval 加 1 秒后继续。
- `access_denied`、`expired_token`、`invalid_grant`：会话失败；`expired_token` 映射为 `expired`。
- 超过 `expiresAt`：状态变为 `expired`，错误为 `device code expired`。
- cancel：状态变为 `cancelled`，后台 WorkOS polling 被 AbortController 中止。
- 设备码模式不监听本地端口，因此 Docker 不需要映射 48801-48811。

### 7.2 localhost 回调登录时序

回调模式必须由调用方显式传入 `{"mode":"callback"}`，不会被自动选择。

```text
管理员/管理台
   |
   | POST /admin/api/login/start
   | body: {"mode":"callback"}
   v
LoginService
   |
   | 启动本地 HTTP callback server
   | bind: 127.0.0.1
   | try: 48801, 48802, ... 48811
   | path: /auth
   v
Local callback server ready
   |
   | GET https://api.cline.bot/api/v1/auth/authorize
   | query:
   |   client_type=extension
   |   callback_url=http://127.0.0.1:<port>/auth
   |   redirect_uri=http://127.0.0.1:<port>/auth
   | redirect=manual
   v
Cline authorize 返回 3xx Location（指向 WorkOS）
   |
   | 网关把 Location 的 provider 覆盖为 MicrosoftOAuth
   v
返回 session：
  mode=callback
  userCode="<selected port>"
  verificationUri=<WorkOS URL>
  verificationUriComplete=<同一 URL>
  pollIntervalSeconds=2
   |
   | 管理员打开 verificationUri，浏览器完成 Microsoft/WorkOS 授权
   v
浏览器回调 http://127.0.0.1:<port>/auth?code=...
   |
   | callback server 返回 200 HTML：Authentication successful
   | 并 resolve authorization code
   v
POST https://api.cline.bot/api/v1/auth/token
  JSON:
  {
    "grant_type":"authorization_code",
    "code":"...",
    "client_type":"extension",
    "redirect_uri":"http://127.0.0.1:<port>/auth"
  }
   |
   | 若响应是原始 access_token + refresh_token：
   |   POST /api/v1/auth/register
   | 若响应已经是完整 Cline token envelope：
   |   直接使用其中的 credentials
   v
AccountStore.saveCredentials(..., provider="MicrosoftOAuth")
   |
   v
$DATA_DIR/accounts.json（0600，原子写）
   |
   v
session.status=approved；返回 email + accountId
```

回调服务器行为：

- 只监听 `127.0.0.1`，不监听 `0.0.0.0`。
- 固定路径为 `/auth`；其他路径返回 404 `Not found`。
- 收到 `?error=...`：返回 400 纯文本 `Authentication failed: ...`，并让登录会话失败。
- 收到有效 `?code=...`：返回 200 `text/html`，然后网关执行 token exchange。
- 没有 code：返回 400 `Missing authorization code`，不会结束整个会话，仍可继续等待正确回调。
- 5 分钟未完成：reject 为 `expired_token`，会话最终显示 `callback session expired`。
- cancel 或服务关闭：关闭 callback server；取消错误为 `Callback authorization cancelled`。
- 全部端口被占用：不启动会话，接口返回 502 `No local callback port is available`。

---

### 7.3 令牌续期与故障转移

| 机制 | 当前实现 |
|---|---|
| 提前续期 | access token 距离到期小于等于 `REFRESH_BUFFER_MS`（默认 5 分钟）时刷新 |
| 单飞刷新 | 同一账号并发请求共享同一个刷新 Promise，避免 refresh token 轮换竞态 |
| Refresh Token 轮换 | `/api/v1/auth/refresh` 返回的新 refresh token 立即写回 store |
| 无效 refresh token | `invalid_grant`/`invalid_token`/`unauthorized` 等判定为需要重登；账号 `disabled=true`，`lastError="invalid_grant: re-login required"` |
| 瞬时刷新失败 | 如果旧 access token 仍在 `RETRYABLE_TOKEN_GRACE_MS`（默认 30 秒）宽限内，继续使用旧 token |
| 401/403 强刷重放 | 上游返回 401/403 时，同一账号第二次 attempt 强制刷新并重放 |
| 账号轮询 | AccountPool 每次调用从轮转后的第一个 active 账号开始 |
| 账号级故障转移 | 计费/额度类错误使该账号对当前模型冷却 90 秒，并继续尝试其他账号 |
| 无账号 | `503 no_accounts` |
| 全部失败 | `502 all_accounts_failed` |

### 7.4 `accounts.json` 的文件形状

Store 版本为 `version: 1`。设备码登录写入 `provider="cline"`，callback 登录写入 `provider="MicrosoftOAuth"`，批量导入默认 `provider="cline"`，也允许注册机传入自定义 provider。

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "6c2b8f2d-1d9f-4a0c-9c52-0db0b3f3a801",
      "label": null,
      "email": "user@example.com",
      "accountId": "cline-user-id",
      "access": "<redacted>",
      "refresh": "<redacted>",
      "expires": 1760000000000,
      "tokenType": "Bearer",
      "provider": "MicrosoftOAuth",
      "createdAt": 1759900000000,
      "updatedAt": 1759999000000,
      "disabled": false,
      "lastError": null
    }
  ]
}
```

账号 upsert 的查找顺序：

1. 如果新凭据带 `accountId`，先按 `accountId` 匹配。
2. 没有命中时，再按 `email` 匹配。
3. 更新已有记录会保留内部 `id` 和 `createdAt`，刷新 `updatedAt`，并清除 `disabled`、`lastError`。

Store 会在文件 mtime 变化时自动 reload。批量导入接口使用一次批量原子写盘：[`POST /admin/api/accounts/import`](#610-post-adminapiaccountsimport批量导入账号)。

### 7.5 回调端口与部署要求

callback server 只绑定网关进程所在机器的 loopback 地址，因此有三种可行场景：

| 场景 | 是否可用 | 做法 |
|---|---|---|
| 浏览器与网关进程在同一台机器 | 是 | 直接启动 callback 模式；确保 48801-48811 至少一个空闲 |
| 远程服务器 + 本机浏览器 | 是，但需隧道 | 把远程端口转发到本机：`ssh -L 48801:127.0.0.1:48801 user@gateway-host`；如有需要同时转发多个端口 |
| Docker + 宿主机浏览器 | 是，但需映射 | 只映射到宿主机 loopback，例如 `127.0.0.1:48801-48811:48801-48811` |
| 浏览器在另一台普通远程机器 | 通常不可用 | 不能直接访问服务器自己的 `127.0.0.1`；使用设备码或建立 SSH 隧道 |

Docker Compose 默认只暴露网关端口，不映射 callback 端口。若确实要在容器内使用 callback 模式，可增加：

```yaml
ports:
  - "127.0.0.1:48801-48811:48801-48811"
```

不要把 48801-48811 映射到 `0.0.0.0` 或直接暴露公网。callback server 没有额外的回调鉴权，只依赖随机 code 和短暂会话；减少攻击面应按需启用并限制来源。

---

## 8. 模型与计费

### 8.1 模型目录来源

网关合并两个公开的上游目录：

| 来源 | 路径 | 对应 bucket |
|---|---|---|
| 提供方目录 | `GET /api/v1/models` | 默认 `credits` |
| 推荐目录 `clinePass` | `GET /api/v1/ai/cline/recommended-models` | `pass` |
| 推荐目录 `free` | `GET /api/v1/ai/cline/recommended-models` | `free` |

合并规则：

1. 先加入提供方目录。
2. 再加入 `pass` 和 `free` 条目。
3. 同 ID 出现多次时保留原有提供方元数据，但采用后加入目录的 bucket。
4. 因此同一模型若同时出现在多个目录，优先级为 `free` > `pass` > `credits`。

目录默认缓存 `MODEL_CACHE_TTL_MS=300000`，即 5 分钟。上游两个目录都不可用时：

- 已有缓存：继续返回缓存。
- 没有缓存：返回 `src/cline/constants.ts` 中的 fallback 目录，并打 warning 日志。

### 8.2 三种 bucket

| bucket | 含义 | 典型模型 ID |
|---|---|---|
| `pass` | Cline Pass 订阅覆盖；订阅只覆盖 `cline-pass/*` 前缀的模型 | `cline-pass/kimi-k3`、`cline-pass/glm-5.3`、`cline-pass/minimax-m3` |
| `free` | Cline 免费桶；免费额度按账号计算，通常每天重置 | `cline-free/deepseek-v4.1-flash`、`cline-free/muse-spark-1.3-contributor`、`cline-free/solar-pro4` |
| `credits` | 消耗 Cline Credits；没有 Credits 的账号会失败 | `anthropic/claude-sonnet-4.6`、`anthropic/claude-fable-5.1`、`openai/gpt-6-astra` |

**最常踩的坑：** `anthropic/claude-sonnet-4.6` 这类不带 `cline-pass/` 前缀的模型走 Cline Credits。只有订阅、没有 Credits 的账号调用它会得到类似 `Insufficient balance` 或 `Insufficient balance. Your Cline Credits balance is ...` 的上游错误。网关会识别这类错误并把该账号对当前模型冷却 90 秒，再尝试其他账号；如果池中所有账号都不能支付该模型，最终返回 `502 all_accounts_failed`，而不是把原始 402 直接透传给客户端。

### 8.3 免费额度和账号池

- 免费桶额度按账号计算，不按网关计算。
- 同一天同一个账号的免费额度耗尽后，故障转移会尝试其他账号。
- 池中所有账号都耗尽时，错误会以 `429` 文本或上游原文形式出现；匹配到 `daily free limit` / `free limit reached` / `INFERENCE_CAP_ERROR` 的账号级错误也会被网关用于切换账号。
- 与共享供应商池相关的 `429` 不一定会触发账号切换，因为换账号可能只是增加延迟。

### 8.4 客户端如何选模型

```bash
# 查看完整模型 ID
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PROXY_API_KEY"

# 查看每个模型的计费桶
curl http://127.0.0.1:8787/admin/api/models \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

推荐策略：

- 想使用订阅额度：选择 `bucket=pass` 的 `cline-pass/*` ID。
- 想使用免费额度：选择 `bucket=free` 的 ID。
- 明确有 Cline Credits：才选择 `bucket=credits` 的模型。
- 不要把自由命名的模型 ID 自己拼前缀；使用目录原样返回的 ID。

---

## 9. 错误码参考

### 9.1 错误体形状

`/v1/*`、`/admin/api/chat` 的请求校验错误以及网关级错误使用 OpenAI 风格：

```json
{
  "error": {
    "message": "错误说明",
    "type": "invalid_request_error",
    "code": "optional_code"
  }
}
```

- `type`：默认 4xx 为 `invalid_request_error`，5xx 为 `server_error`；上游错误或特定代码可能覆盖。
- `code`：仅在有值时出现。
- 上游对非账号级错误通常直接返回原始响应体和状态码，因此客户端也可能看到上游自己的错误 JSON。

管理 API 的鉴权错误不是 OpenAI 风格：

```json
{"error":"unauthorized"}
```

未知路由统一返回：

```json
{
  "error": {
    "message": "Unknown route /path",
    "type": "invalid_request_error"
  }
}
```

### 9.2 状态码表

| 状态码 | 常见来源 | 常见原因 | 客户端建议 |
|---|---|---|---|
| `200` | 网关成功响应 | 请求成功、SSE 建立 | 正常处理 |
| `400` | 本地校验或上游 | JSON 非法、缺 `model`、`messages` 非数组、上游参数错误 | 修正请求；若是账号额度文本，网关可能已尝试换号 |
| `401` | 本地鉴权或上游凭证 | `/v1/*` 的 API key 错误；上游 token 被拒绝 | 检查 `PROXY_API_KEY`；管理员重新登录对应账号 |
| `402` | 上游 | Credits 不足等上游计费错误 | 使用 `pass`/`free` 模型或更换有 Credits 的账号；若匹配账号级错误，网关会先故障转移 |
| `403` | 管理台或上游 | 非 loopback 未授权访问管理台；上游拒绝凭证 | 设置 `ADMIN_TOKEN` 或用 loopback；上游 403 会触发强刷和换号，最终可能变成 502 |
| `404` | 网关路由或上游 | 路由不存在；上游模型不存在 | 检查路径和模型 ID |
| `429` | 上游 | 免费日限、供应商限流或账号额度 | 账号级免费日限会尝试其他账号；共享池限流通常直接返回 |
| `500` | 网关或上游 | 未处理异常；上游返回 500 且不匹配账号级错误 | 查看网关日志；可重试 |
| `502` | 网关 | 所有账号失败、上游不可达、Anthropic 上游非 JSON | 检查账号、网络、上游状态和日志 |
| `503` | 网关 | 没有 active 账号或全部需要重新登录 | 在管理台完成登录 |
| `504` | 反向代理常见 | 反向代理超时 | 检查代理 timeout；**网关源码没有显式构造 504**，当前不会在业务代码中主动返回 504 |

### 9.3 账号级错误识别规则

当前源码对以下状态和文本执行账号切换：

```text
状态：400、402、429

文本匹配（不区分大小写）：
insufficient_credits
insufficient balance
credit balance
INFERENCE_CAP_ERROR
daily free limit
free limit reached
exceeded your current quota
quota exceeded
```

匹配后：

- 当前账号 + 当前模型冷却 90 秒；
- 继续尝试下一个候选账号；
- 所有账号都失败时返回 502 `all_accounts_failed`。

### 9.4 上游 401 与本地 401 的区别

- 客户端 key 错：立即返回本地 401 `invalid_api_key`。
- 账号 token 被上游拒绝：网关不会直接把上游 401 返回给客户端，而是先强制刷新并重放；仍失败则换号；所有账号耗尽后返回 502。
- 管理令牌错：返回管理 API 的 401 `{"error":"unauthorized"}`，不是 OpenAI 错误体。

---

## 10. 环境变量完整表

以下变量来自 `cline2api/src/config.ts` 与 `cline2api/.env.example`。除特别说明外，未设置时使用默认值。所有整数变量通过 `parseInt` 读取；解析失败或小于等于 0 时回退默认值。

| 变量 | 必填 | 默认值 | 作用 |
|---|---|---|---|
| `PROXY_API_KEY` | 否 | 无；首次启动自动生成 | 客户端访问 `/v1/*` 的 key；支持逗号分隔多个 key；生成值写入 `$DATA_DIR/proxy-api-key.txt` |
| `ADMIN_TOKEN` | 否，但公网部署必须设置 | 无 | 管理台和 `/admin/api/*` 令牌；未设置时仅允许 loopback |
| `HOST` | 否 | `127.0.0.1` | HTTP 监听地址；容器内使用 `0.0.0.0` |
| `PORT` | 否 | `8787` | HTTP 监听端口 |
| `DATA_DIR` | 否 | `./data`（`path.resolve` 后的绝对路径） | `accounts.json` 和自动生成的 proxy key 文件目录 |
| `LOG_LEVEL` | 否 | `info` | 日志级别：`debug`、`info`、`warn`、`error`；无法识别时回退 `info` |
| `CLINE_API_BASE_URL` | 否 | `https://api.cline.bot` | Cline 上游 base URL；会去掉末尾 `/` |
| `WORKOS_API_BASE_URL` | 否 | `https://api.workos.com` | WorkOS base URL；会去掉末尾 `/` |
| `WORKOS_CLIENT_ID` | 否 | `client_01K3A541FN8TA3EPPHTD2325AR` | 官方 Cline WorkOS client ID |
| `REFRESH_BUFFER_MS` | 否 | `300000` | access token 到期前多久开始刷新 |
| `RETRYABLE_TOKEN_GRACE_MS` | 否 | `30000` | 刷新暂时失败时，仍可使用未过期旧 token 的宽限时间 |
| `REQUEST_TIMEOUT_MS` | 否 | `30000` | WorkOS auth、token refresh、模型目录、subscription、usage 等上游请求的 timeout；当前聊天转发路径传入客户端 AbortSignal，未传 signal 时代码使用 600000 ms 上游兜底 |
| `MODEL_CACHE_TTL_MS` | 否 | `300000` | 模型目录缓存 TTL |
| `CLINE_CLIENT_NAME` | 否 | `cline-sdk` | 上游 `X-CLIENT-TYPE` 头 |
| `CLINE_CLIENT_VERSION` | 否 | `3.0.62` | 上游 `X-CLIENT-VERSION` 和 User-Agent 版本 |
| `CLINE_PLATFORM` | 否 | `process.platform` | 上游 `X-PLATFORM`；`.env.example` 示例写 `unknown` |
| `CLINE_PLATFORM_VERSION` | 否 | `unknown` | 上游 `X-PLATFORM-VERSION` |
| `CLINE_CORE_VERSION` | 否 | `0.0.83` | 上游 `X-CORE-VERSION` |

### 10.1 示例配置

```dotenv
# 客户端 key，逗号分隔可接受多个
PROXY_API_KEY=sk-client-one,sk-client-two

# 公网必须设置
ADMIN_TOKEN=replace-with-a-long-random-token

HOST=0.0.0.0
PORT=8787
DATA_DIR=/data
LOG_LEVEL=info

CLINE_API_BASE_URL=https://api.cline.bot
WORKOS_API_BASE_URL=https://api.workos.com
WORKOS_CLIENT_ID=client_01K3A541FN8TA3EPPHTD2325AR

REFRESH_BUFFER_MS=300000
RETRYABLE_TOKEN_GRACE_MS=30000
REQUEST_TIMEOUT_MS=30000
MODEL_CACHE_TTL_MS=300000

CLINE_CLIENT_NAME=cline-sdk
CLINE_CLIENT_VERSION=3.0.62
CLINE_PLATFORM=unknown
CLINE_PLATFORM_VERSION=unknown
CLINE_CORE_VERSION=0.0.83
```

### 10.2 配置文件与密钥注意事项

- 不要提交填有真实值的 `.env`。
- 不要把 `accounts.json` 交给客户端或写入日志。
- `PROXY_API_KEY` 和 `ADMIN_TOKEN` 必须使用不同值。
- 多个客户端 key 可以用于权限隔离和轮换，但当前所有 key 等价。
- 自动生成客户端 key 时日志只显示配置数量，不显示 key 本身。

---

## 11. 部署注意

### 11.1 Docker

仓库中的 `docker-compose.yml` 会：

- 使用 `HOST=0.0.0.0`，让容器内 Node 监听所有网卡；
- 使用 `DATA_DIR=/data`；
- 将数据目录挂载为 `./data:/data`；
- 要求通过环境变量传入 `PROXY_API_KEY`；
- 允许 `ADMIN_TOKEN` 为空，但公网映射时必须设置；
- 默认把宿主端口绑定到 `127.0.0.1:8787`，由 nginx/Caddy 提供 TLS 和公网入口。

示例：

```bash
cat > .env <<'EOF'
PROXY_API_KEY=sk-your-client-key
ADMIN_TOKEN=replace-with-a-long-random-token
EOF

docker compose up -d --build
docker compose logs -f cline2api
```

数据备份至少包含：

```text
./data/accounts.json
./data/proxy-api-key.txt
```

不要只备份容器，不备份 `DATA_DIR`。容器重建后账号和自动生成的客户端 key 需要从该卷恢复。

如果使用 `callback` 登录模式，默认 Compose 不会映射 `48801-48811`。需要同时在 Compose 中增加只绑定宿主机 loopback 的端口范围：

```yaml
ports:
  - "127.0.0.1:48801-48811:48801-48811"
```

设备码模式不需要上述映射，远程/Docker 部署优先使用设备码。

### 11.2 反向代理与 SSE

流式响应必须禁用代理缓冲。Caddy 示例：

```caddyfile
cline.example.com {
    @stream path /v1/* /admin/api/chat
    handle @stream {
        reverse_proxy 127.0.0.1:8787 {
            flush_interval -1
        }
    }
    handle {
        encode gzip zstd
        reverse_proxy 127.0.0.1:8787
    }
}
```

nginx 示例：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location /admin/api/chat {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```

网关成功流式响应已经包含：

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

但 `X-Accel-Buffering` 只对支持该头的代理生效；nginx/Caddy 自身仍需关闭缓冲。

### 11.3 公网安全清单

- 必须设置强随机 `ADMIN_TOKEN`。
- 必须设置 `PROXY_API_KEY`，不要依赖自动生成后再把文件暴露到 Web。
- 不要把 `DATA_DIR` 挂载到公开静态目录。
- 不要让管理台直接暴露到公网；若必须暴露，使用 HTTPS、访问控制和强令牌。
- 定期轮换 `PROXY_API_KEY` 和 `ADMIN_TOKEN`。
- 日志中不要输出 `accounts.json` 内容或 Authorization 头。
- 备份和迁移时把 `accounts.json` 视为高敏感文件。
- 上游账号需要用户本人完成 WorkOS 浏览器确认；网关不提供绕过验证码或浏览器验证的能力。

### 11.4 运行检查

```bash
# 进程存活
curl -fsS http://127.0.0.1:8787/healthz

# 管理状态（本机）
curl -fsS http://127.0.0.1:8787/admin/api/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 账号列表
curl -fsS http://127.0.0.1:8787/admin/api/accounts \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 12. 源码核对差异

以下是本次重新读取最新源码后核实到的、与常见的接口说明或本次任务描述不一致的地方：

1. **`/v1/models` 仍不返回 `bucket`。** `ModelCatalog.toOpenAIModels()` 会剥离 bucket，保持纯 OpenAI shape；计费分桶只在 `GET /admin/api/models` 返回。
2. **callback 端口实际是 `48801-48811`，共 11 个，不是 `48801-48806`。** `callbackServer.ts` 的默认端口数组长度是 11；只有全部端口 `EADDRINUSE` 时才返回 `502 No local callback port is available`。
3. **`GET /admin/api/login/modes` 是静态能力列表，不检测端口占用。** 它始终返回 `{"modes":["device","callback"],"defaultMode":"device"}`；即使 callback 当前不可用，也不会把 `callback` 从列表移除。
4. **callback 模式显式使用 `MicrosoftOAuth`。** Cline authorize 返回的 WorkOS Location 会被改写成 `provider=MicrosoftOAuth`；成功后账号 `provider` 也写成 `MicrosoftOAuth`。这不是“网关自动判断某个 IdP”，而是代码固定选择的 provider。
5. **账号导入请求支持可选的 `accountId`。** README 的导入字段表没有列出它，但源码支持，并且去重时 `accountId` 优先于 `email`。省略 `accountId` 时才用 email 去重。
6. **账号导入上限与响应细节：** 单次最多 5000 条；请求体最大 2 MiB；行级错误最多返回 20 条但 `skipped` 统计全部；合法条目一次批量原子写盘。`expires < 1e12` 会按秒乘以 1000，数字字符串不会被自动转换。
7. **`/v1/*` 鉴权是全局前置守卫。** `createApp()` 对 `/v1/*` 注册了 `app.use()`，所以未知 `/v1/...` 路由在缺 key/错误 key 时也先返回 401 + OpenAI 错误体，而不是 404。
8. **管理鉴权响应分两种形状。** 管理 API 未授权返回 401 `{"error":"unauthorized"}`；管理台首页 `/` 未授权返回 403 纯文本 `Admin UI is not exposed here. Set ADMIN_TOKEN or use localhost.`。这不是 OpenAPI 风格错误体。
9. **网关源码没有显式 504。** 504 通常由反向代理产生。聊天转发在收到客户端 AbortSignal 时使用该 signal；没有 signal 时 `postChatCompletions` 使用 600000 ms 的兜底 timeout，而不是直接使用 `REQUEST_TIMEOUT_MS`。`REQUEST_TIMEOUT_MS` 主要用于 auth、refresh、目录、订阅和 usage 请求。
10. **`anthropic-version` 不会被网关校验或转发。** Anthropic 请求体按固定字段转换；未列入转换器的其他字段会被忽略，不会自动透传上游。
11. **删除账号不存在时不返回 404。** `DELETE /admin/api/accounts/:id` 始终返回 200，通过 `removed:false` 表示未找到。
12. **`GET /admin/api/usage` 是“每账号一行”。** `GET /admin/api/subscription` 只展示首个候选账号，不能用来观察整个账号池的订阅和配额。
13. **上游聊天 401/403 通常不会原样返回。** 网关会先强制刷新并重放，再切换账号；最终失败通常变成 502 `all_accounts_failed`，而不是 401。
14. **callback server 只绑定 `127.0.0.1`，默认 Docker Compose 不映射回调端口。** 远程使用需要 SSH 转发或只绑定宿主机 loopback 的端口映射，不能依赖容器默认端口发布。

---

