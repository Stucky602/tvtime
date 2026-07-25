import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: [
      { find: /^.*supabase\.js$/, replacement: path.resolve('./tools/stub/supabase-stub.js') },
      { find: /^.*\/room\.js$/, replacement: path.resolve('./tools/stub/room-stub.js') },
      { find: 'virtual:pwa-register', replacement: path.resolve('./tools/stub/pwa-stub.js') },
    ],
  },
  build: { outDir: 'dist-stub' },
});
