// 错题宝库入口：启动守卫、hash 路由、导航渲染、主题初始化

const appEl = () => document.getElementById('app');

// ---------- 全局 toast：统一错误文案映射（平台 413/401 等码 → 中文） ----------
const ERROR_TEXT = {
  'QUOTA_EXCEEDED': '存储配额已满，请联系管理员调高或配置对象存储',
  'UNAUTHORIZED': '登录已过期，请重新进入应用',
  'FORBIDDEN': '没有权限执行此操作',
  'NOT_FOUND': '数据不存在或已被删除',
};

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = ERROR_TEXT[msg] || (msg === '413' ? ERROR_TEXT.QUOTA_EXCEEDED
    : msg === '401' ? ERROR_TEXT.UNAUTHORIZED : msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- 路由表：hash 模式 → 视图模块（懒加载） ----------
// 视图模块默认导出 { render(el, query) }
const ROUTES = [
  { pattern: /^#\/books$/, load: () => import('./views/books.js') },
  { pattern: /^#\/books\/(\d+)$/, load: () => import('./views/books.js') },
  { pattern: /^#\/capture$/, load: () => import('./views/capture.js') },
  { pattern: /^#\/mistakes\/(\d+)$/, load: () => import('./views/mistakes.js') },
  { pattern: /^#\/sublimate$/, load: () => import('./views/sublimate.js') },
  { pattern: /^#\/practice$/, load: () => import('./views/practice.js') },
  { pattern: /^#\/practice\/([-\w]+)$/, load: () => import('./views/practice.js') },
  { pattern: /^#\/settings$/, load: () => import('./views/settings.js') },
];

async function route() {
  const viewEl = document.getElementById('view');
  if (!viewEl) return; // boot 未完成
  const hash = location.hash || '#/books';
  // 路径与查询分离：#/capture?demo=1 → path=#/capture, query=demo=1
  const qIdx = hash.indexOf('?');
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const queryStr = qIdx === -1 ? '' : hash.slice(qIdx + 1);
  for (const r of ROUTES) {
    const m = path.match(r.pattern);
    if (m) {
      const view = await r.load();
      viewEl.innerHTML = '';
      view.default.render(viewEl, { params: m.slice(1), query: new URLSearchParams(queryStr) });
      setActiveNav(path);
      return;
    }
  }
  // 未匹配 → 错题簿
  location.hash = '#/books';
}

// ---------- 导航 ----------
const NAV = [
  { hash: '#/books', icon: '📚', label: '错题簿' },
  { hash: '#/sublimate', icon: '📈', label: '升华' },
  { hash: '#/practice', icon: '✏️', label: '练习' },
  { hash: '#/settings', icon: '⚙️', label: '设置' },
];

export function renderNav(container) {
  const sb = document.createElement('nav');
  sb.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = '📖 错题宝库';
  sb.appendChild(brand);
  for (const n of NAV) {
    const b = document.createElement('a');
    b.className = 'nav-item'; b.href = n.hash; b.dataset.nav = n.hash;
    b.innerHTML = `<span>${n.icon}</span><span>${n.label}</span>`;
    sb.appendChild(b);
  }
  // 收录主按钮常驻
  const fab = document.createElement('a');
  fab.className = 'fab'; fab.href = '#/capture'; fab.title = '收录错题';
  fab.textContent = '＋';
  container.appendChild(sb);
  container.appendChild(fab);
}

function setActiveNav(hash) {
  const base = '#/' + (hash.split('?')[0].split('/')[1] || 'books');
  document.querySelectorAll('[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === base);
  });
}

// ---------- 主题 ----------
async function initTheme() {
  // 临时直读 settings（Task 3 起改走 db.js）
  try {
    const rows = await window.applet.data('settings').list({});
    const hit = rows.rows.find(r => r.kind === 'ui');
    const ui = hit ? JSON.parse(hit.value) : { theme: 'sunny' };
    document.documentElement.dataset.theme = ui.theme || 'sunny';
  } catch { document.documentElement.dataset.theme = 'sunny'; }
}

// ---------- 启动守卫：等 window.applet（平台运行时注入） ----------
async function boot() {
  for (let i = 0; i < 30; i++) {
    if (window.applet) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.applet) {
    appEl().innerHTML = '<div class="boot">运行时初始化失败：未检测到平台数据接口，请从平台内打开本应用。</div>';
    return;
  }
  appEl().innerHTML = '';
  renderNav(appEl());
  const main = document.createElement('main');
  main.className = 'main'; main.id = 'view';
  appEl().appendChild(main);
  // 视图渲染目标：#view（视图模块向 render(el) 传入）
  window.addEventListener('hashchange', route);
  await initTheme();
  await route();
}

boot();
