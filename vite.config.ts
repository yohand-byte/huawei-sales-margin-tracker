import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(() => {
  const basePath = process.env.VITE_BASE_PATH?.trim() || '/huawei-sales-margin-tracker/';

  return {
    base: basePath,
    plugins: [react()],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    },
  };
});
