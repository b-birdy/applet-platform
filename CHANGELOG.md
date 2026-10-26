# Changelog

## v0.1 (2026-10-26)

首个可用版本。

### 平台核心
- 用户/角色体系：普通用户 / 管理员 / 超级管理员（admin）；管理员建号制（开放注册预留）；登录失败锁定（阈值/时长可配）；管理员重置密码
- 小程序宫格首页 + 沙箱 iframe 容器（无同源授权，token postMessage 注入，60 分钟轮换）
- 个人中心：昵称/密码/主题（深浅双主题，苍青工板设计语言）/登录历史
- 我的应用：数据用量、JSON 导出、自助清除（确认弹窗）

### 小程序体系
- `applets/<id>/` 目录约定 + `applet.json` 清单（数据表声明、external_apis 白名单）
- 统一 Data API：按用户强隔离、列白名单、单事务 batch、每用户配额（管理员可按应用覆盖）
- 表结构演进：仅允许加列（ALTER 自动迁移），破坏性变更拒绝
- 内置运行时 `window.applet.data(table)` CRUD
- 示例小程序：背单词（word-cards）

### 管理端
- 用户管理（增删改查/重置/锁定/CSV 批量导入）
- 小程序管理（状态机 testing/enabled/disabled、批量授权、专属配额、检查报告、硬删除——代码/资源/数据三清）
- 新增小程序五步向导（可复制提示词：开发/自检/上传，自动轮询识别新应用）
- Agent 认证（准入码申请 → 审批 → API Key 签发 → 追加授权 → 吊销）
- 系统设置、操作日志（全量审计）

### 流水线
- GitHub 同步器：Cron 每 5 分钟 + webhook 实时（push/PR），消失目录标记 missing 不自动删
- R2 静态托管：`/app/<id>/`（授权用户）、`/preview/<id>/`（管理员，PR 分支预览）
- PR 平台内一键合并（squash），合并后自动同步
- MCP 服务（Streamable HTTP `/mcp`）：get_spec / check_applet / submit_applet / get_status + agent_apply
- 自动规范检查器（12 规则 + CLI `pnpm check:applets`），CI 全量执行
