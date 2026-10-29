<script setup lang="ts">
// 用户管理：CRUD/重置密码/锁定/删除/CSV 导入（全部确认弹窗）
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, ApiError } from '../../api/client';
import { useAuthStore } from '../../stores/auth';

const authStore = useAuthStore();

type User = { id: number; username: string; role: string; nickname: string | null; status: string; locked_until: string | null };
const users = ref<User[]>([]);
const q = ref('');
const roleLabel: Record<string, string> = { user: '普通用户', admin: '管理员', superadmin: '超级管理员' };

async function load() {
  const res = await api<{ users: User[] }>(`/api/admin/users${q.value ? `?q=${encodeURIComponent(q.value)}` : ''}`);
  users.value = res.users;
}
onMounted(load);

// 新建用户对话框（角色/密码可选/昵称）
const createVisible = ref(false);
const createForm = ref({ username: '', password: '', nickname: '', role: 'user' });
const idRe = /^[a-zA-Z0-9_-]{2,32}$/;

function openCreate() {
  createForm.value = { username: '', password: '', nickname: '', role: 'user' };
  createVisible.value = true;
}

async function submitCreate() {
  const f = createForm.value;
  if (!idRe.test(f.username)) { ElMessage.warning('用户名需 2-32 位字母/数字/下划线/连字符'); return; }
  if (f.password && f.password.length < 8) { ElMessage.warning('密码至少 8 位（留空则自动生成）'); return; }
  try {
    const res = await api<{ generatedPassword?: string }>('/api/admin/users', {
      method: 'POST',
      body: { username: f.username, password: f.password || undefined, nickname: f.nickname || undefined, role: f.role },
    });
    createVisible.value = false;
    if (res.generatedPassword) {
      await ElMessageBox.alert(
        `<p>用户「${f.username}」已创建，自动生成密码（仅此一次显示）：</p><pre style="user-select:all;font-size:15px">${res.generatedPassword}</pre>`,
        '请保存密码',
        { dangerouslyUseHTMLString: true, confirmButtonText: '我已保存' }
      );
    } else {
      ElMessage.success('已创建');
    }
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
        <el-tooltip content="创建平台账号；密码留空将自动生成并一次性显示" placement="bottom">
          <el-button type="primary" @click="openCreate">新建用户</el-button>
        </el-tooltip>
      </div>
    </header>

    <el-table :data="users" stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="username" label="用户名" min-width="100" />
      <el-table-column prop="nickname" label="昵称" min-width="80" />
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

    <!-- 新建用户对话框 -->
    <el-dialog v-model="createVisible" title="新建用户" width="460px">
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="用户名" required>
          <el-input v-model="createForm.username" placeholder="2-32 位字母/数字/下划线/连字符" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="createForm.role">
            <el-radio value="user">普通用户</el-radio>
            <el-radio v-if="authStore.isAdmin" value="admin" disabled>管理员（仅超管可建）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="createForm.nickname" placeholder="选填" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="createForm.password" type="password" show-password placeholder="留空自动生成（≥8 位）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!createForm.username" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 17px; margin: 0; }
.ops { display: flex; gap: 8px; }
</style>
