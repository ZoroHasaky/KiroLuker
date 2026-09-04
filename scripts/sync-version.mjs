import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const versionFile = join(projectRoot, 'VERSION')
const version = (await readFile(versionFile, 'utf8')).trim()

if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION 不符合语义化版本格式: ${version || '(空)'}`)
}

async function updateJson(filename, update) {
  const file = join(projectRoot, filename)
  const json = JSON.parse(await readFile(file, 'utf8'))
  const before = JSON.stringify(json)
  update(json)
  if (JSON.stringify(json) !== before) {
    await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    console.log(`[version] ${filename} -> ${version}`)
  }
}

await updateJson('package.json', (json) => {
  json.version = version
})

await updateJson('package-lock.json', (json) => {
  json.version = version
  if (json.packages?.['']) json.packages[''].version = version
})

console.log(`[version] active version: ${version}`)
