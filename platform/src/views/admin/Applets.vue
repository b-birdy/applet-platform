<script setup lang="ts">
// 小程序管理：表格 + 编辑/授权/状态/合并 PR/检查报告/删除 + 新增向导入口
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, ApiError } from '../../api/client';
import AppletWizard from './AppletWizard.vue';
import IconPicker from '../../components/IconPicker.vue';
import { adoptPrompt } from '../../data/prompts';

type Applet = {
  id: number; name: string; path: string; icon: string | null; status: string;
  authorized_users: number; tables: number; open_prs: number; open_pr_number: number | null; missing: number;
  version: string | null;
};
type User = { id: number; username: string; role: string };

const router = useRouter();
const applets = ref<Applet[]>([]);
const users = ref<User[]>([]);
const wizardVisible = ref(false);
const reportVisible = ref(false);
const reportTarget = ref('');
const historyVisible = ref(false);
const historyTarget = ref('');
const historyData = ref<{ events: any[]; prs: any[]; agents: any[] }>({ events: [], prs: [], agents: [] });

const actionLabel: Record<string, string> = {
  'applet.create': '创建', 'applet.status': '状态变更', 'applet.authorize': '授权变更',
  'applet.update': '编辑', 'applet.delete': '删除', 'applet.merge_pr': '合并 PR',
  'agent.submit': 'Agent 提交', 'applet.import': '导入',
};

async function openHistory(a: Applet) {
  historyTarget.value = a.path;
  try {
    historyData.value = await api<any>(`/api/admin/applets/${a.path}/history`);
  } catch {
    historyData.value = { events: [], prs: [], agents: [] };
  }
  historyVisible.value = true;
}

function fmtDetail(d: any): string {
  if (d === null || d === undefined) return '';
  try { return JSON.stringify(d); } catch { return String(d); }
}
const reportIssues = ref<{ level: string; rule: string; file: string; message: string }[]>([]);

const statusLabel: Record<string, string> = { testing: '测试', enabled: '启用', disabled: '停用' };
const statusClass: Record<string, string> = { testing: 'warn', enabled: 'ok', disabled: 'off' };
const statusRowClass: Record<string, string> = { testing: 'row-testing', enabled: 'row-enabled', disabled: 'row-disabled' };
const displayLabel: Record<string, string> = { embed: '内嵌展示', new_tab: '新标签页' };

async function load() {
  const [a, u] = await Promise.all([
    api<{ applets: Applet[] }>('/api/admin/applets'),
    api<{ users: User[] }>('/api/admin/users'),
  ]);
  applets.value = a.applets;
  users.value = u.users;
}
onMounted(load);
onMounted(loadTasks);

const TRANSITIONS: Record<string, { to: string; label: string }[]> = {
  testing: [{ to: 'enabled', label: '启用' }, { to: 'disabled', label: '停用' }],
  enabled: [{ to: 'testing', label: '测试' }, { to: 'disabled', label: '停用' }],
  disabled: [{ to: 'testing', label: '测试' }, { to: 'enabled', label: '启用' }],
};

async function changeStatus(a: Applet, to: string) {
  const label = statusLabel[to] ?? to;
  await ElMessageBox.confirm(
    `将「${a.name}」状态从「${statusLabel[a.status]}」变更为「${label}」？`,
    '状态变更',
    { type: 'warning', confirmButtonText: '确认变更', cancelButtonText: '取消' }
  );
  try {
    await api(`/api/admin/applets/${a.path}/status`, { method: 'POST', body: { status: to } });
    ElMessage.success('已变更');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? (e as any).detail?.error ?? e.code : '变更失败');
  }
}

// 多选授权对话框
const authDialog = ref(false);
const authTarget = ref<Applet | null>(null);
const selected = ref<number[]>([]);
const selectedAllowed = ref(true);

async function openAuthorizeDialog(a: Applet) {
  authTarget.value = a;
  selected.value = [];
  selectedAllowed.value = true;
  authDialog.value = true;
}

async function submitAuthorize() {
  const a = authTarget.value!;
  try {
    await api(`/api/admin/applets/${a.path}/authorize`, {
      method: 'POST',
      body: { userIds: selected.value, allowed: selectedAllowed.value },
    });
    ElMessage.success('授权已更新');
    authDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error('授权失败');
  }
}

// 授权 Agent 快捷入口（从 Applets 行直接授权，复用 grant API）
const agentGrantVisible = ref(false);
const agentGrantTarget = ref<Applet | null>(null);
const agentList = ref<{ id: number; name: string; status: string }[]>([]);
const agentGrantId = ref<number | null>(null);

async function openAgentGrant(a: Applet) {
  agentGrantTarget.value = a;
  agentGrantId.value = null;
  try {
    const res = await api<{ agents: { id: number; name: string; status: string }[] }>('/api/admin/agents');
    agentList.value = res.agents.filter((x) => x.status === 'approved');
  } catch { agentList.value = []; }
  agentGrantVisible.value = true;
}

async function submitAgentGrant() {
  try {
    await api(`/api/admin/agents/${agentGrantId.value}/grant`, { method: 'POST', body: { appletId: agentGrantTarget.value!.path } });
    ElMessage.success('已授权该 agent 操作此小程序');
    agentGrantVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? (e.code === 'APPLET_NOT_FOUND' ? '小程序不存在' : e.code) : '授权失败');
  }
}

// 编辑对话框（改进 8）：名称/图标/展示方式/版本/专属配额
const editVisible = ref(false);
const editTarget = ref<Applet | null>(null);
const editForm = ref({ name: '', icon: '', display: 'embed', version: '', quotaRows: undefined as number | undefined, quotaBytes: undefined as number | undefined });

function openEdit(a: Applet) {
  editTarget.value = a;
  editForm.value = { name: a.name, icon: a.icon ?? '', display: (a as any).display ?? 'embed', version: (a as any).version ?? '', quotaRows: undefined, quotaBytes: undefined };
  editVisible.value = true;
}

async function submitEdit() {
  const a = editTarget.value!;
  const f = editForm.value;
  const body: any = {};
  if (f.name && f.name !== a.name) body.name = f.name;
  if (f.icon && f.icon !== (a.icon ?? '')) body.icon = f.icon;
  if (f.display) body.display = f.display;
  if (f.version.trim() !== ((a as any).version ?? '')) body.version = f.version.trim();
  const quota: any = {};
  if (f.quotaRows !== undefined && !Number.isNaN(Number(f.quotaRows))) quota.rows = Number(f.quotaRows);
  if (f.quotaBytes !== undefined && !Number.isNaN(Number(f.quotaBytes))) quota.bytes = Number(f.quotaBytes);
  if (Object.keys(quota).length) body.quota = quota;
  try {
    await api(`/api/admin/applets/${a.path}`, { method: 'PUT', body });
    editVisible.value = false;
    ElMessage.success('已保存');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '保存失败');
  }
}

const healthChecks = ref<{ area: string; name: string; ok: boolean; message: string }[] | null>(null);
const healthOk = ref(true);

async function checkReport(a: Applet) {
  reportTarget.value = a.path;
  healthChecks.value = null;
  try {
    const res = await api<{ issues: typeof reportIssues.value }>(`/api/admin/applets/${a.path}/check-report`);
    reportIssues.value = res.issues;
  } catch {
    reportIssues.value = [];
  }
  // 健康检查（功能测试模块）：静态规范 + 运行时完整性 + 数据层
  try {
    const h = await api<{ ok: boolean; checks: typeof healthChecks.value }>(`/api/admin/applets/${a.path}/health`);
    healthChecks.value = h.checks;
    healthOk.value = h.ok;
  } catch {
    healthChecks.value = null;
  }
  reportVisible.value = true;
}

// 复制给 agent 的完整健康报告（含修复提示词引导）
function copyHealth() {
  const lines: string[] = [];
  if (healthChecks.value) {
    lines.push('【平台健康检查报告】');
    for (const c of healthChecks.value) {
      lines.push(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.area} / ${c.name}: ${c.message}`);
    }
    if (!healthOk.value) {
      lines.push('');
      lines.push('请根据以上 FAIL 项修复小程序（保持 applet.json 清单与代码一致），');
      lines.push('然后调用 check_applet 自检清零并重新 submit_applet 提交（同分支自动更新 PR）。');
    }
  }
  if (reportIssues.value.length) {
    lines.push('');
    lines.push('【静态规范问题】');
    lines.push(...reportIssues.value.map((i) => `[${i.level}] ${i.rule} ${i.file}: ${i.message}`));
  }
  navigator.clipboard.writeText(lines.join('\n') || '全部通过');
  ElMessage.success('健康报告已复制，可粘贴给 agent');
}

function copyReport() {
  const text = reportIssues.value.map((i) => `[${i.level}] ${i.rule} ${i.file}: ${i.message}`).join('\n') || '无问题';
  navigator.clipboard.writeText(text);
  ElMessage.success('问题清单已复制，可粘贴给 agent');
}

async function mergePR(a: Applet) {
  await ElMessageBox.confirm(
    `合并「${a.name}」的 PR #${a.open_pr_number ?? '?'}？合并后平台将自动同步上线，小程序保持当前状态不变（测试/启用/停用均不变更）。`,
    '合并 PR',
    { type: 'warning', confirmButtonText: '合并', cancelButtonText: '取消' }
  );
  try {
    const res = await api<{ pr: number }>(`/api/admin/applets/${a.path}/merge-pr`, { method: 'POST' });
    ElMessage.success(`PR #${res.pr} 已合并并同步`);
    // 2 秒后自动刷新（等平台同步完成），列表的「合并 PR」按钮消失
    setTimeout(load, 2000);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? (e.code === 'NO_OPEN_PR' ? '没有待合并的 PR' : e.code) : '合并失败');
  }
}

async function remove(a: Applet) {
  try {
    await ElMessageBox.confirm(
      `将永久删除小程序「${a.name}」：git 仓库中的代码、R2 中的资源、全部用户的${a.tables}张数据表将被清空，且不可恢复。确定删除吗？`,
      '删除小程序',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
  } catch { return; }
  try {
    await api(`/api/admin/applets/${a.path}`, { method: 'DELETE' });
    ElMessage.success('已删除（仓库/资源/数据已清空）');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '删除失败');
  }
}

function handleRowCmd(row: Applet, cmd: string) {
  if (cmd.startsWith('status:')) { changeStatus(row, cmd.slice(7)); return; }
  if (cmd === 'authorize-user') { openAuthorizeDialog(row); return; }
  if (cmd === 'authorize-agent') { openAgentGrant(row); return; }
  if (cmd === 'adopt-agent') { openAdoptAgent(row); return; }
  if (cmd === 'delete') { remove(row); return; }
}

// 新 Agent 接管已有小程序：自动生成准入码，内嵌完整提示词（申请→授权→修改→提交）
const adoptVisible = ref(false);
const adoptTarget = ref<Applet | null>(null);
const adoptCode = ref('');
const adoptPromptText = ref('');
const mcpUrl = `${window.location.origin}/mcp`;
async function openAdoptAgent(a: Applet) {
  adoptTarget.value = a;
  adoptCode.value = '';
  adoptVisible.value = true;
  adoptPromptText.value = adoptPrompt({ id: a.path, name: a.name }, mcpUrl);
  try {
    const code = await api<{ code: string }>('/api/admin/access-codes', { method: 'POST', body: {} });
    adoptCode.value = code.code;
    adoptPromptText.value = adoptPrompt({ id: a.path, name: a.name }, mcpUrl, code.code);
  } catch { /* 准入码生成失败不阻断——提示词走索取文案 */ }
}
async function copyAdopt() {
  await navigator.clipboard.writeText(adoptPromptText.value);
  ElMessage.success('已复制到剪贴板');
  // 接管提示词复制 → 开一张 modify 任务（推进中任务列表可见）
  try {
    await api('/api/admin/tasks/track', { method: 'POST', body: { kind: 'modify', path: adoptTarget.value!.path } });
  } catch { /* 静默 */ }
}

function onWizardCreated() {
  wizardVisible.value = false;
  load();
}

// 推进中任务：数量徽标 + 抽屉列表
type TaskRow = { key: string; kind: 'create' | 'modify'; path: string; name: string; step: string; step_label: string; pr_number: number | null; started_at: string | null; aged: boolean };const tasksVisible = ref(false);
const tasks = ref<TaskRow[]>([]);
const taskCount = ref(0);
const tasksLoading = ref(false);

async function loadTasks() {
  tasksLoading.value = true;
  try {
    const res = await api<{ tasks: TaskRow[]; active: number }>('/api/admin/tasks');
    tasks.value = res.tasks;
    taskCount.value = res.active;
  } catch { /* 静默 */ }
  tasksLoading.value = false;
}

async function cancelTask(t: TaskRow) {
  try {
    await api(`/api/admin/tasks/${t.kind}/${t.path}/cancel`, { method: 'POST' });
    await loadTasks();
  } catch { /* 静默 */ }
}

// 平台总览：30 天使用统计（宫格打开打点聚合）+ PR 红点数
type UsageRow = { path: string; opens: number; users: number };
const usageVisible = ref(false);
const usageRows = ref<UsageRow[]>([]);
const usageLoading = ref(false);

async function openUsage() {
  usageVisible.value = true;
  usageLoading.value = true;
  try {
    const res = await api<{ usage: UsageRow[] }>('/api/admin/overview');
    usageRows.value = res.usage;
  } catch { /* 静默 */ }
  usageLoading.value = false;
}

const kindLabel: Record<string, string> = { create: '新建', modify: '修改' };
const stepTag: Record<string, { type: 'warning' | 'primary' | 'success'; label: string }> = {
  waiting_submit: { type: 'warning', label: '等待提交' },
  pr_open: { type: 'primary', label: 'PR 待合并' },
  done: { type: 'success', label: '已完成' },
};

// 版本切换：历史提交列表 + 回退确认（git 历史保留、数据承载校验在服务端）
type VersionRow = { sha: string; message: string; date: string; author: string };
const verVisible = ref(false);
const verTarget = ref<Applet | null>(null);
const versions = ref<VersionRow[]>([]);
const verLoading = ref(false);

// 提交信息「submit applet X by agent N: <changelog>」→ 显示 changelog 段（无则显示原文）
function verLabel(v: VersionRow): string {
  const m = v.message.match(/by agent \d+: (.+)$/);
  return m ? m[1] : v.message;
}

async function openVersions(a: Applet) {
  verTarget.value = a;
  verVisible.value = true;
  verLoading.value = true;
  versions.value = [];
  try {
    const res = await api<{ versions: VersionRow[] }>(`/api/admin/applets/${a.path}/versions`);
    versions.value = res.versions;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '版本历史加载失败');
  }
  verLoading.value = false;
}

async function switchVersion(v: VersionRow) {
  const a = verTarget.value!;
  await ElMessageBox.confirm(
    `将「${a.name}」的代码回退到 ${v.sha.slice(0, 7)}（${v.message}）？\n\n· 以一次新的回退提交完成，git 历史保留、随时可切回\n· 用户数据不受影响\n· 若旧版本的数据表无法承载现有数据结构，切换会被拒绝并说明原因`,
    '版本切换',
    { type: 'warning', confirmButtonText: '确认切换', cancelButtonText: '取消', customStyle: { whiteSpace: 'pre-line' } as any }
  );
  try {
    await api(`/api/admin/applets/${a.path}/switch-version`, { method: 'POST', body: { sha: v.sha } });
    ElMessage.success('已切换并同步上线');
    verVisible.value = false;
    setTimeout(load, 1500);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DATA_INCOMPATIBLE') {
      ElMessageBox.alert((e as any).detail?.message ?? '旧版本的数据表无法承载切换', '切换失败', { type: 'error' });
    } else {
      ElMessage.error(e instanceof ApiError ? e.code : '切换失败');
    }
  }
}
</script>

<template>
  <div>
    <header class="head">
      <h1>小程序管理</h1>
      <div class="head-ops">
        <el-badge :value="taskCount" :hidden="taskCount === 0" type="warning">
          <el-button @click="tasksVisible = true; loadTasks()">推进中任务</el-button>
        </el-badge>
        <el-tooltip content="近 30 天各小程序的打开次数与使用人数（宫格点击打点）" placement="bottom">
          <el-button @click="openUsage">使用统计</el-button>
        </el-tooltip>
        <el-button type="primary" @click="wizardVisible = true">＋ 新增小程序</el-button>
      </div>
    </header>

    <el-table :data="applets" stripe :row-class-name="({ row }: any) => statusRowClass[row.status] ?? ''">
      <el-table-column label="应用" min-width="150">
        <template #default="{ row }">
          <div class="appname">
            <img v-if="row.icon && row.icon.startsWith('data:image')" class="ic img" :src="row.icon" alt="">
            <span v-else class="ic">{{ row.icon || '▣' }}</span>
            <div>
              <b>
                {{ row.name }}
                <el-badge v-if="row.missing" is-dot type="danger" title="仓库中已不存在" />
              </b>
              <div class="path">applets/{{ row.path }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span class="st" :class="statusClass[row.status]"><i></i>{{ statusLabel[row.status] }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="authorized_users" label="授权用户" width="86" align="center" />
      <el-table-column label="开发者" min-width="90">
        <template #default="{ row }">
          <span class="muted" :class="{ 'dev-agent': !(row as any).developer_user }">{{ (row as any).developer_user || (row as any).developer_agent || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="版本" width="64" align="center">
        <template #default="{ row }">
          <span class="muted">{{ row.version || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="tables" label="数据表" width="70" align="center" />
      <el-table-column label="展示方式" width="84" align="center">
        <template #default="{ row }">
          <span class="muted">{{ displayLabel[(row as any).display] ?? '内嵌展示' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="PR" width="70" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.open_prs" type="warning" size="small">待合并</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="440" align="left" class-name="ops-col">
        <template #default="{ row }">
          <div class="ops-row">
            <el-tooltip content="名称/图标/展示方式/专属配额" placement="top">
              <el-button size="small" @click="openEdit(row)">编辑</el-button>
            </el-tooltip>
            <el-dropdown trigger="click" @command="(cmd: string) => handleRowCmd(row, cmd)">
              <el-button size="small">状态▾</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="t in TRANSITIONS[row.status] ?? []" :key="t.to" :command="'status:' + t.to">
                    切换到{{ t.label }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-tooltip content="静态规范 + 运行时 + 数据层综合检查" placement="top">
              <el-button size="small" @click="checkReport(row)">健康报告</el-button>
            </el-tooltip>
            <el-tooltip content="该小程序的完整操作时间线" placement="top">
              <el-button size="small" @click="openHistory(row)">操作历史</el-button>
            </el-tooltip>
            <el-tooltip content="查看历史提交并回退到任一版本（git 历史保留，数据承载校验自动进行）" placement="top">
              <el-button size="small" @click="openVersions(row)">版本切换</el-button>
            </el-tooltip>
            <el-button v-if="row.open_prs" size="small" type="primary" @click="mergePR(row)">合并 PR</el-button>
            <el-dropdown trigger="click" @command="(cmd: string) => handleRowCmd(row, cmd)">
              <el-button size="small">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="authorize-user">授权用户…</el-dropdown-item>
                  <el-dropdown-item command="authorize-agent">授权 Agent…</el-dropdown-item>
                  <el-dropdown-item command="adopt-agent">新 Agent 接管…</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除小程序…</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增向导 -->
    <el-dialog v-model="wizardVisible" title="新增小程序（三步向导）" width="760px" destroy-on-close>
      <AppletWizard @created="onWizardCreated" />
    </el-dialog>

    <!-- 授权对话框 -->
    <el-dialog v-model="authDialog" :title="`授权 — ${authTarget?.name}`" width="480px">
      <p class="hint">勾选要授权的用户（当前已授权 {{ authTarget?.authorized_users }} 人）：</p>
      <el-select v-model="selected" multiple filterable placeholder="选择用户" style="width: 100%">
        <el-checkbox
          :model-value="selected.length === users.length && users.length > 0"
          :indeterminate="selected.length > 0 && selected.length < users.length"
          @change="selected = ($event as any) ? users.map((u: User) => u.id) : []"
          style="margin: 0 0 6px 4px">全选（{{ users.length }}）</el-checkbox>
        <el-option v-for="u in users" :key="u.id" :label="u.username" :value="u.id" />
      </el-select>
      <el-switch v-model="selectedAllowed" active-text="允许" inactive-text="拒绝" style="margin-top: 12px" />
      <template #footer>
        <el-button @click="authDialog = false">取消</el-button>
        <el-button type="primary" :disabled="selected.length === 0" @click="submitAuthorize">应用授权</el-button>
      </template>
    </el-dialog>

    <!-- 授权 Agent 对话框 -->
    <el-dialog v-model="agentGrantVisible" :title="`授权 Agent — ${agentGrantTarget?.name}`" width="440px">
      <p class="hint">选择一个已批准的 agent，允许它对本小程序提交修改（PR）：</p>
      <el-select v-model="agentGrantId" filterable placeholder="选择 agent" style="width: 100%">
        <el-option v-for="a in agentList" :key="a.id" :label="a.name" :value="a.id" />
      </el-select>
      <p class="hint" style="margin-top: 8px">没有目标 agent？先到「Agent 认证」页审批接入。</p>
      <template #footer>
        <el-button @click="agentGrantVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!agentGrantId" @click="submitAgentGrant">授权</el-button>
      </template>
    </el-dialog>

    <!-- 编辑对话框 -->
    <el-dialog v-model="editVisible" :title="`编辑 — ${editTarget?.name}`" width="480px">
      <el-form label-width="90px" @submit.prevent>
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="图标">
          <IconPicker v-model="editForm.icon" />
        </el-form-item>
        <el-form-item label="展示方式">
          <el-radio-group v-model="editForm.display">
            <el-tooltip content="点击宫格后在平台页面内的框架中打开" placement="top">
              <el-radio value="embed">内嵌展示</el-radio>
            </el-tooltip>
            <el-tooltip content="点击宫格后在浏览器新标签页打开" placement="top">
              <el-radio value="new_tab">新标签页</el-radio>
            </el-tooltip>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="版本号">
          <el-tooltip content="两级版本号（v主.次，如 v1.0 / v2.3）。agent 提交新版时会按清单自动更新，此处可手工修正" placement="top">
            <el-input v-model="editForm.version" placeholder="v1.0" style="width: 140px" />
          </el-tooltip>
        </el-form-item>
        <el-form-item label="专属配额">
          <div class="quota-grid">
            <el-input-number v-model="editForm.quotaRows" :min="100" :max="1000000" :step="1000" placeholder="行数" controls-position="right" />
            <span class="muted">行 / 用户（留空用全局值）</span>
            <el-input-number v-model="editForm.quotaBytes" :min="1048576" :max="1073741824" :step="1048576" placeholder="字节" controls-position="right" />
            <span class="muted">字节 / 用户（留空用全局值）</span>
          </div>
        </el-form-item>
      </el-form>
      <p class="hint" style="margin: 0 0 10px">专属配额：本应用每个用户可存的数据上限，覆盖系统设置里的全局默认值。</p>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新 Agent 接管：准入码 + 完整提示词 -->
    <el-dialog v-model="adoptVisible" :title="`新 Agent 接管 — ${adoptTarget?.name}`" width="640px">
      <p class="hint" style="margin: 0 0 10px">
        把下面的提示词复制给新的 agent。它先凭提示词内嵌的准入码申请接入，你审批后
        <b>记得在「授权 Agent…」里把本小程序的编辑权授给它</b>（提示词中也已告知它这一点）。
      </p>
      <div class="prompt-card">
        <pre>{{ adoptPromptText }}</pre>
      </div>
      <template #footer>
        <el-button type="primary" @click="copyAdopt">复制提示词</el-button>
      </template>
    </el-dialog>

    <!-- 历史时间线抽屉（日志管理） -->
    <el-drawer v-model="historyVisible" :title="`操作历史 — ${historyTarget}`" size="520px">
      <h3 class="hist-h">归属 Agent</h3>
      <el-empty v-if="historyData.agents.length === 0" description="无归属 agent" :image-size="50" />
      <div v-else class="hist-agents">
        <el-tag v-for="a in historyData.agents" :key="a.id" style="margin: 0 6px 6px 0">
          {{ a.name }}（{{ a.source === 'submitted' ? '首次提交' : '管理员授权' }}）
        </el-tag>
      </div>

      <h3 class="hist-h">PR 记录</h3>
      <el-empty v-if="historyData.prs.length === 0" description="无 PR 记录" :image-size="50" />
      <div v-else class="hist-prs">
        <div v-for="p in historyData.prs" :key="p.pr_number" class="hist-pr">
          PR #{{ p.pr_number }} — {{ p.branch }} <el-tag size="small" :type="p.state === 'open' ? 'warning' : p.state === 'merged' ? 'success' : 'info'">{{ p.state }}</el-tag>
        </div>
      </div>

      <h3 class="hist-h">事件时间线（{{ historyData.events.length }}）</h3>
      <el-empty v-if="historyData.events.length === 0" description="暂无事件" :image-size="50" />
      <el-timeline v-else style="padding-left: 4px">
        <el-timeline-item v-for="(e, i) in historyData.events" :key="i" :timestamp="e.at" placement="top">
          <b>{{ actionLabel[e.action] ?? e.action }}</b>
          <span class="hist-actor"> — {{ e.actorType === 'agent' ? `agent ${e.actorName}` : e.actorName ?? e.actorId }}</span>
          <div v-if="e.detail" class="hist-detail">{{ fmtDetail(e.detail) }}</div>
        </el-timeline-item>
      </el-timeline>
    </el-drawer>

    <!-- 检查报告抽屉 -->
    <el-drawer v-model="reportVisible" :title="`健康报告 — ${reportTarget}`" size="520px">
      <template v-if="healthChecks">
        <h3 class="rep-h">功能健康检查（{{ healthOk ? '全部通过' : '存在 FAIL 项' }}）</h3>
        <ul class="issues">
          <li v-for="(c, idx) in healthChecks" :key="'h' + idx" :class="c.ok ? 'pass' : 'error'">
            <b>{{ c.area }} / {{ c.name }}</b>
            <span>{{ c.message }}</span>
          </li>
        </ul>
      </template>
      <h3 class="rep-h">静态规范问题（{{ reportIssues.length }}）</h3>
      <el-empty v-if="reportIssues.length === 0" description="无问题（全部通过）" :image-size="50" />
      <ul v-else class="issues">
        <li v-for="(i, idx) in reportIssues" :key="idx" :class="i.level">
          <b>[{{ i.level }}] {{ i.rule }}</b>
          <span>{{ i.file }}: {{ i.message }}</span>
        </li>
      </ul>
      <el-button style="margin-top: 12px" @click="copyHealth">复制完整报告（给 agent）</el-button>
    </el-drawer>

    <!-- 推进中任务抽屉 -->
    <el-drawer v-model="tasksVisible" title="推进中任务" size="460px">
      <p class="hint" style="margin: 0 0 12px">复制提示词后自动开单；agent 提交 PR 后进入「待合并」，合并即自动关单（新建任务）或按合并时间判定（修改任务）。任务挂起 7 天以上会标灰提醒。</p>
      <div v-loading="tasksLoading">
        <el-empty v-if="!tasksLoading && tasks.length === 0" description="暂无推进中的任务" :image-size="60" />
        <div v-for="t in tasks" :key="t.key" class="task" :class="{ aged: t.aged, done: t.step === 'done' }">
          <div class="task-top">
            <el-tag size="small" :type="t.kind === 'create' ? 'success' : 'primary'">{{ kindLabel[t.kind] }}</el-tag>
            <b>{{ t.name }}</b>
            <span class="task-path">{{ t.path }}</span>
            <el-tag size="small" :type="stepTag[t.step]?.type ?? 'info'" style="margin-left: auto">{{ stepTag[t.step]?.label ?? t.step_label }}</el-tag>
          </div>
          <div class="task-meta">
            <span v-if="t.step_label && t.step !== 'pr_open'">{{ t.step_label }}</span>
            <span v-if="t.started_at">开始于 {{ t.started_at }}</span>
            <span v-if="t.aged" class="aged-note">已挂起 7 天以上</span>
            <el-button v-if="t.step !== 'done'" text size="small" type="danger" @click="cancelTask(t)">作废</el-button>
          </div>
        </div>
      </div>
    </el-drawer>
    <!-- 使用统计抽屉 -->
    <el-drawer v-model="usageVisible" title="应用使用统计（近 30 天）" size="440px">
      <p class="hint" style="margin: 0 0 12px">数据来自用户从首页宫格打开应用的打点（2026-10-29 起生效，历史无数据）。</p>
      <div v-loading="usageLoading">
        <el-empty v-if="!usageLoading && usageRows.length === 0" description="暂无打开记录" :image-size="60" />
        <div v-for="u in usageRows" :key="u.path" class="usage-row">
          <b class="mono">{{ u.path }}</b>
          <span class="usage-nums">{{ u.opens }} 次打开 · {{ u.users }} 个用户</span>
        </div>
      </div>
    </el-drawer>

    <!-- 版本切换弹窗 -->
    <el-dialog v-model="verVisible" :title="`版本切换 — ${verTarget?.name}`" width="640px">
      <p class="hint" style="margin: 0 0 10px">
        每行是一个历史版本（最近在上）。切换以一次新的回退提交完成：git 历史保留、用户数据不动；
        若旧版本的数据表无法承载现有数据结构，切换会被拒绝并说明原因。
      </p>
      <div v-loading="verLoading" class="ver-list">
        <el-empty v-if="!verLoading && versions.length === 0" description="没有历史版本（可能只有一个提交）" :image-size="60" />
        <table v-else-if="!verLoading" class="ver-table">
          <thead>
            <tr><th style="width: 90px">版本</th><th>修改说明</th><th style="width: 110px">切换</th></tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.sha">
              <td class="mono">{{ v.sha.slice(0, 7) }}</td>
              <td>
                <div class="ver-msg">{{ verLabel(v) }}</div>
                <div class="ver-meta">{{ v.author }} · {{ v.date?.replace('T', ' ').slice(0, 16) }}</div>
              </td>
              <td><el-button size="small" @click="switchVersion(v)">切换到此版本</el-button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.head-ops { display: flex; align-items: center; gap: 12px; }
.task { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
.task.aged { opacity: .62; }
.task.done { opacity: .5; }
.task-top { display: flex; align-items: center; gap: 8px; }
.task-path { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, monospace; }
.task-meta { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-size: 12px; color: var(--ink-3); flex-wrap: wrap; }
.aged-note { color: var(--warn); }
.ver-list { max-height: 420px; overflow: auto; }
.ver-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ver-table th { text-align: left; font-size: 12px; color: var(--ink-3); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.ver-table td { padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.ver-msg { font-size: 13px; }
.ver-meta { font-size: 11px; color: var(--ink-3); margin-top: 2px; }
h1 { font-size: 17px; margin: 0; }
.appname { display: flex; align-items: center; gap: 9px; }
.appname .ic { width: 28px; height: 28px; border-radius: 7px; background: var(--accent-weak); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 15px; }
.appname .ic.img { object-fit: cover; background: var(--surface-2); }
.appname .path { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, monospace; }
.muted { color: var(--ink-3); }
.ops-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ops-row .el-button { margin: 0; }
.row-testing td { background: color-mix(in srgb, var(--warn) 8%, transparent) !important; }
.row-enabled td { background: color-mix(in srgb, var(--ok) 6%, transparent) !important; }
.row-disabled td { background: color-mix(in srgb, var(--off) 8%, transparent) !important; }
.quota-grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 10px; align-items: center; }
.hint { font-size: 12px; color: var(--ink-3); }
.hist-h { font-size: 13px; margin: 14px 0 8px; }
.hist-prs .hist-pr { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.hist-actor { color: var(--ink-3); font-size: 12px; }
.hist-detail { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, monospace; word-break: break-all; margin-top: 2px; }
.hint { font-size: 13px; color: var(--ink-2); margin-top: 0; }
.issues { list-style: none; padding: 0; margin: 0; }
.issues li { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 8px; font-size: 13px; }
.issues li.error { border-color: var(--danger); }
.issues li.warn { border-color: var(--warn); }
.issues li.pass { border-color: var(--ok); }
.rep-h { font-size: 13px; margin: 12px 0 8px; }
.prompt-card { background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 380px; overflow: auto; }
.prompt-card pre { margin: 0; white-space: pre-wrap; font-size: 12.5px; line-height: 1.7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
