# Applet 平台

个人应用管理平台：在 Cloudflare Workers 上承载你自己的小程序/小工具集合。用户登录后看到被授权的小程序宫格；每个小程序获得按用户强隔离的数据存储；所有小程序由 AI agent 通过平台 MCP 服务开发、检查并上传（PR 流水线内置于平台）。

详细设计见 [docs/superpowers/specs/2026-10-25-applet-platform-design.md](docs/superpowers/specs/2026-10-25-applet-platform-design.md)。

## 目录结构

```
applet-platform/
├─ platform/               # 平台本体
│  ├─ src/                 # 前端（Vue 3 + Element Plus）
│  ├─ worker/              # Worker 后端（Hono：API、MCP、同步器、静态服务）
│  └─ wrangler.toml        # D1/R2 绑定、cron 配置
├─ applets/                # 小程序根目录（每个子目录 = 一个小程序）
│  └─ word-cards/          # 示例：背单词
│     ├─ applet.json       # 清单：id/名称/图标/入口/数据表声明
│     ├─ index.html
│     └─ assets/
├─ docs/
│  ├─ applet-spec.md       # 小程序开发规范（MCP get_spec 的内容源）
│  └─ superpowers/         # 设计文档与实施计划
└─ .github/workflows/      # CI：规范检查 + 测试 + 构建
```

## 部署（Cloudflare）

> **重要**：`*.workers.dev` 域名在中国大陆基本不可访问。生产使用请绑定自定义域名（见第 9 步）。

1. **Fork 或使用本仓库**：本仓库应为 public，包含全部代码与 CI。
2. **创建 D1 数据库**：Cloudflare 控制台 → Storage & Databases → D1 → Create，命名 `applet-platform-db`。（本仓库已内置 Database ID `54c58c42-5bdb-468f-bd15-e25d7dbdb293`；若你重建了库，替换 `platform/worker/wrangler.toml` 中的 `database_id`。）
3. **创建 R2 存储桶**：Storage & Databases → R2 → Create bucket，命名 `applet-platform-assets`。
4. **创建 Worker（Workers Builds，推荐）**：Workers & Pages → Create → Workers → Connect to Git，选中本仓库 `applet-platform`。构建设置：
   - Build command: `npx pnpm install --frozen-lockfile && npx pnpm build`
   - 部署命令（Deploy command）: `npx wrangler deploy --config platform/worker/wrangler.toml`
   - 根目录：仓库根
   静态资源由 wrangler.toml 的 `[assets]` 配置自动上传（`platform/dist`，构建后生成），SPA 路由回退已内置（not_found_handling）。首次部署成功后再做后续绑定（第 6-7 步）。
5. **配置 wrangler.toml**：把 `platform/worker/wrangler.toml` 中 `database_id` 的占位符替换为第 2 步的 Database ID（文件中有 `TODO(deploy)` 注释标记）。
6. **绑定资源**：Worker → Settings → Bindings：绑定第 2 步的 D1（变量名 `DB`）与第 3 步的 R2（变量名 `ASSETS`）；确认 Cron Trigger 已启用（每 5 分钟）。
7. **配置 Secrets**（Worker → Settings → Variables and Secrets，全部为 Secret 类型）：

   | Secret | 用途 |
   |---|---|
   | `ADMIN_INIT_PASSWORD` | 首次初始化的管理口令（自定义强随机值） |
   | `GITHUB_TOKEN` | 平台代建 PR/合并/同步用（需 `repo` 权限，指向本仓库） |
   | `GITHUB_OWNER` / `GITHUB_REPO` | 仓库归属（如 `b-birdy` / `applet-platform`） |
   | `MCP_SIGNING_KEY` | 小程序 token 与 MCP 密钥签发（强随机串） |
   | `GH_WEBHOOK_SECRET` | GitHub webhook 签名密钥（强随机串） |

8. **首次初始化**：部署完成后访问 `https://<你的域名>/api/setup` 确认 `{"needsInit":true}`，然后 `POST /api/setup`（或等前端接入初始化页）：
   ```bash
   curl -X POST https://<你的域名>/api/setup \
     -H 'content-type: application/json' \
     -d '{"adminPassword":"<ADMIN_INIT_PASSWORD>","newPassword":"<你的admin密码>"}'
   ```
   成功后用 `admin` / 新密码登录平台。
9. **绑定自定义域名**：Worker → Settings → Domains & Routes → Add Custom Domain（域名需已托管在 Cloudflare 或将 NS 切到 Cloudflare）。国内用户一律通过该域名访问。
10. **配置 GitHub webhook**（可选但推荐，实时同步）：仓库 → Settings → Webhooks → Add：
    - URL: `https://<你的域名>/api/hooks/github`
    - Secret: 与 `GH_WEBHOOK_SECRET` 相同
    - Events: Push、Pull requests

**注意（免费版 CPU 限制）**：Workers 免费版单请求 CPU 上限 10ms。本平台登录哈希用 PBKDF2 100,000 次迭代，本地测试无碍；若部署后登录返回 1102 错误，将 `platform/worker/auth.ts` 中 `PBKDF2_ITERATIONS` 降为 10,000（哈希格式自带迭代数，已存口令不受影响）。

### Wrangler CLI 部署（替代控制台）

```bash
cd platform/worker
npx wrangler d1 execute applet-platform-db --file=./db/schema.sql --remote  # 初始化表结构
npx wrangler deploy
npx wrangler secret put ADMIN_INIT_PASSWORD  # 依次配置全部 Secrets
```

> Workers Builds 路径下同样需要先跑一次 schema 初始化（本地 `npx wrangler d1 execute applet-platform-db --file=platform/worker/db/schema.sql --remote`），首次 `/api/setup` 才能工作。

## Agent 接入指南

所有小程序由 agent 开发。接入流程：

1. **拿准入码**：管理员在平台「Agent 认证」页生成一次性准入码，交给你。
2. **连接 MCP**：Streamable HTTP 端点 `https://<你的域名>/mcp`，认证方式 `Authorization: Bearer <准入码或API Key>`。
3. **申请接入**：凭准入码调用工具 `agent_apply({name, fingerprint})`，等管理员审批。
4. **拿 API Key**：审批通过后管理员会给你签发的 API Key（仅展示一次）。
5. **开发**：`get_spec()` 获取完整规范 → 本地开发 → `check_applet()` 自检至零 error → `submit_applet()` 上传（平台自动建 PR）→ `get_status()` 查进度。
6. **上线**：管理员在平台内审阅 diff、合并 PR、启用应用。

规范全文见 [docs/applet-spec.md](docs/applet-spec.md)（即 MCP `get_spec` 下发的内容）。

## 本地开发

```bash
pnpm install
pnpm test            # 全量测试（worker 集成测试跑 workerd）
pnpm build           # 类型检查 + 构建
pnpm check:applets   # 对 applets/ 跑规范检查
npx wrangler dev     # 本地起 Worker（platform/worker 下）
```

测试环境变量（vitest.config.ts 已内置）：`ADMIN_INIT_PASSWORD=test-admin-init`、`MCP_SIGNING_KEY=test-signing-key`、`GH_WEBHOOK_SECRET=test-hook-secret`。

## 安全模型速览

- 小程序运行在无同源授权的 sandbox iframe 中，凭据由平台 postMessage 注入、60 分钟自动轮换；小程序代码无法接触 cookie。
- Data API 按用户强隔离：`user_id` 由平台注入，请求伪造一律忽略；表/列名白名单，值全参数化。
- 全部敏感操作（用户增删、状态变更、PR 合并、agent 吊销…）需管理员确认且写入审计日志。
- agent 权限按小程序绑定：默认只能操作自己提交过的应用，追加授权需管理员操作，全程指纹可追溯。

## Changelog

见 [CHANGELOG.md](CHANGELOG.md)。
