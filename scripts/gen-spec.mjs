// 生成 wrangler esbuild 可用的文本常量（?raw 是 Vite 特性，wrangler 打包不认）
// 编辑源文件后运行: node scripts/gen-spec.mjs （或 pnpm gen:spec）
import { readFileSync, writeFileSync } from 'node:fs';
const jobs = [
  ['docs/applet-spec.md', 'platform/worker/spec-text.ts', 'SPEC_MD', 'Applet 小程序开发规范'],
  ['platform/worker/applet-runtime.js', 'platform/worker/runtime-text.ts', 'RUNTIME_JS', 'window.applet'],
];
for (const [src, out, name] of jobs) {
  const text = readFileSync(src, 'utf-8');
  writeFileSync(out, `// 自动生成：勿手改。源文件 ${src}，运行 node scripts/gen-spec.mjs 同步。\nexport const ${name} = ${JSON.stringify(text)};\n`);
  console.log(`${out} generated, ${text.length} chars`);
}
