// Vite ?raw 导入的通用声明（sql/md/js/ts/vue 全覆盖）
declare module '*?raw' {
  const content: string;
  export default content;
}
