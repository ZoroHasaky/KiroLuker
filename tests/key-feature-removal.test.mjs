import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

async function loadCommonJs(file, require, extra = {}) {
  const source = await fs.readFile(new URL(file, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const exports = {}
  vm.runInNewContext(outputText, { exports, require, ...extra }, { filename: file })
  return exports
}

test('主进程实际注册的 IPC 不再提供 Key 管理或网关，保留账号功能', async () => {
  const handlers = new Map()
  const inert = new Proxy({}, { get: () => function () {} })
  const { registerIpc } = await loadCommonJs('../src/main/ipc.ts', (name) => {
    if (name === 'electron') return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
    return inert
  })
  registerIpc(() => null)
  assert.ok(handlers.size > 30)
  assert.deepEqual([...handlers.keys()].filter((name) => /^(keys|key-gateway):/.test(name)), [])
  for (const name of ['accounts:load', 'accounts:verify', 'accounts:refresh-token', 'accounts:create-api-key', 'accounts:list-api-keys', 'accounts:delete-api-key', 'kiro:chat-test']) {
    assert.ok(handlers.has(name), `必须保留 ${name}`)
  }
})

test('preload 实际暴露的 API 不再包含独立 Key / 网关接口和推送订阅', async () => {
  let api
  const calls = []
  await loadCommonJs('../src/preload/index.ts', (name) => {
    if (name === 'electron') return {
      contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'api'); api = value } },
      ipcRenderer: { invoke: async (channel) => { calls.push(channel); return { success: true } } }
    }
    return {}
  }, { process: { contextIsolated: true } })
  assert.ok(api)
  for (const method of ['loadKeys', 'addKey', 'importKeys', 'updateKey', 'setKeyRegion', 'deleteKey', 'selectKey', 'testKey', 'listKeyModels', 'syncKey', 'syncAllKeys', 'getKeyGatewayStatus', 'getKiroCapability', 'getKeyGatewayStats', 'resetKeyGatewayStats', 'getKeyGatewayHistory', 'inspectKeyGatewayConflict', 'enableKeyGateway', 'disableKeyGateway', 'configureKeyGateway', 'onKeyGatewayChanged', 'keyChatTest', 'cancelKeyChatTest', 'onKeyChatChunk']) {
    assert.equal(api[method], undefined, `${method} 必须移除`)
  }
  await api.loadAccounts()
  await api.createAccountApiKey({}, 'test')
  assert.deepEqual(calls, ['accounts:load', 'accounts:create-api-key'])
})
