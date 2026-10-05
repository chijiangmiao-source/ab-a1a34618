// 一次运行后退出的 verify 服务：
//   1. 前端构建（核心模块原样发布，杜绝构建产物与规则实现漂移）
//   2. 规则测试（UTF-8/SHA-256、批次规则、封存协议、三类中断恢复）
//   3. 在临时端口启动 Compose 宿主，HTTP 冒烟（页面 + /health 健康响应）
//   4. Playwright 真实 Chromium：页面交互、IndexedDB 持久化、中断恢复场景
//   5. 以退出码报告：0 全部通过；非 0 存在失败
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];

function report(suite, ok, detail = '') {
  results.push({ suite, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${suite}] ${detail || (ok ? '通过' : '失败')}`);
}

function runStep(name, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(`   ${d}`); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(`   ${d}`); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// 本机无 root 时解压在 .syslib/root 的 Chromium 依赖库（若存在）。
function localLibPath() {
  const libRoot = join(ROOT, '.syslib', 'root');
  if (!existsSync(libRoot)) return '';
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.includes('.so')) found.push(dir);
    }
  };
  try { walk(libRoot); } catch { return ''; }
  return [...new Set(found)].join(':');
}

async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---------- 阶段 1：前端构建 ----------
console.log('\n=== 阶段 1：前端构建 ===');
{
  const { code } = await runStep('build', [join(ROOT, 'scripts', 'build-web.mjs')]);
  report('build:web', code === 0, code === 0 ? '核心模块已发布到 public/vendor/core' : `构建退出码 ${code}`);
}

// ---------- 阶段 2：规则测试 ----------
console.log('\n=== 阶段 2：规则测试（Node + 内存 IndexedDB）===');
{
  const { code, out } = await runStep('rules', [join(ROOT, 'src', 'verify', 'rules.test.mjs')]);
  report('test:rules', code === 0, code === 0 ? '全部规则断言通过' : `规则测试失败（退出码 ${code}）`);
  if (code !== 0) process.exitCode = 1;
}

// ---------- 阶段 3：启动宿主 + HTTP 冒烟 ----------
console.log('\n=== 阶段 3：启动宿主服务并做 HTTP 冒烟 ===');
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const serverProc = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
serverProc.stdout.on('data', (d) => process.stdout.write(`   ${d}`));
serverProc.stderr.on('data', (d) => process.stderr.write(`   ${d}`));

let browser = null;
try {
  const healthy = await waitForHealth(BASE);
  report('smoke:health', healthy, healthy ? `GET /health → 200（${BASE}）` : '健康端点未在超时内就绪');

  if (healthy) {
    const checks = [
      ['smoke:health-json', '/health', async (r, t) => r.ok && (r.headers.get('content-type') || '').includes('application/json') && JSON.parse(t).status === 'ok'],
      ['smoke:healthz', '/healthz', async (r) => r.ok],
      ['smoke:ready', '/ready', async (r, t) => r.ok && JSON.parse(t).webBuilt === true],
      ['smoke:index', '/', async (r, t) => r.ok && t.includes('离线封存链复核页') && t.includes('/app.mjs')],
      ['smoke:app-module', '/app.mjs', async (r, t) => r.ok && t.includes("from '/vendor/core/vault.mjs'")],
      ['smoke:core-module', '/vendor/core/vault.mjs', async (r, t) => r.ok && t.includes('class Vault') && t.includes('_commitManifest')],
      ['smoke:build-manifest', '/vendor/core/build-manifest.json', async (r, t) => r.ok && Array.isArray(JSON.parse(t).modules)],
      ['smoke:404', '/no-such-path', async (r) => r.status === 404],
    ];
    for (const [name, path, check] of checks) {
      try {
        const r = await fetch(`${BASE}${path}`);
        const text = await r.text();
        const passed = await check(r, text);
        report(name, !!passed, `${path} → ${r.status}`);
      } catch (e) {
        report(name, false, `${path} 异常：${e.message}`);
      }
    }
  }

  // ---------- 阶段 4：真实浏览器演练 ----------
  console.log('\n=== 阶段 4：Chromium 页面与中断恢复演练 ===');
  const { chromium } = await import('playwright');
  const extraLib = localLibPath();
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: extraLib ? { LD_LIBRARY_PATH: `${extraLib}:${process.env.LD_LIBRARY_PATH || ''}` } : undefined,
  });
  console.log('   浏览器：', browser.version());

  const parseReceipt = (text) => {
    const i = text.indexOf('{');
    return i >= 0 ? JSON.parse(text.slice(i)) : null;
  };
  const fillBatch = async (page, batchId, events) => {
    await page.fill('#batch-id', batchId);
    await page.click('#clear-rows'); // 每次填表前重置事件行
    for (let i = 1; i < events.length; i++) await page.click('#add-row');
    const rowEls = page.locator('#event-rows .event-row');
    for (let i = 0; i < events.length; i++) {
      await rowEls.nth(i).locator('input.seq').fill(String(events[i].seq));
      await rowEls.nth(i).locator('input[type="text"]').fill(events[i].text);
    }
  };
  const submitAndWait = (page) => page.click('#submit-btn');
  const waitReady = (page) => page.waitForSelector('#db-status.pill-ok', { timeout: 10000 });
  const chainCount = (page) => page.locator('#chain-list .seg-card .batch').count();

  // 4.0 浏览器内规范哈希与核心模块加载
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);
    const hashOk = await page.evaluate(async () => {
      const { sha256Hex, utf8Bytes } = await import('/vendor/core/encoding.mjs');
      const h = await sha256Hex(utf8Bytes('abc'));
      return h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
        && new TextEncoder().encode('事件').length === 6;
    });
    report('browser:crypto-sha256', hashOk, '页面内 UTF-8 SHA-256 与 NIST 已知答案一致');
    await ctx.close();
  }

  // 4.1 正常封存 + 重开持久化 + 幂等回执 + 冲突保留
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);

    await fillBatch(page, 'UI-RUN-1', [{ seq: 1, text: '俯仰+12' }, { seq: 2, text: '偏航-3' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');
    const r1 = parseReceipt(await page.locator('#result-panel').innerText());
    report('ui:seal', !!r1 && r1.seqRange.join('-') === '1-2', `封存回执 ${r1?.receiptId || '缺失'}`);

    // 重开页面：段仍在链上，恢复审计为空操作
    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const auditText1 = await page.locator('#audit-list').innerText();
    const countAfterReopen = await chainCount(page);
    report('ui:reopen-persist', countAfterReopen === 1 && /无需恢复动作|未发现残留/.test(auditText1),
      `重开后链上 ${countAfterReopen} 段，且无多余恢复动作`);

    // 同标识同内容重传 → 原回执
    await fillBatch(page, 'UI-RUN-1', [{ seq: 1, text: '俯仰+12' }, { seq: 2, text: '偏航-3' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');
    const dupText = await page.locator('#result-panel').innerText();
    const r2 = parseReceipt(dupText);
    report('ui:idempotent-receipt', dupText.includes('原回执') && r2?.digest === r1.digest,
      `同标识同内容重传给出原回执 ${r2?.digest === r1.digest ? '' : '(摘要不一致!)'}`);
    report('ui:no-dup-append', (await chainCount(page)) === 1, '重传未重复追加段');

    // 同标识不同内容 → 冲突，证据保留
    await fillBatch(page, 'UI-RUN-1', [{ seq: 1, text: '俯仰+99（篡改）' }, { seq: 2, text: '偏航-3' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.conflict');
    const conflictText = await page.locator('#result-panel').innerText();
    const stillOne = await chainCount(page);
    report('ui:conflict-preserved', conflictText.includes('冲突') && conflictText.includes(r1.digest.slice(0, 12)) && stillOne === 1,
      '内容不同明确冲突、指向既有证据且链不增长');

    // 规则阻断（首个证据）：25 条（UI 最多 24 行，直接驱动页面内 Vault 实例）
    const blocked = await page.evaluate(async () => {
      try {
        await globalThis.__VAULT__.submit({
          batchId: 'UI-TOO-MANY',
          events: Array.from({ length: 25 }, (_, i) => ({ seq: i + 1, text: 'x' })),
        });
        return { blocked: false };
      } catch (e) {
        return { blocked: true, code: e.code, evidence: e.evidence };
      }
    });
    report('ui:rule-block-evidence',
      blocked.blocked && blocked.code === 'EVENTS_TOO_MANY' && /25/.test(blocked.evidence),
      `超限批次被阻断（${blocked.code || '未抛错'}，证据：${(blocked.evidence || '').slice(0, 40)}）`);

    // 序号非严格递增：通过 UI 表单提交，检查错误面板的首个阻断证据
    await fillBatch(page, 'UI-BAD-SEQ', [{ seq: 1, text: 'a' }, { seq: 1, text: 'b' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.error');
    const seqText = await page.locator('#result-panel').innerText();
    report('ui:seq-evidence', seqText.includes('SEQ_NOT_STRICTLY_INCREASING') && seqText.includes('位置 2'),
      '失序序号在 UI 展示首个阻断证据与位置');

    report('ui:no-page-errors', errors.length === 0, errors.length ? `页面异常：${errors.join('; ')}` : '全程无未捕获页面错误');
    await ctx.close();
  }

  // 4.2 AFTER_INTENT：未发布准备段不得进入链
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);
    await page.selectOption('#crash-point', 'after-intent');
    await fillBatch(page, 'CRASH-INTENT', [{ seq: 1, text: '只到意图' }]);
    await submitAndWait(page);
    await page.waitForSelector('#db-status.pill-bad', { timeout: 10000 });

    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const audit = await page.locator('#audit-list').innerText();
    const count = await chainCount(page);
    report('crash:after-intent', /废弃未发布准备段/.test(audit) && count === 0,
      '意图后中断：重开后未发布准备段被废弃，链为空');
    await ctx.close();
  }

  // 4.3 AFTER_SEGMENT：完整未发布批次按既定意图唯一恢复；再重开不重复追加
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);

    await fillBatch(page, 'CRASH-SEG-BASE', [{ seq: 1, text: '历史段' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');

    await page.selectOption('#crash-point', 'after-segment');
    await fillBatch(page, 'CRASH-SEG-PENDING', [{ seq: 2, text: '段已写清单未切' }]);
    await submitAndWait(page);
    await page.waitForSelector('#db-status.pill-bad', { timeout: 10000 });

    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const audit = await page.locator('#audit-list').innerText();
    const count = await chainCount(page);
    const segCards = page.locator('#chain-list .seg-card');
    const card2 = segCards.nth(1);
    const card2Text = await card2.innerText();
    report('crash:after-segment-recover',
      /按既定意图恢复发布/.test(audit) && /唯一结果/.test(audit) && count === 2,
      '段后中断：重开后按既定意图恢复为唯一结果，链上两段');
    report('ui:segment-meta',
      card2Text.includes('2–2') && card2Text.includes('恢复动作'),
      '页面展示恢复段序号范围、前驱摘要与恢复动作');

    // 再一次重开：不得重复追加
    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const count2 = await chainCount(page);
    const audit2 = await page.locator('#audit-list').innerText();
    report('crash:no-double-append', count2 === 2 && !/按既定意图恢复发布/.test(audit2),
      '再次重开已发布段不重复追加');

    // 同内容重传拿原回执
    await fillBatch(page, 'CRASH-SEG-PENDING', [{ seq: 2, text: '段已写清单未切' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');
    const dup = await page.locator('#result-panel').innerText();
    report('crash:dup-after-recover', dup.includes('原回执') && (await chainCount(page)) === 2,
      '恢复后同标识同内容重传仍给原回执');
    await ctx.close();
  }

  // 4.4 AFTER_MANIFEST：已发布段去重
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);
    await page.selectOption('#crash-point', 'after-manifest');
    await fillBatch(page, 'CRASH-MANIFEST', [{ seq: 1, text: '清单切完意图没删' }]);
    await submitAndWait(page);
    await page.waitForSelector('#db-status.pill-bad', { timeout: 10000 });

    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const audit = await page.locator('#audit-list').innerText();
    const count = await chainCount(page);
    report('crash:after-manifest-dedup', /已发布去重/.test(audit) && count === 1,
      '清单后中断：重开后识别已发布并去重，不重复追加');

    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    report('crash:dedup-idempotent', (await chainCount(page)) === 1, '再次扫描仍只一段');

    await fillBatch(page, 'CRASH-MANIFEST', [{ seq: 1, text: '清单切完意图没删' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');
    const t = await page.locator('#result-panel').innerText();
    report('crash:manifest-receipt', t.includes('原回执'), '去重后重传给原回执');
    await ctx.close();
  }

  // 4.5 损坏段与孤儿段：不得混入封存链，页面给出首个阻断证据
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);
    await fillBatch(page, 'EVIDENCE-BASE', [{ seq: 1, text: '正常段' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');

    // 注入一个完整但无意图、无清单引用的孤儿段
    await page.evaluate(async () => {
      const { buildSegment, GENESIS_DIGEST } = await import('/vendor/core/chain.mjs');
      const seg = await buildSegment('EVAL-ORPHAN', [{ seq: 88, text: '无人认领' }], GENESIS_DIGEST, 1);
      await new Promise((resolve, reject) => {
        const r = indexedDB.open('attestation-vault');
        r.onsuccess = () => {
          const db = r.result;
          const t = db.transaction('segments', 'readwrite');
          t.objectStore('segments').put(seg, seg.digest);
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
        };
        r.onerror = () => reject(r.error);
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const audit = await page.locator('#audit-list').innerText();
    report('corrupt:orphan-quarantined', /隔离孤儿段|无有效准备意图/.test(audit) && (await chainCount(page)) === 1,
      '完整孤儿段保留为证据但不进入链');
    await ctx.close();
  }

  // 4.6 已发布段损坏：链校验必须报告首个阻断证据
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await waitReady(page);
    await fillBatch(page, 'ROT-BASE', [{ seq: 1, text: '会腐烂' }]);
    await submitAndWait(page);
    await page.waitForSelector('#result-panel.ok');

    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const r = indexedDB.open('attestation-vault');
        r.onsuccess = () => {
          const db = r.result;
          const t = db.transaction(['manifest', 'segments'], 'readwrite');
          const mreq = t.objectStore('manifest').get('active');
          mreq.onsuccess = () => {
            const digest = mreq.result.order[0];
            const sreq = t.objectStore('segments').get(digest);
            sreq.onsuccess = () => {
              const seg = sreq.result;
              seg.lastSeq = 4242; // 半写入/位腐烂
              t.objectStore('segments').put(seg, digest);
            };
          };
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
        };
        r.onerror = () => reject(r.error);
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    const bodyText = await page.locator('body').innerText();
    report('corrupt:published-detected', /摘要重算不通过|链校验阻断|清单指向/.test(bodyText),
      '已发布段损坏时页面给出首个阻断证据');
    await ctx.close();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  serverProc.kill('SIGTERM');
  await once(serverProc, 'exit').catch(() => {});
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n=== verify 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  console.error(`失败 ${failed.length} 项：`);
  for (const f of failed) console.error(`  ✗ [${f.suite}] ${f.detail}`);
  process.exit(1);
}
console.log('verify 全部通过 ✅');
process.exit(0);
