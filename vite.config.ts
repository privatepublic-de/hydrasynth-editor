import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // probe.html (the protocol test page) is served by `npm run dev` only, not built.
  // .claude/ holds agent worktrees, each with its own copy of test/.
  test: { exclude: ['**/node_modules/**', '.claude/**', 'local/**'] },
})
