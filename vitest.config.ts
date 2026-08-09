import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration files share the DATABASE_URL database (migrations,
    // admin repository, e2e); run files one at a time to avoid interference.
    fileParallelism: false,
  },
});
