<script setup lang="ts">
// Agent 认证：准入码生成（显示一次）/申请审批/已批准管理/追加授权/吊销
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, ApiError } from '../../api/client';

type Agent = {
  id: number; name: string; fingerprint: string; status: 'pending' | 'approved' | 'revoked';
  applied_at: string; last_seen: string | null; applet_count: number;
};
type Applet = { id: number; path: string };

const pending = ref<Agent[]>([]);
const approved = ref<Agent[]>([]);
const applets = ref<Applet[]>([]);
const mcpUrl = `${window.location.origin}/mcp`;
const lastCode = ref('');

async function load() {
  const [a, apps] = await Promise.all([
    api<{ agents: Agent[] }>('/api/admin/agents'),
    api<{ applets: Applet[] }>('/api/admin/applets'),
  ]);
  pending.value = a.agents.filter((x) => x.status === 'pending');
  approved.value = a.agents.filter((x) => x.status !== 'pending');
  applets.value = apps.applets;
}
onMounted(load);

async function generateCode() {
  try {
    await ElMessageBox.confirm('生成一次性准入码（默认 24 小时有效）？生成后立即显示一次，之后无法查看。', '生成准入码', {
      confirmButtonText: '生成', cancelButtonText: '取消', type: 'info',
    });
  } catch { return; }
  const res = await api<{ code: string }>('/api/admin/access-codes', { method: 'POST', body: {} });
  lastCode.value = res.code;
  ElMessage.success('准入码已生成（仅本次显示）');
}

function copyCode() {
  navigator.clipboard.writeText(lastCode.value);
  ElMessage.success('已复制');
}

async function approve(a: Agent) {
  try {
    await ElMessageBox.confirm(`批准 agent「${a.name}」（指纹 ${a.fingerprint}）接入？批准后将签发长期 API Key。`, '审批 Agent', {
      confirmButtonText: '批准', cancelButtonText: '取消', type: 'warning',
    });
  } catch { return; }
  try {
    const res = await api<{ key: string }>(`/api/admin/agents/${a.id}/approve`, { method: 'POST', body: {} });
    // 密钥仅此一次展示
    await ElMessageBox.alert(
      `<p>请立即保存以下 API Key（仅此一次展示）：</p><pre style="user-select:all">${res.key}</pre>`,
      'API Key 已签发',
      { dangerouslyUseHTMLString: true, confirmButtonText: '我已保存' }
    );
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '审批失败');
  }
}

async function reject(a: Agent) {
  try {
    await ElMessageBox.confirm(`拒绝并移除申请「${a.name}」？`, '拒绝申请', {
      confirmButtonText: '拒绝', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger',
    });
  } catch { return; }
  await api(`/api/admin/agents/${a.id}/reject`, { method: 'POST', body: {} });
  ElMessage.success('已拒绝');
  await load();
}

async function revoke(a: Agent) {
  try {
    await ElMessageBox.confirm(`吊销「${a.name}」的 API Key？吊销后该 agent 立即失去接入能力。`, '吊销 Agent', {
      confirmButtonText: '吊销', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger',
    });
  } catch { return; }
  await api(`/api/admin/agents/${a.id}/revoke`, { method: 'POST', body: {} });
  ElMessage.success('已吊销');
  await load();
}

// 追加授权
const grantDialog = ref(false);
const grantTarget = ref<Agent | null>(null);
const grantApplet = ref('');

async function openGrant(a: Agent) {
  grantTarget.value = a;
  grantApplet.value = '';
  grantDialog.value = true;
}

async function submitGrant() {
  try {
    await api(`/api/admin/agents/${grantTarget.value!.id}/grant`, { method: 'POST', body: { appletId: grantApplet.value } });
    ElMessage.success('已追加授权');
    grantDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? (e.code === 'APPLET_NOT_FOUND' ? '小程序不存在' : e.code) : '授权失败');
  }
}
</script>

<template>
  <div>
    <header class="head">
      <h1>Agent 认证</h1>
      <el-tooltip content="生成一次性接入码，交给你的 AI agent 连接 MCP 时使用，24 小时有效" placement="bottom">
        <el-button type="primary" @click="generateCode">生成准入码</el-button>
      </el-tooltip>
    </header>

    <el-alert v-if="lastCode" type="success" :closable="false" class="code-box">
      <template #title>
        最新准入码（仅此一次显示）：
        <code class="code">{{ lastCode }}</code>
        <el-button size="small" text type="primary" @click="copyCode">复制</el-button>
      </template>
      <div class="hint">agent 连接 {{ mcpUrl }} 后凭此码调用 agent_apply 申请接入，你在下方审批。</div>
    </el-alert>

    <h2 class="sec">待审批申请（{{ pending.length }}）</h2>
    <el-empty v-if="pending.length === 0" description="暂无申请" :image-size="60" />
    <el-table v-else :data="pending" stripe>
      <el-table-column prop="name" label="标识" min-width="140" />
      <el-table-column prop="fingerprint" label="指纹" min-width="160" />
      <el-table-column prop="applied_at" label="申请时间" width="170" />
      <el-table-column label="操作" width="180" align="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="approve(row)">批准</el-button>
          <el-button size="small" type="danger" plain @click="reject(row)">拒绝</el-button>
        </template>
      </el-table-column>
    </el-table>

    <h2 class="sec">已接入 Agent（{{ approved.length }}）</h2>
    <el-empty v-if="approved.length === 0" description="暂无已接入的 agent" :image-size="60" />
    <el-table v-else :data="approved" stripe>
      <el-table-column prop="name" label="标识" min-width="120" />
      <el-table-column prop="fingerprint" label="指纹" min-width="140" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <span class="st" :class="row.status === 'approved' ? 'ok' : 'off'"><i></i>{{ row.status === 'approved' ? '正常' : '已吊销' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="applet_count" label="可操作小程序" width="120" align="center" />
      <el-table-column label="操作" width="200" align="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'approved'" size="small" @click="openGrant(row)">追加授权</el-button>
          <el-button v-if="row.status === 'approved'" size="small" type="danger" plain @click="revoke(row)">吊销</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="grantDialog" :title="`追加授权 — ${grantTarget?.name}`" width="440px">
      <p class="hint">选择允许该 agent 操作的小程序（其自行提交过的已自动归属）：</p>
      <el-select v-model="grantApplet" filterable placeholder="选择小程序" style="width: 100%">
        <el-option v-for="a in applets" :key="a.id" :label="a.path" :value="a.path" />
      </el-select>
      <template #footer>
        <el-button @click="grantDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!grantApplet" @click="submitGrant">授权</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 17px; margin: 0; }
.sec { font-size: 14px; margin: 22px 0 10px; }
.code-box { margin-bottom: 8px; }
.code { font-family: ui-monospace, monospace; font-weight: 600; user-select: all; }
.hint { font-size: 12px; color: var(--ink-3); }
</style>
