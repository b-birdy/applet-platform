<script setup lang="ts">
// 用户管理：CRUD/重置密码/锁定/删除/CSV 导入（全部确认弹窗）
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, ApiError } from '../../api/client';

type User = { id: number; username: string; role: string; nickname: string | null; status: string; locked_until: string | null };
const users = ref<User[]>([]);
const q = ref('');
const roleLabel: Record<string, string> = { user: '普通用户', admin: '管理员', superadmin: '超级管理员' };

async function load() {
  const res = await api<{ users: User[] }>(`/api/admin/users${q.value ? `?q=${encodeURIComponent(q.value)}` : ''}`);
  users.value = res.users;
}
onMounted(load);

async function create() {
  const { value } = await ElMessageBox.prompt(
    '格式：用户名,密码[,昵称]（密码至少 8 位）',
    '新建用户',
    { inputPlaceholder: 'alice,password123,爱丽丝', confirmButtonText: '创建', cancelButtonText: '取消' }
  );
  const [username, password, nickname] = value.split(',').map((s: string) => s.trim());
  try {
    await api('/api/admin/users', { method: 'POST', body: { username, password, nickname: nickname || undefined } });
    ElMessage.success('已创建');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? (e.code === 'DUPLICATE' ? '用户名已存在' : e.code) : '创建失败');
  }
}

async function resetPassword(u: User) {
  const { value } = await ElMessageBox.prompt(`为「${u.username}」设置新密码（至少 8 位）`, '重置密码', {
    inputPlaceholder: 'newpassword123', confirmButtonText: '重置', cancelButtonText: '取消',
  });
  await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST', body: { newPassword: value.trim() } });
  ElMessage.success('密码已重置，该用户所有会话已失效');
}

async function toggleLock(u: User) {
  const locking = u.status !== 'locked';
  await ElMessageBox.confirm(
    locking ? `锁定「${u.username}」？其会话将立即失效。` : `解除「${u.username}」的锁定？`,
    locking ? '锁定用户' : '解锁用户',
    { type: 'warning', confirmButtonText: locking ? '锁定' : '解锁', cancelButtonText: '取消' }
  );
  await api(`/api/admin/users/${u.id}/${locking ? 'lock' : 'unlock'}`, { method: 'POST' });
  ElMessage.success(locking ? '已锁定' : '已解锁');
  await load();
}

async function remove(u: User) {
  try {
    await ElMessageBox.confirm(
      `将永久删除用户「${u.username}」，该用户在各小程序应用中的全部数据将同时清除，且不可恢复。确定删除吗？`,
      '删除用户',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
  } catch { return; }
  try {
    await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '删除失败');
  }
}

async function importCsv() {
  const { value } = await ElMessageBox.prompt(
    '每行一个用户：用户名,密码[,昵称]。重复用户名将跳过并在结果中报告。',
    '批量导入（CSV）',
    {
      inputType: 'textarea',
      inputPlaceholder: 'username,password,nickname\nbob,password123\n...',
      confirmButtonText: '导入', cancelButtonText: '取消',
    }
  );
  try {
    const res = await api<{ imported: number; failed: { username: string; reason: string }[] }>('/api/admin/users/import', {
      method: 'POST', body: { csv: value },
    });
    ElMessage.success(`导入 ${res.imported} 个，失败 ${res.failed.length} 个`);
    if (res.failed.length) {
      ElMessageBox.alert(res.failed.map((f) => `${f.username}: ${f.reason}`).join('\n'), '失败明细');
    }
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '导入失败');
  }
}
</script>

<template>
  <div>
    <header class="head">
      <h1>用户管理</h1>
      <div class="ops">
        <el-input v-model="q" placeholder="搜索用户名/昵称" clearable style="width: 200px" @change="load" @clear="load" />
        <el-button @click="importCsv">批量导入</el-button>
        <el-button type="primary" @click="create">新建用户</el-button>
      </div>
    </header>

    <el-table :data="users" stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="username" label="用户名" min-width="120" />
      <el-table-column prop="nickname" label="昵称" min-width="100" />
      <el-table-column label="角色" width="110">
        <template #default="{ row }">
          <el-tag :type="row.role === 'superadmin' ? 'danger' : row.role === 'admin' ? 'warning' : 'info'" size="small">
            {{ roleLabel[row.role] || row.role }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <span class="st" :class="row.status === 'locked' ? 'off' : 'ok'"><i></i>{{ row.status === 'locked' ? '已锁定' : '正常' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" align="right">
        <template #default="{ row }">
          <el-button size="small" @click="resetPassword(row)">重置密码</el-button>
          <el-button size="small" :type="row.status === 'locked' ? 'success' : 'warning'" plain @click="toggleLock(row)">
            {{ row.status === 'locked' ? '解锁' : '锁定' }}
          </el-button>
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 17px; margin: 0; }
.ops { display: flex; gap: 8px; }
</style>
