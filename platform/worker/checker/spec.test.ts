import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkApplet } from './index';

const ROOT = process.cwd(); // vitest 从仓库根运行
const APPLET_DIR = join(ROOT, 'applets/word-cards');
const SPEC_PATH = join(ROOT, 'docs/applet-spec.md');

function loadAppletFiles(): Map<string, string> {
  const files = new Map<string, string>();
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.set(rel, readFileSync(full, 'utf-8'));
    }
  }
  walk(APPLET_DIR, '');
  return files;
}

describe('word-cards example applet', () => {
  it('passes the checker with zero issues', () => {
    const issues = checkApplet('word-cards', loadAppletFiles());
    expect(issues).toEqual([]);
  });

  it('manifest id matches directory name', () => {
    const manifest = JSON.parse(readFileSync(join(APPLET_DIR, 'applet.json'), 'utf-8'));
    expect(manifest.id).toBe('word-cards');
    expect(manifest.entry).toBe('index.html');
    expect(manifest.tables).toEqual([
      { name: 'words', columns: [
        { name: 'word', type: 'text', required: true },
        { name: 'meaning', type: 'text' },
        { name: 'status', type: 'integer', default: 0 },
      ] },
    ]);
  });
});

describe('applet spec doc (MCP get_spec content source)', () => {
  const SECTIONS = ['structure', 'manifest', 'data', 'security', 'upload', '接口参考'];
  const spec = readFileSync(SPEC_PATH, 'utf-8');

  it.each(SECTIONS)('has a section for MCP key "%s"', (key) => {
    // 章节标题形如 ## structure / ## data（MCP 章节键）
    expect(new RegExp(`^## ${key}(\\s|$)`, 'm').test(spec)).toBe(true);
  });

  it('covers the security red lines from the platform spec', () => {
    for (const term of ['eval', 'document.cookie', 'external_apis', 'app-runtime.js', 'user_id']) {
      expect(spec).toContain(term);
    }
  });

  it('documents the runtime data API surface', () => {
    for (const api of ['list', 'create', 'update', 'remove', 'batch']) {
      expect(spec).toContain(api);
    }
  });
});
