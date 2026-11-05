// Prompt 模板与 LLM 输出解析器（按学科模板化，输出 JSON schema 约束）
// 各 build* 返回系统提示词文本；各 parse* 容错解析并归一化。

const Q_TYPES = ['单选', '多选', '判断', '填空', '简答'];
const ONLINE_TYPES = ['单选', '多选', '判断', '填空'];

// ---------- 收录管线 ----------

export function buildRecognitionPrompt(subject) {
  return `你是专业的试卷批阅助手。用户会提供一张题目照片（可能包含手写内容）。请识别并输出 JSON（不要输出其它文字）：
{"question_text":"题目完整题干","user_answer":"学生的手写答案（黑笔内容），没有则空字符串","right_answer":"正确的答案（红笔内容），图中没有红笔答案则空字符串","has_red_pen":布尔值，图中是否包含红笔书写的正确答案}
要求：保留数学公式/英语原文的准确转写；学科为${subject}。`;
}

export function buildAnswerPrompt(subject, questionText) {
  return `你是${subject}学科的资深教师。请为下面的题目给出正确答案与完整解题过程，输出 JSON（不要输出其它文字）：
{"right_answer":"最终答案（简明）","solution":"分步解题过程"}
题目：${questionText}`;
}

export function buildAnalysisPrompt(subject, { questionText, userAnswer, rightAnswer }) {
  return `你是${subject}学科的资深教师。学生做错了下面的题，请分析错误原因，输出 JSON（不要输出其它文字）：
{"analysis":"错误分析：指出薄弱的知识点、这种题型的特点、正确的解题思路、以及答这类题时需要注意的坑。250字以内。"}
题目：${questionText}
学生的答案：${userAnswer || '（空白或未识别）'}
正确答案：${rightAnswer || '（无）'}`;
}

export function buildTaggingPrompt(subject, tagsByDim) {
  const existing = JSON.stringify(tagsByDim);
  return `你是${subject}学科的助教。请根据下面的错题信息，从四个维度给出标签，输出 JSON（不要输出其它文字）：
{"type":["题型标签，0-3个，如：单选/多选/判断/填空/大题/简答/作文"],"category":["知识归类标签，0-3个，如：代数/几何/三角函数/力学/电路学"],"kp":["具体知识点标签，0-3个，越精确越好"],"cause":["错误原因标签，0-3个，如：计算失误/审题偏差/基础知识薄弱/无法融会贯通/粗心"]}
用户已有的标签清单（优先复用，避免同义新造）：${existing}
错题信息将随后给出。`;
}

// ---------- 出题 ----------

export function buildGenerationPrompt(subject, { count, difficulty, focusText, example }) {
  return `你是${subject}学科的资深命题教师。请围绕下面的范围生成 ${count} 道练习题，输出 JSON（不要输出其它文字）：
{"questions":[{"stem":"题干","answer":"标准答案","grading_points":"判分要点（主观题给分依据，用；分隔）","q_type":"单选|多选|判断|填空|简答 之一","mode":"online|offline（需要画图、列表格或写复杂数学公式的题必须 offline，其余 online）"}]}
要求：
- 数量：正好 ${count} 道
- 难度：与原错题${difficulty === '简单' ? '更简单一些' : difficulty === '较难' ? '稍有提升' : '近似'}
- 单选题请把选项写在题干内（A. … B. …）；多选题同理
出题范围：${focusText}${example ? `\n参考原题风格：${example}` : ''}`;
}

// ---------- 练习判分 ----------

export function buildGradingPrompt(question, userAnswer) {
  return `你是阅卷教师。请按判分要点给学生答案打分，输出 JSON（不要输出其它文字）：
{"result":"right|partial|wrong","score":0到100的整数,"feedback":"简短点评（对在哪、错在哪、怎么改进）"}
题目：${question.stem}
标准答案：${question.answer}
判分要点：${question.grading_points || '（无，按标准答案判）'}
学生答案：${userAnswer}`;
}

// ---------- 解析器 ----------

export function parseRecognition(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  return {
    question_text: String(o.question_text || ''),
    user_answer: String(o.user_answer || ''),
    right_answer: String(o.right_answer || ''),
    has_red_pen: !!o.has_red_pen,
  };
}

export function parseTagging(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  const pick = (arr, max = 3) => (Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()).map(s => s.trim()).slice(0, max) : []);
  return { type: pick(o.type), category: pick(o.category), kp: pick(o.kp), cause: pick(o.cause) };
}

export function parseQuestions(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  const list = Array.isArray(o.questions) ? o.questions : [];
  const out = [];
  for (const q of list) {
    if (!q || typeof q.stem !== 'string' || !q.stem.trim() || typeof q.answer !== 'string' || !q.answer.trim()) continue;
    let qType = Q_TYPES.includes(q.q_type) ? q.q_type : '简答';
    let mode = q.mode === 'online' || q.mode === 'offline' ? q.mode
      : (ONLINE_TYPES.includes(qType) ? 'online' : 'offline');
    out.push({
      stem: q.stem.trim(),
      answer: q.answer.trim(),
      grading_points: String(q.grading_points || ''),
      q_type: qType,
      mode,
    });
  }
  return out;
}

export function parseGrade(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  const result = ['right', 'partial', 'wrong'].includes(o.result) ? o.result
    : ['right', 'partial', 'wrong'].includes(String(o.result).toLowerCase()) ? String(o.result).toLowerCase() : 'wrong';
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score) || 0)));
  return { result, score, feedback: String(o.feedback || '') };
}

export function parseAnalysis(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  return { analysis: String(o.analysis || '') };
}

export function parseAnswer(text) {
  const o = typeof text === 'string' ? JSON.parse(text) : text;
  return { right_answer: String(o.right_answer || ''), solution: String(o.solution || '') };
}
