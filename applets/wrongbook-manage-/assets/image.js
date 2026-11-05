// 客户端图片压缩：长边 ≤1600px，JPEG 质量递减至 ≤100KB
// 返回 {blob, dataUrl, width, height}；dataUrl 供 vision base64 与入库复用

async function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('画布导出失败')), 'image/jpeg', quality);
  });
}

function drawScaled(bitmap, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

export async function compressImage(fileOrBlob, { maxEdge = 1600, maxBytes = 102400 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(fileOrBlob);
  } catch {
    throw new Error('无法读取图片文件，请换一张试试');
  }
  try {
    let w = bitmap.width, h = bitmap.height;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    let quality = 0.75;
    // 质量递减 → 仍超限则缩边 20% 重来，最多 6 轮
    for (let round = 0; round < 6; round++) {
      const canvas = drawScaled(bitmap, w, h);
      let blob = await toBlob(canvas, quality);
      if (blob.size <= maxBytes) {
        const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        return { blob, dataUrl, width: w, height: h };
      }
      quality -= 0.2;
      if (quality < 0.2) { quality = 0.75; w = Math.round(w * 0.8); h = Math.round(h * 0.8); }
    }
    // 最终结果如实返回（可能仍超限，UI 层提示）
    const canvas = drawScaled(bitmap, w, h);
    const blob = await toBlob(canvas, 0.2);
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    return { blob, dataUrl, width: w, height: h };
  } finally {
    bitmap.close?.();
  }
}
