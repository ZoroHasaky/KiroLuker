// 构建后处理：对 electron-vite 产物里的 JS 做混淆加密（就地覆盖）。
//
// 只做混淆，不做 gzip：主进程用 require/import 直接加载 .js，渲染层通过
// <script src> 引入，两者都无法自动解压 .gz。
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import JavaScriptObfuscator from 'javascript-obfuscator'
import dotenv from 'dotenv'
import chalk from 'chalk'
import CliTable3 from 'cli-table3'

const readdir = promisify(fs.readdir)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const stat = promisify(fs.stat)

// 加载 .env.production
try {
  const envPath = path.resolve('.env.production')
  dotenv.config({ path: envPath })
  console.log(chalk.green(`[ config ] 已加载环境变量文件: ${envPath}`))
} catch (err) {
  console.log(chalk.red(`[ config error ] 加载环境变量文件失败: ${err.message}`))
  process.exit(1)
}

const buildDir = process.env.VITE_OUTDIR
if (!buildDir) {
  console.log(chalk.red('[ config error ] 未找到 VITE_OUTDIR 环境变量，请检查 .env.production 文件'))
  process.exit(1)
}
if (!fs.existsSync(buildDir)) {
  console.log(chalk.red(`[ config error ] 构建目录不存在: ${buildDir}，请先执行 electron-vite build`))
  process.exit(1)
}
console.log(chalk.cyan(`[ config ] 构建目录: ${buildDir}`))

// ---------------------------------------------------------------------------
// 分档混淆：在「难以被简单破解」与「运行流畅」之间取平衡。
//
// 关键认知：卡顿的主因是把 controlFlowFlattening / RC4 字符串加密 / 死代码注入
// / selfDefending 施加到了体量巨大的第三方库产物上（ant-design-vue、vue 等）。
// 这些库本就是公开的开源代码，混淆它们几乎不保护任何东西，却带来最重的运行时
// 开销（框架代码在渲染 / 响应式里被高频调用）。
//
// 因此按产物分三档：
//   * 渲染层业务代码（index-*.js 等，含 store、IPC 协议、UI 逻辑）：强档全量混淆
//   * 第三方库（vendor-*.js）：轻档，仅重命名 + 字符串数组，接近原生速度
//   * 主进程 / preload：node 档。这两个跑在 Node 侧，target 必须是 node；
//     并且保留 console —— 主进程日志是排查线上问题的唯一入口，屏蔽掉不值得。
// ---------------------------------------------------------------------------

// 强档：只用于渲染层业务代码（小体量，重混淆也不卡）。
const APP_OBFUSCATOR_OPTIONS = {
  compact: true,
  simplify: true,
  target: 'browser',
  sourceMap: false,

  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,

  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,

  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 5,
  stringArrayWrappersType: 'function',
  stringArrayWrappersParametersMaxCount: 5,
  stringArrayWrappersChainedCalls: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,

  splitStrings: true,
  splitStringsChunkLength: 8,

  numbersToExpressions: true,

  selfDefending: true,

  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,

  disableConsoleOutput: true,
  unicodeEscapeSequence: false
}

// 轻档：只用于第三方库产物。刻意关闭所有「高运行时开销」的变换：
//   - controlFlowFlattening（运行时最大开销）
//   - stringArrayEncoding / stringArrayCallsTransform（每次取字符串都要解码）
//   - deadCodeInjection（体积暴涨，拖慢解析 / JIT）
//   - selfDefending / splitStrings / numbersToExpressions
// 仅保留标识符重命名 + 未加密的字符串数组，做到「不易直接阅读」且几乎不影响性能。
const VENDOR_OBFUSCATOR_OPTIONS = {
  compact: true,
  simplify: true,
  target: 'browser',
  sourceMap: false,

  controlFlowFlattening: false,
  deadCodeInjection: false,

  stringArray: true,
  stringArrayEncoding: [], // 不加密 → 无逐次解密开销
  stringArrayThreshold: 0.5,
  stringArrayRotate: true, // 仅初始化一次，运行时无成本
  stringArrayShuffle: true,
  stringArrayCallsTransform: false,

  splitStrings: false,
  numbersToExpressions: false,
  selfDefending: false,

  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,

  disableConsoleOutput: true,
  unicodeEscapeSequence: false
}

// node 档：主进程与 preload。
// 关掉 selfDefending：它靠函数源码格式自检，而这两个文件会被 electron-builder
// 塞进 asar 并可能带 V8 代码缓存，自检误判会直接让应用起不来，代价太大。
// 也不做 deadCodeInjection —— 主进程冷启动时间直接体现为「点开图标多久出窗口」。
const NODE_OBFUSCATOR_OPTIONS = {
  compact: true,
  simplify: true,
  target: 'node',
  sourceMap: false,

  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,

  deadCodeInjection: false,

  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.9,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 3,
  stringArrayWrappersType: 'function',
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersChainedCalls: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,

  splitStrings: true,
  splitStringsChunkLength: 10,

  numbersToExpressions: true,

  selfDefending: false,

  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,

  // 保留主进程日志：出问题时这是唯一的排查入口
  disableConsoleOutput: false,
  unicodeEscapeSequence: false
}

// 依据产物路径区分档位：
//   out/main、out/preload → node 档
//   assets/vendor-*.js    → 轻档（Vite 把第三方库拆到 vendor-*）
//   其余渲染层产物        → 强档
const isNodeFile = (fileName) => /^(main|preload)[\\/]/.test(fileName)
const isVendorFile = (fileName) => /(^|[\\/])vendor-/.test(fileName)

const tierOf = (fileName) => {
  if (isNodeFile(fileName)) return { name: 'node 档', options: NODE_OBFUSCATOR_OPTIONS, color: chalk.cyan }
  if (isVendorFile(fileName)) return { name: '轻档', options: VENDOR_OBFUSCATOR_OPTIONS, color: chalk.blue }
  return { name: '强档', options: APP_OBFUSCATOR_OPTIONS, color: chalk.magenta }
}

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
  return parseFloat((Math.abs(bytes) / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 递归收集 .js 文件
const getJsFileList = async (dir) => {
  let list = []
  let items = []
  try {
    items = await readdir(dir)
  } catch (err) {
    console.log(chalk.red(`[error] 读取目录 ${dir} 失败: ${err.message}`))
    return list
  }
  for (const item of items) {
    const full = path.join(dir, item)
    try {
      const st = await stat(full)
      if (st.isDirectory()) list = list.concat(await getJsFileList(full))
      else if (st.isFile() && /\.js$/.test(item)) {
        list.push({ fileName: path.relative(buildDir, full), fullPath: full })
      }
    } catch (err) {
      console.log(chalk.yellow(`[warning] 处理 ${full} 出错: ${err.message}`))
    }
  }
  return list
}

const startTime = Date.now()

// 幂等标记：混淆是就地覆盖的，重复跑会把混淆结果再混淆一遍
// （体积指数级膨胀、运行时也会被拖慢）。写一行标记，第二次直接跳过。
const MARKER = '/*__obfuscated__*/'

const processFile = async (fileInfo) => {
  const beforeSize = (await stat(fileInfo.fullPath)).size
  const content = await readFile(fileInfo.fullPath, 'utf8')
  if (content.startsWith(MARKER)) {
    console.log(chalk.gray(`[ obfuscator ] skip  已混淆 ${fileInfo.fileName}`))
    return { name: fileInfo.fileName, before: beforeSize, after: beforeSize, tier: '跳过' }
  }
  const tier = tierOf(fileInfo.fileName)
  const result = JavaScriptObfuscator.obfuscate(content, tier.options)
  await writeFile(fileInfo.fullPath, `${MARKER}\n${result.getObfuscatedCode()}`, 'utf8')
  const afterSize = (await stat(fileInfo.fullPath)).size
  console.log(
    chalk.yellow(`[ obfuscator ] done ${tier.color(`[${tier.name}]`)} ${fileInfo.fileName}`) +
      chalk.gray(` (${formatFileSize(beforeSize)} → ${formatFileSize(afterSize)})`)
  )
  return { name: fileInfo.fileName, before: beforeSize, after: afterSize, tier: tier.name }
}

const run = async () => {
  console.log(chalk.green('[ obfuscator ] 扫描 JS 文件...'))
  const files = await getJsFileList(buildDir)
  if (files.length === 0) {
    console.log(chalk.yellow('[ obfuscator ] 未找到 JS 文件'))
    return
  }
  console.log(chalk.green(`[ obfuscator ] 找到 ${files.length} 个 JS，开始混淆...`))

  const rows = []
  for (let i = 0; i < files.length; i++) {
    rows.push(await processFile(files[i]))
    console.log(chalk.cyan(`[ progress ] ${Math.round(((i + 1) / files.length) * 100)}% (${i + 1}/${files.length})`))
  }

  const totalBefore = rows.reduce((a, r) => a + r.before, 0)
  const totalAfter = rows.reduce((a, r) => a + r.after, 0)
  const secs = ((Date.now() - startTime) / 1000).toFixed(2)
  console.log(chalk.green(`[ obfuscator ] finished ✓ built in ${secs}s`))

  const table = new CliTable3({ head: ['档位', '文件', '混淆前', '混淆后', '变化率'] })
  for (const r of rows) {
    const pct = r.before > 0 ? (((r.after - r.before) / r.before) * 100).toFixed(1) : '0'
    table.push([r.tier, r.name, formatFileSize(r.before), formatFileSize(r.after), '+' + pct + '%'])
  }
  const totalPct = totalBefore > 0 ? (((totalAfter - totalBefore) / totalBefore) * 100).toFixed(1) : '0'
  table.push(['总计', '', formatFileSize(totalBefore), formatFileSize(totalAfter), '+' + totalPct + '%'])
  console.log(table.toString())
}

process.on('uncaughtException', (err) => {
  console.log(chalk.red(`[ uncaught ] ${err.message}`))
  console.log(err.stack)
  process.exit(1)
})

run().catch((err) => {
  console.log(chalk.red(`[ error ] ${err.message}`))
  process.exit(1)
})
