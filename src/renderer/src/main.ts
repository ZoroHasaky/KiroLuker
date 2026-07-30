import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
// ant-design-vue 组件改为按需自动引入（见 electron.vite.config.ts 的 Components 插件），
// 不再全量 app.use(Antd)。命令式 API（message / Modal / theme 等）仍按需具名导入。
// reset.css 是静态样式基线，与按需加载无关，保留。
import 'ant-design-vue/dist/reset.css'
import './assets/styles.css'

createApp(App).use(createPinia()).use(router).mount('#app')
