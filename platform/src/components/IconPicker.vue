<script setup lang="ts">
// 图标选择器：预置 emoji 分类网格 + 自定义上传（canvas 缩放至 128×128，data URI 存储）
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const PRESETS: { group: string; icons: string[] }[] = [
  { group: '常用', icons: ['📚', '📝', '🧮', '📊', '🗓️', '✅', '💡', '🔖', '🗂️', '📋', '🧪', '🛠️'] },
  { group: '工具', icons: ['🔧', '⚙️', '🔬', '📐', '📏', '🧰', '🔗', '📌', '🖨️', '💾', '🖥️', '⌨️'] },
  { group: '学习', icons: ['🎓', '✏️', '📖', '🔤', '🈶', '🎧', '🗣️', '🧠', '🎯', '🏆', '📈', '♾️'] },
  { group: '生活', icons: ['🌤️', '⏰', '🍎', '💪', '🧘', '💰', '🛒', '🍳', '🚗', '🏠', '🎁', '🎉'] },
  { group: '媒体', icons: ['🎵', '🎬', '📷', '🎨', '🎙️', '📻', '🖼️', '🌈', '✨', '🔮', '🃏', '🎲'] },
];

const tab = ref<'preset' | 'upload'>('preset');
const preview = ref('');
const busy = ref(false);

const isImg = computed(() => props.modelValue.startsWith('data:image'));

function pick(icon: string) {
  emit('update:modelValue', icon);
}

function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件');
    return;
  }
  busy.value = true;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      try {
        emit('update:modelValue', fitToIcon(img));
        preview.value = fitToIcon(img);
        ElMessage.success('图标已自动缩放至 128×128');
      } catch {
        ElMessage.error('图片处理失败，请换一张试试');
      }
      busy.value = false;
      input.value = '';
    };
    img.onerror = () => {
      ElMessage.error('图片无法读取');
      busy.value = false;
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
}

/** 居中裁剪为正方形并缩放至 128×128；超过 60KB 自动降质重编码 */
function fitToIcon(img: HTMLImageElement): string {
  const SIZE = 128;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  // cover-crop：取中心正方形缩放填充（图标场景优于拉伸变形）
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
  let quality = 0.92;
  let data = canvas.toDataURL('image/png');
  // PNG 对照片可能很大，超 60KB 时换 JPEG 并逐级降质
  while (data.length > 80_000 && quality >= 0.4) {
    data = canvas.toDataURL('image/jpeg', quality);
    quality -= 0.15;
    if (quality < 0.4 && data.length > 80_000) {
      // 最后手段：缩小尺寸
      const small = document.createElement('canvas');
      small.width = 64;
      small.height = 64;
      small.getContext('2d')!.drawImage(canvas, 0, 0, 64, 64);
      data = small.toDataURL('image/jpeg', 0.8);
    }
  }
  return data;
}
</script>

<template>
  <div class="icon-picker">
    <div class="tabs">
      <button type="button" class="tab" :class="{ on: tab === 'preset' }" @click="tab = 'preset'">预置图标</button>
      <button type="button" class="tab" :class="{ on: tab === 'upload' }" @click="tab = 'upload'">上传图片</button>
    </div>

    <template v-if="tab === 'preset'">
      <div v-for="g in PRESETS" :key="g.group" class="group">
        <div class="group-name">{{ g.group }}</div>
        <div class="grid">
          <button
            v-for="ic in g.icons"
            :key="ic"
            type="button"
            class="cell"
            :class="{ on: modelValue === ic }"
            @click="pick(ic)"
          >{{ ic }}</button>
        </div>
      </div>
    </template>

    <template v-else>
      <label class="drop" :class="{ busy }">
        <input type="file" accept="image/*" hidden @change="onFile">
        <template v-if="isImg || preview">
          <img class="prev" :src="modelValue.startsWith('data:image') ? modelValue : preview" alt="图标预览">
          <span class="drop-hint">点击更换图片</span>
        </template>
        <template v-else>
          <span class="drop-icon">🖼️</span>
          <span class="drop-hint">点击选择图片<br><small>自动居中裁剪并缩放至 128×128，无需手动处理尺寸</small></span>
        </template>
      </label>
    </template>

    <div v-if="modelValue" class="current">
      当前：
      <img v-if="isImg" class="cur-img" :src="modelValue" alt="">
      <span v-else class="cur-emoji">{{ modelValue }}</span>
      <button type="button" class="clear" @click="pick(''); preview = ''">清除</button>
    </div>
  </div>
</template>

<style scoped>
.icon-picker { width: 100%; max-height: 340px; overflow: auto; }
/* 手机窄屏：8 列改 6 列 */
@media (max-width: 480px) {
  .icon-picker .grid { grid-template-columns: repeat(6, 1fr); }
}
.tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.tab {
  border: none; background: none; font: inherit; font-size: 13px; padding: 6px 12px;
  border-radius: 6px; cursor: pointer; color: var(--ink-2);
}
.tab.on { background: var(--accent-weak); color: var(--accent); font-weight: 600; }
.group { margin-bottom: 8px; }
.group-name { font-size: 11px; color: var(--ink-3); margin: 6px 0 4px; }
.grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.cell {
  aspect-ratio: 1; font-size: 20px; border: 1px solid transparent; border-radius: 8px;
  background: var(--canvas); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.cell:hover { background: var(--accent-soft); }
.cell.on { border-color: var(--accent); background: var(--accent-weak); }
.drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  border: 1.5px dashed var(--line-strong); border-radius: 12px; padding: 24px;
  cursor: pointer; text-align: center; color: var(--ink-2); min-height: 160px;
}
.drop:hover { border-color: var(--accent); background: var(--accent-soft); }
.drop.busy { opacity: .5; pointer-events: none; }
.drop-icon { font-size: 32px; }
.drop-hint small { color: var(--ink-3); }
.prev { width: 64px; height: 64px; border-radius: 12px; object-fit: cover; }
.current { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: var(--ink-2); }
.cur-img { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; }
.cur-emoji { font-size: 22px; }
.clear { border: none; background: none; color: var(--danger); cursor: pointer; font-size: 12px; padding: 0; }
</style>
