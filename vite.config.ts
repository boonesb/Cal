import { defineConfig } from 'vite';

const buildTimestamp = process.env.BUILD_TIMESTAMP ?? new Date().toISOString();

export default defineConfig({
  define: {
    'import.meta.env.BUILD_TIMESTAMP': JSON.stringify(buildTimestamp),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
