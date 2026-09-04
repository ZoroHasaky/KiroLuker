import { join } from 'path'

/**
 * 主进程可能被 Rollup 拆到 out/main/chunks，不能用当前模块的 __dirname
 * 推算 preload 和 renderer。appPath 始终指向项目根目录或打包后的 app.asar。
 */
export function resolveRuntimePaths(appPath: string): {
  preload: string
  renderer: string
} {
  const outputRoot = join(appPath, 'out')
  return {
    preload: join(outputRoot, 'preload', 'index.js'),
    renderer: join(outputRoot, 'renderer', 'index.html')
  }
}
