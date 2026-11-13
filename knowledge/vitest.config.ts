import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    // The database integration suite shares one database; keep files serial.
    fileParallelism: false,
  },
});
