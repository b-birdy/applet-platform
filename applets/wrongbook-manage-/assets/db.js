// 数据访问层：平台 store 的薄封装（翻页拉全量、KV 设置、级联删簿、标签归并）
// 平台错误（413 QUOTA_EXCEEDED / 401 UNAUTHORIZED 等）原样上抛，由 UI 层中文呈现。

export function store(name) {
  return window.applet.data(name);
}

// 翻页拉全量（平台 list 单页上限未知，500 一页足够快）
export async function listAll(name) {
  const s = store(name);
  const out = [];
  let offset = 0;
  for (;;) {
    const { rows, total } = await s.list({ limit: 500, offset });
    out.push(...rows);
    offset += rows.length;
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

// ---------- 设置 KV ----------
export async function getSetting(kind, fallback) {
  const rows = await store('settings').list({});
  const hit = rows.rows.find(r => r.kind === kind);
  return hit ? JSON.parse(hit.value) : fallback;
}

export async function setSetting(kind, value) {
  const s = store('settings');
  const { rows } = await s.list({});
  const hit = rows.find(r => r.kind === kind);
  const val = JSON.stringify(value);
  if (hit) await s.update(hit.id, { value: val });
  else await s.create({ kind, value: val });
}

// AI 接入点：kind 为 'llm' | 'vision'（存 ai_endpoints）| 's3'（存 s3_endpoints）
export async function loadEndpoints(kind) {
  if (kind === 's3') return await getSetting('s3_endpoints', []);
  const all = await getSetting('ai_endpoints', { llm: [], vision: [] });
  return all[kind] || [];
}

// ---------- 级联删簿 ----------
export async function deleteBookCascade(bookId) {
  const mistakes = await listAll('mistakes');
  const mine = mistakes.filter(m => m.book_id === bookId);
  const mIds = new Set(mine.map(m => m.id));

  const mts = await listAll('mistake_tags');
  for (const mt of mts) if (mIds.has(mt.mistake_id)) await store('mistake_tags').remove(mt.id);

  const questions = await listAll('questions');
  const qIds = new Set(questions.filter(q => q.book_id === bookId).map(q => q.id));
  const attempts = await listAll('attempts');
  for (const a of attempts) if (qIds.has(a.question_id)) await store('attempts').remove(a.id);
  for (const q of questions) if (q.book_id === bookId) await store('questions').remove(q.id);

  for (const m of mine) await store('mistakes').remove(m.id);
  await store('wrongbooks').remove(bookId);
}

// ---------- 标签 ----------
// 归并：name(trim)+dim 相同视为同一标签，复用已有行，缺的新建
export async function createTagRefs(subject, generated, existingRows) {
  const s = store('tags');
  const existing = existingRows || await listAll('tags');
  const keyOf = (t) => `${(t.name || '').trim()}|${t.dim}`;
  const index = new Map(existing.map(t => [keyOf(t), t.id]));
  const tagIds = [];
  const newRows = [];
  for (const g of generated) {
    const name = (g.name || '').trim();
    if (!name) continue;
    const key = `${name}|${g.dim}`;
    if (index.has(key)) { tagIds.push(index.get(key)); continue; }
    const r = await s.create({ name, dim: g.dim, subject: subject || null });
    index.set(key, r.id);
    tagIds.push(r.id);
    newRows.push({ id: r.id, name, dim: g.dim, subject });
  }
  return { tagIds, newRows };
}

export async function attachTags(mistakeId, tagIds) {
  if (!tagIds.length) return;
  await store('mistake_tags').batch(tagIds.map(tag_id => ({ mistake_id: mistakeId, tag_id })));
}

// 摘除某题全部标签关联
export async function detachTagsByMistake(mistakeId) {
  const mts = await listAll('mistake_tags');
  for (const mt of mts) if (mt.mistake_id === mistakeId) await store('mistake_tags').remove(mt.id);
}

// 删除一个标签：删 tags 行 + 全量摘除关联（不删题）
export async function deleteTagEverywhere(tagId) {
  const mts = await listAll('mistake_tags');
  for (const mt of mts) if (mt.tag_id === tagId) await store('mistake_tags').remove(mt.id);
  await store('tags').remove(tagId);
}
