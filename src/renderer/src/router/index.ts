import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    {
      path: '/home',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
      meta: { title: '主页' }
    },
    {
      path: '/accounts',
      name: 'accounts',
      component: () => import('@/views/AccountsView.vue'),
      meta: { title: '账户管理' }
    },
    {
      path: '/browser',
      name: 'browser',
      component: () => import('@/views/BrowserView.vue'),
      meta: { title: '临时浏览器' }
    },
    {
      path: '/keys',
      name: 'keys',
      redirect: '/home'
    },
    {
      path: '/link-extraction',
      name: 'link-extraction',
      component: () => import('@/views/LinkExtractionView.vue'),
      meta: { title: '提链' }
    },
    {
      path: '/free-switch',
      name: 'free-switch',
      component: () => import('@/views/FreeSwitchView.vue'),
      meta: { title: '切Free' }
    },
    { path: '/subscription', redirect: '/link-extraction' },
    { path: '/tools', redirect: '/home' },
    { path: '/billing', redirect: '/home' },
    {
      path: '/logs',
      name: 'logs',
      component: () => import('@/views/LogsView.vue'),
      meta: { title: '系统日志' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '设置' }
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/views/AboutView.vue'),
      meta: { title: '关于' }
    }
  ]
})

export default router
