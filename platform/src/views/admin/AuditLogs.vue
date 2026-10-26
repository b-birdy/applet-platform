<script setup lang="ts">
// 操作日志：只读流水 + 筛选
import { ref, onMounted } from 'vue';
import { api } from '../../api/client';

type Log = { id: number; actor_type: string; actor_id: string | null; action: string; target: string | null; detail: string | null; at: string };

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
      <el-table-column prop="at" label="时间" width="170" />
      <el-table-column label="操作人" width="140">
        <template #default="{ row }">{{ row.actor_type }}:{{ row.actor_id ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="action" label="动作" min-width="160" />
      <el-table-column prop="target" label="对象" min-width="120" />
      <el-table-column label="详情" min-width="220">
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
</style>
