// Production renderer only, with an isolated fixture preload and no application main process.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const sources = [
  'src/renderer/src/views/BrowserView.vue',
  'src/renderer/src/browser-chrome/index.html',
  'src/renderer/src/browser-chrome/main.ts',
  'src/renderer/src/browser-chrome/style.css',
  'src/renderer/src/router/index.ts',
  'src/renderer/src/components/layout/AppSidebar.vue'
]
const newestSource = Math.max(...sources.map((file) => statSync(path.join(root, file)).mtimeMs))
for (const entry of ['out/renderer/index.html', 'out/renderer/src/browser-chrome/index.html']) {
  let modified = 0
  try { modified = statSync(path.join(root, entry)).mtimeMs } catch { /* Build missing. */ }
  if (modified < newestSource) throw new Error(`Production renderer missing or stale: ${entry}. Build with electron-vite before running this test.`)
}
const output = path.join(root, 'out/browser-management-ui')
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(path.join(output, 'profile-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const code = await new Promise((resolve, reject) => {
  const child = spawn(require('electron'), [path.join(root, 'tests/ui/browser-management.cjs'), profile], {
    cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 120000
  })
  child.on('error', reject)
  child.on('exit', (code) => resolve(code ?? 1))
})
if (code !== 0) process.exit(code)
console.log('Production BrowserView + standalone chrome: PASS (fixture IPC only). Screenshots: out/browser-management-ui/.')