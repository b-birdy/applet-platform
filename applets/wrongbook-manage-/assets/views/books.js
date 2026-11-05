// 错题簿：列表 + 新建（两级科目，主题建后不可改）+ 级联删除
import { SUBJECTS, isSubjectOpen } from '../subjects.js';
import { toast } from '../main.js';
import { store, listAll, deleteBookCascade } from '../db.js';

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
    document.body.appendChild(mask);
  });
}

// 新建/查看表单（编辑态 editBook 时 level1/level2 只读）
function bookForm(onDone, editBook = null) {
  const form = el('div', { class: 'card' });
  form.appendChild(el('h3', {}, editBook ? '错题簿详情' : '新建错题簿'));

  form.appendChild(el('label', {}, '名称'));
  const name = el('input', { value: editBook?.name || '', placeholder: '如：初二上学期数学' });
  form.appendChild(name);

  form.appendChild(el('label', {}, '一级主题'));
  const l1 = el('select', { disabled: !!editBook });
  for (const g of SUBJECTS) l1.appendChild(el('option', { value: g.level1 }, g.level1));
  if (editBook) l1.value = editBook.level1;
  form.appendChild(l1);

  form.appendChild(el('label', {}, '二级科目'));
  const l2 = el('select', { disabled: !!editBook });
  const fillL2 = () => {
    l2.innerHTML = '';
    const g = SUBJECTS.find(x => x.level1 === l1.value);
    for (const it of g.items) {
      const opt = el('option', { value: it.name }, it.open ? it.name : `${it.name}（待开发）`);
      if (!it.open) opt.disabled = true;
      l2.appendChild(opt);
    }
  };
  fillL2();
  if (editBook) l2.value = editBook.level2;
  else l1.addEventListener('change', fillL2);
  form.appendChild(l2);

  if (editBook) {
    form.appendChild(el('p', { class: 'muted' }, '主题一旦建好不可修改；如需更换请删除整本重建。'));
  }

  const btns = el('div', { style: 'display:flex;gap:10px;margin-top:16px' });
  if (!editBook) {
    btns.appendChild(el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: async () => {
      const nm = name.value.trim();
      if (!nm) { toast('请填写名称'); return; }
      if (!isSubjectOpen(l1.value, l2.value)) { toast('该科目暂未开放'); return; }
      await store('wrongbooks').create({ name: nm, level1: l1.value, level2: l2.value });
      toast('错题簿已创建');
      onDone();
    } }, '创建'));
  }
  btns.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: onDone }, editBook ? '返回' : '取消'));
  form.appendChild(btns);
  return form;
}

async function bookList(root, rerender) {
  root.innerHTML = '';
  const books = await listAll('wrongbooks');
  const mistakes = await listAll('mistakes');
  const countByBook = {};
  for (const m of mistakes) countByBook[m.book_id] = (countByBook[m.book_id] || 0) + 1;

  const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px' },
    el('h2', { style: 'margin:0' }, '我的错题簿'),
    el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => root.replaceChildren(bookForm(rerender)) }, '＋ 新建错题簿'));
  root.appendChild(head);

  if (!books.length) {
    root.appendChild(el('div', { class: 'card' }, el('p', { class: 'muted' }, '还没有错题簿，点右上角「新建错题簿」开始收录错题吧。')));
    return;
  }
  for (const b of books) {
    const card = el('div', { class: 'card', style: 'display:flex;justify-content:space-between;align-items:center;gap:12px' });
    const left = el('div', { style: 'cursor:pointer;flex:1' },
      el('h3', { style: 'margin:0 0 4px' }, b.name),
      el('div', { class: 'muted' }, `${b.level1} · ${b.level2} · ${countByBook[b.id] || 0} 道错题`));
    left.addEventListener('click', () => { location.hash = `#/books/${b.id}`; });
    const del = el('button', { class: 'btn btn-ghost', style: 'width:auto;color:var(--danger)' }, '删除');
    del.addEventListener('click', async () => {
      const ok = await confirmDialog(`确定删除错题簿「${b.name}」？将连带删除全部 ${countByBook[b.id] || 0} 道错题与相关练习题，不可恢复。`);
      if (!ok) return;
      await deleteBookCascade(b.id);
      toast('已删除');
      rerender();
    });
    card.append(left, del);
    root.appendChild(card);
  }
}

export default {
  async render(root, { params }) {
    // #/books → 列表；#/books/:id → 簿内错题列表（mistakes.js 提供）
    if (params?.[0]) {
      const { renderBookMistakes } = await import('./mistakes.js');
      await renderBookMistakes(root, Number(params[0]));
      return;
    }
    const rerender = () => bookList(root, rerender);
    await rerender();
  },
};
