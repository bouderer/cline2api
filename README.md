# cline2api

把 Cline 账号变成你自己的 **OpenAI 兼容 / Anthropic Messages** API。

仓库分成两个互相独立、又可以组队工作的部分：

```text
cline2api/
├── cline2api/        生产级反代网关（TypeScript + Hono）
│   ├── 对外提供 OpenAI / Anthropic 两套协议
│   ├── 多账号轮询、401 静默强刷、令牌自动续期
│   └── 自带管理台，可视化登录账号、看用量、试聊
│
├── cline-register/   独立注册机（Node，无第三方框架）
│   ├── 驱动 Cline 官方 WorkOS OAuth 登录链路
│   ├── 自动处理微软异地登录保护（用自带 Graph API 的邮箱接码）
│   └── 把拿到的凭据批量推送到远程网关
│
└── docs/API.md       完整接口文档（鉴权 / 每个端点 / 错误码 / 环境变量）
```

两者**没有编译期依赖**，可以分开部署：

- 只想跑网关 → 只用 `cline2api/`；
- 只想批量登录账号 → 只用 `cline-register/`，配好 `CLINE2API_REMOTE_URL` + `CLINE2API_ADMIN_TOKEN` 就能把凭据推到远端网关。

---

## 快速开始

### 1. 启动网关

```bash
cd cline2api
npm install
cp .env.example .env
```

编辑 `.env`，**至少**设置两个东西：

```env
# 客户端访问 /v1/* 用的密钥（OpenAI SDK 的 api_key）
PROXY_API_KEY=sk-your-own-key

# 管理台 / 管理 API 的令牌。暴露到公网时必须设置！
ADMIN_TOKEN=your-admin-token
```

启动：

```bash
npm run dev
```

- 管理台：<http://127.0.0.1:8787/>
- OpenAI Base URL：`http://127.0.0.1:8787/v1`
- Anthropic Base URL：`http://127.0.0.1:8787`
- 健康检查：`http://127.0.0.1:8787/healthz`

> 不设 `PROXY_API_KEY` 时网关会自动生成一个，写到 `$DATA_DIR/proxy-api-key.txt`（0600，不打印到日志）。

### 2. 登录账号

两种方式，任选：

**A. 用管理台（推荐，有浏览器时）**

打开 <http://127.0.0.1:8787/> → 点「登录新账号」→ 扫码或点链接 → 浏览器确认 → 页面自动轮询并在成功后保存账号。

登录模式可选：
- `device`（默认）：WorkOS 设备码，适合 Docker / 无头服务器，**不需要任何入向端口**；
- `callback`：localhost 回调，速度快、不受设备码风控影响，但需要 `48801–48806` 端口可达。

**B. 用注册机批量灌账号（推荐，大量账号时）**

```bash
cd ../cline-register
npm install
cp .env.example .env      # 填好邮箱库存 + 目标网关地址
npm run status            # 看账号池
npm run login             # 登录下一个
npm run push              # 把成功的凭据推到网关
```

详见 [`cline-register/README.md`](cline-register/README.md)。

### 3. 用起来

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-your-own-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"cline-free/deepseek-v4.1-flash","stream":false,
       "messages":[{"role":"user","content":"你好"}]}'
```

Claude Code：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787   # 注意：不要带 /v1
export ANTHROPIC_AUTH_TOKEN=sk-your-own-key
```

完整接口说明见 [`docs/API.md`](docs/API.md)。

---

## 鉴权一览

| 访问对象 | 凭证 | 请求头 |
|---|---|---|
| `/v1/*`（客户端） | `PROXY_API_KEY` | `Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| `/admin/*` 与管理台 | `ADMIN_TOKEN` | `Authorization: Bearer <token>` 或 `?token=<token>` |
| 上游 `api.cline.bot` | Cline 账号令牌 | 网关内部持有，客户端看不到 |

**未设置 `ADMIN_TOKEN` 时，管理接口只允许本机 loopback 访问。**
一旦把网关暴露到公网，**必须**同时设置 `PROXY_API_KEY` 和 `ADMIN_TOKEN`，否则管理台会对外开放。

---

## 模型与计费

网关的模型目录是**实时**从上游拉的，并按计费方式分成三类（在管理台 `/admin/api/models` 的 `bucket` 字段里能看到）：

| bucket | 含义 |
|---|---|
| `pass` | Cline Pass 订阅覆盖，ID 形如 `cline-pass/kimi-k3` |
| `free` | 免费模型，ID 形如 `cline-free/deepseek-v4.1-flash` |
| `credits` | 消耗 Cline Credits，ID 形如 `anthropic/claude-sonnet-4.6` |

**最容易踩的坑**：只有订阅、没有 Credits 的账号，去调不带 `cline-pass/` 前缀的模型会报 `Insufficient balance`。想用订阅额度，请显式使用 `cline-pass/*` 的模型 ID。

---

## 部署

### Docker

```bash
cd cline2api
echo "PROXY_API_KEY=sk-your-key" > .env
echo "ADMIN_TOKEN=your-admin-token" >> .env
echo "HOST=0.0.0.0" >> .env
docker compose up -d --build
```

- 数据卷要挂 `DATA_DIR`，否则账号会在容器重建后丢失；
- 流式响应需要在反代上关掉缓冲：`proxy_buffering off;` + `proxy_set_header X-Accel-Buffering no;`（`nginx/cline2api.conf` 里已有示例）。

### 直接跑

```bash
cd cline2api
npm run build
npm run serve
```

---

## 文档索引

- [`docs/API.md`](docs/API.md) — 接口文档：鉴权、每个端点、请求/响应示例、错误码、环境变量
- [`cline2api/README.md`](cline2api/README.md) — 网关上游契约、登录流程、多账号调度细节
- [`cline-register/README.md`](cline-register/README.md) — 注册机用法、两条 OAuth 链路、远程推送

---

## 免责声明

本项目只做**协议转换与凭证托管**，不创建 Cline 账号，也不绕过任何人机验证、短信验证或风控。请只用于你**自己有权管理**的账号，并遵守 [Cline 服务条款](https://cline.bot/tos)。
