// AI 客户端：OpenAI 兼容 /chat/completions，多接入点 fallback，JSON 提取
import { loadEndpoints } from './db.js';

export class AiJsonError extends Error {
  constructor(msg) { super(msg); this.name = 'AiJsonError'; }
}

// 从 LLM 文本中提取 JSON：剥围栏、截取平衡的 {} / [] 段
export function extractJson(text) {
  if (typeof text !== 'string') throw new AiJsonError('输出不是文本');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 找第一个 { 或 [，向后扫描到与之平衡的收尾
  const start = s.search(/[{[]/);
  if (start === -1) throw new AiJsonError('未找到 JSON');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); }
      catch (e) { throw new AiJsonError('JSON 解析失败: ' + e.message); }
    } }
  }
  throw new AiJsonError('JSON 未闭合');
}

// 单次请求一个端点；返回 assistant 文本
async function callOne(entry, messages, { json, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model: entry.model,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };
    const res = await fetchImpl(`${entry.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.api_key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { const err = new Error('响应不是合法 JSON（HTTP 200）'); err.bad_body = true; throw err; }
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

// fallback：命中（网络错误/超时/5xx/401）切下一条；其余 4xx 与坏响应体立即抛
const SWITCHABLE = (e) => !e.bad_body && (e.status === undefined || e.status >= 500 || e.status === 401);

export async function chat(kind, messages, opts = {}) {
  const { timeoutMs = 120000 } = opts;
  // dev 演示模式：全局开关 __DEMO_AI 打开且注入了 __mockFetch 时走 mock
  let fetchImpl = opts.fetchImpl;
  if (!fetchImpl && globalThis.__DEMO_AI && globalThis.__mockFetch) fetchImpl = globalThis.__mockFetch;
  if (!fetchImpl) fetchImpl = globalThis.fetch;
  const endpoints = await loadEndpoints(kind);
  if (!endpoints.length) throw new Error(`请先在设置中配置${kind === 'vision' ? '图像识别' : 'LLM'}接入点`);
  const failures = [];
  for (const ep of endpoints) {
    try {
      return await callOne(ep, messages, { json: opts.json, timeoutMs, fetchImpl });
    } catch (e) {
      if (e.bad_body) throw new AiJsonError(e.message); // 模型侧输出坏：走 chatJson 重试路径，不换端点
      const reason = e.name === 'AbortError' ? '超时' : (e.status ? `HTTP ${e.status}` : (e.message || '网络错误'));
      failures.push(`「${ep.name || ep.base_url}」${reason}`);
      if (!SWITCHABLE(e)) throw e;
    }
  }
  throw new Error(`全部接入点失败：${failures.join('；')}`);
}

// chat + JSON 提取；AiJsonError 重试一次
export async function chatJson(kind, messages, opts = {}) {
  try {
    return extractJson(await chat(kind, messages, { ...opts, json: true }));
  } catch (e) {
    if (!(e instanceof AiJsonError)) throw e;
    const retry = [...messages, { role: 'user', content: '上一次输出不是合法 JSON。请只输出 JSON，不要任何解释文字。' }];
    return extractJson(await chat(kind, retry, { ...opts, json: true }));
  }
}

// 连通性测试：最小请求，如实回报 {ok, detail, latency_ms}
export async function testEndpoint(kind, entry, { fetchImpl = globalThis.fetch } = {}) {
  const t0 = Date.now();
  try {
    const content = await callOne(entry, [{ role: 'user', content: 'ping' }], { timeoutMs: 30000, fetchImpl });
    return { ok: true, detail: `连通正常（${content ? '模型有响应' : '空响应'}）`, latency_ms: Date.now() - t0 };
  } catch (e) {
    const reason = e.name === 'AbortError' ? '超时（30 秒）'
      : e.status === 401 ? '认证失败（401，请检查 API Key）'
      : e.status === 404 ? '接口不存在（404，请检查 baseURL 是否到 /v1）'
      : e.status ? `HTTP ${e.status}` : `网络错误（${e.message}，常见原因：CORS 拦截或地址不可达）`;
    return { ok: false, detail: reason, latency_ms: Date.now() - t0 };
  }
}
