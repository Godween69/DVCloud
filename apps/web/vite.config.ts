import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev-сервер только на localhost; запросы /api уходят на сервер DVCloud.
// Адрес сервера можно сменить переменной DVCLOUD_DEV_API (например, когда порт 3004 занят другим процессом).
const api = process.env.DVCLOUD_DEV_API ?? 'http://127.0.0.1:3004';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5177,
    proxy: { '/api': api },
  },
});
