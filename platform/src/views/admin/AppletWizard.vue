<script setup lang="ts">
// 新增小程序五步向导（D16）：①基本信息 ②开发提示词 ③自检提示词 ④问题清单 ⑤上传提示词 → 轮询识别
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { devPrompt, checkPrompt, uploadPrompt } from '../../data/prompts';
import { api } from '../../api/client';

const emit = defineEmits<{ created: [] }>();

const step = ref(0);
const mcpUrl = `${window.location.origin}/mcp`;
const knownPaths = ref<Set<string>>(new Set());

const form = ref({ id: '', name: '', icon: '' });

const idRe = /^[a-z][a-z0-9-]*$/;
const idOk = computed(() => idRe.test(form.value.id));
const nameOk = computed(() => form.value.name.trim().length > 0);
const canNext = computed(() => (step.value === 0 ? idOk.value && nameOk.value : true));

const dev = computed(() => devPrompt(form.value, mcpUrl));
const check = computed(() => checkPrompt(form.value, mcpUrl));
const upload = computed(() => uploadPrompt(form.value, mcpUrl));

const stepTitles = ['基本信息', '开发', '规范自检', '检查结果', '上传'];

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  ElMessage.success('已复制到剪贴板');
}

function next() {
  if (!canNext.value) return;
  step.value = Math.min(step.value + 1, 4);
}
function prev() {
  step.value = Math.max(step.value - 1, 0);
}

// 第 4 步开始轮询：等新 applet 出现（测试态）→ 完成向导
let pollTimer: number | undefined;
const waiting = ref(false);
const detected = ref(false);

onMounted(async () => {
  const res = await api<{ applets: { path: string }[] }>('/api/admin/applets');
  knownPaths.value = new Set(res.applets.map((a) => a.path));
});

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});

function startPolling() {
  waiting.value = true;
  pollTimer = window.setInterval(async () => {
    try {
      const res = await api<{ applets: { path: string }[] }>('/api/admin/applets');
      const fresh = res.applets.find((a) => a.path === form.value.id && !knownPaths.value.has(a.path));
      if (fresh) {
        window.clearInterval(pollTimer);
        waiting.value = false;
        detected.value = true;
        ElMessage.success(`已识别到新小程序「${form.value.name}」，默认处于测试状态`);
      }
    } catch { /* 轮询失败下次再试 */ }
  }, 5000);
}
</script>

<template>
  <div class="wizard">
    <el-steps :active="step" align-center finish-status="success" class="steps">
      <el-step v-for="t in stepTitles" :key="t" :title="t" />
    </el-steps>

    <!-- 第 1 步：基本信息 -->
    <section v-if="step === 0" class="body">
      <el-form label-width="90px">
        <el-form-item label="小程序 ID" :error="form.id && !idOk ? '小写字母开头，只能含小写字母、数字、连字符' : ''">
          <el-input v-model="form.id" placeholder="word-cards" />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="form.name" placeholder="背单词" />
        </el-form-item>
        <el-form-item label="图标">
          <el-input v-model="form.icon" placeholder="📚（emoji，可选）" style="width: 200px" />
        </el-form-item>
      </el-form>
      <p class="hint">ID 即小程序在仓库中的目录名（applets/&lt;ID&gt;/），创建后不可更改。</p>
    </section>

    <!-- ②开发 ③自检 ⑤上传：提示词卡片 -->
    <section v-if="step === 1 || step === 2 || step === 4" class="body">
      <h3>{{ step === 1 ? '把下面的提示词复制给你的 agent（开发）' : step === 2 ? '复制提示词让 agent 自检并修正' : '复制提示词让 agent 上传（提交 PR）' }}</h3>
      <div class="prompt-card">
        <pre>{{ step === 1 ? dev : step === 2 ? check : upload }}</pre>
      </div>
      <div class="row">
        <el-button type="primary" @click="copy(step === 1 ? dev : step === 2 ? check : upload)">复制提示词</el-button>
        <span v-if="step === 1" class="hint">agent 完成开发后，进入下一步做规范自检。</span>
        <span v-else-if="step === 2" class="hint">agent 报告 issues 为空（或仅剩可解释的 warn）后，进入下一步。</span>
        <span v-else class="hint">agent 上传后平台自动建 PR；下方按钮开始等待平台识别。</span>
      </div>
    </section>

    <!-- 第 4 步：等待识别 -->
    <section v-if="step === 3" class="body center">
      <template v-if="!detected">
        <el-icon class="spin" :size="28"><i class="el-icon-loading" /></el-icon>
        <p>{{ waiting ? `等待 agent 完成上传…（每 5 秒检查一次「${form.id}」是否出现在小程序列表）` : 'agent 上传完成后点击下方按钮开始检测。' }}</p>
        <el-button v-if="!waiting" type="primary" @click="startPolling">开始检测</el-button>
      </template>
      <template v-else>
        <el-result icon="success" title="已识别到新小程序" :sub-title="`「${form.name}」已进入小程序列表（测试状态）`">
          <template #extra>
            <el-button type="primary" @click="emit('created')">完成</el-button>
          </template>
        </el-result>
      </template>
    </section>

    <footer class="foot">
      <el-button v-if="step > 0 && step !== 3" @click="prev">上一步</el-button>
      <el-button v-if="step < 3 && step !== 4" type="primary" :disabled="!canNext" @click="next">
        {{ step === 2 ? 'agent 自检完成后，下一步' : '下一步' }}
      </el-button>
      <el-button v-if="step === 4 && detected" type="success" @click="emit('created')">完成</el-button>
    </footer>
  </div>
</template>

<style scoped>
.wizard { display: flex; flex-direction: column; gap: 16px; }
.steps { margin-bottom: 8px; }
.body { min-height: 240px; }
.body h3 { font-size: 14px; margin: 0 0 10px; }
.prompt-card { background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 300px; overflow: auto; }
.prompt-card pre { margin: 0; white-space: pre-wrap; font-size: 12.5px; line-height: 1.7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.hint { font-size: 12px; color: var(--ink-3); }
.center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.spin { animation: rotate 1s linear infinite; }
@keyframes rotate { to { transform: rotate(360deg); } }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
