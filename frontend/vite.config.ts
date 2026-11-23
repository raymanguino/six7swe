import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The chat example pool (#205), shared with the knowledge service. Compiled from source: the
      // module imports nothing, so the frontend needs neither the package's build nor zod. Keep
      // in step with the same path in tsconfig.json (`paths`), which tsc reads instead of this.
      '@six7swe/knowledge-types/chat-examples': path.resolve(
        import.meta.dirname,
        '../packages/knowledge-types/src/chatExamples.ts',
      ),
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
