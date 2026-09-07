import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
mkdirSync(path.join(root, 'out'), { recursive: true })
const profile = mkdtempSync(path.join(root, 'out/browser-runtime-profile-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let output = ''
const code = await new Promise((resolve, reject) => {
  const child = spawn(require('electron'), [path.join(root, 'tests/ui/browser-runtime.cjs'), profile], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, timeout: 120000
  })
  child.stdout.on('data', (data) => { output += data.toString(); process.stdout.write(data) })
  child.on('error', reject)
  child.on('exit', (code) => resolve(code ?? 1))
})
process.exitCode = code === 0 && output.includes('\"result\":\"PASS\"') ? 0 : 1
