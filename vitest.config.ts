import { defineConfig } from 'vitest/config';
export default defineConfig({ cacheDir:process.env.ABYSSUS_VITE_CACHE, test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, fileParallelism: false } });
