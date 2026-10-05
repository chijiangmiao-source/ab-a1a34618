// 前端构建：把 src/core 原样发布到 public/vendor/core（模块间使用相对路径 import，
// 浏览器可直接加载，无需打包器，从根本上避免构建产物与规则测试实现漂移）。
// 同时生成版本清单，供页面与冒烟核对构建时间。
import { cp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcCore = join(root, 'src', 'core');
const outCore = join(root, 'public', 'vendor', 'core');

await rm(outCore, { recursive: true, force: true });
await mkdir(outCore, { recursive: true });
await cp(srcCore, outCore, { recursive: true });

const manifest = {
  name: 'deepspace-attestation-vault',
  builtAt: new Date().toISOString(),
  modules: ['encoding.mjs', 'validation.mjs', 'chain.mjs', 'vault.mjs'],
};
await writeFile(join(outCore, 'build-manifest.json'), JSON.stringify(manifest, null, 2));

// 健全性检查：核心四个模块必须都在。
for (const m of manifest.modules) {
  const s = await stat(join(outCore, m));
  if (!s.isFile()) throw new Error(`构建失败：缺少 ${m}`);
}
console.log(`[build:web] 核心模块已发布到 public/vendor/core（${manifest.modules.length} 个模块，${manifest.builtAt}）`);
