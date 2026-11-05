// S3 SigV4 签名直传（path-style，MinIO 友好）。密钥混淆见 secure.js；本模块只管签名与传输。
// Node 与浏览器均有 Web Crypto（globalThis.crypto.subtle）。

const enc = new TextEncoder();

function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(secret, data, out = 'hex') {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return fmt(sig, out);
}

export async function sha256Hex(data) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return fmt(d, 'hex');
}

async function fmt(buf, out) {
  if (out === 'raw') return buf; // ArrayBuffer 直通（签名密钥推导链用）
  const bytes = new Uint8Array(buf);
  if (out === 'hex') return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const importK = (raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

// 原始字节进、原始字节出（签名密钥推导链用）
async function hmacRaw(rawKey, data) {
  return crypto.subtle.sign('HMAC', await importK(rawKey), enc.encode(data));
}

export async function hmacSha256(secret, data, out = 'hex') {
  return hmac(secret, data, out);
}

// 纯函数式签名：cfg + 请求要素 → 带签名头的请求头
export async function signRequest(cfg, { method, path, amzDate, dateStamp, payloadSha256 }) {
  const host = new URL(cfg.endpoint).host;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    path,
    '', // query 为空
    `host:${host}\nx-amz-content-sha256:${payloadSha256}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadSha256,
  ].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(`AWS4${cfg.secret_key}`, dateStamp, 'raw');
  const kRegion = await hmacRaw(kDate, cfg.region);
  const kService = await hmacRaw(kRegion, 's3');
  const kSigning = await hmacRaw(kService, 'aws4_request');
  const signature = await fmt(await crypto.subtle.sign('HMAC', await importK(kSigning), enc.encode(stringToSign)), 'hex');

  return {
    headers: {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadSha256,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.access_key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

// 上传一个对象（blob），成功返回可访问 URL
export async function put(cfg, key, blob, { fetchImpl = globalThis.fetch } = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const path = `/${cfg.bucket}/${key}`;
  const payloadSha256 = await fmt(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()), 'hex');
  const { headers } = await signRequest(cfg, { method: 'PUT', path, amzDate, dateStamp, payloadSha256 });

  const url = `${cfg.endpoint.replace(/\/$/, '')}${path}`;
  const res = await fetchImpl(url, { method: 'PUT', headers, body: blob });
  if (!res.ok) {
    throw new Error(`S3 上传失败（HTTP ${res.status}）：请检查桶的 CORS 配置与访问密钥是否正确`);
  }
  return { url };
}

// 连通测试：PUT 探针对象随即 DELETE
export async function test(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const key = `__conn_test_${Date.now()}`;
  try {
    await put(cfg, key, new Blob(['x']), { fetchImpl });
  } catch (e) {
    return { ok: false, detail: e.message };
  }
  // DELETE 失败不影响连通结论（可能无删权限），尝试即弃
  try {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const path = `/${cfg.bucket}/${key}`;
    const empty = await sha256Hex('');
    const { headers } = await signRequest(cfg, { method: 'DELETE', path, amzDate, dateStamp, payloadSha256: empty });
    await fetchImpl(`${cfg.endpoint.replace(/\/$/, '')}${path}`, { method: 'DELETE', headers });
  } catch { /* 忽略清理失败 */ }
  return { ok: true, detail: '连通正常（已写入并清理探针对象）' };
}
