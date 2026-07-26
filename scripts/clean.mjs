// 打包前清理：删掉 dist（安装包产物）与 out（编译产物）。
//
// 为什么连 out 一起删：混淆脚本是就地覆盖并写幂等标记的，只要 out 里残留上一轮
// 已混淆的文件，本轮就会被跳过，最终打进安装包的可能是旧代码。
//
// 用 Node 的 fs 而不是 rm -rf：Windows 上没有 rm。
import fs from 'fs'
import path from 'path'
import chalk from 'chalk'

const targets = ['dist', 'out']

for (const target of targets) {
  const full = path.resolve(target)
  if (!fs.existsSync(full)) {
    console.log(chalk.gray(`[ clean ] skip ${target}（不存在）`))
    continue
  }
  try {
    fs.rmSync(full, { recursive: true, force: true })
    console.log(chalk.green(`[ clean ] removed ${target}`))
  } catch (err) {
    console.log(chalk.red(`[ clean error ] 删除 ${target} 失败: ${err.message}`))
    process.exit(1)
  }
}
