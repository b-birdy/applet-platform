<script setup lang="ts">
// 操作日志：只读流水 + 筛选
import { ref, onMounted } from 'vue';
import { api } from '../../api/client';

type Log = {
  id: number; actor_type: string; actor_id: string | null; action: string;
  target: string | null; detail: string | null; at: string;
  user_name: string | null; agent_name: string | null; agent_fingerprint: string | null;
};

const logs = ref<Log[]>([]);
const actor = ref('');
const action = ref('');
const loading = ref(true);

async function load() {
  loading.value = true;
  const params = new URLSearchParams();
  if (actor.value) params.set('actor', actor.value);
  if (action.value) params.set('action', action.value);
  const res = await api<{ logs: Log[] }>(`/api/admin/logs?${params}`);
  logs.value = res.logs;
  loading.value = false;
}
onMounted(load);

const ACTION_ZH: Record<string, string> = {
  'login.success': '登录成功',
  'login.failure': '登录失败',
  'login.locked': '登录被拒（已锁定）',
  'logout': '退出登录',
  'user.create': '新建用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'user.reset_password': '重置密码',
  'user.lock': '锁定用户',
  'user.unlock': '解锁用户',
  'user.import': '批量导入用户',
  'profile.password_changed': '修改自己的密码',
  'setup.init': '平台初始化',
  'settings.update': '修改系统设置',
  'sync.once': '手动同步仓库',
  'applet.create': '新建小程序',
  'applet.update': '编辑小程序',
  'applet.delete': '删除小程序',
  'applet.status': '变更小程序状态',
  'applet.authorize': '变更用户授权',
  'applet.merge_pr': '合并 PR',
  'applet.health_fix': '健康检查修复（清理孤儿表）',
  'agent.apply': 'Agent 申请接入',
  'agent.approve': '批准 Agent',
  'agent.reject': '拒绝 Agent',
  'agent.revoke': '吊销 Agent',
  'agent.grant': '授权 Agent 操作小程序',
  'agent.code_created': '生成准入码',
  'agent.submit': 'Agent 提交小程序',
  'my.purge': '用户清除自己的数据',
  'agent.import_data': 'Agent 导入数据',
};

// 操作人显示：user → 用户名（如「用户: admin」），agent → 认证名称（如「Agent: WorkBuddy 智能体（词汇整理）」）
// 后端已 join 名字；名字缺失（用户已删等）回退到 ID
function actorLabel(row: Log): string {
  if (row.actor_type === 'agent') {
    return row.agent_name ? `Agent: ${row.agent_name}` : `Agent #${row.actor_id}`;
  }
  if (row.actor_type === 'system') return '系统';
  return row.user_name ? `用户: ${row.user_name}` : `用户 #${row.actor_id}`;
}

function fmtDetail(d: string | null): string {
  if (!d) return '';
  try {
    return JSON.stringify(JSON.parse(d));
  } catch {
    return d;
  }
}
</script>

<template>
  <div>
    <header class="head">
      <h1>操作日志</h1>
      <div class="ops">
        <el-input v-model="actor" placeholder="按操作人筛选" clearable style="width: 160px" @change="load" @clear="load" />
        <el-input v-model="action" placeholder="按操作类型筛选" clearable style="width: 180px" @change="load" @clear="load" />
      </div>
    </header>

    <el-table v-loading="loading" :data="logs" stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="at" label="时间" width="165" />
      <el-table-column label="操作人" min-width="200">
        <template #default="{ row }">
          <span v-if="row.actor_type === 'agent'" class="agent-tag">{{ actorLabel(row) }}</span>
          <span v-else class="actor">{{ actorLabel(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="动作" width="170">
        <template #default="{ row }">
          <el-tooltip :content="row.action" placement="top">
            <span class="action-zh">{{ ACTION_ZH[row.action] ?? row.action }}</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column prop="target" label="对象" width="140" />
      <el-table-column label="详情" min-width="240">
        <template #default="{ row }">
          <span class="detail">{{ fmtDetail(row.detail) }}</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 17px; margin: 0; }
.ops { display: flex; gap: 8px; }
.detail { font-size: 12px; color: var(--ink-3); font-family: ui-monospace, monospace; word-break: break-all; }
.action-zh { cursor: help; border-bottom: 1px dashed var(--line-strong); }
.actor { white-space: nowrap; }
.agent-tag { white-space: nowrap; max-width: none; }
</style>
