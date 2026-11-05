// 错题列表（簿内）与详情：筛选、编辑、标签摘除/添加、删除
import { store, listAll, detachTagsByMistake } from '../db.js';
import { toast } from '../main.js';

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


function confirmDialog(text) {
  return new Promise(resolve => {
    const mask = el('div', { class: 'modal-mask' });
    const box = el('div', { class: 'modal' },
      el('p', {}, text),
      el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => { mask.remove(); resolve(false); } }, '取消'),
        el('button', { class: 'btn btn-danger', style: 'width:auto', onclick: () => { mask.remove(); resolve(true); } }, '确定删除'),
      ));
    mask.appendChild(box);
    mask.addEventListener('click', e => { if (e.target === mask) { mask.remove(); resolve(false); } });
    document.body.appendChild(mask);
  });
}

// 摘要：题干截断
function brief(text, n = 42) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : (s || '（无题干）');
}

const DIM_NAMES = { type: '题型', category: '知识归类', kp: '知识点', cause: '错误原因' };

// 题目标签：[{name, dim}]（联 mistake_tags × tags）
async function tagsOfMistake(mistakeId, tags, mts) {
  const tById = new Map(tags.map(t => [t.id, t]));
  return mts.filter(mt => mt.mistake_id === mistakeId)
    .map(mt => tById.get(mt.tag_id)).filter(Boolean);
}

// ---------- 簿内列表 #/books/:id ----------
export async function renderBookMistakes(root, bookId) {
  root.innerHTML = '';
  const books = await listAll('wrongbooks');
  const book = books.find(b => b.id === bookId);
  if (!book) {
    root.appendChild(el('div', { class: 'card' }, el('p', {}, '错题簿不存在或已删除。'),
      el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/books'; } }, '返回错题簿')));
    return;
  }

  const [allMistakes, tags, mts] = await Promise.all([
    listAll('mistakes'), listAll('tags'), listAll('mistake_tags')]);
  const mine = allMistakes.filter(m => m.book_id === bookId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  root.append(el('h2', { style: 'margin:0 0 4px' }, book.name),
    el('p', { class: 'muted', style: 'margin:0 0 14px' }, `${book.level1} · ${book.level2} · ${mine.length} 道错题`));

  // 筛选：题型 / 标签
  const typeSet = new Set(mine.map(m => m.question_type).filter(Boolean));
  const filterCard = el('div', { class: 'card', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' });
  filterCard.appendChild(el('label', {}, '题型'));
  const typeSel = el('select', {},
    el('option', { value: '' }, '全部'),
    ...[...typeSet].sort().map(t => el('option', { value: t }, t)));
  filterCard.appendChild(typeSel);
  filterCard.appendChild(el('label', {}, '标签'));
  const tagSel = el('select', {},
    el('option', { value: '' }, '全部'),
    ...tags.map(t => el('option', { value: t.id }, `${DIM_NAMES[t.dim] || t.dim}：${t.name}`)));
  filterCard.appendChild(tagSel);
  root.appendChild(filterCard);

  const listWrap = el('div');
  root.appendChild(listWrap);

  function renderList() {
    listWrap.innerHTML = '';
    let rows = mine;
    if (typeSel.value) rows = rows.filter(m => m.question_type === typeSel.value);
    if (tagSel.value) {
      const tid = Number(tagSel.value);
      const mIds = new Set(mts.filter(mt => mt.tag_id === tid).map(mt => mt.mistake_id));
      rows = rows.filter(m => mIds.has(m.id));
    }
    if (!rows.length) {
      listWrap.appendChild(el('div', { class: 'card' }, el('p', { class: 'muted' }, '没有符合筛选的错题。')));
      return;
    }
    for (const m of rows) {
      const mTags = mts.filter(mt => mt.mistake_id === m.id).map(mt => tags.find(t => t.id === mt.tag_id)).filter(Boolean);
      const card = el('div', { class: 'card', style: 'cursor:pointer' });
      card.addEventListener('click', () => { location.hash = `#/mistakes/${m.id}`; });
      card.append(
        el('p', { style: 'margin:0 0 6px;font-weight:600' }, brief(m.question_text)),
        el('p', { class: 'muted', style: 'margin:0 0 6px' },
          [m.question_type, m.created_at ? m.created_at.slice(0, 10) : ''].filter(Boolean).join(' · ') || ' '));
      if (mTags.length) {
        const chips = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
        for (const t of mTags) chips.appendChild(el('span', { class: 'chip' }, t.name));
        card.appendChild(chips);
      }
      listWrap.appendChild(card);
    }
  }
  typeSel.addEventListener('change', renderList);
  tagSel.addEventListener('change', renderList);
  renderList();

  root.appendChild(el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = `#/capture?book=${bookId}`; } }, '＋ 收录新错题'));
}

// ---------- 详情 #/mistakes/:id ----------
export async function renderMistakeDetail(root, mistakeId) {
  root.innerHTML = '';
  let m;
  try { m = await store('mistakes').get(mistakeId); } catch { m = null; }
  if (!m) {
    root.appendChild(el('div', { class: 'card' }, el('p', {}, '错题不存在或已删除。'),
      el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/books'; } }, '返回')));
    return;
  }

  const [tags, mts] = await Promise.all([listAll('tags'), listAll('mistake_tags')]);
  const myTags = await tagsOfMistake(mistakeId, tags, mts);

  root.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:auto;margin-bottom:10px', onclick: () => { location.hash = `#/books/${m.book_id}`; } }, '← 返回'));

  // 图片
  let images = [];
  try { images = JSON.parse(m.images || '[]'); } catch {}
  if (images.length) {
    const imgWrap = el('div', { style: 'margin-bottom:14px;display:flex;gap:8px;overflow-x:auto' });
    for (const src of images) imgWrap.appendChild(el('img', { src, style: 'max-height:260px;border-radius:8px' }));
    root.appendChild(imgWrap);
  }

  const card = el('div', { class: 'card' });
  card.append(
    el('h3', { style: 'margin-top:0' }, '题干'),
    el('p', { style: 'white-space:pre-wrap' }, m.question_text || '（无）'),
    el('h3', {}, '你的答案'),
    el('p', { style: 'white-space:pre-wrap' }, m.user_answer || '（无）'),
    el('h3', {}, '正确答案'),
    el('p', { style: 'white-space:pre-wrap' }, m.right_answer || '（无）'),
    el('h3', {}, '错误分析'),
    el('p', { style: 'white-space:pre-wrap' }, m.analysis || '（无）'));
  root.appendChild(card);

  // 标签区：chips + 删除 + 添加
  const tagCard = el('div', { class: 'card' });
  tagCard.appendChild(el('h3', { style: 'margin-top:0' }, '标签'));
  const chipWrap = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' });
  function renderChips() {
    chipWrap.innerHTML = '';
    if (!myTags.length) chipWrap.appendChild(el('span', { class: 'muted' }, '暂无标签'));
    for (const t of myTags) {
      const chip = el('span', { class: 'chip' }, `${DIM_NAMES[t.dim] || t.dim}：${t.name} `, el('button', {
        style: 'background:none;border:none;color:inherit;cursor:pointer;padding:0', title: '摘除该标签',
        onclick: async (e) => {
          e.stopPropagation();
          const mt = mts.find(x => x.mistake_id === mistakeId && x.tag_id === t.id);
          if (mt) { await store('mistake_tags').remove(mt.id); toast('已摘除标签'); }
          const i = myTags.indexOf(t); if (i > -1) myTags.splice(i, 1);
          renderChips();
        },
      }, '×'));
      chipWrap.appendChild(chip);
    }
    chipWrap.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: openAddTag }, '＋ 添加标签'));
  }
  function openAddTag() {
    const mask = el('div', { class: 'modal-mask' });
    const box = el('div', { class: 'modal' });
    box.appendChild(el('h3', { style: 'margin-top:0' }, '添加标签'));
    const dimSel = el('select', {}, ...Object.entries(DIM_NAMES).map(([k, v]) => el('option', { value: k }, v)));
    const nameIn = el('input', { type: 'text', placeholder: '标签名（可新建）' });
    const existingSel = el('select', {}, el('option', { value: '' }, '选择已有标签…'),
      ...tags.map(t => el('option', { value: t.id }, `${DIM_NAMES[t.dim] || t.dim}：${t.name}`)));
    box.append(
      el('label', {}, '维度'), dimSel,
      el('label', {}, '已有标签'), existingSel,
      el('label', {}, '或新建'), nameIn,
      el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px' },
        el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => mask.remove() }, '取消'),
        el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: async () => {
          let tid = existingSel.value ? Number(existingSel.value) : 0;
          const name = nameIn.value.trim();
          if (!tid && name) {
            if (tags.some(t => t.name === name && t.dim === dimSel.value)) {
              tid = tags.find(t => t.name === name && t.dim === dimSel.value).id;
            } else {
              const r = await store('tags').create({ name, dim: dimSel.value, subject: m.subject || null });
              tags.push(r); tid = r.id;
            }
          }
          if (!tid) { mask.remove(); return; }
          if (mts.some(x => x.mistake_id === mistakeId && x.tag_id === tid)) { mask.remove(); toast('已有该标签'); return; }
          const nr = await store('mistake_tags').create({ mistake_id: mistakeId, tag_id: tid });
          mts.push(nr);
          myTags.push(tags.find(t => t.id === tid));
          renderChips();
          mask.remove();
        } }, '添加'),
      ));
    mask.appendChild(box);
    mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
    document.body.appendChild(mask);
  }
  renderChips();
  tagCard.appendChild(chipWrap);
  root.appendChild(tagCard);

  // 操作区
  const ops = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
  ops.append(
    el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: openEdit }, '编辑'),
    el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: openGenerate }, '🎯 针对此题出题'),
    el('button', { class: 'btn btn-danger', style: 'width:auto', onclick: async () => {
      if (!await confirmDialog('确定删除这道错题吗？关联标签将一并摘除。')) return;
      await detachTagsByMistake(mistakeId);
      await store('mistakes').remove(mistakeId);
      toast('已删除');
      location.hash = `#/books/${m.book_id}`;
    } }, '删除错题'));
  root.appendChild(ops);

  // 编辑表单（弹窗）
  function openEdit() {
    const mask = el('div', { class: 'modal-mask' });
    const box = el('div', { class: 'modal' });
    box.appendChild(el('h3', { style: 'margin-top:0' }, '编辑错题'));
    const f = {};
    for (const [key, label] of [['question_text', '题干'], ['user_answer', '你的答案'], ['right_answer', '正确答案'], ['analysis', '错误分析']]) {
      const ta = el('textarea', { rows: key === 'question_text' ? 4 : 2 });
      ta.value = m[key] || '';
      f[key] = ta;
      box.append(el('label', {}, label), ta);
    }
    const typeIn = el('input', { type: 'text', value: m.question_type || '' });
    box.append(el('label', {}, '题型'), typeIn);
    box.append(el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px' },
      el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => mask.remove() }, '取消'),
      el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: async () => {
        const upd = {};
        for (const k of Object.keys(f)) upd[k] = f[k].value.trim();
        upd.question_type = typeIn.value.trim();
        await store('mistakes').update(mistakeId, upd);
        Object.assign(m, upd);
        toast('已保存');
        mask.remove();
        renderMistakeDetail(root, mistakeId); // 重渲染
      } }, '保存'),
    ));
    mask.appendChild(box);
    mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
    document.body.appendChild(mask);
  }

  // 针对此题出题：跳升华页并带上 ref 参数（Task 12 处理）
  function openGenerate() {
    location.hash = `#/sublimate?ref=${mistakeId}`;
  }
}

export default {
  render(root, { params }) {
    return renderMistakeDetail(root, Number(params[0]));
  },
};
