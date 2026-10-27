// 小程序图标工具：识别图标类型（emoji 文本 / 自定义图片 data URI）
export function iconSrc(icon?: string | null): string | null {
  if (!icon) return null;
  return icon.startsWith('data:image') ? icon : null;
}
