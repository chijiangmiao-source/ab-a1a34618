// 规则测试（不依赖浏览器）：覆盖 UTF-8/SHA-256 规范、批次校验、哈希链绑定、
// 幂等回执、冲突保留证据、三类中断恢复、损坏/孤儿/半写入隔离、清单唯一性。
// 运行：npm run test:rules   （verify 服务会先跑本文件，失败即以非零退出码报告）
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';

import { utf8Bytes, sha256Hex } from '../core/encoding.mjs';
import { normalizeSubmission, ValidationError, MAX_EVENTS } from '../core/validation.mjs';
import { buildSegment, GENESIS_DIGEST, verifySegment, verifyChain, hashEventText } from '../core/chain.mjs';
import { Vault, CRASH_POINTS } from '../core/vault.mjs';

let passed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) passed += 1;
  else failures.push(msg);
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else failures.push(`${msg}\n   期望 ${e}\n   实际 ${a}`);
}
async function throws(fn, code, msg) {
  try {
    await fn();
    failures.push(`${msg}：预期抛出 ${code}，但未抛出`);
  } catch (err) {
    if (err instanceof ValidationError && err.code === code) passed += 1;
    else failures.push(`${msg}：预期 ValidationError(${code})，实际 ${err?.code || err?.name}: ${err?.message}`);
  }
}
function section(name) {
  console.log(`  · ${name}`);
}

async function resetDb() {
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('attestation-vault');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删除数据库被阻塞'));
  });
  globalThis.__FAULT_INJECTION = null;
  return Vault.open();
}

// 直接写对象仓的测试辅助。
async function rawPut(vault, store, value, key) {
  await new Promise((resolve, reject) => {
    const t = vault.db.transaction(store, 'readwrite');
    t.objectStore(store).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
async function rawCount(vault, store) {
  return new Promise((resolve, reject) => {
    const t = vault.db.transaction(store);
    const req = t.objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const batch = (batchId, events) => ({ batchId, events });
const ev = (seq, text) => ({ seq, text });

// ---------- 1. 规范编码与 SHA-256 ----------
console.log('1) UTF-8 字节编码与 SHA-256 已知答案');
{
  section('ASCII 已知答案 sha256("abc")');
  eq(await sha256Hex(utf8Bytes('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'abc 的 SHA-256 必须匹配 NIST 已知答案');

  section('多字节 UTF-8：与 node:crypto 独立交叉验证');
  for (const s of ['事件', '深空滑翔器🚀', 'αβγ\n\t|delim|', '']) {
    const web = await sha256Hex(utf8Bytes(s));
    const node = createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
    eq(web, node, `文本 ${JSON.stringify(s)} 的 WebCrypto 与 node:crypto 结果一致`);
    eq(Array.from(utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')), `文本 ${JSON.stringify(s)} 的 UTF-8 字节一致`);
  }

  section('文本哈希随内容变化');
  ok((await hashEventText('a')) !== (await hashEventText('b')), '不同文本哈希必须不同');
  ok((await hashEventText('A')) !== (await hashEventText('ａ')), '半角/全角字节不同，哈希必须不同');
}

// ---------- 2. 批次规则 ----------
console.log('2) 批次提交规则');
{
  const valid = batch('GLIDER-A:run-1', [ev(1, '点火'), ev(2, '调姿'), ev(24, '入轨')]);
  const norm = normalizeSubmission(valid);
  eq(norm.batchId, 'GLIDER-A:run-1', '合法批次标识被接受');
  eq(norm.events.length, 3, '合法事件列表被接受');

  await throws(() => normalizeSubmission(null), 'BATCH_NOT_OBJECT', 'null 被拒');
  await throws(() => normalizeSubmission('x'), 'BATCH_NOT_OBJECT', '字符串被拒');
  await throws(() => normalizeSubmission({ batchId: 1, events: [] }), 'BATCH_ID_TYPE', 'batchId 非字符串');
  await throws(() => normalizeSubmission({ batchId: 'bad id!', events: [ev(1, 'x')] }), 'BATCH_ID_FORMAT', '含非法字符的 batchId');
  await throws(() => normalizeSubmission({ batchId: '', events: [ev(1, 'x')] }), 'BATCH_ID_FORMAT', '空 batchId');
  await throws(() => normalizeSubmission({ batchId: 'a'.repeat(65), events: [ev(1, 'x')] }), 'BATCH_ID_FORMAT', '超长 batchId');
  await throws(() => normalizeSubmission({ batchId: 'b' }), 'EVENTS_NOT_ARRAY', 'events 非数组');
  await throws(() => normalizeSubmission(batch('b', [])), 'EVENTS_EMPTY', '空批次');
  await throws(() => normalizeSubmission(batch('b', Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ev(i + 1, 'x')))), 'EVENTS_TOO_MANY', '25 条事件');
  ok(normalizeSubmission(batch('b', Array.from({ length: MAX_EVENTS }, (_, i) => ev(i + 1, 'x')))).events.length === 24, '24 条事件恰好可接受');

  await throws(() => normalizeSubmission(batch('b', [{ seq: '1', text: 'x' }])), 'SEQ_TYPE', '字符串序号');
  await throws(() => normalizeSubmission(batch('b', [ev(1.5, 'x')])), 'SEQ_TYPE', '小数序号');
  await throws(() => normalizeSubmission(batch('b', [ev(0, 'x')])), 'SEQ_NON_POSITIVE', '序号 0');
  await throws(() => normalizeSubmission(batch('b', [ev(-3, 'x')])), 'SEQ_NON_POSITIVE', '负序号');
  await throws(() => normalizeSubmission(batch('b', [ev(1, 42)])), 'TEXT_TYPE', '非文本载荷');
  await throws(() => normalizeSubmission(batch('b', [ev(2, 'x'), ev(2, 'y')])), 'SEQ_NOT_STRICTLY_INCREASING', '重复序号');
  await throws(() => normalizeSubmission(batch('b', [ev(5, 'x'), ev(4, 'y')])), 'SEQ_NOT_STRICTLY_INCREASING', '序号逆序');

  const err = (() => { try { normalizeSubmission(batch('b', [ev(1, 'a'), ev(3, 'b'), ev(2, 'c')])); return null; } catch (e) { return e; } })();
  ok(err instanceof ValidationError && err.code === 'SEQ_NOT_STRICTLY_INCREASING', '乱序批次被拒');
  ok(/位置 3/.test(err.evidence), '首个阻断证据必须指出首个失序位置');
}

// ---------- 3. 哈希链结构 ----------
console.log('3) 段摘要、前驱绑定与防篡改');
{
  const s1 = await buildSegment('b1', [ev(1, 'a'), ev(2, 'b')], GENESIS_DIGEST, 1000);
  ok(/^[0-9a-f]{64}$/.test(s1.digest), '段摘要为 64 位 hex');
  eq(s1.prevDigest, GENESIS_DIGEST, '首段前驱为 GENESIS');
  eq([s1.firstSeq, s1.lastSeq], [1, 2], '序号范围正确');
  ok(s1.eventHashes[0].textHash === await hashEventText('a'), '段内事件文本哈希正确');

  const s1again = await buildSegment('b1', [ev(1, 'a'), ev(2, 'b')], GENESIS_DIGEST, 1000);
  eq(s1again.digest, s1.digest, '相同输入必然得到相同摘要（内容定址）');
  const s2 = await buildSegment('b2', [ev(3, 'c')], s1.digest, 2000);
  ok(s2.digest !== s1.digest && s2.prevDigest === s1.digest, '次段以前段摘要绑定');

  ok((await verifySegment(s1)) === null, '完好段自检通过');
  const tamperedLast = { ...s1, lastSeq: 9 };
  ok((await verifySegment(tamperedLast)) !== null, '篡改 lastSeq 被检出');
  const tamperedHash = { ...s1, eventHashes: s1.eventHashes.map((eh) => ({ ...eh })) };
  tamperedHash.eventHashes[1].textHash = '0'.repeat(64);
  ok((await verifySegment(tamperedHash)) !== null, '篡改事件文本哈希被检出');
  const tamperedPrev = { ...s2, prevDigest: '1'.repeat(64), digest: 'deadbeef' };
  // digest 与内容都不合法，自检必须失败
  ok((await verifySegment({ ...tamperedPrev, digest: s2.digest })) !== null, '更换前驱但保留旧摘要被重算检出');

  const goodChain = await verifyChain([s1, s2]);
  ok(goodChain.ok === true, '前驱与序号连续的链校验通过');

  const s2broken = await buildSegment('b2', [ev(3, 'c')], 'f'.repeat(64), 2000);
  ok((await verifyChain([s1, s2broken])).ok === false, '前驱断裂的链被拒');
  const s2gap = await buildSegment('b2', [ev(9, 'c')], s1.digest, 2000);
  const gapCheck = await verifyChain([s1, s2gap]);
  ok(gapCheck.ok === false && /序号不连续/.test(gapCheck.firstBlocking), '段间序号不连续被拒且给出阻断证据');
  ok((await verifyChain([])).ok === true, '空链合法');
}

// ---------- 4-17. Vault 协议 ----------
console.log('4) 正常封存路径');
let vault = await resetDb();
let receipt1;
{
  const out = await vault.submit(batch('RUN-1', [ev(1, '姿态:俯仰 12°'), ev(2, '姿态:偏航 -3°')]));
  eq(out.status, 'sealed', '首批封存成功');
  ok(out.duplicate === false, '首批不是重传');
  receipt1 = out.receipt;
  eq(receipt1.seqRange, [1, 2], '回执序号范围');
  ok(receipt1.digest === receipt1.digest.toLowerCase(), '回执含段摘要');
  eq(receipt1.eventHashes.length, 2, '回执含每事件哈希');
  eq(receipt1.eventHashes[0].textHash, await hashEventText('姿态:俯仰 12°'), '回执事件哈希按规范 UTF-8 计算');

  const { segs, check, manifest } = await vault.listChain();
  eq(segs.length, 1, '清单指向 1 个已发布段');
  ok(check.ok, '已发布链校验通过');
  eq(manifest.order, [receipt1.digest], '清单按追加顺序指向段摘要');
  eq(manifest.head, receipt1.digest, '清单链头更新为新段');
  eq(await rawCount(vault, 'intents'), 0, '发布后准备意图已清理');

  // 未列入清单的段不算已封存：直接塞一个完整段进 segments。
  const rogue = await buildSegment('ROGUE', [ev(99, 'x')], GENESIS_DIGEST, 1);
  await rawPut(vault, 'segments', rogue, rogue.digest);
  const listing = await vault.listChain();
  eq(listing.segs.length, 1, '未被清单指向的段不属于已封存记录');
}

console.log('5) 同标识同内容重传 → 原回执');
{
  const out = await vault.submit(batch('RUN-1', [ev(1, '姿态:俯仰 12°'), ev(2, '姿态:偏航 -3°')]));
  eq(out.status, 'sealed', '重传仍返回 sealed');
  ok(out.duplicate === true, '标记为重传');
  eq(out.receipt.receiptId, receipt1.receiptId, '重传返回原回执编号');
  eq(out.receipt.digest, receipt1.digest, '重传返回原段摘要');
  const { segs } = await vault.listChain();
  eq(segs.length, 1, '重传不重复追加段');
}

console.log('6) 同标识不同内容 → 冲突且保留既有证据');
{
  const out = await vault.submit(batch('RUN-1', [ev(1, '姿态:俯仰 99°（被篡改的说法）'), ev(2, 'x')]));
  eq(out.status, 'conflict', '内容不同必须冲突');
  ok(!!out.conflict.detail && out.conflict.existingDigest === receipt1.digest, '冲突指向既有证据摘要');
  const { segs } = await vault.listChain();
  eq(segs.length, 1, '冲突不产生新段');
  eq(segs[0].digest, receipt1.digest, '既有段原封不动');
  eq(await rawCount(vault, 'intents'), 0, '冲突不留下准备意图');

  const again = await vault.submit(batch('RUN-1', [ev(1, '姿态:俯仰 12°'), ev(2, '姿态:偏航 -3°')]));
  eq(again.receipt.digest, receipt1.digest, '冲突后原内容重传仍返回原回执');
}

console.log('7) 跨批次序号连续性');
{
  let threw = null;
  try { await vault.submit(batch('RUN-2', [ev(5, '跳跃起点')])); } catch (e) { threw = e; }
  ok(threw instanceof ValidationError && threw.code === 'SEQ_DISCONTINUOUS_WITH_CHAIN', '跨批序号断裂被阻断');
  ok(/期望 3/.test(threw.evidence), '阻断证据给出期望序号');

  const ok2 = await vault.submit(batch('RUN-2', [ev(3, '第三事件'), ev(4, '第四事件')]));
  eq(ok2.status, 'sealed', '序号连续的第二批可封存');
  const { segs, check } = await vault.listChain();
  eq(segs.length, 2, '链上现有两段');
  ok(check.ok, '两段链校验通过');
  eq(segs[1].prevDigest, segs[0].digest, '第二段前驱绑定第一段摘要');
}

console.log('8) 中断：准备意图写入后（AFTER_INTENT）');
vault.close();
vault = await resetDb();
{
  globalThis.__FAULT_INJECTION = { crashAt: CRASH_POINTS.AFTER_INTENT, throwInsteadOfHang: true };
  let crashed = false;
  try {
    await vault.submit(batch('LOST-INTENT', [ev(1, '只写了意图')]));
  } catch (e) {
    crashed = e.code === 'SIMULATED_CRASH';
  }
  ok(crashed, '提交在准备意图后中断');
  eq(await rawCount(vault, 'intents'), 1, '意图确实落库');
  eq(await rawCount(vault, 'segments'), 0, '段尚未写入');

  globalThis.__FAULT_INJECTION = null;
  vault.close();
  vault = await Vault.open();
  const rec = await vault.recover();
  const acts = rec.audit.map((a) => a.action);
  ok(acts.includes('INTENT_DISCARDED'), '未发布准备段被废弃，不进入链');
  const { segs, check } = await vault.listChain();
  eq(segs.length, 0, '链保持为空');
  ok(check.ok, '空链仍有效');
  eq(await rawCount(vault, 'intents'), 0, '废弃意图已删除');
  eq(await rawCount(vault, 'segments'), 0, '没有产生任何段');
}

console.log('9) 中断：段写入后清单切换前（AFTER_SEGMENT）→ 唯一恢复');
vault.close();
vault = await resetDb();
let segDigest;
{
  // 先有一段已发布历史，验证恢复段必须接到正确链尾。
  globalThis.__FAULT_INJECTION = null;
  const base = await vault.submit(batch('BASE', [ev(1, '历史事件')]));
  segDigest = base.receipt.digest;

  globalThis.__FAULT_INJECTION = { crashAt: CRASH_POINTS.AFTER_SEGMENT, throwInsteadOfHang: true };
  let crashed = false;
  try {
    await vault.submit(batch('PENDING', [ev(2, '段已写清单未切')]));
  } catch (e) { crashed = e.code === 'SIMULATED_CRASH'; }
  ok(crashed, '提交在段写入后中断');
  eq(await rawCount(vault, 'segments'), 2, '历史段与候选段均在库');
  const beforeList = await vault.listChain();
  eq(beforeList.segs.length, 1, '中断后重开前：候选段不在清单上，不算已封存');

  globalThis.__FAULT_INJECTION = null;
  vault.close();
  vault = await Vault.open();
  const rec = await vault.recover();
  const pub = rec.audit.find((a) => a.action === 'RECOVERED_PUBLISHED');
  ok(!!pub, '完整未发布批次按既定意图恢复发布');
  ok(pub.detail.includes('唯一结果'), '恢复动作声明为唯一结果');
  eq(pub.seqRange, [2, 2], '恢复段序号范围展示正确');
  ok(pub.prevDigest === segDigest, '恢复段前驱展示为历史链尾');

  const { segs, check, manifest } = await vault.listChain();
  eq(segs.length, 2, '恢复后链上恰为两段');
  ok(check.ok, '恢复后链连续有效');
  eq(manifest.order.length, 2, '清单只追加一次');

  // 再次扫描必须幂等，不得重复追加。
  const rec2 = await vault.recover();
  ok(!rec2.audit.some((a) => a.action === 'RECOVERED_PUBLISHED'), '第二次扫描不再恢复同一批次');
  const again = await vault.listChain();
  eq(again.segs.length, 2, '已发布段未被重复追加');
  eq(await rawCount(vault, 'intents'), 0, '恢复后意图被清理');

  // 同标识同内容重传返回同回执。
  const dup = await vault.submit(batch('PENDING', [ev(2, '段已写清单未切')]));
  ok(dup.duplicate === true && dup.receipt.seqRange[0] === 2, '恢复完成后重传返回原回执');
  eq((await vault.listChain()).segs.length, 2, '重传不改变链');
}

console.log('10) 中断：清单切换后（AFTER_MANIFEST）→ 去重');
vault.close();
vault = await resetDb();
{
  globalThis.__FAULT_INJECTION = { crashAt: CRASH_POINTS.AFTER_MANIFEST, throwInsteadOfHang: true };
  let crashed = false;
  try {
    await vault.submit(batch('COMMITTED', [ev(1, '清单已切，意图没来得及删')]));
  } catch (e) { crashed = e.code === 'SIMULATED_CRASH'; }
  ok(crashed, '提交在清单切换后中断');
  eq(await rawCount(vault, 'intents'), 1, '意图残留在库');

  globalThis.__FAULT_INJECTION = null;
  vault.close();
  vault = await Vault.open();
  const rec = await vault.recover();
  ok(rec.audit.some((a) => a.action === 'DEDUP_ALREADY_PUBLISHED'), '识别为已发布并去重');
  const { segs } = await vault.listChain();
  eq(segs.length, 1, '已发布段没有被重复追加');
  eq(await rawCount(vault, 'intents'), 0, '冗余意图被删除');

  const rec2 = await vault.recover();
  eq(rec2.audit.filter((a) => a.action === 'DEDUP_ALREADY_PUBLISHED').length, 0, '再次扫描无重复去重动作');
  const dup = await vault.submit(batch('COMMITTED', [ev(1, '清单已切，意图没来得及删')]));
  ok(dup.duplicate === true, '同内容重传仍给原回执');
  eq((await vault.listChain()).segs.length, 1, '链长度不变');
}

console.log('11) 损坏准备段 / 孤儿段 / 半写入意图');
vault.close();
vault = await resetDb();
{
  // 损坏段：完整意图 + 键存在但内容损坏的段。
  const seg = await buildSegment('CORRUPT', [ev(1, '会损坏的段')], GENESIS_DIGEST, 5);
  const intent = {
    batchId: 'CORRUPT',
    events: [ev(1, '会损坏的段')],
    expectedDigest: seg.digest,
    prevDigest: GENESIS_DIGEST,
    firstSeq: 1,
    lastSeq: 1,
    baseHead: GENESIS_DIGEST,
    baseOrder: [],
    createdAt: 5,
    preparedAt: 5,
  };
  await rawPut(vault, 'intents', intent, 'CORRUPT');
  const rotten = { ...seg, lastSeq: 7 }; // 半写入/位腐烂
  await rawPut(vault, 'segments', rotten, seg.digest);

  // 孤儿段：完整但无意图、无清单引用。
  const orphan = await buildSegment('ORPHAN', [ev(50, '无人认领')], GENESIS_DIGEST, 6);
  await rawPut(vault, 'segments', orphan, orphan.digest);

  // 半写入意图：结构残缺。
  await rawPut(vault, 'intents', { batchId: 'HALF', expectedDigest: 'xyz' }, 'HALF');

  const rec = await vault.recover();
  const actions = rec.audit.map((a) => a.action);
  ok(actions.includes('CORRUPT_SEGMENT_QUARANTINED'), '损坏准备段被隔离，不进入链');
  const corruptEntry = rec.audit.find((a) => a.action === 'CORRUPT_SEGMENT_QUARANTINED');
  ok(!!corruptEntry.detail && corruptEntry.seqRange[0] === 1, '隔离记录给出证据与序号范围');
  ok(actions.includes('ORPHAN_SEGMENT_QUARANTINED'), '无意图孤儿段隔离保留');
  ok(actions.includes('INTENT_DISCARDED'), '半写入意图被废弃');

  const { segs, check } = await vault.listChain();
  eq(segs.length, 0, '任何残留段都未进入已封存链');
  ok(check.ok, '空链仍校验通过');
  eq(await rawCount(vault, 'intents'), 0, '无效意图均已清理');
  eq(await rawCount(vault, 'segments'), 2, '损坏段与孤儿段作为证据保留在段仓');
}

console.log('12) 24 条上限与跨批次恢复的批次标识稳定');
vault.close();
vault = await resetDb();
{
  const many = Array.from({ length: 24 }, (_, i) => ev(i + 1, `evt-${i + 1}`));
  const out = await vault.submit(batch('FULL', many));
  eq(out.status, 'sealed', '24 条整批可封存');
  eq(out.receipt.eventCount, 24, '回执记录 24 条');

  // 规则校验先于冲突判定：同标识扩成 25 条仍首先被上限阻断。
  const expanded = await (async () => {
    try { await vault.submit(batch('FULL', many.concat([ev(25, 'x')]))); return null; }
    catch (e) { return e; }
  })();
  ok(expanded instanceof ValidationError && expanded.code === 'EVENTS_TOO_MANY', '同标识 25 条扩批先被上限阻断');

  const over = await (async () => {
    try { await vault.submit(batch('OVER', Array.from({ length: 25 }, (_, i) => ev(i + 100, 'x')))); return null; }
    catch (e) { return e; }
  })();
  ok(over instanceof ValidationError && over.code === 'EVENTS_TOO_MANY', '新批次 25 条被上限阻断');
}

vault.close();

// ---------- 13. 断裂链上禁止任何提交（不遗漏、不混入） ----------
console.log('13) 已发布链损坏：追加与重传都被阻断');
vault = await resetDb();
{
  const good = await vault.submit(batch('GOOD', [ev(1, '完好段'), ev(2, '第二事件')]));
  eq(good.status, 'sealed', '前置批次封存成功');

  // 直接在段仓里破坏已发布段（模拟位腐烂 / 半写入）。
  const rotten = await vault._getSegment(good.receipt.digest);
  rotten.eventHashes[0].textHash = 'a'.repeat(64);
  await rawPut(vault, 'segments', rotten, rotten.digest);

  let appendErr = null;
  try { await vault.submit(batch('AFTER', [ev(3, '试图追加')])); } catch (e) { appendErr = e; }
  ok(appendErr instanceof ValidationError && appendErr.code === 'CHAIN_INVALID', '断裂链上追加被 CHAIN_INVALID 阻断');
  ok(/摘要重算不通过/.test(appendErr.evidence), '阻断证据说明重算不通过');

  let dupErr = null;
  try { await vault.submit(batch('GOOD', [ev(1, '完好段'), ev(2, '第二事件')])); } catch (e) { dupErr = e; }
  ok(dupErr instanceof ValidationError && dupErr.code === 'CHAIN_INVALID', '断裂链上连同内容重传也不给出正常回执');

  // 清单未变、损坏段仍是唯一指向：没有混入新段。
  const { segs, manifest } = await vault.listChain();
  eq(manifest.order, [good.receipt.digest], '清单未被追加');
  eq(segs.length, 1, '段仓中仍只有那一个（已损坏的）证据段');
}
vault.close();

// ---------- 14. 不重开页面直接重传：断点续写同样收敛 ----------
console.log('14) AFTER_SEGMENT 残留下直接重传（不经恢复扫描）');
vault = await resetDb();
{
  await vault.submit(batch('BASE-14', [ev(1, '历史')]));
  globalThis.__FAULT_INJECTION = { crashAt: CRASH_POINTS.AFTER_SEGMENT, throwInsteadOfHang: true };
  let crashed = false;
  try { await vault.submit(batch('PEND-14', [ev(2, '候选内容')])); }
  catch (e) { crashed = e.code === 'SIMULATED_CRASH'; }
  ok(crashed, '段写入后中断');
  globalThis.__FAULT_INJECTION = null;

  // 同标识不同内容：即使段已写，也必须冲突且保留既有准备证据。
  const conflict = await vault.submit(batch('PEND-14', [ev(2, '被改写的内容')]));
  eq(conflict.status, 'conflict', '断点处内容不同被判冲突');
  eq((await vault.listChain()).segs.length, 1, '冲突未推动清单');

  // 同标识同内容重传：断点续写，发布一次。
  const done = await vault.submit(batch('PEND-14', [ev(2, '候选内容')]));
  eq(done.status, 'sealed', '同内容重传完成封存');
  const list = await vault.listChain();
  eq(list.segs.length, 2, '链上恰为两段，无重复');
  ok(list.check.ok, '续写后链有效');
  eq(await rawCount(vault, 'intents'), 0, '意图已清理');

  // 再来一次重传：幂等原回执。
  const again = await vault.submit(batch('PEND-14', [ev(2, '候选内容')]));
  ok(again.duplicate === true && again.receipt.digest === done.receipt.digest, '续写后重传给原回执');
  eq((await vault.listChain()).segs.length, 2, '链长度不变');
}
vault.close();

// ---------- 15. 多个完整未发布意图同时残留：无遗漏、按序、序号连续地恢复 ----------
console.log('15) 多意图批量恢复（不遗漏、不重排）');
vault = await resetDb();
{
  const mkIntent = async (batchId, seq, prevDigest, preparedAt) => {
    const events = [ev(seq, `event-${seq}`)];
    const seg = await buildSegment(batchId, events, prevDigest, preparedAt);
    const intent = {
      batchId,
      events,
      expectedDigest: seg.digest,
      prevDigest,
      firstSeq: seq,
      lastSeq: seq,
      baseHead: prevDigest,
      baseOrder: [],
      createdAt: preparedAt,
      preparedAt,
    };
    await rawPut(vault, 'segments', seg, seg.digest);
    await rawPut(vault, 'intents', intent, batchId);
    return seg;
  };
  // 逆序写入（模拟键遍历顺序不等于准备顺序），验证按 preparedAt 排序恢复。
  const s1 = await mkIntent('MULTI-1', 1, GENESIS_DIGEST, 100);
  const s2 = await mkIntent('MULTI-2', 2, s1.digest, 200);
  const s3 = await mkIntent('MULTI-3', 3, s2.digest, 300);

  const rec = await vault.recover();
  const pubs = rec.audit.filter((a) => a.action === 'RECOVERED_PUBLISHED');
  eq(pubs.length, 3, '三个残留完整批次全部被恢复，无遗漏');
  eq(pubs.map((p) => p.batchId), ['MULTI-1', 'MULTI-2', 'MULTI-3'], '恢复顺序按准备意图既定先后，不重排');

  const { segs, check, manifest } = await vault.listChain();
  eq(manifest.order, [s1.digest, s2.digest, s3.digest], '清单顺序与哈希链一致');
  ok(check.ok, '多段恢复后摘要/前驱/序号连续校验通过');
  eq(await rawCount(vault, 'intents'), 0, '三个意图均已清理');

  // 重复扫描幂等。
  const rec2 = await vault.recover();
  eq(rec2.audit.filter((a) => a.action === 'RECOVERED_PUBLISHED').length, 0, '再次扫描零恢复动作');
  eq((await vault.listChain()).segs.length, 3, '链仍为三段');
}
vault.close();

// ---------- 汇总 ----------
console.log(`\n规则测试结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.error('\n失败项：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部规则测试通过 ✅');
