import { describe, expect, it } from 'vitest';
import { checkApplet } from './index';

// 工具：构造一个最小合规的 applet 文件集
function baseFiles(overrides: Record<string, string | null> = {}): Map<string, string> {
  const manifest = {
    id: 'demo',
    name: '演示',
    icon: '🎯',
    entry: 'index.html',
    version: '1.0.0',
    tables: [{ name: 'items', columns: [{ name: 'title', type: 'text', required: true }] }],
  };
  const files: Record<string, string> = {
    'applet.json': JSON.stringify(manifest),
    'index.html': '<!doctype html><html><body><script src="/app-runtime.js"></script><script src="./main.js"></script></body></html>',
    'main.js': 'const el = document.createElement("div");',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return new Map(Object.entries(files));
}

function rulesOf(issues: ReturnType<typeof checkApplet>): string[] {
  return issues.map((i) => i.rule);
}

describe('manifest rules', () => {
  it('flags missing applet.json with manifest.missing', () => {
    const issues = checkApplet('demo', baseFiles({ 'applet.json': null }));
    expect(rulesOf(issues)).toContain('manifest.missing');
    expect(issues.find((i) => i.rule === 'manifest.missing')!.level).toBe('error');
  });

  it('flags incomplete manifest with manifest.invalid', () => {
    const issues = checkApplet('demo', baseFiles({ 'applet.json': JSON.stringify({ id: 'demo' }) }));
    expect(rulesOf(issues)).toContain('manifest.invalid');
  });

  it('flags id mismatch with manifest.invalid', () => {
    const m = JSON.parse(baseFiles().get('applet.json')!);
    m.id = 'other';
    const issues = checkApplet('demo', baseFiles({ 'applet.json': JSON.stringify(m) }));
    expect(rulesOf(issues)).toContain('manifest.invalid');
  });
});

describe('table declaration rules', () => {
  it('flags bad column name with manifest.table', () => {
    const m = JSON.parse(baseFiles().get('applet.json')!);
    m.tables[0].columns[0].name = 'Bad-Col';
    const issues = checkApplet('demo', baseFiles({ 'applet.json': JSON.stringify(m) }));
    expect(rulesOf(issues)).toContain('manifest.table');
  });

  it('flags created_at/id columns with manifest.table (reserved, platform-provided)', () => {
    for (const reserved of ['created_at', 'id', 'user_id']) {
      const m = JSON.parse(baseFiles().get('applet.json')!);
      m.tables[0].columns[0].name = reserved;
      const issues = checkApplet('demo', baseFiles({ 'applet.json': JSON.stringify(m) }));
      const hit = issues.find((i) => i.rule === 'manifest.table' && i.level === 'error');
      expect(hit).toBeDefined();
      expect(hit!.message).toContain(reserved);
    }
  });

  it('flags user_id column with manifest.table', () => {
    const m = JSON.parse(baseFiles().get('applet.json')!);
    m.tables[0].columns[0].name = 'user_id';
    const issues = checkApplet('demo', baseFiles({ 'applet.json': JSON.stringify(m) }));
    expect(rulesOf(issues)).toContain('manifest.table');
  });

  it('flags unknown column type with manifest.table', () => {
    const m = JSON.parse(baseFiles().get('applet.json')!);
    m.tables[0].columns[0].type = 'varchar(20)';
    const issues = checkApplet('demo', baseFiles({ 'applet.json': JSON.stringify(m) }));
    expect(rulesOf(issues)).toContain('manifest.table');
  });
});

describe('entry & runtime rules', () => {
  it('flags missing entry file with entry.missing', () => {
    const issues = checkApplet('demo', baseFiles({ 'index.html': null }));
    expect(rulesOf(issues)).toContain('entry.missing');
  });

  it('flags missing runtime script with runtime.script', () => {
    const issues = checkApplet('demo', baseFiles({
      'index.html': '<!doctype html><html><body><script src="./main.js"></script></body></html>',
    }));
    expect(rulesOf(issues)).toContain('runtime.script');
  });
});

describe('security rules', () => {
  it('flags eval( with security.dynamic', () => {
    const issues = checkApplet('demo', baseFiles({ 'main.js': 'eval("1+1")' }));
    expect(rulesOf(issues)).toContain('security.dynamic');
  });

  it('flags new Function( with security.dynamic', () => {
    const issues = checkApplet('demo', baseFiles({ 'main.js': 'const f = new Function("return 1");' }));
    expect(rulesOf(issues)).toContain('security.dynamic');
  });

  it('flags document.cookie with security.cookie', () => {
    const issues = checkApplet('demo', baseFiles({ 'main.js': 'const c = document.cookie;' }));
    expect(rulesOf(issues)).toContain('security.cookie');
  });

  it('flags window.top with security.top', () => {
    const issues = checkApplet('demo', baseFiles({ 'main.js': 'window.top.location="x";' }));
    expect(rulesOf(issues)).toContain('security.top');
  });

  it('flags external script src with security.external', () => {
    const issues = checkApplet('demo', baseFiles({
      'index.html': '<!doctype html><html><body><script src="/app-runtime.js"></script><script src="https://cdn.example.com/lib.js"></script></body></html>',
    }));
    expect(rulesOf(issues)).toContain('security.external');
  });

  it('allows external script when domain declared in external_apis', () => {
    const m = JSON.parse(baseFiles().get('applet.json')!);
    m.external_apis = ['cdn.example.com'];
    const issues = checkApplet('demo', baseFiles({
      'applet.json': JSON.stringify(m),
      'index.html': '<!doctype html><html><body><script src="/app-runtime.js"></script><script src="https://cdn.example.com/lib.js"></script></body></html>',
    }));
    expect(rulesOf(issues)).not.toContain('security.external');
  });

  it('flags fetch to undeclared domain with security.external_api', () => {
    const issues = checkApplet('demo', baseFiles({
      'main.js': 'fetch("https://api.other.com/data").then(r => r.json());',
    }));
    expect(rulesOf(issues)).toContain('security.external_api');
  });

  it('allows fetch to declared external_apis domain', () => {
    const m = JSON.parse(baseFiles().get('applet.json')!);
    m.external_apis = ['api.other.com'];
    const issues = checkApplet('demo', baseFiles({
      'applet.json': JSON.stringify(m),
      'main.js': 'fetch("https://api.other.com/data").then(r => r.json());',
    }));
    expect(rulesOf(issues)).not.toContain('security.external_api');
  });

  it('flags hardcoded secret with security.secret', () => {
    const issues = checkApplet('demo', baseFiles({
      'main.js': 'const api_key = "AbCdEf123456AbCdEf123456";',
    }));
    expect(rulesOf(issues)).toContain('security.secret');
  });
});

describe('size rule', () => {
  it('warns size.loc over 10000 total lines', () => {
    const big = Array.from({ length: 10050 }, (_, i) => `// line ${i}`).join('\n');
    const issues = checkApplet('demo', baseFiles({ 'main.js': big }));
    const warn = issues.find((i) => i.rule === 'size.loc');
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warn');
  });

  it('returns empty for a compliant applet', () => {
    expect(checkApplet('demo', baseFiles())).toEqual([]);
  });
});
