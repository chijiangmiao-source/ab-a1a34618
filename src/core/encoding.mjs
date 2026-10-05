// 跨环境工具：规范 UTF-8 字节编码与十六进制表示。
// 浏览器与 Node 均以同样的字节序列参与 SHA-256 计算。

export function utf8Bytes(text) {
  if (typeof text !== 'string') {
    throw new TypeError('payload text must be a string');
  }
  return new TextEncoder().encode(text);
}

export function toHex(buffer) {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(`invalid hex digest: ${String(hex).slice(0, 32)}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// 稳定的内容序列化字节：序号与文本载荷以长度前缀拼接，
// 避免分隔符歧义（如文本中出现 '|'）。
export function eventBytes(seq, text) {
  const head = new TextEncoder().encode(`${seq}\n`);
  const body = utf8Bytes(text);
  const lenPrefix = new TextEncoder().encode(`${body.length}\n`);
  const out = new Uint8Array(head.length + lenPrefix.length + body.length);
  out.set(head, 0);
  out.set(lenPrefix, head.length);
  out.set(body, head.length + lenPrefix.length);
  return out;
}

export async function sha256Bytes(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }
  // Node 20 始终有 WebCrypto；此回退仅供极端环境。
  const { createHash } = await import('node:crypto');
  return new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest());
}

export async function sha256Hex(bytes) {
  return toHex(await sha256Bytes(bytes));
}

// 拼接若干字节块后整体哈希，用于段内容定址。
export async function sha256Concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    merged.set(p, offset);
    offset += p.length;
  }
  return sha256Bytes(merged);
}
