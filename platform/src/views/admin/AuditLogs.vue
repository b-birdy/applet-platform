<script setup lang="ts">
// 操作日志：只读流水 + 筛选
import { ref, onMounted } from 'vue';
import { api } from '../../api/client';
import { useIsMobile } from '../../composables/useIsMobile';

const { isMobile } = useIsMobile();

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

    <!-- 桌面：弹性表格（min-width 分配比例，无固定宽） -->
    <el-table v-if="!isMobile" v-loading="loading" :data="logs" stripe>
      <el-table-column prop="at" label="时间" min-width="150" />
      <el-table-column label="操作人" min-width="200">
        <template #default="{ row }">
          <span v-if="row.actor_type === 'agent'" class="agent-tag">{{ actorLabel(row) }}</span>
          <span v-else class="actor">{{ actorLabel(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="动作" min-width="130">
        <template #default="{ row }">
          <el-tooltip :content="row.action" placement="top">
            <span class="action-zh">{{ ACTION_ZH[row.action] ?? row.action }}</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column prop="target" label="对象" min-width="110">
        <template #default="{ row }">
          <span class="mono">{{ row.target ?? '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="详情" min-width="260">
        <template #default="{ row }">
          <span class="detail">{{ fmtDetail(row.detail) || '—' }}</span>
        </template>
      </el-table-column>
    </el-table>

    <!-- 移动端：卡片列表（无横向滚动） -->
    <div v-else v-loading="loading" class="cards">
      <div v-for="l in logs" :key="l.id" class="log-card">
        <div class="card-top">
          <el-tooltip :content="l.action" placement="top">
            <span class="action-zh">{{ ACTION_ZH[l.action] ?? l.action }}</span>
          </el-tooltip>
          <span class="card-time">{{ l.at }}</span>
        </div>
        <div class="card-actor">
          <span v-if="l.actor_type === 'agent'" class="agent-tag">{{ actorLabel(l) }}</span>
          <span v-else class="actor">{{ actorLabel(l) }}</span>
        </div>
        <div v-if="l.target" class="card-row"><span class="k">对象</span><span class="mono">{{ l.target }}</span></div>
        <div v-if="l.detail" class="card-row"><span class="k">详情</span><span class="detail">{{ fmtDetail(l.detail) }}</span></div>
      </div>
      <el-empty v-if="!loading && logs.length === 0" description="暂无日志" />
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 17px; margin: 0; }
.ops { display: flex; gap: 8px; }
.detail { font-size: 12px; color: var(--ink-3); font-family: ui-monospace, monospace; word-break: break-all; }
.action-zh { cursor: help; border-bottom: 1px dashed var(--line-strong); }
.actor { white-space: nowrap; }
.agent-tag { white-space: nowrap; }
.mono { font-size: 12px; font-family: ui-monospace, monospace; }
.cards { display: flex; flex-direction: column; gap: 10px; }
.log-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 10px 14px; font-size: 13px;
}
.card-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.card-time { font-size: 11px; color: var(--ink-3); }
.card-actor { margin-bottom: 4px; }
.card-row { display: flex; gap: 8px; margin-top: 2px; align-items: baseline; }
.card-row .k { font-size: 11px; color: var(--ink-3); flex: none; width: 30px; }
.card-row .detail, .card-row .mono { word-break: break-all; min-width: 0; }
</style>
