// 客观题判分：单选/判断精确匹配，多选集合相等，填空归一化匹配
// 返回 'right' | 'wrong'；主观题型（简答等）返回 null（交给 LLM 判）

export function normalizeAnswer(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    // 全角 ASCII 区（FF01-FF5E，含＝、Ｘ等）转半角
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '');
}

export function gradeObjective(question, userAnswer) {
  const type = question.q_type;
  if (type === '单选' || type === '判断') {
    return normalizeAnswer(userAnswer) === normalizeAnswer(question.answer) ? 'right' : 'wrong';
  }
  if (type === '多选') {
    const a = [...normalizeAnswer(userAnswer)].sort().join('');
    const b = [...normalizeAnswer(question.answer)].sort().join('');
    return a && a === b ? 'right' : 'wrong';
  }
  if (type === '填空') {
    return normalizeAnswer(userAnswer) === normalizeAnswer(question.answer) ? 'right' : 'wrong';
  }
  return null; // 简答/作文等走 LLM 判分
}
