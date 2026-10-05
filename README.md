# 深空滑翔器 · 离线姿态事件封存链复核页

返航后审查员用本页确认：浏览器在封存中断后**不会遗漏、重排或混入半写入批次**。
系统完全离线运行——页面、SHA-256、哈希链与 IndexedDB 持久化均在本机浏览器内完成，
宿主只提供静态资源与健康响应。

## 领域规则

- 批次 = 稳定 `batchId`（1–64 位字母数字及 `:_-`）+ **至多 24 条**事件。
- 事件序号为正整数且在批内**严格递增**；载荷为文本。
- 每条事件文本按**规范 UTF-8 字节**计算 SHA-256（`TextEncoder` + WebCrypto，
  与 `node:crypto` 交叉验证，含 NIST 已知答案 `sha256("abc")`）。
- 新段把**前段摘要**纳入自身 SHA-256 输入，形成不可变哈希链。
- 提交结果：
  - 同标识同内容重传 → 返回**原回执**（同 receiptId/摘要，链不增长）；
  - 同标识不同内容 → **冲突**，既有证据原封不动，拒绝写入并给出既有段摘要。

## 持久化协议（IndexedDB 三仓）

| 仓 | 键 | 内容 |
|---|---|---|
| `intents` | `batchId` | 准备意图：事件原文、期望段摘要、前驱、准备时基底 |
| `segments` | `digest` | 不可变段（内容定址，只追加） |
| `manifest` | `active` | 活动清单（唯一一行：链头 + 段摘要顺序） |

封存序列：**准备意图 → 不可变段 → 清单切换 → 清理意图**。
**只有清单指向、且摘要 / 前驱 / 序号连续校验通过的段才属于已封存记录。**

### 中断恢复扫描（每次打开页面执行）

| 残留状态 | 恢复动作 |
|---|---|
| 只有意图、段缺失（准备后中断） | `INTENT_DISCARDED`：未发布准备段不得进入链 |
| 意图结构残缺（半写入） | 废弃意图，不进入链 |
| 段已写、清单未切，且完整可接链尾 | `RECOVERED_PUBLISHED`：**按既定意图恢复为唯一结果** |
| 清单已切、意图残留 | `DEDUP_ALREADY_PUBLISHED`：已发布段**不重复追加**，删除冗余意图 |
| 段体损坏 / 摘要重算不符 | `CORRUPT_SEGMENT_QUARANTINED`：保留证据、隔离，不入链 |
| 完整段但无意图认领 | `ORPHAN_SEGMENT_QUARANTINED`：保留证据、不入链 |
| 前驱或序号不连续 | 链校验报告**首个阻断证据** |

扫描可重复执行且幂等；页面展示每段的**序号范围、前驱摘要、恢复动作和首个阻断证据**。

## 运行

```bash
# 直接运行（需要 Node >= 20）
npm ci
npm run build:web
HOST=0.0.0.0 PORT=8080 npm start          # 页面 http://localhost:8080，健康 /health

# Docker Compose（可配置宿主端口）
PORT=9090 docker compose up --build web

# 一次运行后退出的 verify 服务（退出码即结论）
npm run verify                             # 本机
docker compose run --build verify          # 容器内（自带 Chromium 与系统库）
```

`npm run verify` 依次执行并在任一环节失败时以非零退出：

1. **前端构建**——核心模块原样发布到 `public/vendor/core`，浏览器与规则测试共用同一份实现；
2. **规则测试**——133 项断言：UTF-8/SHA-256 已知答案、批次规则、哈希链防篡改、
   幂等回执、冲突保留、三类中断恢复、损坏/孤儿/半写入隔离、断裂链禁写、断点续写；
3. **HTTP 冒烟**——宿主在临时端口启动，校验 `/health`、`/healthz`、`/ready`、
   页面与模块资源、404；
4. **真实 Chromium 演练**——页面封存、重开持久化、三个故障注入点中断后重开恢复、
   损坏段与孤儿段隔离，共 30 项核验。

页面左下「故障注入点」可手工演练：选择中断点 → 封存一批 → 点「模拟返航：关闭并重开页面」。

## 目录

```
src/core/      encoding/validation/chain/vault —— 纯领域层（浏览器与 Node 共用）
public/        index.html / styles.css / app.mjs（复核页）
src/server.mjs 可配置端口的静态宿主与健康响应
src/verify/    rules.test.mjs（规则测试）、verify.mjs（一次退出的核验服务）
scripts/       前端构建
compose.yaml   web（页面+健康）与 verify（一次退出）两个服务
```
