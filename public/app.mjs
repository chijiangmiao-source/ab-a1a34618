// 复核页前端逻辑：提交批次、展示封存链、返航恢复扫描、故障演练。
import { Vault, CRASH_POINTS } from '/vendor/core/vault.mjs';
import { ValidationError } from '/vendor/core/validation.mjs';
import { GENESIS_DIGEST } from '/vendor/core/chain.mjs';

const FAULT_LS_KEY = 'vault.faultCrashAt';

const el = (id) => document.getElementById(id);
const refs = {
  dbStatus: el('db-status'),
  chainTip: el('chain-tip'),
  batchId: el('batch-id'),
  rows: el('event-rows'),
  addRow: el('add-row'),
  clearRows: el('clear-rows'),
  submit: el('submit-btn'),
  summary: el('submit-summary'),
  result: el('result-panel'),
  chainList: el('chain-list'),
  crashPoint: el('crash-point'),
  reopen: el('reopen-btn'),
  reset: el('reset-btn'),
  faultState: el('fault-state'),
  auditList: el('audit-list'),
};

let vault = null;
let crashed = false;

// 调试/自动化句柄：verify 服务可用它在真实页面环境内直接驱动封存协议。
globalThis.__VAULT__ = null;

// ---------- 故障注入桥接 ----------
// 页面把 localStorage 中的注入点安装为全局钩子；中断时抛出应用层事件并冻结当前流程，
// 由「重开页面」按钮（或测试直接关掉页面）结束本次打开，下一次打开进入恢复扫描。
function installFaultHook() {
  const crashAt = localStorage.getItem(FAULT_LS_KEY) || '';
  globalThis.__FAULT_INJECTION = crashAt
    ? {
        crashAt,
        onCrash(label) {
          crashed = true;
          localStorage.removeItem(FAULT_LS_KEY); // 只中断一次，重开后不再注入
          document.dispatchEvent(new CustomEvent('vault-crash', { detail: { label } }));
        },
      }
    : null;
  return crashAt;
}

function refreshFaultState(active) {
  refs.faultState.textContent = active
    ? `已武装：下一次封存将在「${crashLabel(active)}」后中断，随后请重开页面`
    : '';
}

function crashLabel(v) {
  return {
    [CRASH_POINTS.AFTER_INTENT]: '准备意图写入',
    [CRASH_POINTS.AFTER_SEGMENT]: '段写入',
    [CRASH_POINTS.AFTER_MANIFEST]: '清单切换',
  }[v] || v;
}

document.addEventListener('vault-crash', (e) => {
  refs.dbStatus.textContent = `已中断 @${crashLabel(e.detail.label)}`;
  refs.dbStatus.className = 'pill pill-bad';
  refs.submit.disabled = false;
  showResult('error', '封存中断演练', `已在「${crashLabel(e.detail.label)}」之后强制中断本次打开。\nIndexedDB 中的残留状态保持原样，请点击「模拟返航：关闭并重开页面」查看恢复扫描结果。`);
});

// ---------- 事件行 ----------
function addEventRow(seq = '', text = '') {
  const row = document.createElement('div');
  row.className = 'event-row';
  const seqInput = document.createElement('input');
  seqInput.className = 'seq';
  seqInput.type = 'number';
  seqInput.min = '1';
  seqInput.step = '1';
  seqInput.placeholder = '序号';
  seqInput.value = seq;
  seqInput.setAttribute('aria-label', '事件序号');
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.maxLength = 4000;
  textInput.placeholder = '文本载荷（姿态事件描述）';
  textInput.value = text;
  textInput.setAttribute('aria-label', '事件文本载荷');
  row.append(seqInput, textInput);
  refs.rows.appendChild(row);
  updateSummary();
}

function readRows() {
  const events = [];
  for (const row of refs.rows.querySelectorAll('.event-row')) {
    const [seqInput, textInput] = row.children;
    events.push({ seqInput, textInput });
  }
  return events;
}

function updateSummary() {
  const n = refs.rows.children.length;
  refs.summary.textContent = `共 ${n} 条事件（上限 24）`;
}

refs.addRow.addEventListener('click', () => {
  if (refs.rows.children.length >= 24) return;
  addEventRow();
});
refs.clearRows.addEventListener('click', () => {
  refs.rows.replaceChildren();
  addEventRow();
});

// 初始提供一条空事件行。
addEventRow();

// ---------- 渲染 ----------
function showResult(kind, title, body) {
  refs.result.hidden = false;
  refs.result.className = `result ${kind}`;
  refs.result.textContent = '';
  const t = document.createElement('div');
  t.className = 'result-title';
  t.textContent = title;
  refs.result.appendChild(t);
  const pre = document.createElement('div');
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = body;
  refs.result.appendChild(pre);
}

function shortHex(h) {
  return h ? `${h.slice(0, 12)}…${h.slice(-6)}` : '';
}

function renderChain({ segs, check }, audit) {
  refs.chainList.replaceChildren();
  if (!segs.length) {
    const empty = document.createElement('div');
    empty.className = 'audit-empty';
    empty.textContent = '尚无已封存段。提交第一个批次后，活动清单将指向链首。';
    refs.chainList.appendChild(empty);
  }
  // 以 digest 索引恢复动作，页面要求展示「每段的…恢复动作」。
  const actionByDigest = new Map();
  for (const a of audit || []) {
    const d = a.segment?.digest;
    if (d && !actionByDigest.has(d)) actionByDigest.set(d, a);
  }

  segs.forEach((seg, i) => {
    const card = document.createElement('div');
    card.className = 'seg-card';
    const top = document.createElement('div');
    top.className = 'seg-top';
    const left = document.createElement('span');
    left.className = 'batch';
    left.textContent = `#${i + 1} 批次 ${seg.batchId}`;
    const right = document.createElement('span');
    right.className = 'seqrange';
    right.textContent = `序号 ${seg.firstSeq}–${seg.lastSeq}（${seg.eventHashes.length} 条）`;
    top.append(left, right);

    const prev = document.createElement('div');
    prev.className = 'digest-line';
    prev.textContent = `前驱 ${seg.prevDigest === GENESIS_DIGEST ? 'GENESIS ' + shortHex(seg.prevDigest) : shortHex(seg.prevDigest)}`;
    const dig = document.createElement('div');
    dig.className = 'digest-line';
    dig.textContent = `本段 ${shortHex(seg.digest)}`;

    card.append(top, prev, dig);

    const act = actionByDigest.get(seg.digest);
    if (act) {
      const r = document.createElement('div');
      r.className = act.action === 'RECOVERED_PUBLISHED' ? 'recover' : 'recover blocked';
      r.textContent = `恢复动作：${actionText(act.action)} — ${act.detail}`;
      card.appendChild(r);
    }
    refs.chainList.appendChild(card);
  });

  if (!check.ok) {
    const b = document.createElement('div');
    b.className = 'seg-card';
    b.style.borderColor = 'var(--bad)';
    b.textContent = `链校验阻断：${check.firstBlocking}`;
    refs.chainList.appendChild(b);
  }
}

function actionText(a) {
  return {
    RECOVERED_PUBLISHED: '按既定意图恢复发布',
    DEDUP_ALREADY_PUBLISHED: '已发布去重',
    INTENT_DISCARDED: '废弃未发布准备段',
    CORRUPT_SEGMENT_QUARANTINED: '隔离损坏段',
    ORPHAN_SEGMENT_QUARANTINED: '隔离孤儿段',
    STALE_INTENT_QUARANTINED: '隔离过期意图段',
    SEQ_GAP_QUARANTINED: '隔离序号断裂段',
  }[a] || a;
}

function renderAudit(audit, chainCheck) {
  refs.auditList.replaceChildren();
  if (!audit.length && chainCheck?.ok) {
    const ok = document.createElement('div');
    ok.className = 'audit-empty';
    ok.textContent = '本次打开未发现残留状态；已发布链校验通过，无需恢复动作。';
    refs.auditList.appendChild(ok);
    return;
  }
  for (const a of audit) {
    const entry = document.createElement('div');
    const tone = ['RECOVERED_PUBLISHED', 'DEDUP_ALREADY_PUBLISHED'].includes(a.action)
      ? 'act-ok'
      : ['CHAIN_INVALID', 'MANIFEST_DANGLING_REF', 'ALREADY_PUBLISHED_SEGMENT_MISSING'].includes(a.action)
        ? 'act-bad'
        : 'act-warn';
    entry.className = `audit-entry ${tone}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [actionText(a.action)];
    if (a.batchId) parts.push(`batch=${a.batchId}`);
    if (a.seqRange) parts.push(`序号 ${a.seqRange[0]}–${a.seqRange[1]}`);
    if (a.prevDigest) parts.push(`前驱=${shortHex(a.prevDigest)}`);
    meta.textContent = parts.join(' ｜ ');

    const detail = document.createElement('div');
    detail.textContent = a.detail || '';
    entry.append(meta, detail);
    refs.auditList.appendChild(entry);
  }
}

// ---------- 启动 / 恢复 ----------
async function bootstrap() {
  const armed = installFaultHook();
  refreshFaultState(armed);
  refs.crashPoint.value = armed || '';

  vault = await Vault.open();
  globalThis.__VAULT__ = vault;
  refs.dbStatus.textContent = '封存库就绪';
  refs.dbStatus.className = 'pill pill-ok';

  const { audit, manifest, chainCheck, publishedCount } = await vault.recover();
  globalThis.__LAST_RECOVERY__ = { audit, chainCheck, publishedCount }; // 供 verify 读取
  renderAudit(audit, chainCheck);
  const { segs, check } = await vault.listChain();
  renderChain({ segs, check }, audit);
  refs.chainTip.textContent = manifest.head === GENESIS_DIGEST ? '链头：GENESIS（空链）' : `链头：${shortHex(manifest.head)}`;
}

// ---------- 提交 ----------
refs.submit.addEventListener('click', async () => {
  if (crashed) return;
  refs.result.hidden = true;
  const batchId = refs.batchId.value.trim();
  const rowInputs = readRows();
  const events = rowInputs.map(({ seqInput, textInput }) => ({
    seq: Number(seqInput.value),
    text: textInput.value,
  }));

  refs.submit.disabled = true;
  try {
    const out = await vault.submit({ batchId, events });
    if (out.status === 'conflict') {
      showResult('conflict', '冲突已记录（既有证据保留）', out.conflict.detail);
    } else {
      const r = out.receipt;
      showResult(
        'ok',
        out.duplicate ? '同标识同内容重传：返回原回执' : '封存成功，回执如下',
        JSON.stringify(
          {
            receiptId: r.receiptId,
            batchId: r.batchId,
            digest: r.digest,
            prevDigest: r.prevDigest,
            seqRange: r.seqRange,
            eventCount: r.eventCount,
            eventHashes: r.eventHashes,
            payloadHash: r.payloadHash,
            recovered: r.recovered,
          },
          null,
          2,
        ),
      );
    }
    await refreshAfterChange();
  } catch (err) {
    if (err instanceof ValidationError) {
      showResult('error', `提交被阻断（${err.code}）`, `首个阻断证据：${err.evidence}`);
    } else if (crashed) {
      // 中断路径由 vault-crash 事件负责呈现
    } else {
      showResult('error', '封存失败', err?.stack || String(err));
    }
  } finally {
    if (!crashed) refs.submit.disabled = false;
  }
});

async function refreshAfterChange() {
  const { audit, chainCheck } = await vault.recover();
  renderAudit(audit, chainCheck);
  const { manifest, segs, check } = await vault.listChain();
  renderChain({ segs, check }, audit);
  refs.chainTip.textContent = manifest.head === GENESIS_DIGEST ? '链头：GENESIS（空链）' : `链头：${shortHex(manifest.head)}`;
}

// ---------- 演练控件 ----------
refs.crashPoint.addEventListener('change', () => {
  const v = refs.crashPoint.value;
  if (v) localStorage.setItem(FAULT_LS_KEY, v);
  else localStorage.removeItem(FAULT_LS_KEY);
  installFaultHook();
  refreshFaultState(v);
});

refs.reopen.addEventListener('click', () => {
  localStorage.removeItem(FAULT_LS_KEY);
  globalThis.location.reload();
});

refs.reset.addEventListener('click', async () => {
  if (!globalThis.confirm('确认清空本机 IndexedDB 封存库？该操作不可恢复。')) return;
  vault.close();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('attestation-vault');
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('删除被阻塞'));
  });
  globalThis.location.reload();
});

bootstrap().catch((err) => {
  refs.dbStatus.textContent = '封存库异常';
  refs.dbStatus.className = 'pill pill-bad';
  showResult('error', '页面初始化失败', err?.stack || String(err));
});
