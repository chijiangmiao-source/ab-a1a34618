// 封存链核心：段内容定址、前驱绑定、链校验。
// 纯函数，浏览器与规则测试共用，保证「规范编码 + SHA-256」只有一份实现。
//
// 段（segment）结构：
//   {
//     digest:    本段内容 SHA-256（内容定址，hex）
//     prevDigest:前段摘要；首段为 64 个 0
//     batchId:   稳定批次标识
//     firstSeq / lastSeq: 本段覆盖的序号范围
//     eventHashes: [{ seq, textHash }]  每事件文本的 UTF-8 SHA-256
//     payloadHash: 段体序列化字节的 SHA-256（与 digest 同源，便于复核）
//     createdAt: 准备意图生成时的时间戳（毫秒）
//   }
//
// digest 的计算输入（全部按字节拼接）：
//   "SEG1\n"
//   prevDigest(64 hex) + "\n"
//   batchIdUtf8 + "\n"
//   firstSeq + "\n" + lastSeq + "\n"
//   对每个事件：seq + "\n" + textHash(64hex) + "\n"
//   payloadHash(64hex) + "\n"
// 这样前驱摘要直接进入哈希，形成不可变的哈希链。

import { sha256Bytes, sha256Concat, utf8Bytes, toHex } from './encoding.mjs';

export const GENESIS_DIGEST = '0'.repeat(64);
const DOMAIN = new TextEncoder().encode('SEG1\n');

const enc = (s) => utf8Bytes(String(s));
const line = (s) => {
  const b = utf8Bytes(String(s));
  const nl = utf8Bytes('\n');
  return [b, nl];
};

// 单条事件文本的规范哈希。
export async function hashEventText(text) {
  return toHex(await sha256Bytes(utf8Bytes(text)));
}

// 由准备好的批次数据构造一个绑定到 prevDigest 的候选段（尚未持久化）。
export async function buildSegment(batchId, events, prevDigest, createdAt) {
  if (!/^[0-9a-f]{64}$/.test(prevDigest)) {
    throw new Error(`prevDigest 必须是 64 位小写十六进制：${String(prevDigest).slice(0, 32)}`);
  }
  const eventHashes = [];
  for (const ev of events) {
    eventHashes.push({ seq: ev.seq, textHash: await hashEventText(ev.text) });
  }
  const firstSeq = events[0].seq;
  const lastSeq = events[events.length - 1].seq;

  // payload：段内除 digest 外的全部事实，先单独定址，再纳入 digest 绑定。
  const payloadParts = [
    ...line(batchId),
    ...line(firstSeq),
    ...line(lastSeq),
  ];
  for (const eh of eventHashes) {
    payloadParts.push(...line(eh.seq));
    payloadParts.push(...line(eh.textHash));
  }
  payloadParts.push(...line(createdAt));
  const payloadHash = toHex(await sha256Concat(payloadParts));

  const digestParts = [
    DOMAIN,
    ...line(prevDigest),
    ...line(batchId),
    ...line(firstSeq),
    ...line(lastSeq),
  ];
  for (const eh of eventHashes) {
    digestParts.push(...line(eh.seq));
    digestParts.push(...line(eh.textHash));
  }
  digestParts.push(...line(payloadHash));
  const digest = toHex(await sha256Concat(digestParts));

  return {
    digest,
    prevDigest,
    batchId,
    firstSeq,
    lastSeq,
    eventHashes,
    payloadHash,
    createdAt,
  };
}

// 直接按段记录重算 digest（不经过事件原文）。
export async function digestOf(seg) {
  const parts = [
    DOMAIN,
    ...line(seg.prevDigest),
    ...line(seg.batchId),
    ...line(seg.firstSeq),
    ...line(seg.lastSeq),
  ];
  for (const eh of seg.eventHashes) {
    parts.push(...line(eh.seq));
    parts.push(...line(eh.textHash));
  }
  parts.push(...line(seg.payloadHash));
  return toHex(await sha256Concat(parts));
}

// 校验单个段自身的完整性；返回 null 或首个阻断证据。
export async function verifySegment(seg) {
  if (!seg || typeof seg !== 'object') return '段记录不是对象';
  const needString = (v, name) => typeof v === 'string' && v.length > 0;
  if (!/^[0-9a-f]{64}$/.test(seg.digest || '')) return `段 digest 格式非法（batchId=${show(seg.batchId)}）`;
  if (!/^[0-9a-f]{64}$/.test(seg.prevDigest || '')) return `段 ${seg.digest.slice(0, 12)} 前驱摘要格式非法`;
  if (!needString(seg.batchId, 'batchId')) return `段 ${seg.digest.slice(0, 12)} 缺少 batchId`;
  if (!Number.isSafeInteger(seg.firstSeq) || !Number.isSafeInteger(seg.lastSeq)) {
    return `段 ${seg.digest.slice(0, 12)} 序号范围不是整数`;
  }
  if (seg.firstSeq > seg.lastSeq) return `段 ${seg.digest.slice(0, 12)} 序号范围倒置 ${seg.firstSeq}>${seg.lastSeq}`;
  if (!Array.isArray(seg.eventHashes) || seg.eventHashes.length === 0) {
    return `段 ${seg.digest.slice(0, 12)} 缺少事件哈希列表`;
  }
  if (seg.eventHashes[0].seq !== seg.firstSeq || seg.eventHashes[seg.eventHashes.length - 1].seq !== seg.lastSeq) {
    return `段 ${seg.digest.slice(0, 12)} 序号范围与事件列表不一致`;
  }
  let prevSeq = 0;
  for (let i = 0; i < seg.eventHashes.length; i++) {
    const eh = seg.eventHashes[i];
    if (!eh || typeof eh !== 'object') return `段 ${seg.digest.slice(0, 12)} 第 ${i + 1} 条事件哈希损坏`;
    if (!/^[0-9a-f]{64}$/.test(eh.textHash || '')) return `段 ${seg.digest.slice(0, 12)} 第 ${i + 1} 条事件文本哈希非法`;
    if (!Number.isSafeInteger(eh.seq) || eh.seq <= prevSeq) {
      return `段 ${seg.digest.slice(0, 12)} 内部序号不严格递增（位置 ${i + 1}）`;
    }
    prevSeq = eh.seq;
  }
  if (!/^[0-9a-f]{64}$/.test(seg.payloadHash || '')) return `段 ${seg.digest.slice(0, 12)} payloadHash 非法`;
  const recomputed = await digestOf(seg);
  if (recomputed !== seg.digest) {
    return `段 ${seg.digest.slice(0, 12)} 摘要重算不通过（期望 ${recomputed.slice(0, 12)}…，属半写入/篡改）`;
  }
  return null;
}

// 校验已发布链（按清单顺序）。返回 { ok, firstBlocking } 。
// 规则：首段前驱为 GENESIS；每段前驱等于前段 digest；段内序号连续；
//       段间序号也连续（last+1 == next.first）——「序号连续的段才属于已封存记录」。
export async function verifyChain(segments) {
  if (!Array.isArray(segments)) return { ok: false, firstBlocking: '链不是数组' };
  let prevDigest = GENESIS_DIGEST;
  let expectedSeq = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const selfErr = await verifySegment(seg);
    if (selfErr) return { ok: false, firstBlocking: `链位置 ${i + 1}：${selfErr}` };
    if (seg.prevDigest !== prevDigest) {
      return {
        ok: false,
        firstBlocking: `链位置 ${i + 1}（段 ${seg.digest.slice(0, 12)}…，batch ${seg.batchId}）前驱不匹配：期望 ${prevDigest.slice(0, 12)}…，实际 ${seg.prevDigest.slice(0, 12)}…`,
      };
    }
    if (expectedSeq !== null && seg.firstSeq !== expectedSeq) {
      return {
        ok: false,
        firstBlocking: `链位置 ${i + 1}（batch ${seg.batchId}）序号不连续：期望首序号 ${expectedSeq}，实际 ${seg.firstSeq}`,
      };
    }
    expectedSeq = seg.lastSeq + 1;
    prevDigest = seg.digest;
  }
  return { ok: true, firstBlocking: null, tipDigest: prevDigest };
}

function show(v) {
  return typeof v === 'string' ? v.slice(0, 24) : String(v);
}
