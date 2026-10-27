// 新增小程序向导的三段提示词模板（D16）
// 管理员复制给 agent；MCP 工具名与 spec/实现保持一致
export type AppletMeta = {
  id: string; name: string; icon?: string;
  version?: string;        // 初始版本号（v0.1 形式，写入 applet.json）
  target?: string;         // 适配终端
  purpose?: string;        // 用途
  features?: string[];     // 主要功能点
  avoid?: string[];        // 需要避免的细节
};

const RULES = `· 只做这个小程序本身，不要改动仓库里其他文件；
· 全程使用简体中文注释与界面文案；
· 数据只能通过平台运行时 window.applet 存取，禁止任何绕过。`;

// 管理员在向导第一步填写的需求说明 → 提示词的【功能需求】块
function requirementBlock(a: AppletMeta): string {
  const lines: string[] = [];
  if (a.version) lines.push(`· 初始版本号：${a.version}（写入 applet.json 的 version 字段，格式 v<主>.<次>）`);
  if (a.target) lines.push(`· 适配终端：${a.target}`);
  if (a.purpose) lines.push(`· 用途：${a.purpose}`);
  if (a.features?.length) {
    lines.push('· 主要功能点（逐一实现）：');
    a.features.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
  }
  if (a.avoid?.length) {
    lines.push('· 需要避免的细节（硬性约束）：');
    a.avoid.forEach((f) => lines.push(`  - ${f}`));
  }
  if (!lines.length) return '';
  return `
【功能需求】
${lines.join('\n')}
`;
}

export function devPrompt(a: AppletMeta, mcpUrl: string, accessCode?: string): string {
  const codeLine = accessCode
    ? `连接凭一次性准入码（24 小时内有效）：${accessCode}`
    : `连接需要一次性准入码（向平台管理员索取）`;
  return `请为本平台开发一个小程序，然后交付可上传的文件集。

【目标】开发小程序「${a.name}」（id: ${a.id}${a.icon ? `，图标建议 ${a.icon}` : ''}）。
${requirementBlock(a)}
【第一步 · 获取规范】
连接平台 MCP 服务（Streamable HTTP）：${mcpUrl}
${codeLine}。连接后先调用工具 get_spec（不传参数获取全部章节），逐条阅读 structure / manifest / data / security / upload 五节规范。

【第二步 · 开发】
按规范在本地目录 ${a.id}/ 中完成开发：
${RULES}
· 必须包含 applet.json 清单（id 必须是 "${a.id}"），数据表在 tables 中声明；如该应用更适合在新标签页打开（而非平台内嵌），在清单加 "display": "new_tab"；
· 入口 HTML 必须引入 <script src="/app-runtime.js"></script>；
· 界面遵循平台设计语言（消费 --canvas/--panel/--ink/--accent 等 CSS 变量，自动适配深浅色）。

完成后把所有文件放在 ${a.id}/ 目录下准备检查。`;
}

export function checkPrompt(a: AppletMeta, mcpUrl: string): string {
  return `请对小程序「${a.name}」（id: ${a.id}）做上传前的规范自检并修正。

【准备】
连接平台 MCP 服务：${mcpUrl}（准入码向管理员索取，若已连接可复用会话）。

【自检】
调用工具 check_applet，参数：
· applet_id: "${a.id}"
· files: ${a.id}/ 目录下全部文件（相对路径 → 文本内容）

【修正】
对返回的 issues 列表逐条处理：
· level 为 "error" 的问题必须全部修正（会阻断上传）；
· level 为 "warn" 的问题评估后能修则修（如 size.loc 行数超限可说明理由交管理员裁定）；
· 修正后再次调用 check_applet，重复直到 issues 为空（或仅剩可解释的 warn）。

${RULES}`;
}

export function existingAppletPrompt(a: AppletMeta, mcpUrl: string, accessCode?: string): string {
  const codeLine = accessCode
    ? `一次性准入码（24 小时内有效）：${accessCode}`
    : `一次性准入码向管理员索取`;
  return `我有一个已经开发完成的小程序，请把它接入本平台并上传。

【目标】把现成的小程序接入平台，id 定为「${a.id}」（显示名「${a.name}」）。
${requirementBlock(a)}
【准备】
连接平台 MCP 服务：${mcpUrl}
· 准入码：${codeLine}。首次使用先用准入码调用 agent_apply 申请接入，等管理员审批拿到 API Key 后继续；
· 已接入：直接用 API Key。

【第一步 · 了解平台约定】
调用工具 get_spec 获取完整规范，重点阅读 structure（目录结构与 app-runtime.js 引入）与 manifest（清单字段）两节。

【第二步 · 适配改造】
在本地把现有代码整理为 ${a.id}/ 目录：
· 创建 applet.json 清单：id 必须是 "${a.id}"；在 tables 中声明该应用需要的数据表（字段按实际需要）；如需调用第三方 API，域名写入 external_apis；
· 入口 HTML 引入 <script src="/app-runtime.js"></script>，数据读写改用 window.applet.data(表名)（平台按登录用户自动隔离数据）；
· 样式建议消费平台的 CSS 变量（--canvas/--panel/--ink/--accent 等）以自动适配深浅色主题；
· 若应用希望在新标签页而非平台内嵌框架中打开，在 applet.json 中加 "display": "new_tab"。

【第三步 · 自检并上传】
调用 check_applet({ applet_id: "${a.id}", files }) 自检，把所有 error 级问题修正至清零；然后调用 submit_applet 提交（平台自动建 PR），报告返回的 pr_number 给管理员。

${RULES}`;
}

export function uploadPrompt(a: AppletMeta, mcpUrl: string): string {
  return `小程序「${a.name}」（id: ${a.id}）已通过自检，现在执行上传。

【准备】
连接平台 MCP 服务：${mcpUrl}（需要已获批的 agent API key；若是首次使用该服务，先用一次性准入码调用 agent_apply 申请，等管理员审批后再继续）。

【上传】
调用工具 submit_applet，参数：
· applet_id: "${a.id}"
· name: "${a.name}"
· files: ${a.id}/ 目录下全部文件（相对路径 → 文本内容）

【提交后】
· 记录返回的 pr_number；
· 调用 get_status 确认 PR 状态为 open、check_report 无 error 级问题；
· 向管理员报告：${a.id} 已提交（PR #<pr_number>），等待平台内审阅合并。

注意：若 submit_applet 返回 issues（含 error），回到检查环节修正后重新提交；若返回 AGENT_SCOPE，说明该小程序归属其他 agent，停止操作并报告管理员。`;
}

// 新 Agent 接管已有小程序（管理员在小程序管理「更多」里生成，准入码自动内嵌）
export function adoptPrompt(a: AppletMeta, mcpUrl: string, accessCode?: string): string {
  const codeLine = accessCode
    ? `一次性准入码（24 小时内有效）：${accessCode}`
    : `一次性准入码向管理员索取`;
  return `请你接手维护平台上的已有小程序「${a.name}」（id: ${a.id}），后续负责它的功能迭代与修复。

【准备 · 申请接入】
连接平台 MCP 服务（Streamable HTTP）：${mcpUrl}
${codeLine}。用该准入码调用 agent_apply 申请接入（name 填你的名字，fingerprint 填你的唯一标识），等管理员审批拿到 API Key 后继续。管理员审批通过后，会把本小程序的编辑权授予你。

【第一步 · 了解现状】
1. 调用工具 get_spec（不传参数获取全部章节），逐条阅读 structure / manifest / data / security / upload 五节规范；
2. 从 GitHub 仓库拉取现有代码：applets/${a.id}/ 目录下是全部文件（清单 applet.json + 入口 HTML + 脚本 + 样式），通读理解当前实现；
3. 调用 get_status({ applet_id: "${a.id}" }) 确认归属与状态。

【第二步 · 修改】
按管理员的任务要求修改代码：
${RULES}
· 修改数据表结构时只允许加列（ALTER ADD COLUMN），破坏性变更需要先与管理员沟通；
· 提交的文件集始终包含 ${a.id}/ 目录的全部文件（未改动的文件也要带上）。

【第三步 · 自检并提交】
调用 check_applet({ applet_id: "${a.id}", files }) 自检，把所有 error 级问题修正至清零；然后调用 submit_applet 提交，平台自动建 PR，把返回的 pr_number 报告给管理员审阅合并。

【提交后】
调用 get_status 确认 PR 为 open 且 check_report 无 error；管理员合并后平台自动同步上线。`;
}
