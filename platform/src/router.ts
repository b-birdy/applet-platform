// 路由表 + 认证守卫
import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('./layouts/MainLayout.vue'),
      children: [
        { path: '', component: () => import('./views/Home.vue') },
        { path: 'profile', component: () => import('./views/Profile.vue') },
        { path: 'my-apps', component: () => import('./views/MyApps.vue') },
        { path: 'app/:id', component: () => import('./views/applet/AppFrame.vue') },
        { path: 'admin/users', component: () => import('./views/admin/Users.vue'), meta: { role: 'admin' } },
        { path: 'admin/applets', component: () => import('./views/admin/Applets.vue'), meta: { role: 'admin' } },
        { path: 'admin/agents', component: () => import('./views/admin/AgentAuth.vue'), meta: { role: 'admin' } },
        { path: 'admin/settings', component: () => import('./views/admin/Settings.vue'), meta: { role: 'admin' } },
        { path: 'admin/logs', component: () => import('./views/admin/AuditLogs.vue'), meta: { role: 'admin' } },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.loaded) await auth.fetchMe();
  if (!to.meta.public && !auth.me) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.meta.role === 'admin' && !auth.isAdmin) return { path: '/' };
  if (to.path === '/login' && auth.me) return { path: '/' };
  return true;
});
