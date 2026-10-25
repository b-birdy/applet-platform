# Applet 平台设计文档（v0.1）

日期：2026-10-25
状态：设计定稿，待开发
来源：与用户的 brainstorming 沟通（本文件所有"已定"条目均经用户确认，标注"我方决定"的为默认判断，用户可否决）

## 1. 意图与背景

用户需要个人应用管理平台，承载其各类小程序、小工具、网页与小型系统。平台跑在 Cloudflare Workers 上，代码放 GitHub public 仓库 `applet-platform`，首个版本 v0.1。所有小程序由各种 AI agent 开发，平台对 agent 提供规范下发（MCP）、认证准入与上传通道。

成功的样子：用户登录后看到被授权应用的宫格，点开即用、数据天然隔离；管理员在平台内完成建号、授权、审核 agent、跟随向导新增小程序、一键合并 PR；整个链路无需离开平台。

## 2. 目标 / 非目标 / 反目标

**目标**
- 平台（用户系统、权限、小程序宫格、管理后台）+ MCP 服务 + 新增小程序流水线，全部跑在一个 Worker
- 小程序纯前端（逻辑在浏览器），数据经平台统一 Data API 存取，按用户强隔离
- agent 经 MCP 认证后上传，平台代建 PR；PR 分支可直接预览（测试态）
- 所有风险操作有确认浮窗

**非目标（v0.1 明确不做）**
- 多语言、站内通知、应用市场/评分
- 小程序自定义后端逻辑（不允许小程序自带服务端）
- 原生移动 App（网页自适应到手机可用即可）
- 邮箱自助找回密码、开放注册（预留开关，不实现）
- 更细的权限组（仅三种角色）

**反目标（出现即失败）**
- 用户数据、密码、token 进入 git 仓库
- 小程序代码能跨用户读写数据
- 未授权用户能看到或打开未授权小程序（包括 API 层面）
- 风险操作（删除、停用、重置密码等）无确认直接生效

## 3. 已定的关键决策

| # | 决策 | 内容 |
|---|------|------|
| D1 | 托管环境 | Cloudflare Workers；用户操作 Cloudflare 连接 GitHub 仓库部署 |
| D2 | 数据库 | 一套 Cloudflare D1（SQLite）。平台表 `t_` 前缀；小程序表 `a_<applet_id>_<表名>` 前缀。不按小程序分库（免费版仅 10 库、加绑定需重新部署） |
| D3 | 静态资源 | Worker 运行时读不了 git：同步器（Cron + GitHub webhook 双通道）把 `applets/<id>/` 拉进 R2，Worker 按 `/app/<id>/` 路由。测试态可从 PR 分支同步预览 |
| D4 | 小程序形态 | 纯前端页面 + 平台 Data API；小程序在 `applet.json` 清单声明自己的数据表，平台校验后自动建表 |
| D5 | 数据隔离 | Data API（`/api/data/<applet>/<table>`）自动注入 `user_id` 过滤；禁原始 SQL；管理端可查看/导出各小程序表 |
| D6 | 角色 | 普通用户 / 管理员 / 超级管理员（admin）。管理员管平台参数与普通用户；超管额外可管管理员账号。不做更细权限 |
| D7 | 账号来源 | v0.1 仅管理员创建账号；注册开关在系统设置预留。量级几十到几百人 |
| D8 | 登录保护 | 同一账号连续 5 次失败锁定 10 分钟，管理员可解锁；不引入图形验证码 |
| D9 | 密码找回 | 管理员重置；超管可重置包括管理员在内的所有人 |
| D10 | 小程序可见性 | 默认新增小程序对普通用户不可见、对所有管理员可见；管理员可按应用授权/拒绝具体用户 |
| D11 | 小程序状态 | 测试（新识别的默认态：管理员可用，普通用户不可见不可用）/ 启用（被授权用户可用）/ 停用（所有人不可用；普通用户不可见，管理员可见不可开）；"已删除"是操作结果而非状态：代码从仓库移除、R2 与 D1 数据一并清除 |
| D12 | PR 合并 | 管理员在"小程序管理"页一键合并（平台调 GitHub API），合并后自动同步 |
| D13 | Agent 准入 | 管理员生成一次性准入码 → agent 连 `/mcp` 凭码提交申请（含身份标识）→ 管理员在"Agent 认证"页审批 → 平台签发长期 MCP API Key；可吊销；全程审计 |
| D14 | 上传链路 | 认证 agent 调 MCP 上传工具 → 平台用自己的 GitHub token 建分支、提交、开 PR（平台因此天然知晓所有 PR）。不用 agent 自己的 GitHub 身份 |
| D15 | 删除策略 | 硬删除；确认浮窗红字警示"代码与全部用户数据将永久删除" |
| D16 | 新增向导 | 五步进度条：基本信息 → 开发（提示词引导连 MCP 拿规范）→ 规范自检（MCP 检查工具产出问题清单）→ 修正 → 上传（MCP 建 PR）。每步提示词可复制 |
| D17 | 自动检查 | 平台对 PR/新增小程序跑结构校验（清单完整性、目录结构、数据表声明、安全红线），问题清单可复制给 agent 修正；另加 GitHub Actions 对 PR 跑结构校验+构建检查 |
| D18 | 命名 | 仓库 `applet-platform`；显示名「Applet 平台」（系统设置可改） |
| D19 | 技术栈 | 前端 Vue 3 + Element Plus + Vite（中文文档全、表格/表单/弹窗齐）；后端 Worker TS + D1 + R2；MCP 同 Worker `/mcp` 路由 |
| D20 | 设计语言 | 「苍青工板」（用户已确认 A）：白面板 + 浅灰画布 `#F6F7F5` + 唯一交互色苍青 `#176E68`；状态灯 = 圆点+文字（启用绿 `#2F8A4C` / 测试橙 `#B9791F` / 停用灰 `#9AA5A2`）；扁平、1px 细边、无渐变；登录页淡方格底纹 + 居中白卡；侧栏两分区（通用/管理员）可折叠成图标条；宫格 = 图标 + 名称（+ 状态灯仅管理员可见） |
| D21 | admin 密码 | 部署时生成强随机密码，存 Worker Secrets；仓库中只有占位符。由部署流程告知用户（不上 git） |
| D22 | 确认浮窗 | 用户/小程序状态变更、删除、重置密码、吊销密钥、合并 PR 等风险操作全部先弹确认 |
| D23 | 域名 | 用户已有域名并将绑定（workers.dev 仅作开发调试）；部署文档写明域名绑定步骤；cookie/iframe 按同源域名部署 |
| D24 | 表结构演进 | 新版本 `tables` 仅允许**新增列**（平台自动 `ALTER TABLE ADD COLUMN`，存量数据兼容）；改类型/删列/删表/改表名在检查时一律拒绝；确需破坏性变更走"删除重建"（数据清空，红字确认） |
| D25 | Agent 能力边界 | 按 applet 绑定：agent 审批后默认只能操作**其提交过的小程序**（首次提交建立归属）；管理员可在 Agent 认证页为 agent 追加授权其他小程序。每个 agent 有唯一指纹：agent_id + 身份标识；其提交的 commit author 固定为 `applet-agent[<agent_id>]`，git 历史可追溯 |
| D26 | 批量写入 | Data API 提供 `/api/data/<applet>/<table>/batch`（单事务），服务导入类场景（如导入词库）；配额按行数累计 |
| D27 | 删除用户连带 | 删除用户时一并硬删其在所有小程序的数据（确认浮窗红字注明"该用户在各应用的数据将同时清除"） |
| D28 | 重复上传语义 | 分支固定 `applet/<id>`；已有 open PR 时 force-push 更新**同一 PR**（`t_prs` 保持单条 open 记录），不堆积 |
| D29 | 资产上限 | 小程序静态资产：单文件 ≤5MB、总计 ≤20MB，检查器强制；富媒体需求未来再评估 |
| D30 | 不用 KV | 修正第 4 节笔误：架构不使用 KV（同步状态/限流都在 D1 与内存中解决） |
| D31 | 示例小程序 | 仓库随附 `applets/word-cards/`（背单词）示例，兼作规范的活文档，并作为 v0.1 的功能性测试载体 |
| D32 | 限额一事一议 | 全局限额（数据行数/存储、资产大小）之外，管理员可在小程序编辑页为**单个应用设置专属限额覆盖全局默认**（如行数、20MB 总量、代码规模超限时）；检查报告与上传错误会明确列出超限项，管理员照单放通；调整入审计日志。不建 agent 侧的申请审批流（v0.1 管理员即审批人） |
| D33 | 双主题 | 苍青工板提供浅色（默认，见 D20）与深色两套主题，共用同一色相系统（深色：深灰绿画布 `#121816`、面板 `#1A211F`、苍青提亮为 `#2FA39A` 保证对比度）；用户在个人信息页自由切换，偏好存用户档案（未登录跟随系统偏好）；基于 CSS 变量实现，Element Plus 暗色模式 |
| D34 | git 权限 | 用户的 git 已配置免密推送：仓库创建与 push 由开发助手完成；Cloudflare 侧（创建 Worker/D1/R2/Secrets/域名绑定）由用户操作或临时授权 |

## 4. 仓库结构

```
applet-platform/
├─ platform/               # 平台本体（Vue3 SPA + Worker 后端）
│  ├─ src/                 # 前端
│  ├─ worker/              # Worker：API、MCP、同步器、静态路由
│  └─ wrangler.toml        # D1/R2 绑定、cron 配置
├─ applets/                # 小程序根目录（每个子目录 = 一个小程序）
│  └─ word-cards/
│     ├─ applet.json       # 清单：id、名称、图标、入口、数据表声明
│     ├─ index.html
│     ├─ assets/…
│     └─ …（纯前端产物）
├─ docs/
│  ├─ superpowers/specs/   # 本文档
│  └─ applet-spec.md       # 小程序开发规范（MCP 下发的同一份内容）
└─ .github/workflows/      # PR 结构校验 + 构建检查
```

## 5. 数据模型（D1）

平台表（`t_` 前缀）：
- `t_users`：id、username、password_hash、role（user/admin/superadmin）、nickname、status（正常/锁定）、failed_count、locked_until、created_at
- `t_sessions`：token、user_id、expires_at（或用签名 cookie，实现者定）
- `t_applets`：id、name、path、icon、status（testing/enabled/disabled）、entry、created_at、sync_commit
- `t_applet_acls`：applet_id、user_id、allowed（1/0）
- `t_agents`：id、name（身份标识）、fingerprint、key_hash、status（pending/approved/revoked）、applied_at、approved_by、last_seen
- `t_agent_applets`：agent_id、applet_id、source（submitted=首次提交建立 / granted=管理员追加）——agent 可操作范围
- `t_agent_access_codes`：code、created_by、used_by、expires_at、used_at
- `t_audit_logs`：id、actor_type（user/agent/system）、actor_id、action、target、detail、ip、at
- `t_settings`：key、value（站点名、注册开关、锁定阈值等）
- `t_prs`：applet_id、pr_number、branch、state（open/merged/closed）、check_report

小程序表：`a_<applet_id>_<table>`，由 `applet.json` 的 `tables` 声明生成，每张表必须含平台注入的 `user_id` 列。

`applet.json` 清单（规范核心）：
```json
{
  "id": "word-cards",
  "name": "背单词",
  "icon": "icon.svg 或 emoji",
  "entry": "index.html",
  "version": "1.0.0",
  "tables": [
    { "name": "words", "columns": [
      { "name": "word", "type": "text", "required": true },
      { "name": "meaning", "type": "text" },
      { "name": "status", "type": "integer", "default": 0 }
    ]}
  ]
}
```

## 6. 接口设计（概要）

认证与会话：
- `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/me`

用户侧：
- `GET /api/my/applets`（仅返回被授权且启用的应用）
- `GET /api/my/usage`（各应用数据用量）
- `GET /api/my/export?applet=` / `POST /api/my/purge?applet=`（确认后清自己的数据）

数据 API（小程序调用）：
- `GET|POST|PUT|DELETE /api/data/<applet_id>/<table>`——自动注入 `user_id` 条件；表名/列名白名单校验；分页、排序参数固定格式；超出配额返回明确错误
- `POST /api/data/<applet_id>/<table>/batch`——单事务批量写入（D26）

管理 API（admin 及以上，逐条审计）：
- 用户：`/api/admin/users` CRUD、`POST .../reset-password`、`POST .../lock|unlock`、批量导入
- 小程序：`/api/admin/applets` CRUD、`POST .../status`（enable/disable/testing）、`/authorize` 批量授权、`DELETE`（硬删除）、`POST .../merge-pr`
- Agent：`/api/admin/agents` 审批/拒绝/吊销、`POST /api/admin/access-codes` 生成准入码
- 系统：`/api/admin/settings`、`/api/admin/logs`、`/api/admin/sync`（手动触发同步）
- 校验报告：`GET /api/admin/applets/<id>/check-report`

MCP（`/mcp` 路由，Streamable HTTP）：
- `get_spec(section)`：下发开发规范（结构/清单/数据/安全/接口）
- `check_applet(payload)`：对传入的目录树跑规范校验，返回结构化问题清单（供 agent 修正）
- `submit_applet(payload)`：凭 API Key 上传；校验 agent 对该 applet 的操作权限（D25：submitted 建立归属或 granted 授权）；平台建/更新分支 `applet/<id>`（已有 open PR 则 force-push 更新同一 PR，D28），commit author 为 `applet-agent[<agent_id>]`
- `get_status(applet_id)`：查询审核状态与报告（agent 仅能查询其可操作的 applet）

## 7. 同步与状态机

- 同步器（Cron 每 5 分钟 + GitHub webhook `push`/`pull_request` 事件）：
  - main 分支 `applets/` 与 `t_applets` 比对：新增目录 → 注册为 `testing`；消失目录 → 提示管理员确认后删除（不自动删）
  - `testing` 状态且有 open PR 的应用：从 PR 分支同步进 R2 的 preview 区，管理员可预览
- 状态机：`testing ⇄ enabled ⇄ disabled`；`testing/disabled/enabled → deleted`（硬删除，需确认浮窗）。合并 PR 后自动 `testing → enabled`（或保持 testing，管理页一个开关，默认直接启用——实现者定，倾向保持 testing 并提示管理员手动启用）
- 删除动作：确认浮窗（红字）→ 调 GitHub API 提交删除目录的 commit → 清 R2 → drop 该 applet 的 `a_*` 表 → 清 ACL/注册记录 → 审计日志

## 8. 安全红线（小程序规范，MCP 下发 + 自动检查）

1. 仅纯前端：HTML/CSS/JS（原生或构建产物），不含服务端代码、不含可执行二进制
2. 数据仅经平台 Data API 存取；禁止直连任何数据库；如需第三方 API 必须在 `applet.json` 的 `external_apis` 声明（域名白名单），未声明的外部请求视为违规
3. 禁止：`eval`/`new Function`、内联事件外的动态代码、加载外部未声明脚本、`document.cookie` 操作、访问 `window.top`、修改平台 DOM（容器隔离：iframe sandbox）
4. 每张数据表必须含 user_id 语义（平台自动注入，应用不得伪造他人 user_id）
5. 单应用数据配额：默认 10,000 行 / 20MB（`t_settings` 可调；管理员可按 D32 为单个应用设置专属限额覆盖全局默认）
6. 代码规模提示：主逻辑源码超过 ~10,000 行时检查器出 warn（不阻断），管理员可按 D32 放通或要求拆分
6. 必须含 `applet.json` 且字段齐全；id 与目录名一致；图标存在
7. 不出现：密钥/密码硬编码、混淆代码、minified 后不可读的主逻辑（构建产物除外，需附 source map 或未压缩校验文件——实现者可放宽为"提交源码目录"）
8. 静态资产：单文件 ≤5MB、总计 ≤20MB（D29）

自动检查器：MCP `check_applet` 与 CI 共用同一套规则实现（worker 端 TS 模块），输出 `{ level: error|warn, rule, file, message }[]`；error 阻断上传。

## 9. 页面清单与交互

用户侧（左栏"通用"分区）：
- 首页：问候 + 应用宫格（图标+名称；管理员视角加状态灯与虚线"新增"格）
- 个人信息：昵称、改密码（旧密码验证）、登录历史（近 10 条）、主题切换（浅/深，D33）
- 我的应用：每应用一栏（用量：行数/最近使用）+ 导出我的数据（JSON 下载）+ 清除我的数据（确认浮窗）

管理侧（左栏"管理员"分区，普通用户完全不可见）：
- 用户管理：表格（搜索/筛选）、新建、编辑、重置密码（确认）、锁定/解锁（确认）、删除（确认+红字，注明其各应用数据同时清除，D27）、CSV 批量导入
- 小程序管理：表格（应用/状态/授权/数据表/操作）＋"新增小程序"五步向导（进度条；第 2/3/5 步提供可复制提示词块）；行操作：编辑（含专属限额覆盖，D32）、授权（批量多选用户）、状态切换（确认）、合并 PR（仅 testing+PR 就绪，确认）、检查报告（问题清单可复制）、删除（确认+红字）
- Agent 认证：生成准入码（一次性、可设过期）；申请列表（agent 标识/指纹/时间）；审批/拒绝（确认）；已批准列表含密钥（仅创建时可见一次）、可操作小程序范围（submitted/granted，可追加授权）、最后活跃、吊销（确认）；点击查看该 agent 审计记录
- 系统设置：站点名、注册开关（预留禁用态）、锁定阈值、数据配额、GitHub 连接状态（token 有效性、最近同步时间）、手动同步按钮
- 操作日志：全平台敏感操作只读流水，按操作人/对象/时间筛选

通用交互：所有破坏性操作 → Element Plus 确认弹窗（危险按钮红色）；提示词块统一"复制"按钮；空状态给引导文案；移动端侧栏折叠为汉堡。

## 10. 部署与运维

- 用户流程：助手免密创建 GitHub `applet-platform` 仓库并 push v0.1（D34）→ Cloudflare 创建 Worker 连接该仓库（**用户操作**）→ 配置 Secrets（`GITHUB_TOKEN`、`ADMIN_INIT_PASSWORD`、`MCP_SIGNING_KEY`）→ 创建 D1 + R2 并绑定 → 首次部署引导页完成初始化（建 admin、写默认设置）→ 绑定用户自有域名（D23，文档写步骤；workers.dev 仅调试用，国内访问不可靠）；README 写清每一步
- wrangler.toml 绑定 D1（`DB`）、R2（`ASSETS`）、Cron Trigger；README 写清部署步骤
- 版本 v0.1；public 仓库；Secrets 不入 git

## 11. 留给实现者的决定

- 会话机制细节（签名 cookie vs session 表）
- 密码哈希算法（建议 PBKDF2/WebCrypto 内置，Worker 无 bcrypt 原生）
- iframe 沙箱参数细节与 Data API 鉴权传递方式（postMessage 握手 or 同源 token）
- 前端路由与组件划分、组件目录结构
- 测试框架选型（建议 Vitest，规则引擎必须有单测）
- 合并 PR 后是否自动启用的默认值（倾向保持 testing）
- GitHub API 库选型（octokit 或裸 fetch）

## 12. 验收要点（v0.1 完成的标志）

1. admin 登录 → 创建普通用户与管理员 → 普通用户登录仅见"通用"分区与空宫格
2. 通过向导五步（复制提示词给真实 agent）完成一个小程序上传 → PR 出现 → 合并 → 普通用户被授权后可见可用
3. 背单词类应用：两个用户各自录入数据互不可见；API 直接伪造他人 user_id 无效
4. 停用/删除/重置密码/吊销密钥均有确认浮窗；删除后 R2、D1 表、仓库目录三处干净
5. 未认证 agent 调 MCP 被拒；未审批 agent 无法上传；吊销后立即失效
6. 结构检查器对缺清单、越权表、eval 等给出可复制的明确报告
7. 示例小程序 `applets/word-cards/` 随仓库附带（D31），功能完整可作为规范参照
