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
      path: '/subscription',
      name: 'subscription',
      component: () => import('@/views/SubscriptionView.vue'),
      meta: { title: '批量订阅' }
    },
    {
      path: '/tools',
      name: 'tools',
      component: () => import('@/views/ToolsView.vue'),
      meta: { title: '常用工具' }
    },
    {
      path: '/billing',
      name: 'billing',
      component: () => import('@/views/BillingView.vue'),
      meta: { title: '账单信息' }
    },
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
