// apiKey 可逆混淆：ob1: 前缀 + XOR 固定盐 + base64。
// 不是加密（纯前端无真密钥可守），只是避免明文躺库/躺屏；界面永不回显明文。
const SALT = 'wb-ob-v1';

function xorBuf(bytes, salt) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ salt.charCodeAt(i % salt.length);
  return out;
}

export function obfuscate(plain) {
  const bytes = new TextEncoder().encode(plain);
  const xored = xorBuf(bytes, SALT);
  let bin = '';
  for (const b of xored) bin += String.fromCharCode(b);
  return 'ob1:' + btoa(bin);
}

export function deobfuscate(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('ob1:')) return stored;
  const bin = atob(stored.slice(4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(xorBuf(bytes, SALT));
}
