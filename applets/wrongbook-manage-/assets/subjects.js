// 科目清单：v0.1 代码常量（新增开放科目需发新版本）。
// open=false 的科目在界面上置灰为「待开发」。
export const SUBJECTS = [
  {
    level1: '基础教育',
    items: [
      { name: '数学', open: true },
      { name: '语文', open: true },
      { name: '英语', open: true },
      { name: '物理', open: true },
      { name: '化学', open: true },
      { name: '生物', open: false },
      { name: '政治', open: false },
      { name: '历史', open: false },
      { name: '地理', open: false },
      { name: '信息技术', open: false },
    ],
  },
  {
    level1: '高等及专业教育',
    items: [
      { name: '高等数学', open: false },
      { name: '线性代数', open: false },
      { name: '概率统计', open: false },
      { name: '大学物理', open: false },
      { name: '编程', open: false },
      { name: '财会', open: false },
      { name: '考公', open: false },
      { name: '考研', open: false },
      { name: '教师资格', open: false },
      { name: '法律职业资格', open: false },
    ],
  },
];

export function isSubjectOpen(level1, name) {
  const group = SUBJECTS.find(g => g.level1 === level1);
  const item = group && group.items.find(i => i.name === name);
  return !!(item && item.open);
}
