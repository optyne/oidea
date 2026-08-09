import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 部署路徑固定在 /canvas/（與 Flutter web 同源，由同一個 nginx 服務）
export default defineConfig({
  plugins: [react()],
  base: '/canvas/',
});
