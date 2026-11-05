// 设置页：个人信息（昵称/主题）、AI 接入（三类接入点管理）、反馈、关于
import { getSetting, setSetting, loadEndpoints } from '../db.js';
import { toast } from '../main.js';
import { testEndpoint } from '../ai.js';
import { test as s3test } from '../s3.js';
import { obfuscate, deobfuscate } from '../secure.js';

const THEMES = [
  { id: 'sunny', name: '明媚阳光' },
  { id: 'night', name: '静谧黑夜' },
  { id: 'cyber', name: '科技朋克' },
  { id: 'cozy', name: '温馨午后' },
];

// 三类接入点的字段定义：label 中文，secret=true 的字段混淆存储、永不回显
const KINDS = [
  { key: 'llm', title: '文本 LLM', fields: [
    { k: 'name', label: '名称', ph: '如：火山方舟主力' },
    { k: 'base_url', label: 'Base URL', ph: 'https://ark.cn-beijing.volces.com/api/v3' },
    { k: 'api_key', label: 'API Key', secret: true, ph: '' },
    { k: 'model', label: '模型名', ph: '如：doubao-seed-1-6' },
  ]},
  { key: 'vision', title: '图像识别', fields: [
    { k: 'name', label: '名称', ph: '如：视觉模型' },
    { k: 'base_url', label: 'Base URL', ph: 'https://...（OpenAI 兼容端点）' },
    { k: 'api_key', label: 'API Key', secret: true, ph: '' },
    { k: 'model', label: '模型名', ph: '支持图片输入的模型' },
  ]},
  { key: 's3', title: '对象存储（S3 兼容）', fields: [
    { k: 'name', label: '名称', ph: '如：我的 MinIO' },
    { k: 'endpoint', label: 'Endpoint', ph: 'https://s3.example.com' },
    { k: 'region', label: 'Region', ph: 'us-east-1' },
    { k: 'bucket', label: 'Bucket', ph: '' },
    { k: 'access_key', label: 'Access Key', secret: true, ph: '' },
    { k: 'secret_key', label: 'Secret Key', secret: true, ph: '' },
    { k: 'prefix', label: '路径前缀（可选）', ph: '' },
  ]},
];

// ---------- 通用 UI ----------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}


// 确认弹窗：resolve(true/false)
function confirmDialog(text) {
  return new Promise(resolve => {
    const mask = el('div', { class: 'modal-mask' });
    const box = el('div', { class: 'modal' },
      el('p', {}, text),
      el('div', { style: 'display:flex;gap:10px;justify-content:flex-end' },
        el('button', { class: 'btn btn-ghost', onclick: () => { mask.remove(); resolve(false); } }, '取消'),
        el('button', { class: 'btn btn-danger', onclick: () => { mask.remove(); resolve(true); } }, '确定'),
      ));
    mask.appendChild(box);
    document.body.appendChild(mask);
  });
}

// ---------- 接入点编辑 ----------

// 从 UI 列表读取当前条目（secret 字段留空=保持原值）
function readEntries(container, fields) {
  return [...container.querySelectorAll('[data-entry]')].map(row => {
    const entry = {};
    for (const f of fields) {
      const input = row.querySelector(`[data-k="${f.k}"]`);
      let v = input.value;
      if (f.secret) {
        if (!v) v = input.dataset.stored || ''; // 未重新输入则保留原值（原值已是混淆态）
        else v = obfuscate(v);
      }
      entry[f.k] = v;
    }
    return entry;
  });
}

function entryRow(kindDef, entry = {}) {
  const row = el('div', { class: 'card', 'data-entry': '' });
  for (const f of kindDef.fields) {
    const input = el('input', { 'data-k': f.k, placeholder: f.ph });
    if (f.secret) {
      // 混淆字段：显示占位「已配置」，不回显明文
      const has = !!entry[f.k];
      input.value = '';
      input.dataset.stored = entry[f.k] || '';
      input.placeholder = has ? '已配置（留空保持不变）' : (f.ph || '未配置');
      input.type = 'password';
    } else {
      input.value = entry[f.k] || '';
    }
    row.append(el('label', {}, f.label), input);
  }
  // 操作行：测试 / 上移 / 下移 / 删除
  const ops = el('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' });
  ops.append(
    el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => testRow(kindDef, row) }, '测试'),
    el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => row.previousElementSibling && row.parentNode.insertBefore(row, row.previousElementSibling) }, '↑'),
    el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => row.nextElementSibling && row.parentNode.insertBefore(row.nextElementSibling, row) }, '↓'),
    el('button', { class: 'btn btn-ghost', style: 'width:auto;color:var(--danger)', onclick: () => row.remove() }, '删除'),
  );
  row.appendChild(ops);
  return row;
}

async function testRow(kindDef, row) {
  const container = row.parentNode;
  const idx = [...container.querySelectorAll('[data-entry]')].indexOf(row);
  const entry = readEntries(container, kindDef.fields)[idx];
  const shown = {};
  for (const f of kindDef.fields) shown[f.k] = f.secret ? deobfuscate(entry[f.k] || '') : entry[f.k];
  const resultEl = row.querySelector('.test-result');
  resultEl.textContent = '测试中…';
  let r;
  if (kindDef.key === 's3') r = await s3test(shown);
  else r = await testEndpoint(kindDef.key, shown);
  resultEl.textContent = `${r.ok ? '✓' : '✗'} ${r.detail}${r.latency_ms != null ? `（${r.latency_ms}ms）` : ''}`;
  resultEl.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
}

async function aiTab(root) {
  const wrap = el('div');
  for (const kd of KINDS) {
    const sec = el('div', { class: 'card' }, el('h3', {}, kd.title));
    const list = el('div', { class: 'entry-list' });
    let entries = [];
    try { entries = await loadEndpoints(kd.key); } catch { /* 首次无配置 */ }
    for (const e of entries) list.appendChild(entryRow(kd, e));
    sec.appendChild(list);
    sec.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:auto;margin-top:8px', onclick: () => list.appendChild(entryRow(kd)) }, '＋ 添加条目'));
    if (kd.key === 's3') {
      const tip = el('details', { class: 'muted' }, el('summary', {}, '桶侧 CORS 配置指引（S3 直传需要）'));
      tip.appendChild(el('pre', { style: 'white-space:pre-wrap;font-size:.8rem' },
`在对象存储控制台为桶配置 CORS 规则：
- 允许来源：* （或本应用的访问地址）
- 允许方法：PUT、DELETE、GET
- 允许头：*
- 暴露头：ETag
MinIO 示例：mc admin config set ... 或 minio console → Buckets → anonymous/cors 规则`));
      sec.appendChild(tip);
    }
    wrap.appendChild(sec);
  }
  const saveBtn = el('button', { class: 'btn btn-primary', style: 'width:auto' }, '保存全部接入配置');
  saveBtn.addEventListener('click', async () => {
    const ai = {};
    const s3list = [];
    for (const kd of KINDS) {
      const list = wrap.querySelector(`.entry-list`); // 按顺序：llm, vision, s3
      const entries = readEntries(list, kd.fields);
      if (kd.key === 's3') { s3list.push(...entries); break; }
      ai[kd.key] = entries;
    }
    // 上面 querySelector 取的是第一个 .entry-list，需要按 kind 分区取
    const secs = wrap.querySelectorAll('.card');
    const listLlm = secs[0].querySelector('.entry-list');
    const listVision = secs[1].querySelector('.entry-list');
    const listS3 = secs[2].querySelector('.entry-list');
    ai.llm = readEntries(listLlm, KINDS[0].fields);
    ai.vision = readEntries(listVision, KINDS[1].fields);
    const s3Entries = readEntries(listS3, KINDS[2].fields);
    await setSetting('ai_endpoints', ai);
    await setSetting('s3_endpoints', s3Entries);
    toast('接入配置已保存');
  });
  wrap.appendChild(saveBtn);
  root.appendChild(wrap);
}

// ---------- 选项卡：个人信息 ----------

async function profileTab(root) {
  const ui = await getSetting('ui', { theme: 'sunny', nickname: '' });
  const wrap = el('div', { class: 'card' });
  wrap.append(el('h3', {}, '个人信息'));
  wrap.append(el('label', {}, '昵称（仅本应用内展示）'));
  const nick = el('input', { value: ui.nickname || '', placeholder: '怎么称呼你' });
  wrap.append(nick);
  wrap.append(el('label', {}, '界面主题'));
  const themeSel = el('select', {});
  for (const t of THEMES) themeSel.appendChild(el('option', { value: t.id }, t.name));
  themeSel.value = ui.theme || 'sunny';
  themeSel.addEventListener('change', () => { document.documentElement.dataset.theme = themeSel.value; });
  wrap.append(themeSel);
  wrap.append(el('button', { class: 'btn btn-primary', style: 'width:auto;margin-top:16px', onclick: async () => {
    await setSetting('ui', { theme: themeSel.value, nickname: nick.value.trim() });
    document.documentElement.dataset.theme = themeSel.value;
    toast('已保存');
  } }, '保存'));
  root.appendChild(wrap);
}

// ---------- 选项卡：反馈 ----------

async function feedbackTab(root) {
  const s = window.applet.data('feedback');
  const wrap = el('div');
  const card = el('div', { class: 'card' }, el('h3', {}, '提交反馈'));
  const type = el('select', {}, el('option', { value: 'bug' }, '故障'), el('option', { value: 'idea' }, '建议'), el('option', { value: 'other' }, '其他'));
  const content = el('textarea', { placeholder: '遇到什么问题 / 想要什么功能，说清楚一点方便处理' });
  card.append(el('label', {}, '类型'), type, el('label', {}, '内容'), content,
    el('button', { class: 'btn btn-primary', style: 'width:auto;margin-top:12px', onclick: async () => {
      if (!content.value.trim()) { toast('内容不能为空'); return; }
      await s.create({ type: type.value, content: content.value.trim() });
      content.value = '';
      toast('已提交，感谢反馈');
      renderList();
    } }, '提交'));
  wrap.appendChild(card);

  const listCard = el('div', { class: 'card' }, el('h3', {}, '我的反馈'));
  const listBox = el('div');
  listCard.appendChild(listBox);
  wrap.appendChild(listCard);
  root.appendChild(wrap);

  async function renderList() {
    listBox.innerHTML = '';
    const { rows } = await s.list({});
    if (!rows.length) { listBox.appendChild(el('p', { class: 'muted' }, '还没有反馈记录')); return; }
    for (const r of rows.sort((a, b) => b.id - a.id)) {
      const statusText = { open: '待处理', processed: '已处理', closed: '已关闭' }[r.status] || r.status;
      listBox.appendChild(el('div', { style: 'border-top:1px solid var(--line);padding:10px 0' },
        el('div', {}, `${r.type === 'bug' ? '🐞' : r.type === 'idea' ? '💡' : '💬'} ${r.content}`),
        el('div', { class: 'muted' }, `${new Date(r.created_at).toLocaleString('zh-CN')} · ${statusText}`),
        r.reply ? el('div', { style: 'margin-top:4px' }, `↩ 回复：${r.reply}`) : null,
      ));
    }
  }
  await renderList();
}

// ---------- 选项卡：关于 ----------

async function aboutTab(root) {
  const mistakes = await window.applet.data('mistakes').list({});
  let imgBytes = 0;
  try {
    for (const m of mistakes.rows) {
      const arr = JSON.parse(m.images || '[]');
      for (const u of arr) if (u.startsWith('data:')) imgBytes += u.length * 0.75; // base64 估算
    }
  } catch { /* ignore */ }
  const usedMB = (imgBytes / 1024 / 1024).toFixed(1);
  const pct = Math.min(100, Math.round(imgBytes / (20 * 1024 * 1024) * 100));
  root.appendChild(el('div', { class: 'card' },
    el('h3', {}, '关于'),
    el('p', {}, '📖 错题宝库 v0.1 —— 拍照收错题 → AI 归因打标 → 统计弱点 → 针对性出题练习'),
    el('p', { class: 'muted' }, '账号与登录由平台管理；AI 接入使用你自己配置的服务，费用自理。'),
    el('p', {}, `本机图片占用约 ${usedMB} MB / 20 MB 配额${pct > 80 ? '（⚠️ 接近配额上限，建议配置对象存储或清理旧错题图片）' : ''}`),
    pct > 0 ? el('div', { style: 'height:8px;background:var(--line);border-radius:4px;overflow:hidden' },
      el('div', { style: `height:100%;width:${pct}%;background:${pct > 80 ? 'var(--danger)' : 'var(--accent)'}` })) : null,
  ));
}

// ---------- 主渲染 ----------

export default {
  async render(root) {
    root.innerHTML = '';
    const tabs = [
      { id: 'profile', label: '个人信息', render: profileTab },
      { id: 'ai', label: 'AI 接入', render: aiTab },
      { id: 'feedback', label: '反馈', render: feedbackTab },
      { id: 'about', label: '关于', render: aboutTab },
    ];
    const bar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px' });
    const body = el('div');
    for (const t of tabs) {
      const b = el('button', { class: 'btn btn-ghost', style: 'width:auto' }, t.label);
      b.addEventListener('click', () => {
        body.innerHTML = '';
        [...bar.children].forEach(c => c.classList.remove('active'));
        b.classList.add('active');
        t.render(body).catch(e => body.append(el('p', { class: 'muted' }, `加载失败：${e.message}`)));
      });
      bar.appendChild(b);
    }
    root.append(bar, body);
    bar.children[0].click(); // 默认个人信息
  },
};
