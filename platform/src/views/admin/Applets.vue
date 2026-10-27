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

const TRANSITIONS: Record<string, { to: string; label: string }[]> = {
  testing: [{ to: 'enabled', label: '启用' }, { to: 'disabled', label: '停用' }],
  enabled: [{ to: 'testing', label: '转回测试' }, { to: 'disabled', label: '停用' }],
  disabled: [{ to: 'enabled', label: '启用' }],
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

// 编辑对话框（改进 8）：名称/图标/展示方式/专属配额
const editVisible = ref(false);
const editTarget = ref<Applet | null>(null);
const editForm = ref({ name: '', icon: '', display: 'embed', quotaRows: undefined as number | undefined, quotaBytes: undefined as number | undefined });

function openEdit(a: Applet) {
  editTarget.value = a;
  editForm.value = { name: a.name, icon: a.icon ?? '', display: (a as any).display ?? 'embed', quotaRows: undefined, quotaBytes: undefined };
  editVisible.value = true;
}

async function submitEdit() {
  const a = editTarget.value!;
  const f = editForm.value;
  const body: any = {};
  if (f.name && f.name !== a.name) body.name = f.name;
  if (f.icon && f.icon !== (a.icon ?? '')) body.icon = f.icon;
  if (f.display) body.display = f.display;
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
    `合并「${a.name}」的 PR #${a.open_pr_number ?? '?'}？合并后平台将自动同步，应用保持「测试」状态，确认后再手动启用。`,
    '合并 PR',
    { type: 'warning', confirmButtonText: '合并', cancelButtonText: '取消' }
  );
  try {
    const res = await api<{ pr: number }>(`/api/admin/applets/${a.path}/merge-pr`, { method: 'POST' });
    ElMessage.success(`PR #${res.pr} 已合并并同步`);
    await load();
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
}

function onWizardCreated() {
  wizardVisible.value = false;
  load();
}
</script>

<template>
  <div>
    <header class="head">
      <h1>小程序管理</h1>
      <el-button type="primary" @click="wizardVisible = true">＋ 新增小程序</el-button>
    </header>

    <el-table :data="applets" stripe :row-class-name="({ row }: any) => statusRowClass[row.status] ?? ''">
      <el-table-column label="应用" min-width="200">
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
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <span class="st" :class="statusClass[row.status]"><i></i>{{ statusLabel[row.status] }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="authorized_users" label="授权用户" width="90" align="center" />
      <el-table-column prop="tables" label="数据表" width="80" align="center" />
      <el-table-column label="展示方式" width="90" align="center">
        <template #default="{ row }">
          <span class="muted">{{ displayLabel[(row as any).display] ?? '内嵌展示' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="PR" width="80" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.open_prs" type="warning" size="small">待合并</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="230" align="left" class-name="ops-col">
        <template #default="{ row }">
          <div class="ops-row">
            <el-tooltip content="名称/图标/展示方式/专属配额" placement="top">
              <el-button size="small" @click="openEdit(row)">编辑</el-button>
            </el-tooltip>
            <el-tooltip content="静态规范 + 运行时 + 数据层综合检查" placement="top">
              <el-button size="small" @click="checkReport(row)">健康报告</el-button>
            </el-tooltip>
            <el-tooltip content="该小程序的完整操作时间线" placement="top">
              <el-button size="small" @click="openHistory(row)">历史</el-button>
            </el-tooltip>
            <el-button v-if="row.open_prs" size="small" type="primary" @click="mergePR(row)">合并 PR</el-button>
            <el-dropdown trigger="click" @command="(cmd: string) => handleRowCmd(row, cmd)">
              <el-button size="small">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="t in TRANSITIONS[row.status] ?? []" :key="t.to" :command="'status:' + t.to">
                    状态 → {{ t.label }}
                  </el-dropdown-item>
                  <el-dropdown-item v-if="TRANSITIONS[row.status]?.length" divided command="authorize-user">授权用户…</el-dropdown-item>
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
    <el-dialog v-model="wizardVisible" title="新增小程序（五步向导）" width="760px" destroy-on-close>
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
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
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
