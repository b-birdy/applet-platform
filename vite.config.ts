import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'platform',
  plugins: [vue()],
  build: {
    outDir: 'dist',
  },
});
