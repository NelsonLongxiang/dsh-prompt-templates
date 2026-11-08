# v0.13.2（2026-11-08）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **模板变量**：模板内容支持 `{{date}}` `{{time}}` `{{datetime}}` `{{weekday}}` `{{session}}` `{{turn}}`，在投递时展开——插入、直接发送、插话打断、定时注入四条路全部生效。值不可得的变量保留原文字面（如插入路径的 `{{turn}}`），未知变量名原样保留，存储始终保存原始文本。模板编辑表单内有变量提示行。
- **⟳N 徽标可点击**：点开工具栏 ⟳N 徽标，查看本会话最近 20 次定时注入（轮次 / 时间 / 模板名 / 注入正文），新到先出；历史按需拉取，不加重 30 秒轮询。
- **HTTP 语义修复**：畸形 JSON 请求体应答 `400 bad-request`（原为 `500 store-error`）。

### 面向贡献者 / 维护者

- **DSH 0.2.x 契约测试护栏**进入日常 verify 门禁：peer 版本线、cordis patch 沙箱表达式、store 真执行、slot 声明、图标运行时导出全部钉死，上游漂移当场爆红。
- **pnpm 10 / 11 双兼容**：store 的 packageExtensions 迁至 pnpm-workspace.yaml（package.json 的 pnpm 字段自 pnpm 11 起被忽略）。
- **运维稳定入口** `scripts/`：remote-heads（分支 ≤10 预算）、branch-audit（①吸收/③独有分类）、push-master（隐私四层排查 → 推送 → 终态计数）。
- **gitee 镜像冻结**：github（NelsonLongXiang/dsh-prompt-templates）为唯一维护远端。
- **公开交接文档** docs/HANDOVER.md（脱敏版）入库。

### 升级注意

- 无存储 schema 变更（仍为 v4）；无破坏性 API 变更；400 替代 500 属错误语义修正。

## English

### For users

- **Template variables**: content supports `{{date}}` `{{time}}` `{{datetime}}` `{{weekday}}` `{{session}}` `{{turn}}`, expanded at delivery — insert, send-now, interject, and scheduled injection all expand. Unavailable values stay literal (e.g. `{{turn}}` outside scheduled injection), unknown names pass through, and storage always keeps the raw text. The template form shows a variable hint line.
- **Clickable ⟳N badge**: open the badge dropdown to see the session's last 20 scheduled injections (turn / time / template names / injected bodies), newest first; history is fetched on demand and never weights the 30s badge poll.
- **HTTP semantics fix**: malformed JSON request bodies now answer `400 bad-request` (previously `500 store-error`).

### For contributors / maintainers

- **DSH 0.2.x contract tests** joined the everyday verify gate: peer version line, the cordis patch sandbox expression, real `defineStore` execution, slot declarations, and runtime icon exports are all pinned — upstream drift fails the gate immediately.
- **pnpm 10 / 11 compatibility**: the store packageExtension moved to pnpm-workspace.yaml (pnpm 11 ignores the package.json pnpm field).
- **Ops stable entries** under `scripts/`: remote-heads (branch ≤10 budget), branch-audit (absorbed/unique classification), push-master (privacy four-layer check → push → final counts).
- **gitee mirror frozen**: github is the single maintained remote.
- **Public handover guide** docs/HANDOVER.md (sanitized) is in the tree.

### Upgrade notes

- No storage schema change (still v4); no breaking API change; 400 replacing 500 is an error-semantics fix.
