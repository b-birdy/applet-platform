<script setup lang="ts">
// 新增小程序三步向导：①基本信息+需求（SDD） ②开发提示词（自检+上传已合并） ③等待识别 → 轮询
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { devPrompt, existingAppletPrompt } from '../../data/prompts';
import { api } from '../../api/client';
import IconPicker from '../../components/IconPicker.vue';

// 向导打开时自动生成一次性准入码（24h），直接内嵌进提示词，省一轮「向管理员要码」的对话
const accessCode = ref('');

const emit = defineEmits<{ created: [] }>();

const step = ref(0);
const mcpUrl = `${window.location.origin}/mcp`;
const knownPaths = ref<Set<string>>(new Set());

const form = ref({
  id: '', name: '', icon: '',
  version: 'v0.1',
  target: '电脑端',
  purpose: '',
  features: [''] as string[],
  avoid: [] as string[],
});

const idRe = /^[a-z][a-z0-9-]*$/;
const versionRe = /^v?\d+\.\d+$/;
const idOk = computed(() => idRe.test(form.value.id));
const nameOk = computed(() => form.value.name.trim().length > 0);
const versionOk = computed(() => versionRe.test(form.value.version.trim()));
const purposeOk = computed(() => form.value.purpose.trim().length > 0);
const featuresOk = computed(() => form.value.features.some((f) => f.trim().length > 0));
const canNext = computed(() => (step.value === 0 ? idOk.value && nameOk.value && versionOk.value && purposeOk.value && featuresOk.value : true));

// 需求说明整合进提示词（SDD）：版本号/终端/用途/功能点/避免项
function reqMeta() {
  return {
    version: form.value.version.trim().replace(/^v/i, '') ? `v${form.value.version.trim().replace(/^v/i, '')}` : undefined,
    target: form.value.target,
    purpose: form.value.purpose.trim(),
    features: form.value.features.map((f) => f.trim()).filter(Boolean),
    avoid: form.value.avoid.map((f) => f.trim()).filter(Boolean),
  };
}
const hasExisting = ref(false); // 已开发完成的成品 → 显示接入式提示词
const dev = computed(() => (hasExisting.value ? existingAppletPrompt({ id: form.value.id, name: form.value.name, icon: form.value.icon || undefined, ...reqMeta() }, mcpUrl, accessCode.value || undefined) : devPrompt({ id: form.value.id, name: form.value.name, icon: form.value.icon || undefined, ...reqMeta() }, mcpUrl, accessCode.value || undefined)));

const stepTitles = ['基本信息', '开发并上传', '等待识别'];

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  ElMessage.success('已复制到剪贴板');
  // 复制即开单/刷新任务时间线（推进中任务）；失败静默（不影响主流程）
  try {
    await api('/api/admin/tasks/track', { method: 'POST', body: { kind: 'create', path: form.value.id } });
  } catch { /* 下次复制再试 */ }
}

function next() {
  if (!canNext.value) return;
  step.value = Math.min(step.value + 1, 2);
}
function prev() {
  step.value = Math.max(step.value - 1, 0);
}

// 第 3 步开始轮询：等新 applet 出现（测试态）→ 完成向导
let pollTimer: number | undefined;
const waiting = ref(false);
const detected = ref(false);

onMounted(async () => {
  const res = await api<{ applets: { path: string }[] }>('/api/admin/applets');
  knownPaths.value = new Set(res.applets.map((a) => a.path));
  // 自动生成准入码（失败不阻断向导——提示词回退为「向管理员索取」文案）
  try {
    const code = await api<{ code: string }>('/api/admin/access-codes', { method: 'POST', body: {} });
    accessCode.value = code.code;
  } catch { /* 保持空串，提示词走索取文案 */ }
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

    <!-- 第 1 步：基本信息 + 需求说明（SDD） -->
    <section v-if="step === 0" class="body">
      <el-alert type="info" :closable="false" style="margin-bottom: 14px">
        <el-checkbox v-model="hasExisting">这个小程序已经开发完成（提示词将改为「接入已有代码」版本）</el-checkbox>
      </el-alert>

      <div class="sec-title">基本身份</div>
      <el-form label-width="90px" class="grid2">
        <el-form-item label="小程序 ID" :error="form.id && !idOk ? '小写字母开头，只能含小写字母、数字、连字符' : ''">
          <el-tooltip content="小程序的唯一标识，即仓库中的目录名 applets/<ID>/，创建后不可更改" placement="top">
            <el-input v-model="form.id" placeholder="word-cards" />
          </el-tooltip>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="背单词" />
        </el-form-item>
        <el-form-item label="初始版本">
          <el-tooltip content="两级版本号：大版本.小版本。首次创建默认 v0.1；agent 每次提交可升级" placement="top">
            <el-input v-model="form.version" placeholder="v0.1" style="width: 140px" :class="{ bad: form.version && !versionOk }" />
          </el-tooltip>
        </el-form-item>
        <el-form-item label="图标">
          <IconPicker v-model="form.icon" />
        </el-form-item>
      </el-form>

      <div class="sec-title">功能需求<el-tooltip content="以下说明会自动整合进给 agent 的提示词中，作为开发的硬性要求" placement="top"><span class="q">?</span></el-tooltip></div>
      <el-form label-width="90px">
        <el-form-item label="适配终端">
          <el-radio-group v-model="form.target">
            <el-tooltip content="主要在桌面浏览器使用，按宽屏布局设计" placement="top"><el-radio value="电脑端">电脑端</el-radio></el-tooltip>
            <el-tooltip content="主要在手机使用，按窄屏布局设计，注意触控友好" placement="top"><el-radio value="手机端">手机端</el-radio></el-tooltip>
            <el-tooltip content="两种终端都要良好可用（响应式布局）" placement="top"><el-radio value="电脑端 + 手机端">两者兼顾</el-radio></el-tooltip>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="用途" :error="form.purpose && !purposeOk ? '' : undefined">
          <el-input v-model="form.purpose" type="textarea" :rows="2" placeholder="这个小程序解决什么问题、给谁用（必填）" />
        </el-form-item>
        <el-form-item label="主要功能点" :error="form.features.length && !featuresOk ? '' : undefined">
          <div class="lines">
            <div v-for="(f, i) in form.features" :key="i" class="line">
              <el-input v-model="form.features[i]" placeholder="一个功能点一行（至少一条，必填）" />
              <el-button v-if="form.features.length > 1" text @click="form.features.splice(i, 1)">✕</el-button>
            </div>
            <el-button text type="primary" @click="form.features.push('')">＋ 增加功能点</el-button>
          </div>
        </el-form-item>
        <el-form-item label="需要避免">
          <div class="lines">
            <div v-for="(f, i) in form.avoid" :key="i" class="line">
              <el-input v-model="form.avoid[i]" placeholder="明确不要做的细节，如：不要自动播放声音" />
              <el-button text @click="form.avoid.splice(i, 1)">✕</el-button>
            </div>
            <el-button text type="primary" @click="form.avoid.push('')">＋ 增加避免项（可选）</el-button>
          </div>
        </el-form-item>
      </el-form>
      <p class="hint">ID 即小程序在仓库中的目录名（applets/&lt;ID&gt;/），创建后不可更改。功能需求会整合进下一步的提示词。</p>
    </section>

    <!-- ②开发（含自检+上传）：提示词卡片 -->
    <section v-if="step === 1" class="body">
      <h3>{{ hasExisting ? '复制提示词给你的 agent（接入已有小程序）' : '把下面的提示词复制给你的 agent（开发 → 自检 → 上传，一次完成）' }}</h3>
      <div class="prompt-card">
        <pre>{{ dev }}</pre>
      </div>
      <div class="row">
        <el-button type="primary" @click="copy(dev)">复制提示词</el-button>
        <span class="hint">agent 会自动完成开发、规范自检并上传建 PR；完成后进入下一步等待平台识别。</span>
      </div>
    </section>

    <!-- 第 3 步：等待识别 -->
    <section v-if="step === 2" class="body center">
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
      <el-button v-if="step > 0 && step !== 2" @click="prev">上一步</el-button>
      <el-button v-if="step < 2" type="primary" :disabled="!canNext" @click="next">下一步</el-button>
    </footer>
  </div>
</template>

<style scoped>
.wizard { display: flex; flex-direction: column; gap: 16px; }
.steps { margin-bottom: 8px; }
.body { min-height: 240px; }
.body h3 { font-size: 14px; margin: 0 0 10px; }
.sec-title { font-size: 13px; font-weight: 600; color: var(--ink); margin: 14px 0 10px; padding-left: 8px; border-left: 3px solid var(--accent); display: flex; align-items: center; gap: 6px; }
.sec-title .q {
  display: inline-flex; align-items: center; justify-content: center;
  width: 15px; height: 15px; border-radius: 50%; font-size: 11px; font-weight: 400;
  background: var(--accent-weak); color: var(--accent); cursor: help;
}
.grid2 { display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; }
@media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
.lines { width: 100%; }
.line { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.line .el-input { flex: 1; }
.bad :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px var(--danger) inset; }
.prompt-card { background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 300px; overflow: auto; }
.prompt-card pre { margin: 0; white-space: pre-wrap; font-size: 12.5px; line-height: 1.7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.hint { font-size: 12px; color: var(--ink-3); }
.center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.spin { animation: rotate 1s linear infinite; }
@keyframes rotate { to { transform: rotate(360deg); } }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
