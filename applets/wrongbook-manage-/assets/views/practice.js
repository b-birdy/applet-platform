// 练习页：批次列表 + 批内作答（客观即时判分 / 主观 AI 点评）+ 答错沉淀 + 线下题单
import { listAll, store } from '../db.js';
import { toast } from '../main.js';
import { gradeObjective } from '../grading.js';
import { chatJson } from '../ai.js';
import { buildGradingPrompt, parseGrade } from '../prompts.js';

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


// 题干里的选项行（A. xxx）拆出来点选；返回 null 表示无选项结构
function parseOptions(stem) {
  const lines = stem.split('\n').map(l => l.trim());
  const opts = lines.filter(l => /^[A-DＡ-Ｄ][.．、]\s*/.test(l));
  if (opts.length < 2) return null;
  return opts.map(l => l.replace(/^([A-DＡ-Ｄ])[.．、]\s*/, '$1. '));
}

export default {
  async render(root, { params, query }) {
    root.innerHTML = '';
    const batchId = params[0];
    if (!batchId) return renderList(root);

    // ---------- 批内作答 ----------
    const [questions, mistakes, books, attempts, tags, mts] = await Promise.all([
      listAll('questions'), listAll('mistakes'), listAll('wrongbooks'),
      listAll('attempts'), listAll('tags'), listAll('mistake_tags')]);
    const batch = questions.filter(q => q.batch_id === batchId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (!batch.length) {
      root.appendChild(el('div', { class: 'card' }, el('p', {}, '练习批次不存在或已清空。'),
        el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/practice'; } }, '返回练习列表')));
      return;
    }
    const batchAttempts = attempts.filter(a => batch.some(q => q.id === a.question_id));
    const answeredIds = new Set(batchAttempts.map(a => a.question_id));
    let offline = query.get('mode') === 'offline';

    const bookById = new Map(books.map(b => [b.id, b]));
    const firstBook = bookById.get(batch[0].book_id);
    const tagIdsByMistake = new Map();
    for (const mt of mts) {
      if (!tagIdsByMistake.has(mt.mistake_id)) tagIdsByMistake.set(mt.mistake_id, []);
      tagIdsByMistake.get(mt.mistake_id).push(mt.tag_id);
    }

    // 头部
    const head = el('div', { class: 'card' },
      el('h3', { style: 'margin-top:0' }, `练习批次（${batch.length} 题）`),
      el('p', { class: 'muted' }, `所属错题簿：${firstBook ? firstBook.name : '未知'} · 生成时间 ${String(batch[0].created_at).slice(0, 10)}`));
    if (!offline) {
      head.appendChild(el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => {
        location.hash = `#/practice/${batchId}?mode=offline`;
      } }, '📄 切换线下题单（打印）'));
    }
    root.appendChild(head);

    // 作答结果
    const resultCard = el('div', { class: 'card', style: 'display:none' });
    root.appendChild(resultCard);

    function showSummary() {
      const rows = batchAttempts.filter(a => answeredIds.has(a.question_id));
      const right = rows.filter(a => a.result === 'right').length;
      const done = rows.length;
      resultCard.style.display = '';
      resultCard.innerHTML = '';
      resultCard.appendChild(el('h3', { style: 'margin-top:0' }, done < batch.length && !offline ? `作答进度 ${done}/${batch.length}` : '本批练习完成'));
      resultCard.appendChild(el('p', { class: 'stat-num' }, done ? `正确率 ${Math.round(right / done * 100)}%（${right}/${done}）` : '尚未作答'));
      const btns = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
        el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/sublimate'; } }, '🎯 再来一批'),
        el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: () => { location.hash = '#/practice'; } }, '返回练习列表'));
      resultCard.appendChild(btns);
    }

    // 答错沉淀：线上答错（含 partial）→ 新 mistakes 行；ref 有则复制标签
    async function sinkMistake(q, userAnswer) {
      const r = await store('mistakes').create({
        book_id: q.book_id,
        question_text: q.stem,
        user_answer: String(userAnswer || ''),
        right_answer: q.answer,
        analysis: '',
        question_type: q.q_type,
        confirmed: 1,
        source: 'practice',
        images: '[]',
      });
      const refId = q.ref_mistake_id;
      if (refId) {
        const ids = tagIdsByMistake.get(refId) || [];
        for (const tag_id of ids) await store('mistake_tags').create({ mistake_id: r.id, tag_id });
      }
      return r.id;
    }

    if (offline) { renderOffline(batch); return; }

    // 在线逐题卡
    for (const q of batch) {
      const card = el('div', { class: 'card', 'data-q': q.id });
      card.appendChild(el('div', { class: 'muted', style: 'margin-bottom:6px' }, `${q.q_type} · ${q.mode === 'offline' ? '线下题' : '线上题'}`));
      card.appendChild(el('p', { style: 'white-space:pre-wrap;font-weight:600' }, q.stem));

      const opts = parseOptions(q.stem);
      const inputWrap = el('div');
      let answerGetter;
      const submitBtn = el('button', { class: 'btn btn-primary', style: 'width:auto;margin-top:8px' }, '提交答案');

      if ((q.q_type === '单选' || q.q_type === '多选') && opts) {
        const picked = new Set(q.q_type === '多选' ? [] : []);
        answerGetter = () => [...picked].sort().join('');
        for (const o of opts) {
          const letter = o[0];
          const b = el('button', { class: 'opt-btn', style: 'width:auto', onclick: () => {
            if (q.q_type === '多选') { picked.has(letter) ? picked.delete(letter) : picked.add(letter); }
            else { picked.clear(); picked.add(letter); }
            [...inputWrap.querySelectorAll('.opt-btn')].forEach(x => x.classList.toggle('opt-on', picked.has(x.dataset.letter)));
          }, 'data-letter': letter }, o);
          inputWrap.appendChild(b);
        }
      } else if (q.q_type === '判断') {
        const picked = new Set();
        answerGetter = () => [...picked].join('');
        for (const letter of ['对', '错']) {
          const b = el('button', { class: 'opt-btn', style: 'width:auto', onclick: () => {
            picked.clear(); picked.add(letter);
            [...inputWrap.querySelectorAll('.opt-btn')].forEach(x => x.classList.toggle('opt-on', x.textContent === letter));
          } }, letter);
          inputWrap.appendChild(b);
        }
      } else {
        const ta = el('textarea', { rows: '3', placeholder: '在这里作答…', style: 'width:100%' });
        answerGetter = () => ta.value;
        inputWrap.appendChild(ta);
      }
      card.append(inputWrap, submitBtn);
      const feedback = el('div', { class: 'feedback', style: 'display:none' });
      card.appendChild(feedback);

      submitBtn.addEventListener('click', async () => {
        const answer = answerGetter();
        if (!answer && answer !== '0') { toast('请先作答'); return; }
        submitBtn.disabled = true;
        try {
          let res;
          const obj = gradeObjective(q, answer);
          if (obj) {
            res = { result: obj, score: obj === 'right' ? 100 : 0, feedback: obj === 'right' ? '回答正确' : `正确答案：${q.answer}` };
          } else {
            feedback.style.display = '';
            feedback.textContent = 'AI 正在批改…';
            const data = await chatJson('llm', [{ role: 'system', content: buildGradingPrompt(q, answer) }], { timeoutMs: 120000 });
            res = parseGrade(typeof data === 'string' ? data : JSON.stringify(data));
          }
          await store('attempts').create({ question_id: q.id, answer: String(answer), result: res.result, score: res.score, feedback: res.feedback });
          batchAttempts.push({ question_id: q.id, result: res.result, answer: String(answer) });
          answeredIds.add(q.id);
          feedback.style.display = '';
          feedback.innerHTML = '';
          feedback.append(
            el('p', { class: res.result === 'right' ? 'ok-text' : 'bad-text' },
              res.result === 'right' ? '✓ 正确' : res.result === 'partial' ? `◐ 部分正确（${res.score} 分）` : '✗ 错误'),
            el('p', { style: 'white-space:pre-wrap' }, res.feedback),
            res.result !== 'right' ? el('p', { class: 'muted' }, `标准答案：${q.answer}`) : null);
          if (res.result !== 'right' && q.mode === 'online') {
            await sinkMistake(q, answer);
            feedback.appendChild(el('p', { class: 'muted' }, '已沉淀进错题簿，可在升华页针对性练习。'));
          }
          showSummary();
        } catch (e) {
          feedback.style.display = '';
          feedback.textContent = `判分失败：${e.message}`;
          submitBtn.disabled = false;
        }
      }, { once: false });
      root.appendChild(card);
    }
    showSummary();

    // ---------- 线下题单 ----------
    function renderOffline(batch) {
      const listCard = el('div', { class: 'card print-sheet' });
      listCard.appendChild(el('h3', { style: 'margin-top:0' }, '线下题单'));
      batch.forEach((q, i) => {
        listCard.appendChild(el('p', { style: 'white-space:pre-wrap;page-break-inside:avoid' }, `${i + 1}. [${q.q_type}] ${q.stem}`));
        if (q.mode === 'offline') listCard.appendChild(el('p', { class: 'muted', style: 'font-size:.85rem' }, `参考答案：${q.answer}`));
      });
      const tools = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
        el('button', { class: 'btn btn-primary no-print', style: 'width:auto', onclick: () => window.print() }, '🖨 打印题单'),
        el('button', { class: 'btn btn-ghost no-print', style: 'width:auto', onclick: () => {
          location.hash = `#/capture?book=${batch[0].book_id}&source=practice_back`;
        } }, '练习录回（拍照归档）'),
        el('button', { class: 'btn btn-ghost no-print', style: 'width:auto', onclick: () => {
          location.hash = `#/practice/${batchId}`;
        } }, '返回在线作答'));
      root.appendChild(tools);
    }
  },
};

// ---------- 批次列表 ----------
async function renderList(root) {
  const [questions, mistakes, books, attempts] = await Promise.all([
    listAll('questions'), listAll('mistakes'), listAll('wrongbooks'), listAll('attempts')]);
  root.appendChild(el('h2', { style: 'margin-top:0' }, '练习'));
  if (!questions.length) {
    root.appendChild(el('div', { class: 'card' }, el('p', {}, '还没有练习题。去「升华」页选个范围，让 AI 给你出题吧。'),
      el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/sublimate'; } }, '去升华页')));
    return;
  }
  const byBatch = new Map();
  for (const q of questions) {
    if (!byBatch.has(q.batch_id)) byBatch.set(q.batch_id, []);
    byBatch.get(q.batch_id).push(q);
  }
  const groups = [...byBatch.entries()]
    .map(([bid, qs]) => ({ bid, qs, t: String(qs[0].created_at) }))
    .sort((a, b) => b.t.localeCompare(a.t));
  for (const { bid, qs, t } of groups) {
    const ids = new Set(qs.map(q => q.id));
    const at = attempts.filter(a => ids.has(a.question_id));
    const right = at.filter(a => a.result === 'right').length;
    const book = books.find(b => b.id === qs[0].book_id);
    root.appendChild(el('div', { class: 'card book-card', onclick: () => { location.hash = `#/practice/${bid}`; } },
      el('div', {},
        el('h3', { style: 'margin:0 0 4px' }, `${t.slice(0, 10)} · ${qs.length} 题`),
        el('p', { class: 'muted', style: 'margin:0' },
          `${book ? book.name : '未知簿'}${at.length ? ` · 已作答 ${at.length}，正确率 ${Math.round(right / at.length * 100)}%` : ' · 未作答'} · 来自${qs[0].origin === 'mistake' ? '单题' : '范围筛选'}出题`))));
  }
}
