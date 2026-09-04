import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveRuntimePaths } from '../src/main/runtimePaths.ts'

test('运行资源路径以 app 根目录为基准，不受主进程 chunk 目录影响', () => {
  const appPath = path.resolve('fixtures', 'app.asar')
  const paths = resolveRuntimePaths(appPath)

  assert.equal(paths.preload, path.join(appPath, 'out', 'preload', 'index.js'))
  assert.equal(paths.renderer, path.join(appPath, 'out', 'renderer', 'index.html'))
  assert.equal(paths.preload.includes(`${path.sep}out${path.sep}main${path.sep}`), false)
  assert.equal(paths.renderer.includes(`${path.sep}out${path.sep}main${path.sep}`), false)
})
