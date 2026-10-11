import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { editor: 'index.html', probe: 'probe.html' } } },
  // .claude/ holds agent worktrees, each with its own copy of test/.
  test: { exclude: ['**/node_modules/**', '.claude/**', 'local/**'] },
})
