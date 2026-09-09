import fs from 'node:fs'
import path from 'node:path'

const buildNumber = String(process.argv[2] || '1').trim()
if (!/^\d+$/.test(buildNumber)) throw new Error('build number must be numeric')

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim()
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(source)) {
  throw new Error(`VERSION is not a valid semantic version: ${source}`)
}
const pubspec = path.join(root, 'app', 'pubspec.yaml')
let text = fs.readFileSync(pubspec, 'utf8')
text = text.replace(/^version:\s*.*$/m, `version: ${source}+${buildNumber}`)
fs.writeFileSync(pubspec, text)
console.log(`Mobile version: ${source}+${buildNumber}`)
