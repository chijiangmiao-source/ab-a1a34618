// IndexedDB 持久化与封存协议。
//
// 三个对象仓（同一数据库、同一版本，保证升级原子性）：
//   intents   key=batchId  准备意图：提交的完整事实 + 期望段摘要/前驱
//   segments  key=digest   不可变段：内容定址，只追加、永不更新
//   manifest  key='active' 活动清单：唯一一行 { head, order:[digest...] }
//
// 封存协议（故障注入点 crashAt 可在任意一步后中断）：
//   1. 恢复扫描（open 时）：清退未发布/损坏准备段，恢复完整未发布批次，去重已发布段
//   2. prepare：写 intent（含 events 原文、expectedDigest、baseHead、baseOrder）
//   3. writeSegment：写 segment（digest 定址；已存在且一致则跳过 → 天然幂等）
//   4. commit：清单切换 —— 读旧清单 → 校验期望未变 → 追加 digest → 写回，
//      然后删除已发布 intent
//
// 只有清单指向、且摘要/前驱/序号连续校验通过的段才算已封存。

import { buildSegment, GENESIS_DIGEST, hashEventText, verifyChain, verifySegment } from './chain.mjs';
import { normalizeSubmission, ValidationError } from './validation.mjs';

export const DB_NAME = 'attestation-vault';
export const DB_VERSION = 1;
const MANIFEST_KEY = 'active';

export const CRASH_POINTS = Object.freeze({
  AFTER_INTENT: 'after-intent',       // 准备意图已写，段未写
  AFTER_SEGMENT: 'after-segment',     // 段已写，清单未切换
  AFTER_MANIFEST: 'after-manifest',   // 清单已切换，intent 删除前中断
});

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('intents')) db.createObjectStore('intents');
      if (!db.objectStoreNames.contains('segments')) db.createObjectStore('segments');
      if (!db.objectStoreNames.contains('manifest')) db.createObjectStore('manifest');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 升级被阻塞'));
  });
}

function tx(db, stores, mode = 'readonly') {
  const t = db.transaction(stores, mode);
  return { t, stores: Object.fromEntries(stores.map((s) => [s, t.objectStore(s)])) };
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

async function readAll(store) {
  return new Promise((resolve, reject) => {
    const out = {};
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        out[cur.key] = cur.value;
        cur.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

function freshManifest() {
  return { head: GENESIS_DIGEST, order: [], committedAt: 0 };
}

// 故障注入：测试把 window.__FAULT_INJECTION 设为 { crashAt, batchId }。
function getFault() {
  try {
    return (globalThis.window?.__FAULT_INJECTION) || globalThis.__FAULT_INJECTION || null;
  } catch {
    return null;
  }
}

async function maybeCrash(label) {
  const fault = getFault();
  if (fault && fault.crashAt === label) {
    // 模拟掉电：已完成的 IDB 写入保留，当前封存流程永久中断。
    // 具体的页面呈现（提示、冻结）由注入方通过 onCrash 回调处理。
    const tag = fault.batchId || '';
    try {
      fault.onCrash?.(label, tag);
    } catch {
      /* 回调失败不改变中断语义 */
    }
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn(`[fault-injection] 模拟封存中断 @${label}${tag ? ' batch=' + tag : ''}`);
    }
    if (fault.throwInsteadOfHang === true) {
      const err = new Error(`CRASH@${label}`);
      err.code = 'SIMULATED_CRASH';
      err.crashPoint = label;
      throw err;
    }
    await new Promise(() => {}); // 永久挂起当前流程，模拟进程终止
  }
}

export class Vault {
  constructor(db) {
    this.db = db;
  }

  static async open() {
    const db = await idbOpen();
    const vault = new Vault(db);
    return vault;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }

  // ---------- 低层读写 ----------

  async _getIntent(batchId) {
    const { t, stores } = tx(this.db, ['intents']);
    return wrap(stores.intents.get(batchId));
  }

  async _getSegment(digest) {
    const { t, stores } = tx(this.db, ['segments']);
    return wrap(stores.segments.get(digest));
  }

  async _getManifest() {
    const { t, stores } = tx(this.db, ['manifest']);
    const m = await wrap(stores.manifest.get(MANIFEST_KEY));
    return m || freshManifest();
  }

  // ---------- 恢复扫描 ----------
  // 返回审计日志数组：每条 { action, batchId?, detail, segment?, seqRange?, prevDigest? }

  async recover() {
    const audit = [];
    const manifest = await this._getManifest();
    const workingOrder = Array.isArray(manifest.order) ? manifest.order.slice() : [];

    // 1) 清单本身的健康度：列出指向的段，区分「已发布且有效」与「清单指向但损坏/缺失」。
    const published = [];
    const dangling = [];
    for (const digest of workingOrder) {
      const seg = await this._getSegment(digest);
      if (!seg) {
        dangling.push({ digest, reason: '清单指向的段不存在' });
        continue;
      }
      const err = await verifySegment(seg);
      if (err) dangling.push({ digest, reason: err });
      else published.push(seg);
    }

    // 2) 找出不在清单上的孤儿段（写完段但清单未切换的残留）。
    const allSegs = await readAll(tx(this.db, ['segments']).stores.segments);
    const orphanSegs = [];
    for (const [digest, seg] of Object.entries(allSegs)) {
      if (!workingOrder.includes(digest)) orphanSegs.push(seg);
    }

    // 3) 处理每条准备意图（按准备时间排序，兼容多意图串行恢复）。
    const intents = await readAll(tx(this.db, ['intents']).stores.intents);
    const orderedIntents = Object.entries(intents).sort(
      (a, b) =>
        (a[1].preparedAt || 0) - (b[1].preparedAt || 0)
        || a[0].localeCompare(b[0]), // 同毫秒时以 batchId 确定次序，保证可重复
    );
    for (const [batchId, intent] of orderedIntents) {
      const result = await this._recoverIntent(batchId, intent, workingOrder, published, orphanSegs, audit);
      if (result?.publishedSegment) {
        published.push(result.publishedSegment);
        workingOrder.push(result.publishedSegment.digest);
      }
    }

    // 4) 残留孤儿段（没有对应意图认领）：损坏的明确标记，完整的保留为证据，均不进入链。
    for (const seg of orphanSegs) {
      const err = await verifySegment(seg).catch(() => '段记录无法解析');
      audit.push({
        action: err ? 'CORRUPT_SEGMENT_QUARANTINED' : 'ORPHAN_SEGMENT_QUARANTINED',
        batchId: seg?.batchId,
        segment: seg || null,
        seqRange: seg && Number.isSafeInteger(seg.firstSeq) ? [seg.firstSeq, seg.lastSeq] : null,
        prevDigest: seg?.prevDigest,
        detail: err
          ? `未列入清单的残留段${seg?.digest ? ' ' + seg.digest.slice(0, 12) + '…' : ''}校验失败：${err}；损坏段不得进入链，保留为证据`
          : `段 ${seg.digest.slice(0, 12)}… 完整但无有效准备意图认领，保留为证据但不进入封存链`,
      });
    }

    // 5) 清单悬挂（理论上不应发生，因为我们总是先写段再切清单）：首个阻断证据。
    for (const d of dangling) {
      audit.push({
        action: 'MANIFEST_DANGLING_REF',
        detail: `活动清单引用了${d.reason}；该引用之后的封存状态不可信`,
      });
    }

    const chainCheck = await verifyChain(published);
    if (!chainCheck.ok) {
      audit.push({ action: 'CHAIN_INVALID', detail: `已发布链校验失败：${chainCheck.firstBlocking}` });
    }
    return {
      audit,
      manifest: { head: chainCheck.ok ? chainCheck.tipDigest : manifest.head, order: workingOrder },
      chainCheck,
      publishedCount: published.length,
    };
  }

  async _recoverIntent(batchId, intent, workingOrder, published, orphanSegs, audit) {
    // 意图自身结构校验：半写入的 intent 直接废弃。
    const intentErr = checkIntentShape(intent);
    if (intentErr) {
      await this._deleteIntent(batchId);
      audit.push({ action: 'INTENT_DISCARDED', batchId, detail: `未发布的准备意图结构不完整（${intentErr}），已废弃，不进入链` });
      return null;
    }

    const seg = await this._getSegment(intent.expectedDigest);

    // 是否已被本意图发布过（AFTER_MANIFEST 中断：清单已切换、intent 未删）。
    if (workingOrder.includes(intent.expectedDigest)) {
      if (!seg) {
        audit.push({
          action: 'ALREADY_PUBLISHED_SEGMENT_MISSING',
          batchId,
          detail: '清单已包含期望段但段体缺失，封存链需要人工介入',
        });
        return null;
      }
      await this._deleteIntent(batchId);
      audit.push({
        action: 'DEDUP_ALREADY_PUBLISHED',
        batchId,
        segment: seg,
        seqRange: [seg.firstSeq, seg.lastSeq],
        prevDigest: seg.prevDigest,
        detail: `清单已包含段 ${seg.digest.slice(0, 12)}…（AFTER_MANIFEST 残留意图）；不重复追加，删除冗余准备意图`,
        receipt: this._receiptFor(seg, intent, true),
      });
      return null;
    }

    if (!seg) {
      // 段缺失：AFTER_INTENT 中断，或段写坏/丢失。未发布 → 废弃意图。
      await this._deleteIntent(batchId);
      audit.push({
        action: 'INTENT_DISCARDED',
        batchId,
        detail: '准备意图存在但期望段缺失（在段写入前中断）；未发布的准备段不得进入链，意图已废弃，需按业务重新提交',
      });
      return null;
    }

    // 段存在但损坏：隔离，不入链。
    const segErr = await verifySegment(seg);
    if (segErr) {
      audit.push({
        action: 'CORRUPT_SEGMENT_QUARANTINED',
        batchId,
        segment: seg,
        seqRange: [seg.firstSeq, seg.lastSeq],
        prevDigest: seg.prevDigest,
        detail: `准备意图对应的段已写入但校验失败：${segErr}；损坏段保留为证据，不进入链，意图作废`,
      });
      await this._deleteIntent(batchId);
      return null;
    }

    // 孤儿段列表中认领并移除（避免被当作 ORPHAN 隔离）。
    const idx = orphanSegs.findIndex((s) => s.digest === seg.digest);
    if (idx >= 0) orphanSegs.splice(idx, 1);

    // 完整但尚未发布：检查是否仍能按「既定意图」接到当前链尾。
    // 意图记录了准备时的基底（baseHead/baseOrder）。
    const currentTip = published.length ? published[published.length - 1].digest : GENESIS_DIGEST;
    if (seg.prevDigest !== currentTip) {
      // 也许清单在意图准备后被别的批次推进了——本场景单页串行提交不会发生，
      // 但仍按规则处理：段虽完整，已无法成为唯一合法结果，隔离保留证据。
      audit.push({
        action: 'STALE_INTENT_QUARANTINED',
        batchId,
        segment: seg,
        seqRange: [seg.firstSeq, seg.lastSeq],
        prevDigest: seg.prevDigest,
        detail: `完整段的前驱 ${seg.prevDigest.slice(0, 12)}… 与当前链尾 ${currentTip.slice(0, 12)}… 不一致，无法按既定意图发布；保留证据不入链`,
      });
      await this._deleteIntent(batchId);
      return null;
    }

    // 序号连续性：接在已发布段之后时，首序号必须等于链尾 lastSeq+1。
    if (published.length > 0) {
      const need = published[published.length - 1].lastSeq + 1;
      if (seg.firstSeq !== need) {
        audit.push({
          action: 'SEQ_GAP_QUARANTINED',
          batchId,
          segment: seg,
          seqRange: [seg.firstSeq, seg.lastSeq],
          prevDigest: seg.prevDigest,
          detail: `段与链尾序号不连续：期望首序号 ${need}，实际 ${seg.firstSeq}；保留证据不入链`,
        });
        await this._deleteIntent(batchId);
        return null;
      }
    }

    // 按既定意图完成发布：这是唯一允许的恢复结果。
    // 先切清单、再删意图，与正常路径同构：若此间再次中断，
    // 下一次扫描会走 DEDUP_ALREADY_PUBLISHED，结果仍然唯一。
    const newOrder = workingOrder.concat(seg.digest);
    await this._commitManifest(seg, newOrder);
    await this._deleteIntent(batchId);
    audit.push({
      action: 'RECOVERED_PUBLISHED',
      batchId,
      segment: seg,
      seqRange: [seg.firstSeq, seg.lastSeq],
      prevDigest: seg.prevDigest,
      detail: `完整段（在清单切换前中断）已按既定意图恢复发布为唯一结果：${seg.digest.slice(0, 12)}…，序号 ${seg.firstSeq}-${seg.lastSeq}`,
      receipt: this._receiptFor(seg, intent, true),
    });
    return { publishedSegment: seg };
  }

  async _deleteIntent(batchId) {
    const { t, stores } = tx(this.db, ['intents'], 'readwrite');
    stores.intents.delete(batchId);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('intent 删除事务中止'));
    });
  }

  async _commitManifest(seg, newOrder) {
    const { t, stores } = tx(this.db, ['manifest'], 'readwrite');
    stores.manifest.put(
      { head: seg.digest, order: newOrder, committedAt: Date.now() },
      MANIFEST_KEY,
    );
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('清单切换事务中止'));
    });
  }

  // ---------- 正常封存路径 ----------

  // 提交批次。返回 { status: 'sealed'|'conflict', receipt?, conflict? }
  async submit(raw) {
    const sub = normalizeSubmission(raw); // 抛出 ValidationError
    const { batchId, events } = sub;

    const manifest = await this._getManifest();
    const order = Array.isArray(manifest.order) ? manifest.order.slice() : [];

    // 先做恢复扫描应在打开页面时完成；这里防御性地处理可能存在的同批意图。
    const existingIntent = await this._getIntent(batchId);
    const chainSegs = [];
    for (const d of order) chainSegs.push(await this._getSegment(d));

    // 任何提交（含重传）之前先整体校验已发布链：链断裂时不得追加、
    // 也不得在断裂链上给出「原回执」式的正常响应。
    const chainCheck = await verifyChain(chainSegs);
    if (!chainCheck.ok) {
      throw new ValidationError(
        'CHAIN_INVALID',
        `已发布封存链存在首个阻断证据：${chainCheck.firstBlocking}；本次提交被阻断`,
        '封存链校验未通过',
      );
    }

    // 幂等 / 冲突判定优先于一切写入。
    // 已发布的同标识批次？
    const publishedSeg = chainSegs.find((s) => s && s.batchId === batchId);
    if (publishedSeg) {
      const same = await this._sameAsPublished(batchId, events, publishedSeg);
      if (same) {
        return {
          status: 'sealed',
          duplicate: true,
          receipt: this._receiptFor(publishedSeg, null, false),
        };
      }
      return {
        status: 'conflict',
        conflict: {
          batchId,
          existingDigest: publishedSeg.digest,
          seqRange: [publishedSeg.firstSeq, publishedSeg.lastSeq],
          detail: `批次标识 ${batchId} 已封存不同内容（既有段 ${publishedSeg.digest.slice(0, 12)}…，序号 ${publishedSeg.firstSeq}-${publishedSeg.lastSeq}）；既有证据保留不变，本次冲突提交未写入任何记录`,
        },
      };
    }

    // 残留未发布意图（同标识）：按既定意图比较内容。
    if (existingIntent) {
      const sameAsIntent = await this._sameAsIntent(events, existingIntent);
      if (sameAsIntent) {
        // 同标识同内容重传且尚未发布：继续走封存路径，段是内容定址的，结果必然是同一回执。
        // 直接复用既有意图继续完成。
      } else {
        return {
          status: 'conflict',
          conflict: {
            batchId,
            existingDigest: existingIntent.expectedDigest,
            seqRange: [existingIntent.firstSeq, existingIntent.lastSeq],
            detail: `批次标识 ${batchId} 存在未发布的准备意图且内容不同；既有准备证据保留，本次冲突提交被拒绝`,
          },
        };
      }
    }

    // 链尾与序号连续性（链健康已在上方整体校验）。
    const tip = order.length ? chainCheck.tipDigest : GENESIS_DIGEST;
    let prevDigest = GENESIS_DIGEST;
    if (chainSegs.length) {
      const tail = chainSegs[chainSegs.length - 1];
      prevDigest = tail.digest;
      const expectedFirstSeq = tail.lastSeq + 1;
      if (events[0].seq !== expectedFirstSeq) {
        throw new ValidationError(
          'SEQ_DISCONTINUOUS_WITH_CHAIN',
          `本批首序号 ${events[0].seq} 与封存链尾序号 ${tail.lastSeq} 不连续（期望 ${expectedFirstSeq}）`,
          '批次序号必须与已封存链连续',
        );
      }
    }

    const createdAt = existingIntent?.createdAt || Date.now();
    const segment = await buildSegment(batchId, events, prevDigest, createdAt);

    // 若既有意图期望不同摘要 → 冲突（内容不同）。
    if (existingIntent && existingIntent.expectedDigest !== segment.digest) {
      return {
        status: 'conflict',
        conflict: {
          batchId,
          existingDigest: existingIntent.expectedDigest,
          seqRange: [existingIntent.firstSeq, existingIntent.lastSeq],
          detail: `批次标识 ${batchId} 的残留准备意图期望不同段摘要；既有证据保留，本次冲突提交被拒绝`,
        },
      };
    }

    // 步骤 1：准备意图（含完整原文，供恢复时核验与重建）。
    if (!existingIntent) {
      const intent = {
        batchId,
        events: events.map((e) => ({ seq: e.seq, text: e.text })),
        expectedDigest: segment.digest,
        prevDigest,
        firstSeq: segment.firstSeq,
        lastSeq: segment.lastSeq,
        baseHead: tip,
        baseOrder: order,
        createdAt,
        preparedAt: Date.now(),
      };
      await this._putIntent(intent);
    }
    await maybeCrash(CRASH_POINTS.AFTER_INTENT);

    // 步骤 2：不可变段（内容定址，重复 put 同值无副作用）。
    await this._putSegment(segment);
    await maybeCrash(CRASH_POINTS.AFTER_SEGMENT);

    // 步骤 3：清单切换（独立事务）。
    const newOrder = order.concat(segment.digest);
    await this._commitManifest(segment, newOrder);
    await maybeCrash(CRASH_POINTS.AFTER_MANIFEST);

    // 步骤 4：清理已发布的准备意图。
    await this._deleteIntent(batchId);

    return {
      status: 'sealed',
      duplicate: false,
      receipt: this._receiptFor(segment, null, false),
    };
  }

  _receiptFor(seg, _intentLike, recovered) {
    return {
      receiptId: `rcpt-${seg.digest.slice(0, 16)}`,
      batchId: seg.batchId,
      digest: seg.digest,
      prevDigest: seg.prevDigest,
      seqRange: [seg.firstSeq, seg.lastSeq],
      eventCount: seg.eventHashes.length,
      eventHashes: seg.eventHashes.map((eh) => ({ seq: eh.seq, textHash: eh.textHash })),
      payloadHash: seg.payloadHash,
      createdAt: seg.createdAt,
      recovered: !!recovered,
    };
  }

  async _sameAsPublished(batchId, events, seg) {
    if (seg.firstSeq !== events[0].seq || seg.lastSeq !== events[events.length - 1].seq) return false;
    if (seg.eventHashes.length !== events.length) return false;
    for (let i = 0; i < events.length; i++) {
      if (seg.eventHashes[i].seq !== events[i].seq) return false;
      const h = await hashEventText(events[i].text);
      if (h !== seg.eventHashes[i].textHash) return false;
    }
    return true;
  }

  async _sameAsIntent(events, intent) {
    if (intent.expectedDigest && intent.firstSeq !== events[0].seq) return false;
    if (!Array.isArray(intent.events) || intent.events.length !== events.length) return false;
    for (let i = 0; i < events.length; i++) {
      if (intent.events[i].seq !== events[i].seq || intent.events[i].text !== events[i].text) return false;
    }
    return true;
  }

  async _putIntent(intent) {
    const { t, stores } = tx(this.db, ['intents'], 'readwrite');
    stores.intents.put(intent, intent.batchId);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('intent 写入事务中止'));
    });
  }

  async _putSegment(seg) {
    const { t, stores } = tx(this.db, ['segments'], 'readwrite');
    stores.segments.put(seg, seg.digest);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('segment 写入事务中止'));
    });
  }

  // 测试辅助：读取已发布链（含校验）。
  async listChain() {
    const manifest = await this._getManifest();
    const segs = [];
    for (const d of manifest.order) {
      const s = await this._getSegment(d);
      if (s) segs.push(s);
    }
    const check = await verifyChain(segs);
    return { manifest, segs, check };
  }
}

function checkIntentShape(intent) {
  if (!intent || typeof intent !== 'object') return '意图不是对象';
  if (typeof intent.batchId !== 'string') return '缺少 batchId';
  if (!/^[0-9a-f]{64}$/.test(intent.expectedDigest || '')) return 'expectedDigest 非法';
  if (!/^[0-9a-f]{64}$/.test(intent.prevDigest || '')) return 'prevDigest 非法';
  if (!Array.isArray(intent.events) || intent.events.length === 0) return 'events 缺失或为空';
  for (const e of intent.events) {
    if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.seq) || typeof e.text !== 'string') {
      return 'events 中存在不完整记录（疑似半写入）';
    }
  }
  if (!Number.isSafeInteger(intent.firstSeq) || !Number.isSafeInteger(intent.lastSeq)) return '序号范围缺失';
  return null;
}
