// 统计纯函数：升华页的数据汇总（无 DOM / 无平台依赖，可单测）
// dim: type=题型 category=知识归类 kp=知识点 cause=错误原因

const DIMS = ['type', 'category', 'kp', 'cause'];

// 数量钳制：1–100 内整数，非法默认 10
export function clampCount(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 10;
  return Math.min(100, Math.max(1, v));
}

// 按 name 计数，降序
function countBy(pairs) {
  const m = new Map();
  for (const p of pairs) m.set(p, (m.get(p) || 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function summarize(mistakes, tags, mistakeTags) {
  const tagById = new Map(tags.map(t => [t.id, t]));
  // mistake_id → 该题的标签行
  const mtByMistake = new Map();
  for (const mt of mistakeTags) {
    if (!mtByMistake.has(mt.mistake_id)) mtByMistake.set(mt.mistake_id, []);
    mtByMistake.get(mt.mistake_id).push(mt.tag_id);
  }

  const pairs = { type: [], category: [], kp: [], cause: [] };
  const comboPairs = [];
  const byMonth = {};

  for (const m of mistakes) {
    const dims = new Map(); // dim → [name]
    for (const tid of mtByMistake.get(m.id) || []) {
      const t = tagById.get(tid);
      if (!t || !pairs[t.dim]) continue;
      pairs[t.dim].push(t.name);
      if (!dims.has(t.dim)) dims.set(t.dim, []);
      dims.get(t.dim).push(t.name);
    }
    // 弱点组合：category × cause 笛卡尔
    const cats = dims.get('category') || [];
    const causes = dims.get('cause') || [];
    for (const c of cats) for (const r of causes) comboPairs.push(`${c} × ${r}`);
    if (m.question_type) pairs.type.push(m.question_type);
    const ym = (m.created_at || '').slice(0, 7);
    if (ym) byMonth[ym] = (byMonth[ym] || 0) + 1;
  }

  return {
    total: mistakes.length,
    byType: countBy(pairs.type),
    byCategory: countBy(pairs.category),
    byKp: countBy(pairs.kp),
    byCause: countBy(pairs.cause),
    weakCombos: countBy(comboPairs).slice(0, 5).map(x => ({ label: x.name, count: x.count })),
    byMonth,
  };
}
