// 升华页：统计分析 + 针对性出题 + 标签总管理
import { listAll, store } from '../db.js';
import { toast } from '../main.js';
import { summarize, clampCount } from '../stats.js';
import { chatJson } from '../ai.js';
import { buildGenerationPrompt, parseQuestions } from '../prompts.js';
import { deleteTagEverywhere } from '../db.js';

const DIM_NAMES = { type: '题型', category: '知识归类', kp: '知识点', cause: '错误原因' };
const DIFFS = ['近似', '简单', '较难'];

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

// 榜单：name + count 条形
function rankList(items, max = 8) {
  const top = items.slice(0, max);
  if (!top.length) return el('p', { class: 'muted' }, '暂无数据');
  const biggest = top[0].count;
  const wrap = el('div');
  for (const { name, count } of top) {
    const bar = el('div', { class: 'rank-bar' },
      el('span', { class: 'rank-name' }, name),
      el('div', { class: 'rank-track' }, el('div', { class: 'rank-fill', style: `width:${Math.round(count / biggest * 100)}%` })),
      el('span', { class: 'rank-count' }, String(count)));
    wrap.appendChild(bar);
  }
  return wrap;
}

function monthBars(byMonth) {
  const keys = Object.keys(byMonth).sort();
  if (!keys.length) return el('p', { class: 'muted' }, '暂无数据');
  const biggest = Math.max(...keys.map(k => byMonth[k]));
  const wrap = el('div', { style: 'display:flex;gap:8px;align-items:flex-end;height:80px' });
  for (const k of keys) {
    wrap.appendChild(el('div', { style: 'text-align:center' },
      el('div', { class: 'rank-fill', style: `width:32px;height:${Math.max(4, Math.round(byMonth[k] / biggest * 64))}px;margin:0 auto` }),
      el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, k)));
  }
  return wrap;
}

export default {
  async render(root, { query }) {
    root.innerHTML = '';
    const [books, mistakes, tags, mts] = await Promise.all([
      listAll('wrongbooks'), listAll('mistakes'), listAll('tags'), listAll('mistake_tags')]);
    const tagById = new Map(tags.map(t => [t.id, t]));
    const bookById = new Map(books.map(b => [b.id, b]));

    // ---------- 状态 ----------
    const state = {
      bookId: query.get('book') ? Number(query.get('book')) : 0, // 0=全部
      tagIds: new Set(query.get('tag') ? [Number(query.get('tag'))] : []),
      refMistakeId: query.get('ref') ? Number(query.get('ref')) : 0,
    };

    // 单题来源：ref=xx → 只围绕该题
    let refMistake = null;
    if (state.refMistakeId) {
      try { refMistake = await store('mistakes').get(state.refMistakeId); } catch {}
      if (!refMistake) {
        root.appendChild(el('div', { class: 'card' }, el('p', {}, '引用的错题不存在或已删除。'),
          el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/sublimate'; } }, '返回升华')));
        return;
      }
    }

    function inScope(m) {
      if (refMistake) return m.id === refMistake.id;
      if (state.bookId && m.book_id !== state.bookId) return false;
      if (state.tagIds.size) {
        const mine = new Set(mts.filter(mt => mt.mistake_id === m.id).map(mt => mt.tag_id));
        for (const tid of state.tagIds) if (!mine.has(tid)) return false;
      }
      return true;
    }
    const scoped = () => mistakes.filter(inScope);

    // ---------- 布局：主列 + 侧栏 ----------
    const grid = el('div', { class: 'sublimate-grid' });
    const main = el('div');
    const side = el('div', { class: 'sublimate-side' });
    grid.append(main, side);
    root.appendChild(grid);

    // ---------- 主列：范围 + 统计 + 出题 ----------
    const filterCard = el('div', { class: 'card' });
    main.appendChild(filterCard);

    const statCard = el('div', { class: 'card' });
    const genCard = el('div', { class: 'card' });
    main.append(statCard, genCard);

    function renderFilter() {
      filterCard.innerHTML = '';
      filterCard.appendChild(el('h3', { style: 'margin-top:0' }, refMistake ? '出题范围：单题' : '出题范围'));
      if (refMistake) {
        filterCard.appendChild(el('p', { style: 'white-space:pre-wrap' }, refMistake.question_text || '（无题干）'));
        filterCard.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => { location.hash = '#/sublimate'; } }, '返回整体统计'));
        return;
      }
      const row = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' });
      const bookSel = el('select', {},
        el('option', { value: '0' }, '全部错题簿'),
        ...books.map(b => el('option', { value: b.id, selected: state.bookId === b.id ? '' : null }, b.name)));
      bookSel.addEventListener('change', () => { state.bookId = Number(bookSel.value); renderStats(); });
      row.appendChild(el('label', {}, '错题簿'));
      row.appendChild(bookSel);

      // 标签多选（chips）
      row.appendChild(el('label', {}, '标签（可多选，交集）'));
      const chipWrap = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      for (const t of tags) {
        const on = state.tagIds.has(t.id);
        const chip = el('button', { class: `chip${on ? ' chip-on' : ''}`, style: 'cursor:pointer;border:none' },
          `${DIM_NAMES[t.dim] || t.dim}：${t.name}`);
        chip.addEventListener('click', () => {
          if (state.tagIds.has(t.id)) state.tagIds.delete(t.id); else state.tagIds.add(t.id);
          renderStats();
        });
        chipWrap.appendChild(chip);
      }
      row.appendChild(chipWrap);
      filterCard.appendChild(row);
    }

    function renderStats() {
      renderFilter();
      const rows = scoped();
      const s = summarize(rows, tags, mts);
      statCard.innerHTML = '';
      statCard.appendChild(el('h3', { style: 'margin-top:0' }, `统计（${s.total} 道错题）`));
      const tiles = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' });
      tiles.append(
        el('div', { class: 'stat-tile' }, el('div', { class: 'stat-num' }, String(s.total)), el('div', { class: 'muted' }, '错题总数')),
        el('div', { class: 'stat-tile' }, el('div', { class: 'stat-num' }, String(tags.length)), el('div', { class: 'muted' }, '标签数')),
        el('div', { class: 'stat-tile' }, el('div', { class: 'stat-num' }, String(s.weakCombos.length)), el('div', { class: 'muted' }, '弱点组合')));
      statCard.appendChild(tiles);

      statCard.appendChild(el('h3', {}, '收录时间分布'));
      statCard.appendChild(monthBars(s.byMonth));

      const fourGrid = el('div', { class: 'four-grid' });
      fourGrid.append(
        el('div', {}, el('h3', {}, '题型 Top'), rankList(s.byType)),
        el('div', {}, el('h3', {}, '知识归类 Top'), rankList(s.byCategory)),
        el('div', {}, el('h3', {}, '知识点 Top'), rankList(s.byKp)),
        el('div', {}, el('h3', {}, '错误原因 Top'), rankList(s.byCause)));
      statCard.appendChild(fourGrid);
      statCard.appendChild(el('h3', {}, '弱点组合 Top5（知识归类 × 错误原因）'));
      if (!s.weakCombos.length) statCard.appendChild(el('p', { class: 'muted' }, '暂无数据（需要同题同时带「知识归类」和「错误原因」标签）'));
      else statCard.appendChild(rankList(s.weakCombos.map(x => ({ name: x.label, count: x.count })), 5));

      // ---------- 出题表单 ----------
      genCard.innerHTML = '';
      genCard.appendChild(el('h3', { style: 'margin-top:0' }, '生成练习题'));
      if (!rows.length) { genCard.appendChild(el('p', { class: 'muted' }, '当前范围没有错题，无法生成。')); return; }
      const row = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center' });
      const countIn = el('input', { type: 'number', min: '1', max: '100', value: '10', style: 'width:90px' });
      const diffSel = el('select', {}, ...DIFFS.map(d => el('option', { value: d }, `难度：${d}`)));
      const genBtn = el('button', { class: 'btn btn-primary', style: 'width:auto' }, '🎯 生成练习题');
      row.append(el('label', {}, '数量'), countIn, diffSel, genBtn);
      genCard.appendChild(row);
      const status = el('p', { class: 'muted', style: 'display:none' });
      genCard.appendChild(status);

      genBtn.addEventListener('click', async () => {
        const n = clampCount(countIn.value);
        countIn.value = String(n);
        const scopeDesc = refMistake ? '围绕这道错题的题型与知识点'
          : [state.bookId ? `错题簿「${bookById.get(state.bookId)?.name || ''}」` : '全部错题簿',
             state.tagIds.size ? `标签：${[...state.tagIds].map(id => tagById.get(id)?.name).filter(Boolean).join('、')}` : '']
            .filter(Boolean).join('，');
        const example = refMistake ? (refMistake.question_text || '').slice(0, 300) : (rows[0].question_text || '').slice(0, 300);
        const subject = (refMistake ? bookById.get(refMistake.book_id)?.level2 : bookById.get(state.bookId || rows[0].book_id)?.level2) || '';
        genBtn.disabled = true;
        status.style.display = '';
        status.textContent = `正在让 AI 生成 ${n} 道练习题，可能需要 1-2 分钟…`;
        try {
          const messages = [{ role: 'system', content: buildGenerationPrompt(subject, { count: n, difficulty: diffSel.value, focusText: scopeDesc, example }) }];
          const data = await chatJson('llm', messages, { timeoutMs: 300000 });
          const qs = parseQuestions(typeof data === 'string' ? data : JSON.stringify(data));
          if (!qs.length) throw new Error('AI 未返回有效题目，请重试或调整范围。');
          const batchId = crypto.randomUUID();
          const bookId = refMistake ? refMistake.book_id : (state.bookId || rows[0].book_id);
          await store('questions').batch(qs.map(q => ({
            book_id: bookId, batch_id: batchId, stem: q.stem, answer: q.answer,
            grading_points: q.grading_points, q_type: q.q_type, mode: q.mode,
            origin: refMistake ? 'mistake' : 'filter', ref_mistake_id: refMistake ? refMistake.id : null,
          })));
          location.hash = `#/practice/${batchId}`;
        } catch (e) {
          status.textContent = `生成失败：${e.message}`;
          genBtn.disabled = false;
        }
      });
    }

    // ---------- 侧栏：标签总管理 ----------
    side.appendChild(el('h3', { style: 'margin-top:0' }, '标签管理'));
    const tagCard = el('div', { class: 'card' });
    side.appendChild(tagCard);
    function renderTagAdmin() {
      tagCard.innerHTML = '';
      const byDim = new Map();
      for (const t of tags) {
        if (!byDim.has(t.dim)) byDim.set(t.dim, []);
        byDim.get(t.dim).push(t);
      }
      if (!tags.length) tagCard.appendChild(el('p', { class: 'muted' }, '还没有标签。收录错题后 AI 会自动生成。'));
      for (const [dim, list] of byDim) {
        tagCard.appendChild(el('h4', { style: 'margin:10px 0 4px' }, DIM_NAMES[dim] || dim));
        for (const t of list) {
          const row = el('div', { style: 'display:flex;gap:6px;align-items:center;margin:4px 0' },
            el('span', { style: 'flex:1' }, t.name),
            el('button', { class: 'btn btn-ghost', style: 'width:auto;padding:2px 8px', title: '重命名', onclick: async () => {
              const name = prompt('新标签名', t.name);
              if (!name || !name.trim() || name.trim() === t.name) return;
              await store('tags').update(t.id, { name: name.trim() });
              t.name = name.trim(); toast('已改名'); renderTagAdmin();
            } }, '改'),
            el('button', { class: 'btn btn-danger', style: 'width:auto;padding:2px 8px', onclick: async () => {
              if (!await confirmDialog(`删除标签「${t.name}」？所有错题上的该标签将被摘除（错题本身保留）。`)) return;
              await deleteTagEverywhere(t.id);
              tags.splice(tags.indexOf(t), 1);
              toast('已删除标签'); renderTagAdmin(); renderStats();
            } }, '删'));
          tagCard.appendChild(row);
        }
      }
    }
    renderTagAdmin();
    renderStats();
  },
};
