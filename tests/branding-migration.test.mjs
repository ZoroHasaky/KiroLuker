import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyUserData } from '../src/main/userDataMigration.ts'

test('改名迁移复制必要数据、不覆盖新数据且不搬运缓存', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiroluker-migration-'))
  try {
    const intermediate = path.join(root, 'KiroLuler')
    const legacy = path.join(root, 'kiro-account-lite')
    const target = path.join(root, 'KiroLuker')
    fs.mkdirSync(path.join(intermediate, 'backups'), { recursive: true })
    fs.mkdirSync(path.join(intermediate, 'Cache'), { recursive: true })
    fs.mkdirSync(legacy, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(intermediate, 'kiroluler.json'), 'intermediate-store')
    fs.writeFileSync(path.join(intermediate, 'kiro-usage-history.json'), 'intermediate-history')
    fs.writeFileSync(path.join(intermediate, 'backups', 'accounts.json'), 'intermediate-backup')
    fs.writeFileSync(path.join(intermediate, 'Cache', 'cache.bin'), 'cache')
    fs.writeFileSync(path.join(legacy, 'kiro-account-lite.json'), 'legacy-store')
    fs.writeFileSync(path.join(legacy, 'kiro-gateway-history.json'), 'legacy-gateway')
    fs.writeFileSync(path.join(target, 'kiro-usage-history.json'), 'new-history')

    const copied = migrateLegacyUserData(root, target)

    assert.equal(fs.readFileSync(path.join(target, 'kiroluler.json'), 'utf8'), 'intermediate-store')
    assert.equal(fs.readFileSync(path.join(target, 'kiro-account-lite.json'), 'utf8'), 'legacy-store')
    assert.equal(fs.readFileSync(path.join(target, 'kiro-usage-history.json'), 'utf8'), 'new-history')
    assert.equal(fs.readFileSync(path.join(target, 'kiro-gateway-history.json'), 'utf8'), 'legacy-gateway')
    assert.equal(fs.readFileSync(path.join(target, 'backups', 'accounts.json'), 'utf8'), 'intermediate-backup')
    assert.equal(fs.existsSync(path.join(target, 'Cache')), false)
    assert.deepEqual(
      new Set(copied),
      new Set(['kiroluler.json', 'backups', 'kiro-account-lite.json', 'kiro-gateway-history.json'])
    )
    assert.equal(fs.existsSync(path.join(intermediate, 'kiroluler.json')), true)
    assert.equal(fs.existsSync(path.join(legacy, 'kiro-account-lite.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
