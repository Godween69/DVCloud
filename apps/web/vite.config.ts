import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-сервер только на localhost; запросы /api уходят на сервер DVCloud.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5177,
    proxy: { '/api': 'http://127.0.0.1:3004' },
  },
});
