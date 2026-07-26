import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { createHtmlPlugin } from 'vite-plugin-html'
import dayjs from 'dayjs'

// 产物文件名带上打包时间戳，便于对着用户截图确认他跑的是哪一版
const buildStamp = dayjs().format('YYYYMMDDHHmmss')
const buildTime = dayjs().format('YYYY-MM-DD HH:mm:ss')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      vue(),
      // 压缩首页 html，并把打包时间注入进去
      createHtmlPlugin({
        minify: true,
        inject: {
          data: { buildTime }
        }
      })
    ],
    base: './',
    build: {
      emptyOutDir: true, // 是否清空目录
      rollupOptions: {
        treeshake: true, // 开启 Tree Shaking，消除未使用的代码，减小最终的包大小
        onwarn(warning, warn) {
          // 自动过滤空 chunk 警告
          if (warning.code === 'EMPTY_BUNDLE') return
          warn(warning)
        },
        output: {
          // 文件名添加时间戳
          entryFileNames: `assets/[name]-[hash]-${buildStamp}.js`,
          chunkFileNames: `assets/[name]-[hash]-${buildStamp}.js`,
          assetFileNames: `assets/[name]-[hash]-${buildStamp}.[ext]`,
          // 自动拆分 node_modules 中的依赖包：混淆脚本据 vendor- 前缀走轻档
          manualChunks(id) {
            if (id.includes('node_modules')) {
              const match = id.match(/node_modules\/(.+?)(\/|$)/)
              if (match) {
                const packageName = match[1].replace('@', '').replace('/', '-')
                return `vendor-${packageName}`
              }
            }
            return undefined
          }
        },
        // 构建后自动过滤空 chunk
        plugins: [
          {
            name: 'remove-empty-chunks',
            generateBundle(_options, bundle): void {
              for (const [key, chunk] of Object.entries(bundle)) {
                if (chunk.type === 'chunk' && chunk.code.trim() === '') {
                  delete bundle[key]
                }
              }
            }
          }
        ]
      },
      minify: 'terser', // 默认为 esbuild，无法去除生产环境 console、debugger
      terserOptions: {
        compress: {
          drop_console: true, // 生产环境删除 console
          drop_debugger: true // 生产环境删除 debugger
        }
      },
      /*
       * ant-design-vue 单个包压缩后约 1.2MB，已经是 manualChunks 能拆到的最小粒度
       * （再拆只能改成按需引入组件，会牵动全部页面的组件注册方式）。
       * 阈值按它的实际体积放宽，避免每次构建都刷一条无从下手的警告。
       */
      chunkSizeWarningLimit: 1400
    }
  }
})
