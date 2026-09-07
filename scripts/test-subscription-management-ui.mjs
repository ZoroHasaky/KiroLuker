import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
mkdirSync(path.join(root, 'out'), { recursive: true })
const profile = mkdtempSync(path.join(root, 'out/subscription-ui-profile-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
for (const phase of ['exercise', 'restore']) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(root, 'tests/ui/subscription-management.cjs'), profile, phase], {
      cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 120000
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
  if (code !== 0) process.exit(code)
}
console.log('Production subscription UI and cross-process record persistence: PASS (fixture IPC only).')
