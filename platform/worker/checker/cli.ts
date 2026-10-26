// CLI: pnpm check:applets — 扫描 applets/*/ 并输出 issues JSON
// 用法: tsx platform/worker/checker/cli.ts <appletsDir>
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkApplet } from './index';

const dir = process.argv[2] || 'applets';
const issues: ReturnType<typeof checkApplet> = [];

if (existsSync(dir)) {
  for (const name of readdirSync(dir)) {
    const appletDir = join(dir, name);
    if (!statSync(appletDir).isDirectory()) continue;
    const files = new Map<string, string>();
    collect(appletDir, '', files);
    issues.push(...checkApplet(name, files));
  }
}

function collect(root: string, prefix: string, out: Map<string, string>) {
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) {
      collect(root, rel, out);
    } else {
      out.set(rel, readFileSync(full, 'utf-8'));
    }
  }
}

console.log(JSON.stringify({ issues }, null, 2));
process.exit(issues.some((i) => i.level === 'error') ? 1 : 0);
