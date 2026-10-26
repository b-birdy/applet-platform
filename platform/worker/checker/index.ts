// 小程序静态检查规则引擎（纯函数，无 IO）
export type CheckIssue = {
  level: 'error' | 'warn';
  rule: string;
  file: string;
  message: string;
};

type ManifestTable = {
  name?: string;
  columns?: { name?: string; type?: string; required?: boolean; default?: unknown }[];
};

type Manifest = {
  id?: string;
  name?: string;
  icon?: string;
  entry?: string;
  version?: string;
  tables?: ManifestTable[];
  external_apis?: string[];
};

const COL_NAME_RE = /^[a-z][a-z0-9_]*$/;
const COL_TYPES = new Set(['text', 'integer', 'real', 'blob']);

const SECURITY_PATTERNS: { rule: string; re: RegExp; msg: string }[] = [
  { rule: 'security.dynamic', re: /\beval\s*\(/, msg: '禁止 eval(' },
  { rule: 'security.dynamic', re: /new\s+Function\s*\(/, msg: '禁止 new Function(' },
  { rule: 'security.cookie', re: /document\.cookie/, msg: '禁止 document.cookie' },
  { rule: 'security.top', re: /window\.top/, msg: '禁止 window.top' },
];

const SECRET_RE = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9+/]{16,}['"]/i;

function isTextFile(path: string): boolean {
  return /\.(html?|js|mjs|css|json|svg|txt|md)$/i.test(path);
}

export function checkAppletWithSizes(
  appletId: string,
  files: Map<string, string>,
  sizes?: Map<string, number>
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const manifestFile = files.get('applet.json');
  let manifest: Manifest | null = null;

  if (!manifestFile) {
    issues.push({ level: 'error', rule: 'manifest.missing', file: 'applet.json', message: '缺少 applet.json 清单' });
  } else {
    try {
      manifest = JSON.parse(manifestFile) as Manifest;
    } catch {
      issues.push({ level: 'error', rule: 'manifest.invalid', file: 'applet.json', message: 'applet.json 不是合法 JSON' });
    }
  }

  let entry: string | undefined;
  if (manifest) {
    if (!manifest.id || !manifest.name || !manifest.entry || !Array.isArray(manifest.tables) || manifest.tables.length === 0) {
      issues.push({ level: 'error', rule: 'manifest.invalid', file: 'applet.json', message: '清单缺少 id/name/entry/tables 字段' });
    } else {
      if (manifest.id !== appletId) {
        issues.push({ level: 'error', rule: 'manifest.invalid', file: 'applet.json', message: `清单 id "${manifest.id}" 与目录名 "${appletId}" 不符` });
      }
      // 数据表声明校验
      for (const t of manifest.tables) {
        if (!t.name || !COL_NAME_RE.test(t.name) || !Array.isArray(t.columns)) {
          issues.push({ level: 'error', rule: 'manifest.table', file: 'applet.json', message: `表名不合法或缺 columns: ${JSON.stringify(t.name)}` });
          continue;
        }
        for (const col of t.columns) {
          if (!col.name || !COL_NAME_RE.test(col.name) || col.name === 'user_id') {
            issues.push({ level: 'error', rule: 'manifest.table', file: 'applet.json', message: `表 ${t.name} 列名不合法或保留: ${JSON.stringify(col.name)}` });
          } else if (!col.type || !COL_TYPES.has(col.type)) {
            issues.push({ level: 'error', rule: 'manifest.table', file: 'applet.json', message: `表 ${t.name}.${col.name} 类型不合法: ${JSON.stringify(col.type)}` });
          }
        }
      }
    }
    entry = manifest.entry;
    // entry 存在性
    if (entry && !files.has(entry)) {
      issues.push({ level: 'error', rule: 'entry.missing', file: entry, message: `入口文件 ${entry} 不存在` });
    }
  }

  const externalApis = manifest?.external_apis ?? [];

  for (const [path, content] of files) {
    if (!isTextFile(path)) continue;

    // HTML: 检查 runtime script 与外部脚本
    if (/\.html?$/i.test(path)) {
      const srcs = [...content.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map((m) => m[1]);
      for (const src of srcs) {
        if (src === '/app-runtime.js' || src === './app-runtime.js') continue;
        const m = src.match(/^https?:\/\/([^/'"]+)/);
        if (m) {
          if (!externalApis.includes(m[1])) {
            issues.push({ level: 'error', rule: 'security.external', file: path, message: `加载外部脚本未声明: ${src}` });
          }
        } else if (!/^(\/|\.\/|https?:\/\/)/.test(src) === false && !externalApis.length) {
          // 相对路径脚本允许
        }
      }
      if (path === entry && !srcs.some((s) => s === '/app-runtime.js' || s === './app-runtime.js')) {
        issues.push({ level: 'error', rule: 'runtime.script', file: path, message: '入口 HTML 必须引入 <script src="/app-runtime.js">' });
      }
    }

    // 通用安全模式（js/html 内联）
    for (const p of SECURITY_PATTERNS) {
      if (p.re.test(content)) {
        issues.push({ level: 'error', rule: p.rule, file: path, message: p.msg });
      }
    }

    // 密钥字面量
    if (SECRET_RE.test(content)) {
      issues.push({ level: 'error', rule: 'security.secret', file: path, message: '疑似硬编码密钥/令牌' });
    }

    // fetch 外部域名
    if (/\.(js|mjs)$/i.test(path) || /\.html?$/i.test(path)) {
      for (const m of content.matchAll(/fetch\s*\(\s*['"`]https?:\/\/([^/'"`]+)/g)) {
        if (!externalApis.includes(m[1])) {
          issues.push({ level: 'error', rule: 'security.external_api', file: path, message: `fetch 未声明域名: ${m[1]}` });
        }
      }
    }
  }

  // 代码规模 warn
  let loc = 0;
  for (const [path, content] of files) {
    if (isTextFile(path)) loc += content.split('\n').length;
  }
  if (loc > 10000) {
    issues.push({ level: 'warn', rule: 'size.loc', file: '*', message: `总行数 ${loc} 超过 10000，请管理员确认` });
  }

  // 资产大小（提供 sizes 时）
  if (sizes) {
    let total = 0;
    for (const [path, size] of sizes) {
      total += size;
      if (size > 5 * 1024 * 1024) {
        issues.push({ level: 'error', rule: 'asset.size', file: path, message: `单文件 ${size}B 超过 5MB 上限` });
      }
    }
    if (total > 20 * 1024 * 1024) {
      issues.push({ level: 'error', rule: 'asset.total_size', file: '*', message: `总资产 ${total}B 超过 20MB 上限` });
    }
  }

  return issues;
}

export function checkApplet(appletId: string, files: Map<string, string>): CheckIssue[] {
  return checkAppletWithSizes(appletId, files);
}
