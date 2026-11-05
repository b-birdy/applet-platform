// 收录管线：拍照/上传 → 压缩 →（可选 S3）→ 识别 → 补答案 → 归因 → 打标 → 确认卡片 → 入库
// 练习录回复用同一管线（source=practice_back）
import { compressImage } from '../image.js';
import { toast } from '../main.js';
import { chatJson } from '../ai.js';
import { buildRecognitionPrompt, buildAnswerPrompt, buildAnalysisPrompt, buildTaggingPrompt,
         parseRecognition, parseAnswer, parseAnalysis, parseTagging } from '../prompts.js';
import { store, listAll, createTagRefs, attachTags } from '../db.js';

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


// 四维标签中文名
const DIM_NAMES = { type: '题型', category: '知识归类', kp: '知识点', cause: '错误原因' };

export default {
  async render(root, { query }) {
    root.innerHTML = '';
    const source = query.get('source') || 'capture';
    const bookId = Number(query.get('book') || 0);
    const books = await listAll('wrongbooks');

    if (!books.length) {
      root.appendChild(el('div', { class: 'card' },
        el('p', {}, '还没有错题簿，先去建一本吧。'),
        el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: () => { location.hash = '#/books'; } }, '去建错题簿')));
      return;
    }

    const stepBar = el('div', { style: 'display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap' });
    const steps = ['① 识别', '② 归因', '③ 打标', '④ 确认'];
    const stepEls = steps.map(s => el('span', { class: 'chip', style: 'opacity:.4' }, s));
    stepEls.forEach(e => stepBar.appendChild(e));
    const setStep = (i) => stepEls.forEach((e, j) => { e.style.opacity = j <= i ? '1' : '.4'; });

    const body = el('div');
    root.append(el('h2', { style: 'margin:0 0 8px' }, source === 'practice_back' ? '练习录回' : '收录错题'), stepBar, body);

    // 选簿
    let selectedBook = bookId || books[0].id;
    if (source === 'capture' && !bookId) {
      const selCard = el('div', { class: 'card' }, el('label', {}, '收入哪本错题簿？'));
      const sel = el('select', {});
      for (const b of books) sel.appendChild(el('option', { value: b.id }, `${b.name}（${b.level2}）`));
      sel.value = String(selectedBook);
      sel.addEventListener('change', () => { selectedBook = Number(sel.value); });
      selCard.appendChild(sel);
      body.appendChild(selCard);
    }

    // 上传入口
    const pickCard = el('div', { class: 'card' });
    const fileInput = el('input', { type: 'file', accept: 'image/*', ...(source !== 'practice_back' ? { capture: 'environment' } : {}) });
    fileInput.style.display = 'none';
    const pickBtn = el('button', { class: 'btn btn-primary', style: 'width:auto' }, '📷 拍照 / 选择图片');
    pickBtn.addEventListener('click', () => fileInput.click());
    pickCard.append(pickBtn, fileInput, el('p', { class: 'muted' }, '一次一道题。黑笔=你的答案，红笔=正确答案（没有红笔 AI 会帮你生成）。'));
    body.appendChild(pickCard);

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        await runPipeline(file, { bookId: selectedBook, source, root: body, setStep });
      } catch (e) {
        toast(`出错：${e.message}`);
      }
    });
  },
};

// ---------- 管线主体 ----------

async function runPipeline(file, { bookId, source, root, setStep }) {
  root.querySelectorAll('.pipeline-result').forEach(n => n.remove());
  const result = el('div', { class: 'pipeline-result' });
  root.appendChild(result);

  result.appendChild(el('p', { class: 'muted' }, '压缩图片中…'));
  const { dataUrl } = await compressImage(file);
  setStep(0);

  let rec; // 识别结果
  try {
    result.appendChild(el('p', { class: 'muted' }, 'AI 识别中…'));
    rec = parseRecognition(await chatJson('vision', [
      { role: 'system', content: buildRecognitionPrompt('数学') },
      { role: 'user', content: [{ type: 'text', text: '请识别这张题图' }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ]));
  } catch (e) {
    rec = { question_text: '', user_answer: '', right_answer: '', has_red_pen: false };
    showStepError(result, '识别', e, async () => {
      rec = parseRecognition(await chatJson('vision', [
        { role: 'system', content: buildRecognitionPrompt('数学') },
        { role: 'user', content: [{ type: 'text', text: '请识别这张题图' }, { type: 'image_url', image_url: { url: dataUrl } }] },
      ]));
      await finish();
    });
    await finish(true); // 手动模式进入确认
    return;
  }
  setStep(1);

  // prompts 层用 camelCase 字段
  const recFields = { questionText: rec.question_text, userAnswer: rec.user_answer, rightAnswer: rec.right_answer };
  let analysis = '';
  try {
    if (!rec.has_red_pen) {
      result.appendChild(el('p', { class: 'muted' }, '图中没有红笔答案，AI 生成中…'));
      const ans = parseAnswer(await chatJson('llm', [
        { role: 'system', content: buildAnswerPrompt('数学', rec.question_text) },
        { role: 'user', content: '请生成' },
      ]));
      rec.right_answer = ans.right_answer;
      rec.answer_solution = ans.solution;
      rec.answer_source = 'ai';
      recFields.rightAnswer = ans.right_answer;
    } else {
      rec.answer_source = 'red_pen';
    }
    result.appendChild(el('p', { class: 'muted' }, 'AI 归因分析中…'));
    analysis = parseAnalysis(await chatJson('llm', [
      { role: 'system', content: buildAnalysisPrompt('数学', recFields) },
      { role: 'user', content: '请分析' },
    ])).analysis;
  } catch (e) {
    showStepError(result, '归因', e, async () => {
      analysis = parseAnalysis(await chatJson('llm', [
        { role: 'system', content: buildAnalysisPrompt('数学', recFields) },
        { role: 'user', content: '请分析' },
      ])).analysis;
      await finish();
    });
    await finish(true);
    return;
  }
  setStep(2);

  let generated = null; // 四维标签（原始，用于确认卡片编辑）
  try {
    result.appendChild(el('p', { class: 'muted' }, 'AI 生成标签中…'));
    const existing = await listAll('tags');
    const tagsByDim = { type: [], category: [], kp: [], cause: [] };
    for (const t of existing) if (tagsByDim[t.dim]) tagsByDim[t.dim].push(t.name);
    generated = parseTagging(await chatJson('llm', [
      { role: 'system', content: buildTaggingPrompt('数学', tagsByDim) },
      { role: 'user', content: `题目：${rec.question_text}\n学生答案：${rec.user_answer}\n正确答案：${rec.right_answer}\n错因分析：${analysis}` },
    ]));
  } catch (e) {
    generated = { type: [], category: [], kp: [], cause: [] };
    showStepError(result, '打标', e, async () => {
      await finish();
    });
    await finish(true);
    return;
  }
  setStep(3);
  await finish();

  // ---------- 确认卡片 ----------
  async function finish(skipSteps = false) {
    result.querySelectorAll('.retry-box').forEach(n => n.remove());
    result.querySelectorAll('p.muted').forEach(n => n.remove());

    const card = el('div', { class: 'card' });
    card.appendChild(el('h3', {}, '确认卡片（可修改后归档）'));

    const img = el('img', { src: dataUrl, style: 'max-width:100%;max-height:280px;border-radius:8px;margin-bottom:8px' });
    card.appendChild(img);

    const mk = (label, value, rows = 3) => {
      card.appendChild(el('label', {}, label));
      const t = el('textarea', {}, value || '');
      card.appendChild(t);
      return t;
    };
    const qText = mk('题干', rec.question_text);
    const uAns = mk('你的答案（黑笔）', rec.user_answer, 2);
    const rAns = mk('正确答案' + (rec.answer_source === 'ai' ? '（AI 生成）' : ''), rec.right_answer, 2);
    const ana = mk('错误分析', analysis, 5);

    // 标签 chips（可删可加）
    const tagArea = el('div');
    const renderTags = () => {
      tagArea.innerHTML = '';
      for (const dim of Object.keys(DIM_NAMES)) {
        const row = el('div', { style: 'margin:6px 0' }, el('strong', {}, `${DIM_NAMES[dim]}：`));
        for (const name of (generated[dim] || [])) {
          row.appendChild(el('span', { class: 'chip' }, name, el('span', {
            class: 'x', onclick: () => { generated[dim] = generated[dim].filter(x => x !== name); renderTags(); },
          }, '×')));
        }
        const inp = el('input', { placeholder: `+${DIM_NAMES[dim]}`, style: 'width:110px;display:inline-block;min-height:32px;padding:4px 8px' });
        inp.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' && inp.value.trim()) {
            (generated[dim] = generated[dim] || []).push(inp.value.trim());
            inp.value = ''; renderTags();
          }
        });
        row.appendChild(inp);
        tagArea.appendChild(row);
      }
    };
    renderTags();
    card.appendChild(el('label', {}, '标签（回车添加，× 删除）'));
    card.appendChild(tagArea);

    card.appendChild(el('div', { style: 'display:flex;gap:10px;margin-top:16px' },
      el('button', { class: 'btn btn-primary', style: 'width:auto', onclick: async () => {
        // 归档
        const tags = await listAll('tags');
        const all = [];
        for (const dim of Object.keys(DIM_NAMES)) for (const name of (generated[dim] || [])) all.push({ name, dim });
        const { tagIds } = await createTagRefs(bookSubject(bookId), all, tags);
        const r = await store('mistakes').create({
          book_id: bookId,
          question_text: qText.value.trim(),
          user_answer: uAns.value.trim(),
          right_answer: rAns.value.trim(),
          answer_source: rec.answer_source || '',
          analysis: ana.value.trim(),
          question_type: (generated.type || [])[0] || '',
          images: JSON.stringify([dataUrl]),
          source,
          confirmed: 1,
          subject: bookSubject(bookId),
        });
        await attachTags(r.id, tagIds);
        toast('已归档');
        location.hash = `#/mistakes/${r.id}`;
      } }, '✓ 归档'),
    ));
    result.appendChild(card);
  }
}

async function bookSubject(bookId) {
  const books = await listAll('wrongbooks');
  return books.find(b => b.id === bookId)?.level2 || '';
}

// 分步失败提示：错误 + 重试此步 + 手动补填
function showStepError(container, stepName, err, retryFn) {
  const box = el('div', { class: 'retry-box', style: 'border:1px solid var(--danger);border-radius:8px;padding:12px;margin:10px 0' },
    el('p', { style: 'color:var(--danger);margin:0 0 8px' }, `${stepName}失败：${err.message}`));
  box.append(
    el('button', { class: 'btn btn-ghost', style: 'width:auto', onclick: async (e) => {
      e.target.textContent = '重试中…';
      try { await retryFn(); } catch (e2) { e.target.textContent = '重试'; toast(`重试失败：${e2.message}`); }
    } }, '重试此步'),
    el('span', { class: 'muted', style: 'margin-left:8px' }, '或直接在下方手动补填后归档'),
  );
  container.appendChild(box);
}
