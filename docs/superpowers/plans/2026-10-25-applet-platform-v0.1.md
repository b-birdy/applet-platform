# Applet 平台 v0.1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建「Applet 平台」v0.1——Cloudflare Worker 上的个人应用管理平台：用户/角色、小程序宫格与沙箱托管、统一 Data API、GitHub 同步与 PR 流水线、MCP agent 认证与规范服务，附示例小程序 word-cards。

**Architecture:** 单仓库单部署：Vite 构建 Vue3 SPA，Hono Worker 同进程承载平台 API、静态路由（R2）、webhook/cron 同步器与无状态 MCP（JSON-RPC）。数据一套 D1（平台表 `t_` 前缀、小程序表 `a_<applet_id>_<表名>`）。小程序代码走 MCP 上传→平台代建 GitHub PR→平台内合并→同步进 R2。

**Tech Stack:** TypeScript、Hono、Vue 3 + Element Plus + Pinia + vue-router、Vite、Cloudflare D1/R2/Cron、Vitest + @cloudflare/vitest-pool-workers、GitHub REST API（裸 fetch）、MCP Streamable HTTP（无状态、手写 JSON-RPC，不引入 SDK）。

**Spec:** `docs/superpowers/specs/2026-10-25-applet-platform-design.md`（决策 D1–D34；本计划引用其编号）

## Global Constraints

- 仓库：GitHub public `applet-platform`，首个 tag `v0.1`；本地根目录 `/agent-projects/applet-website-onworker`（git init 在 Task 1）
- 包管理 pnpm；Node ≥ 20；TypeScript strict
- 禁止使用 KV（D30）；绑定仅 D1（`DB`）、R2（`ASSETS`）、Cron Trigger（每 5 分钟）
- Secrets：`GITHUB_TOKEN`、`ADMIN_INIT_PASSWORD`、`MCP_SIGNING_KEY`、`GH_WEBHOOK_SECRET`；不入 git
- D1 表名规范：平台表 `t_` 前缀、小程序表 `a_<applet_id>_<表名>`（D2）
- 密码：PBKDF2-SHA256 10,000 迭代 + 16B 随机盐（Workers 免费版 10ms CPU 约束下的既定取舍）
- Data API 默认配额 10,000 行 / 20MB 每用户每应用；资产单文件 ≤5MB（5,242,880B）、总 ≤20MB（D29）；代码行数 >10,000 仅 warn（D32）
- 全局色值（D20）：画布 `#F6F7F5`、面板 `#FFFFFF`、墨 `#1C2422`、交互苍青 `#176E68`、状态灯 启用 `#2F8A4C` / 测试 `#B9791F` / 停用 `#9AA5A2`；深色主题画布 `#121816`、面板 `#1A211F`、苍青 `#2FA39A`（D33）
- 小程序状态机：`testing ⇄ enabled ⇄ disabled`，删除为硬删除操作（D11）；合并 PR 后保持 testing 并提示管理员手动启用
- 所有风险操作 API 前必须过确认弹窗（前端职责），API 端全部写审计日志（D22）
- 提交信息用 conventional commits（feat/fix/test/chore/docs）；每任务至少一个提交

## Review Focus

规范隐含、单靠任务测试最易伤到真人的五类输入，按可能性排序（每条已钉进所属任务的测试步骤）：

1. **伪造 user_id**：请求体带 `user_id` 指向他人 → 一律忽略，行归属会话用户（Task 5 测试）
2. **跨用户读取**：用户 B 按 id 读用户 A 的数据行 → 404 而非数据泄露（Task 5 测试）
3. **吊销后的 agent 密钥**：吊销瞬间起所有请求 401，含进行中的（Task 11 测试）
4. **沙箱 token 打管理接口**：applet 短时 token 调 `/api/admin/*` 一律 401，session cookie 才可（Task 11 测试）
5. **配额溢出**：第 10001 行写入返回明确错误（`QUOTA_EXCEEDED` + 当前用量），绝不静默丢弃（Task 5 测试）

---

### Task 1: 仓库脚手架与 CI

**Files:**
- Create: `package.json`、`tsconfig.json`、`vitest.config.ts`、`vite.config.ts`、`index.html`、`platform/src/main.ts`、`platform/src/App.vue`、`platform/worker/index.ts`、`platform/worker/wrangler.toml`、`.github/workflows/ci.yml`、`.gitignore`、`pnpm-workspace.yaml`
- Test: `platform/worker/index.test.ts`

**Interfaces:**
- Produces: 可运行的 Hono Worker（`GET /api/health` → `{"ok":true}`）、可构建的 Vue SPA（Vite root=`platform/`，outDir=`platform/dist`）、`pnpm test` / `pnpm build` / `pnpm check:applets` 三个根脚本、vitest 配置（worker 测试用 @cloudflare/vitest-pool-workers，绑定 `DB`/`ASSETS` 本地模拟）

- [ ] **Step 1: 初始化 git 并验证 gh 认证**

```bash
cd /agent-projects/applet-website-onworker && git init -b main
gh auth status || echo "NEED_USER_SETUP"
```
若输出 `NEED_USER_SETUP`：停止，请用户配置后再继续（D34）。

- [ ] **Step 2: 写 package.json（deps: hono, vue, element-plus, pinia, vue-router；devDeps: typescript, vite, @vitejs/plugin-vue, vitest, @cloudflare/vitest-pool-workers, wrangler, vue-tsc, jsdom, tsx）与三个根脚本**：`test`→`vitest run`、`build`→`vue-tsc -b && vite build`、`check:applets`→`tsx platform/worker/checker/cli.ts applets`（Task 4 实现前先输出 `{issues:[]}` 占位并成功退出）。

- [ ] **Step 3: 写 vitest.config.ts**：`@cloudflare/vitest-pool-workers`，`wrangler` 指向 `platform/worker/wrangler.toml`，`main` 指向 `platform/worker/index.ts`；前端 store 测试（Task 13）用同文件 `environment` jsdom + include 分离。

- [ ] **Step 4: 写 wrangler.toml**：`name="applet-platform"`、`main="index.ts"`、`compatibility_date` 取当月 1 日、`d1_databases` binding `DB`、`r2_buckets` binding `ASSETS`、`triggers.crons=["*/5 * * * *"]`。不含 KV（D30）。

- [ ] **Step 5: 写最小 worker 与失败测试**

```ts
// platform/worker/index.test.ts
import { SELF } from 'cloudflare:test';
it('health', async () => {
  const r = await SELF.fetch('https://x/api/health');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
});
```

- [ ] **Step 6: 运行 `pnpm test`，期望 PASS**（此时只实现 index.ts 的 health 路由与 scheduled 空壳）

- [ ] **Step 7: 运行 `pnpm build`，期望 Vue 空应用构建成功**

- [ ] **Step 8: 写 ci.yml**：push/PR 触发，`pnpm install --frozen-lockfile` → `pnpm check:applets` → `pnpm test` → `pnpm build`。

- [ ] **Step 9: 写 .gitignore**（node_modules、dist、.superpowers、.dev.vars、.wrangler）并提交：`chore: scaffold platform monorepo with CI`

### Task 2: D1 schema

**Files:**
- Create: `platform/worker/db/schema.sql`、`platform/worker/db/apply.ts`（dev 脚本：对本地/远端 D1 执行 schema）
- Test: `platform/worker/db/schema.test.ts`

**Interfaces:**
- Produces: 全部平台表（spec §5 清单 + `t_agent_applets` + `t_prs`）；测试内固定 `applySchema(env.DB)` 帮助函数——后续所有 worker 测试的 beforeAll 都调它

- [ ] **Step 1: 写 schema.test.ts**：`applySchema` 后查询 `sqlite_master` 断言存在 `t_users,t_sessions,t_applets,t_applet_acls,t_agents,t_agent_applets,t_agent_access_codes,t_audit_logs,t_settings,t_prs` 共 10 表。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL（表不存在）**

- [ ] **Step 3: 写 schema.sql**：字段按 spec §5；`t_users.password_hash` 存 `pbkdf2$<iter>$<salt_b64>$<hash_b64>` 格式字符串；`t_agents.fingerprint` TEXT 非空；`t_applet_acls.allowed` INTEGER 1/0；全部建索引（users.username 唯一、applets.path 唯一、sessions.token 唯一、acls (applet_id,user_id) 唯一、audit_logs (at)、agent_applets (agent_id,applet_id) 唯一）。`applySchema` 用 `exec` 逐语句执行（D1 `batch` 不支持多语句字符串时拆分）。

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: d1 schema for platform tables`**

### Task 3: 认证内核 + 初始化 + 设置 + 审计

**Files:**
- Create: `platform/worker/auth.ts`、`platform/worker/settings.ts`、`platform/worker/audit.ts`、`platform/worker/routes/setup.ts`、`platform/worker/routes/auth.ts`
- Test: `platform/worker/auth.test.ts`、`platform/worker/routes/auth.test.ts`

**Interfaces:**
- Produces（后续任务按此调用）:
  - `hashPassword(pw: string, saltB64?: string): Promise<string>`、`verifyPassword(pw: string, stored: string): Promise<boolean>`
  - `createSession(db: D1Database, userId: number): Promise<string>`（32B 随机 hex token，写 `t_sessions`，30 天）；`getAuth(request, db): Promise<{userId, role, username} | null>`（读 HttpOnly cookie `sid`）
  - Hono 中间件 `requireAuth`、`requireRole(min: 'user'|'admin'|'superadmin')`（admin 通过时 superadmin 也通过）
  - `logAudit(db, e: {actor_type:'user'|'agent'|'system', actor_id: string, action: string, target?: string, detail?: any, ip?: string}): Promise<void>`
  - `getSetting(db, key: string, fallback?: string): Promise<string>`、`getQuota(db, appletId?: string): Promise<{rows: number, bytes: number}>`（读 per-applet 覆盖 `quota.<applet_id>.*`，缺省全局 `quota_rows`/`quota_bytes`，默认 10000/20971520）
  - 路由：`POST /api/auth/login|logout`、`GET /api/me`、`GET /api/setup`（`{needsInit: boolean}`）、`POST /api/setup`（body `{adminPassword, newPassword}`；仅 `t_users` 空且 `adminPassword === env.ADMIN_INIT_PASSWORD` 时建 admin 用户并写默认 settings，否则 403）

- [ ] **Step 1: 写 auth.test.ts（失败测试）**：哈希可验证通过/失败；连续 5 次登录失败后 `t_users.locked_until` > now 且正确密码也返回 401（错误码 `LOCKED`）；管理员 `POST /api/admin/users/:id/unlock` 前置不存在故本测试只测锁定副作用；`/api/setup` 在空库时 `needsInit:true`、密码错 403、正确建 admin 并可登录。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**（PBKDF2 用 `crypto.subtle`；锁定逻辑：`failed_count>=lock_threshold(默认5)` → `locked_until=now+lock_minutes(默认10)`，阈值/分钟从 settings 读；登录成功清零计数并写审计 `login.success`/`login.failure`；setup 成功写默认 settings：`site_name=Applet 平台, registration_enabled=0, lock_threshold=5, lock_minutes=10, quota_rows=10000, quota_bytes=20971520`）

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: auth core, first-run setup, settings, audit log`**

### Task 4: 小程序检查器（规则引擎 + CLI）

**Files:**
- Create: `platform/worker/checker/index.ts`、`platform/worker/checker/rules.ts`、`platform/worker/checker/cli.ts`
- Test: `platform/worker/checker/checker.test.ts`

**Interfaces:**
- Produces（Task 11 MCP、Task 10 检查报告、CI 共用）:
  - `type CheckIssue = { level: 'error' | 'warn'; rule: string; file: string; message: string }`
  - `checkApplet(appletId: string, files: Map<string, string>): CheckIssue[]`——`files` 为相对该 applet 目录的路径→文本（二进制以 `{size}` 占位对象传入另一入口 `checkAppletWithSizes(appletId, files, sizes)`，本任务只做文本与清单）
  - CLI：`pnpm check:applets` 扫描 `applets/*/`，输出 issues JSON，error 存在时退出码 1

- [ ] **Step 1: 写失败测试**（用例即规则，每条断言具体 rule 名）:
  - 缺 `applet.json` → error `manifest.missing`
  - 清单缺 id/name/entry/tables 或 id 与目录名不符 → error `manifest.invalid`
  - tables 列名含非 `[a-z0-9_]`、或名为 `user_id`、或类型不在 `text|integer|real|blob` → error `manifest.table`
  - entry 文件不存在 → error `entry.missing`
  - entry HTML 无 `<script src="/app-runtime.js">` → error `runtime.script`
  - 源码出现 `eval(`、`new Function(`、`document.cookie`、`window.top` → error `security.dynamic` / `security.cookie` / `security.top`
  - 加载外部脚本（`src="http` 且非 `/app-runtime.js`，域名不在清单 `external_apis`）→ error `security.external`
  - `fetch(` 指向未声明域名 → error `security.external_api`
  - 形如密钥的字面量（`(?i)(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9+/]{16,}`）→ error `security.secret`
  - 总行数 >10000 → warn `size.loc`；无 error 时输出空数组

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现规则引擎**（纯函数遍历 files；HTML 用正则提取 script src 与内联代码；不引入 AST 依赖）

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**；`pnpm check:applets` 空目录跑通退出 0

- [ ] **Step 5: 提交 `feat: applet checker rules engine with cli`**

### Task 5: Data API（用户隔离核心）

**Files:**
- Create: `platform/worker/routes/data.ts`、`platform/worker/data.ts`
- Test: `platform/worker/routes/data.test.ts`

**Interfaces:**
- Consumes: Task 2 schema、Task 3 `getAuth/getQuota`
- Produces:
  - `registerAppletTables(db, appletId: string, tables: ManifestTable[]): Promise<void>`——建表（自动加 `user_id INTEGER NOT NULL`、`rowid` 用默认）、新版本仅允许新增列（D24：比对已注册清单快照存 `t_settings` key `manifest.<applet_id>`，出现改列/删列/删表 → 抛 `SchemaChangeError`，新增列 `ALTER TABLE ADD COLUMN`）
  - `dropAppletTables(db, appletId): Promise<void>`
  - 路由：`GET|POST|PUT|DELETE /api/data/:appletId/:table` + `POST .../batch`；鉴权接受 session cookie 或 applet token（`Authorization: Bearer`，Task 11 签发；token 含 `{userId, appletId}`，仅能访问该 applet）；写入/查询全部强制 `user_id = 会话用户`；响应 `{rows, total}` / `{ok:true, count}`
  - 错误规范：401 `UNAUTHORIZED`、403 `APPLET_FORBIDDEN`（token 与 applet 不符）、404 `TABLE_NOT_FOUND`、400 `BAD_COLUMN`（非白名单列）、413 `QUOTA_EXCEEDED {used:{rows,bytes},limit:{…}}`（本测试只断言 413 + code）

- [ ] **Step 1: 写失败测试**（先在 setup 里 `registerAppletTables` 注册两用户 + word-cards 一张表）:
  - 用户 A POST 一行 → GET 只见自己那行；用户 B GET → `rows: []`
  - 用户 B PUT 用户 A 的行 id → 404
  - POST body 带 `user_id: B` 以 A 会话发出 → 落库归属 A
  - GET ?column=evil → 400 `BAD_COLUMN`；GET /nope → 404
  - 配额压到 10001 行（循环 batch 写）→ 第 10001 行 413 `QUOTA_EXCEEDED` 且库里仍为 10000 行
  - batch 请求事务性：第二批中一条失败 → 全批回滚
  - 新版清单加一列 → 再注册成功且旧数据还在；删列 → 抛 `SchemaChangeError`

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**（SQL 全部参数化；表/列名经白名单拼接——值永远走 bind；batch 用 `db.batch`；quota 在写前 `SELECT COUNT(*)` + 估算行大小）

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: data api with per-user isolation, batch, quota`**

### Task 6: 管理端·用户 API

**Files:**
- Create: `platform/worker/routes/admin/users.ts`
- Modify: `platform/worker/index.ts`（挂载 `/api/admin`）
- Test: `platform/worker/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: Task 3 auth/settings/audit、Task 5 `dropAppletTables` 的反操作（删除用户要清数据）
- Produces: `POST/GET/PUT/DELETE /api/admin/users`、`POST /api/admin/users/:id/reset-password`、`POST /api/admin/users/:id/lock|unlock`、`POST /api/admin/users/import`（body `{csv: string}`，`username,password,nickname` 每行）；superadmin 专属 `DELETE` 与对 admin 角色用户的写操作；删除用户连带删除其所有 `a_*` 表数据（D27，红字文案由前端负责）

- [ ] **Step 1: 写失败测试**: admin 建 user → 列表可见；user 调任一 admin API → 403；admin 建 admin → 403（仅 superadmin）；重置密码后新密码可登录旧密码不可；锁定后该用户登录 401 `LOCKED`；删除用户 → 其在 `a_demo_t1` 的 3 行消失（先注册演示表插数据再删）；CSV 导入 3 行成功 1 行重复用户名 → 返回 `{imported:3, failed:[{username,reason}]}`；以上操作各产生一条 `t_audit_logs`。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: admin user management api`**

### Task 7: 管理端·小程序 API

**Files:**
- Create: `platform/worker/routes/admin/applets.ts`
- Test: `platform/worker/routes/admin/applets.test.ts`

**Interfaces:**
- Consumes: Task 3、Task 5（register/drop tables）、Task 4 checker
- Produces:
  - `GET /api/admin/applets`（含每应用授权数、表数、open PR 号）、`PUT /api/admin/applets/:id`（名称/图标/专属配额覆盖 `quota.<id>.*`，写审计 D32）
  - `POST /api/admin/applets/:id/status` body `{status}`——状态机校验（非法跃迁 400）；`testing→enabled`、`enabled⇄disabled`、`→testing` 均合法
  - `POST /api/admin/applets/:id/authorize` body `{userIds: number[], allowed: boolean}`（批量，D10）
  - `GET /api/admin/applets/:id/check-report` → `{issues: CheckIssue[]}`（用 Task 4 引擎对 R2 `prod/<id>/` 现有文件跑）
  - `GET /api/admin/applets/:id/data/<table>`（管理员查看任意用户数据，只读）
  - `DELETE /api/admin/applets/:id`——硬删除序列写在此处但调 Task 8 GitHub 删目录 + Task 9 清 R2 + Task 5 drop 表（本任务用 stub 接口 `AppletRemover` 注入，Task 10 替换真身）

- [ ] **Step 1: 写失败测试**: 建测试 applet → 状态默认 testing；`disabled→testing` 400；批量授权 2 用户后 `GET /api/my/applets`（用 user 会话）可见；取消授权后不可见；check-report 对含 eval 的假文件返回 1 条 error；配额覆盖后 `getQuota` 返回覆盖值；删除（stub remover 记录调用）→ `t_applets` 无该行、`a_*` 表已 drop、审计有 `applet.delete`。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**（`AppletRemover` 接口 `{remove(appletId): Promise<void>}` 从 env 注入，默认 stub 抛"not wired"由本任务测试 stub 替换）

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: admin applet management api`**

### Task 8: GitHub 客户端

**Files:**
- Create: `platform/worker/github.ts`
- Test: `platform/worker/github.test.ts`

**Interfaces:**
- Produces（Task 9/10/11 共用，全部走裸 fetch，`fetch` 可注入替换用于测试）:
  ```ts
  class GitHubClient {
    constructor(token: string, owner: string, repo: string, fetchImpl?: typeof fetch)
    getHeadSha(branch: string): Promise<string | null>            // 404 → null
    createBranch(name: string, fromSha: string): Promise<void>
    putFiles(branch: string, files: Map<string,string|{contentBase64}>, message: string, author: {name,email}): Promise<string> // blob→tree→commit，返回新 sha
    deleteDir(branch: string, dir: string, message: string, author: {name,email}): Promise<string>
    openPR(title: string, head: string, base: string): Promise<number>
    getPR(num: number): Promise<{state:'open'|'closed'|'merged', head: string, mergeable: boolean}>
    mergePR(num: number, sha: string): Promise<void>              // squash
    getTree(ref: string): Promise<{path: string, size?: number}[]> // recursive，仅 applets/ 下
  }
  ```
  - commit author 固定格式：`applet-agent[<agent_id>] <agent_name>@agents.noreply.applet-platform`（D25 指纹），平台自身操作 author 为 `platform[bot]`

- [ ] **Step 1: 写失败测试**（注入内存 fetch mock，断言请求序列与 JSON-RPC 无关的 REST 调用形状）: putFiles 三步 API（blob/tree/commit）的 method/body 正确并返回新 sha；getPR 404 → 抛 `NotFound`；mergePR 先 GET sha 再 PUT merge；deleteDir 用 GET tree 过滤目录前缀 + commit；author 名符合 `applet-agent[3]` 格式。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: github rest client for applet pipeline`**

### Task 9: 同步器 + webhook + R2 静态服务

**Files:**
- Create: `platform/worker/sync.ts`、`platform/worker/routes/hooks.ts`、`platform/worker/serve.ts`
- Modify: `platform/worker/index.ts`（挂 `scheduled` cron → `syncOnce`、`POST /api/hooks/github`、`GET /app/:id/*`、`GET /preview/:id/*`、`GET /app-runtime.js`）
- Test: `platform/worker/sync.test.ts`、`platform/worker/serve.test.ts`

**Interfaces:**
- Consumes: Task 8 GitHubClient、Task 4 checker（新注册时跑一遍存报告进 `t_prs.check_report`）
- Produces:
  - `syncOnce(env): Promise<{added: string[], missing: string[]}>`——main 的 `applets/` 树 vs `t_applets`：新目录→注册 testing + 同步文件到 R2 `prod/<id>/` + 跑 checker 存报告；消失目录→`t_applets` 标记 `missing=1`（**不自动删**，管理页红点提示）
  - `syncPreview(env, appletId, branch): Promise<void>`——PR 分支文件 → R2 `preview/<id>/`
  - webhook：校验 `x-hub-signature-256`（`GH_WEBHOOK_SECRET`），`pull_request` 事件（opened/synchronize）→ 对 `applets/**` 变更的 applet 跑 `syncPreview`；`push` → `syncOnce`
  - 静态：`/app/:id/*` 服务 R2 `prod/<id>/`（`testing/disabled` 状态仅 admin 会话可取；`enabled` 需被授权用户；403 兜底 `APPLET_FORBIDDEN`）；`/preview/:id/*` 仅 admin；`/app-runtime.js` 服务内置运行时脚本（Task 14 前先回占位 script：`window.applet={ready:false}`）
  - Content-Type 按扩展名映射（html/js/css/svg/json/woff2…）

- [ ] **Step 1: 写失败测试**: mock GitHubClient 返回含新 applet 的树 → `syncOnce` 后 `t_applets` 多一行 testing、R2 `prod/x/applet.json` 可读、`t_prs.check_report` 有值；再跑一次不重复注册；`missing` 分支置位；未授权 user 取 `/app/testing-app/` → 403；admin 可取；enabled+授权 user 可取；webhook 签名错误 → 401。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: repo syncer, webhook, r2 applet serving`**

### Task 10: PR 合并 + 硬删除落地

**Files:**
- Create: `platform/worker/routes/admin/pr.ts`、`platform/worker/remover.ts`
- Modify: `platform/worker/routes/admin/applets.ts`（注入真 remover）、`platform/worker/sync.ts`（merge 后触发 `syncOnce`）
- Test: `platform/worker/routes/admin/pr.test.ts`

**Interfaces:**
- Consumes: Task 8 `mergePR/getPR`、Task 9 `syncOnce`、Task 5 `dropAppletTables`
- Produces:
  - `POST /api/admin/applets/:id/merge-pr`——前置：该 applet 有 open PR（`t_prs.state='open'`）；执行 `mergePR` → `t_prs.state='merged'` → `syncOnce(env)` → 审计；PR 不存在 409
  - `remover.ts`: `createAppletRemover(env): AppletRemover`——github `deleteDir`（`applets/<id>/`）+ 清 R2 `prod|preview/<id>/` + `dropAppletTables` + 删 ACL/PR 记录（Task 7 的 DELETE 调它）

- [ ] **Step 1: 写失败测试**: 有 open PR 时 merge 成功且 `t_prs` 变 merged、`syncOnce` 被调用（spy）；无 PR → 409；remover 对 stub GitHub 断言 deleteDir 被调、R2 三类键清除、D1 表与 ACL 消失、审计含 `applet.delete`。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: pr merge and hard delete pipeline`**

### Task 11: MCP 服务（认证、准入、四工具）

**Files:**
- Create: `platform/worker/mcp.ts`、`platform/worker/routes/mcp.ts`
- Modify: `platform/worker/index.ts`（挂 `POST /mcp`）
- Test: `platform/worker/mcp.test.ts`

**Interfaces:**
- Consumes: Task 3 settings/audit、Task 4 checker、Task 8 GitHubClient、Task 5 registerAppletTables（PR 阶段不建表，合并后 syncOnce 注册时才建）
- Produces:
  - 无状态 MCP（JSON-RPC 2.0，仅 POST，支持方法 `initialize`、`notifications/initialized`（204 无响应体）、`tools/list`、`tools/call`；其他 → -32601；非法 JSON → -32700）
  - 四工具（`tools/call` params.name）: `get_spec(section?: 'all'|'structure'|'manifest'|'data'|'security'|'upload')`——返回 `docs/applet-spec.md` 对应章节文本（Task 12 内容）；`check_applet({applet_id, files})` → checker 结果 JSON；`submit_applet({applet_id, name, files, entry})`——文件过 checker（error 阻断）、资产限 5MB/20MB（D29）、行级清单校验；通过 → `putFiles` 到 `applet/<id>` 分支（已存在 force 更新同分支）→ 已有 open PR 则推到同分支自动更新（D28），否则 `openPR` → 写 `t_prs` → **首次提交建立 agent 归属**（`t_agent_applets` source=submitted，D25）→ 返回 `{pr_number}`
  - `get_status({applet_id})` → 该 applet 的 PR/检查状态（agent 仅能查 `t_agent_applets` 内的 applet）
  - 认证：`Authorization: Bearer <access_code>` 仅允许 `agent_apply({name, fingerprint})` 工具调用（建 `t_agents` status=pending）；`Bearer <api_key>` 允许其余（approved 才有效）；其余 401
  - 管理路由：`POST /api/admin/access-codes`（生成一次性码，默认 24h 过期）、`GET /api/admin/agents`、`POST /api/admin/agents/:id/approve|reject|revoke`（approve 时签发 32B key，明文仅此一次返回）、`POST /api/admin/agents/:id/grant` body `{appletId}`（追加授权 D25）
  - 审计：`agent.apply/approve/reject/revoke/submit` 全记录

- [ ] **Step 1: 写失败测试**:
  - 无 Authorization → 401；`initialize` 返回 `{protocolVersion, capabilities:{tools:{}}}` 形状
  - access_code 调 `agent_apply` → pending 记录 + 码标记 used（二次用同码 403）
  - 未审批 key 调 `submit_applet` → 403 `AGENT_NOT_APPROVED`
  - 审批后 submit 合法 applet（mock GitHub）→ 返回 pr_number、`t_prs` 有 open 记录、author 为 `applet-agent[<id>]`、归属建立
  - 同 applet 再次 submit → 复用同分支不新开 PR（mock 断言 openPR 未再调）
  - agent A submit agent B 提交过的 applet → 403 `AGENT_SCOPE`
  - revoke 后旧 key 立即 401（Review Focus 3）
  - applet token（Task 5 签发器）调 `/api/admin/users` → 401（Review Focus 4）
  - files 含 `eval(` → 返回 issues 而不建 PR
  - `get_spec('security')` 返回含「安全红线」字样的文本

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现**（JSON-RPC 分发器 ~80 行 + 工具表；key hash 用 Task 3 `hashPassword`）

- [ ] **Step 4: 运行 `pnpm test`，期望 PASS**

- [ ] **Step 5: 提交 `feat: stateless mcp server with agent access flow`**

### Task 12: 开发规范文档 + word-cards 示例小程序

**Files:**
- Create: `docs/applet-spec.md`、`applets/word-cards/applet.json`、`applets/word-cards/index.html`、`applets/word-cards/assets/style.css`、`applets/word-cards/assets/main.js`
- Test: `platform/worker/checker/spec.test.ts`（用 checker 跑 word-cards 断言零 issue）

**Interfaces:**
- Consumes: Task 4 checker（本文档即 MCP `get_spec` 的内容源，两者必须同步——spec.test.ts 防漂移）
- Produces: `docs/applet-spec.md` 六章节（structure/manifest/data/security/upload/接口参考），内容覆盖 spec §8 全部红线与 `app-runtime.js` 用法（`window.applet.data(table).list/create/update/remove/batch`，token 由平台 postMessage 注入）；word-cards：tables `words(word text required, meaning text, status integer default 0)`，功能=添加/列表/标记已学/删除，纯原生 JS，深浅主题跟随平台 CSS 变量

- [ ] **Step 1: 写失败测试**: `checkApplet('word-cards', 读盘文件)` → 空数组；`applet.json` 的 id 等于目录名；每个 MCP 章节 key 在文档中存在二级标题（读文件正则断言）。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 写规范文档与小程序**（样式遵循 D20 色值，浅色为主色变量留深色覆盖钩子）

- [ ] **Step 4: 运行 `pnpm test` 与 `pnpm check:applets`，均 PASS**

- [ ] **Step 5: 提交 `feat: applet spec doc and word-cards example`**

### Task 13: 前端外壳（路由、布局、主题、登录）

**Files:**
- Create: `platform/src/router.ts`、`platform/src/stores/auth.ts`、`platform/src/stores/theme.ts`、`platform/src/api/client.ts`、`platform/src/layouts/MainLayout.vue`、`platform/src/views/Login.vue`、`platform/src/styles/theme.css`、`platform/src/styles/tokens.css`
- Modify: `platform/src/App.vue`、`platform/src/main.ts`
- Test: `platform/src/stores/theme.test.ts`、`platform/src/api/client.test.ts`（jsdom）

**Interfaces:**
- Produces:
  - `client.ts`: `api(path, opts?)` fetch 包装（cookie 凭证、非 2xx 抛 `{code, status, detail}`）
  - 路由表：`/login`、`/`（Home）、`/profile`、`/my-apps`、`/app/:id`（Task 14）、admin 区 `/admin/users|applets|agents|settings|logs`（meta.role='admin'，守卫读 `/api/me`）
  - MainLayout：左栏两分区（通用/管理员，无 admin 角色时整个分区不渲染 D6）+ 可折叠（折叠成 48px 图标条）+ 右侧 `<router-view>`
  - `tokens.css`：D20/D33 全部色值的 CSS 变量（`:root` 浅色 + `html.dark` 覆盖），Element Plus 暗色模式 class 切换；theme store 持久化到 localStorage，登录后同步到用户档案
  - Login.vue：D20 登录页样式（方格底纹、白卡、字标）；登录成功跳 `/`

- [ ] **Step 1: 写失败测试**: theme store 切换 → `document.documentElement.classList` 含/不含 `dark` 且 localStorage 更新；client 对 401 响应抛出含 code 的错误对象。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现外壳与登录页**

- [ ] **Step 4: 运行 `pnpm test` 与 `pnpm build`，均 PASS**

- [ ] **Step 5: 提交 `feat: frontend shell with dual theme and login`**

### Task 14: 用户侧 API + 三页 + 小程序沙箱容器

**Files:**
- Create: `platform/src/views/Home.vue`、`platform/src/views/Profile.vue`、`platform/src/views/MyApps.vue`、`platform/src/views/applet/AppFrame.vue`、`platform/worker/routes/my.ts`
- Create: `platform/worker/applet-runtime.js`（替换 Task 9 占位）
- Test: `platform/src/views/applet/handshake.test.ts`、`platform/worker/routes/my.test.ts`

**Interfaces:**
- Consumes: Task 3 `/api/me`、Task 7 授权查询、Task 9 静态服务、Task 5 Data API
- Produces:
  - worker 路由（spec §6 用户侧）: `GET /api/my/applets`（仅被授权且 enabled 的应用，admin 附带全部可见）、`GET /api/my/usage`、`GET /api/my/export?applet=`（JSON 下载）、`POST /api/my/purge?applet=`（清本人该应用数据，审计 `my.purge`）
  - Home：问候 + `GET /api/my/applets` 宫格（图标/名称，admin 加状态灯与虚线新增格→跳 `/admin/applets`）
  - Profile：改昵称/改密码（旧密码必填）/登录历史/主题切换（D33）
  - MyApps：`GET /api/my/usage` 列表 + 导出（`GET /api/my/export?applet=` 下载 JSON）+ 清除（`POST /api/my/purge?applet=`，确认弹窗）
  - AppFrame：`<iframe sandbox="allow-scripts allow-forms allow-popups">`（**无 allow-same-origin**）+ postMessage 握手：load 后 `POST /api/applet-token {appletId}` → `iframe.contentWindow.postMessage({type:'applet-token', token}, '*')`；token 有效期 60 分钟，过期前 5 分钟平台自动重发
  - `/api/applet-token` 路由（session 鉴权 + 授权校验，签发 `{userId, appletId, exp}` HMAC token，`MCP_SIGNING_KEY` 做密钥）
  - applet-runtime.js：监听 message → 保存 token → 暴露 `window.applet.data(table)` CRUD helper（fetch `Authorization: Bearer`）

- [ ] **Step 1: 写失败测试**（worker 侧 token 往返）: 签发→Data API 中间件解析回 `{userId, appletId}`；篡改签名 → 401；过期 → 401；无 allow-same-origin 下 runtime 无法读 cookie（静态断言 AppFrame 的 sandbox 属性字符串不含 `allow-same-origin`）。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现三页与容器**（全部走 D20 设计语言；风险操作 = MyApps 清除数据，用 `ElMessageBox.confirm` 红色确认）

- [ ] **Step 4: 运行 `pnpm test` 与 `pnpm build`，均 PASS**

- [ ] **Step 5: 提交 `feat: user pages and sandboxed applet frame with token handshake`**

### Task 15: 管理端五页

**Files:**
- Create: `platform/src/views/admin/Users.vue`、`platform/src/views/admin/Applets.vue`、`platform/src/views/admin/AppletWizard.vue`、`platform/src/views/admin/AgentAuth.vue`、`platform/src/views/admin/Settings.vue`、`platform/src/views/admin/AuditLogs.vue`、`platform/src/data/prompts.ts`
- Test: `platform/src/data/prompts.test.ts`

**Interfaces:**
- Consumes: Task 6/7/10/11 管理 API、Task 13 外壳
- Produces:
  - Users：表格 + 新建/编辑（`ElForm`）/重置密码/锁定解锁/删除（全部确认弹窗，删除红字注明连带数据 D27）/CSV 导入对话框（粘贴文本提交）
  - Applets：表格（状态灯、授权数、PR 列）+ 行操作（编辑含专属限额、授权对话框多选用户、状态切换、合并 PR、检查报告抽屉（issues 列表 + 一键复制）、删除红字）+ missing 红点提示
  - AppletWizard：五步 `el-steps`（进度条）：①表单（id/name/icon）②③⑤ 三个提示词卡片（内容来自 `prompts.ts`，含当前 applet id 与 MCP 地址，复制按钮）④问题清单展示；完成态轮询 `/api/admin/applets` 直到新 applet 出现（测试态）
  - prompts.ts 导出 `devPrompt(applet)`, `checkPrompt(applet)`, `uploadPrompt(applet)`（模板引用 MCP 端点、准入码获取方式、`get_spec`/`check_applet`/`submit_applet` 工具名）
  - AgentAuth：生成准入码（显示一次）、申请列表（审批/拒绝确认）、已批准列表（可操作 applet 标签、追加授权对话框、吊销确认、密钥仅签发时展示）
  - Settings：站点名/注册开关（禁用态展示）/锁定参数/配额/GitHub 连接状态（最近同步时间 + 手动同步按钮）
  - AuditLogs：只读表格，筛选 actor/action/时间

- [ ] **Step 1: 写失败测试**: 三个 prompt 模板均含 `get_spec`、`check_applet` 或 `submit_applet` 工具名与 applet id 占位替换；wizard 步骤状态机（step 不能跳步）。

- [ ] **Step 2: 运行 `pnpm test`，期望 FAIL**

- [ ] **Step 3: 实现五页**（所有确认弹窗用 `ElMessageBox.confirm`，危险项 `confirmButtonText` 红色 + `type:'warning'`；表格操作列按状态显隐）

- [ ] **Step 4: 运行 `pnpm test` 与 `pnpm build`，均 PASS**

- [ ] **Step 5: 提交 `feat: admin pages with wizard, confirms, agent auth ui`**

### Task 16: 部署文档 + 发版 v0.1

**Files:**
- Create: `README.md`、`CHANGELOG.md`
- Modify: `platform/worker/applet-runtime.js`（如 Task 14 有占位残留则定稿）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可发布仓库

- [ ] **Step 1: 写 README**：项目简介、结构图（spec §4）、Cloudflare 部署十步（含 Secrets 清单、D1/R2 创建绑定、首次 `/api/setup`、自定义域名绑定步骤与 workers.dev 国内不可用警示 D23）、agent 接入指南（MCP 端点、准入码流程）、本地开发（`pnpm i && pnpm test && wrangler dev`）

- [ ] **Step 2: 全量验证**

```bash
pnpm test && pnpm build && pnpm check:applets
```
Expected: 全 PASS。

- [ ] **Step 3: 提交 `docs: deployment guide and changelog`，打 tag `v0.1`**

- [ ] **Step 4: 创建 GitHub 仓库并推送**

```bash
gh repo create applet-platform --public --source . --push
git push origin main --tags
```
（若 gh 无建仓权限：停下请用户操作，D34）

- [ ] **Step 5: 告知用户**：仓库地址 + Cloudflare 侧待办清单（创建 Worker 连接仓库、配 4 个 Secrets、建 D1/R2、绑定域名）——此为用户操作段（D34）
