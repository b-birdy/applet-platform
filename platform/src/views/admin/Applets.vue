<script setup lang="ts">
// 小程序管理：表格 + 编辑/授权/状态/合并 PR/检查报告/删除 + 新增向导入口
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, ApiError } from '../../api/client';
import AppletWizard from './AppletWizard.vue';

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

async function checkReport(a: Applet) {
  reportTarget.value = a.path;
  try {
    const res = await api<{ issues: typeof reportIssues.value }>(`/api/admin/applets/${a.path}/check-report`);
    reportIssues.value = res.issues;
  } catch {
    reportIssues.value = [];
  }
  reportVisible.value = true;
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
            <span class="ic">{{ row.icon || '▣' }}</span>
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
      <el-table-column label="操作" width="420" align="right">
        <template #default="{ row }">
          <el-dropdown v-if="TRANSITIONS[row.status]?.length" trigger="click" @command="(to: string) => changeStatus(row, to)">
            <el-button size="small">状态</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="t in TRANSITIONS[row.status]" :key="t.to" :command="t.to">{{ t.label }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip content="选择哪些用户可以使用该小程序" placement="top">
            <el-button size="small" @click="openAuthorizeDialog(row)">授权</el-button>
          </el-tooltip>
          <el-tooltip content="名称/图标/展示方式/本应用专属配额" placement="top">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
          </el-tooltip>
          <el-button v-if="row.open_prs" size="small" type="primary" @click="mergePR(row)">合并 PR</el-button>
          <el-button size="small" @click="checkReport(row)">检查报告</el-button>
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
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

    <!-- 编辑对话框 -->
    <el-dialog v-model="editVisible" :title="`编辑 — ${editTarget?.name}`" width="480px">
      <el-form label-width="90px" @submit.prevent>
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="图标">
          <el-input v-model="editForm.icon" placeholder="emoji，如 📚" style="width: 160px" />
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

    <!-- 检查报告抽屉 -->
    <el-drawer v-model="reportVisible" :title="`检查报告 — ${reportTarget}`" size="480px">
      <el-empty v-if="reportIssues.length === 0" description="无问题（全部通过）" />
      <ul v-else class="issues">
        <li v-for="(i, idx) in reportIssues" :key="idx" :class="i.level">
          <b>[{{ i.level }}] {{ i.rule }}</b>
          <span>{{ i.file }}: {{ i.message }}</span>
        </li>
      </ul>
      <el-button style="margin-top: 12px" @click="copyReport">复制问题清单</el-button>
    </el-drawer>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 17px; margin: 0; }
.appname { display: flex; align-items: center; gap: 9px; }
.appname .ic { width: 28px; height: 28px; border-radius: 7px; background: var(--accent-weak); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 15px; }
.appname .path { font-size: 11px; color: var(--ink-3); font-family: ui-monospace, monospace; }
.muted { color: var(--ink-3); }
.row-testing td { background: color-mix(in srgb, var(--warn) 8%, transparent) !important; }
.row-enabled td { background: color-mix(in srgb, var(--ok) 6%, transparent) !important; }
.row-disabled td { background: color-mix(in srgb, var(--off) 8%, transparent) !important; }
.quota-grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 10px; align-items: center; }
.hint { font-size: 12px; color: var(--ink-3); }
.hint { font-size: 13px; color: var(--ink-2); margin-top: 0; }
.issues { list-style: none; padding: 0; margin: 0; }
.issues li { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 8px; font-size: 13px; }
.issues li.error { border-color: var(--danger); }
.issues li.warn { border-color: var(--warn); }
</style>
