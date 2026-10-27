// 响应式断点：窄屏（<768px）判定，随窗口实时更新
import { ref, onMounted, onBeforeUnmount } from 'vue';

const query = '(max-width: 767px)';

export function useIsMobile() {
  const isMobile = ref(false);
  const mq = window.matchMedia(query);
  const update = () => { isMobile.value = mq.matches; };
  onMounted(() => {
    update();
    mq.addEventListener('change', update);
  });
  onBeforeUnmount(() => mq.removeEventListener('change', update));
  return { isMobile };
}
