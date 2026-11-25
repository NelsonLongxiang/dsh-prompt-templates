# v0.24.0

> 中英双语发布说明。提示词插件独立发布；跨仓角色修复与实际部署状态另行跟踪。

## 中文

- **a2a 协作的收尾自查要登记决策卡**（#85，属主 2026-11-25）：会话手上有 a2a 单子时，收尾自查多带一行；`selfcheck_conclude` 新增 `card`（本轮提交的决策卡号或出站请求号）与 `no_card`（不提交的原因，一句话），二选一，两项都空即拒绝，被拒的结论不落库。`no_card` 上限 200 个字符（按码点计）。
- **无提卡工具时记为不适用**：仅当会话的实际工具作用域确认 `superagent_decision_propose`、`a2a_decision_propose`、`a2a_outbound_request` 三者都不可见，才登记为“工具不可用”且不作要求。读不到作用域、缺少工具服务或读取出错，一律按“有这些工具”处理，不凭角色名称豁免。
- **登记写入新增的 `self_check_cards` 表**：建表与索引均为幂等增量，未升 schema 版本；原有自查记录表不变。
- **固定七点未改**：决策卡那行放在固定要点之外，workbench-market 18 的固定七点原文未动。

### 范围与验证边界

- 发布门禁在干净环境对 PR #85 的合并提交 `ab0a2d0b` 执行 `pnpm verify` 通过（typecheck、321/321 测试、build、package 自检），并由非作者按原需求与反例完成一次复核。npm 私有与公网两端为同一制品（sha1 `85e237a1…`）。
- 本版只涉及收尾自查的登记要求。本包不修改 A2A 的角色白名单或预设，不代表任何预设已升级或历史卡片已闭合。
- 本版**不含** PR #86、#87、#88（投卡队列、代写作者会话卡、投卡方式）。这些已陆续合入 master 但尚未经作者以外评审；本版经属主裁定，由独立发布分支 `release/v0.24.0` 从 PR #85 的合并提交发布，不推 master、不包含它们。
- 本次发布未安装到任何宿主；真实宿主上的加载、卡片闭合与模型是否照做均未验证。

## English

- **The a2a collaboration wrap-up check asks for a decision card** (#85, owner 2026-11-25): when the session holds an a2a ticket, the wrap-up check carries one more line. `selfcheck_conclude` takes `card` (the id of the decision card or outbound request submitted this round) or `no_card` (one sentence why none). Exactly one is required: both empty is refused, and a refused conclusion is not logged. `no_card` is limited to 200 characters, counted as code points.
- **Recorded not applicable when no card tool exists**: only when the session's actual tool scope confirms that `superagent_decision_propose`, `a2a_decision_propose` and `a2a_outbound_request` are all unavailable is the round recorded as "tool unavailable" and not required. An unreadable scope, a missing tools service or a read fault all count as "has them"; no role name grants an exemption.
- **Registrations go to a new `self_check_cards` table**: the table and its index are additive and idempotent, with no schema version bump; the existing self-check log is unchanged.
- **The fixed points are unchanged**: the card line sits outside the fixed points, and workbench-market 18's seven fixed points read as before.

### Scope and validation limits

- The release gate passed `pnpm verify` in a clean environment on the PR #85 merge commit `ab0a2d0b` (typecheck, 321/321 tests, build, package self-check), followed by a non-author review against the original requirements and counterexamples. The private and public npm registries carry the same artifact (sha1 `85e237a1…`).
- This release only changes the wrap-up check's registration requirement. The package does not change A2A role allowlists or presets, and publishing it does not upgrade any preset or close historical rounds.
- This release does **not** include PR #86, #87 or #88 (the cast queue, author-session drafts and cast modes). They have since landed on master without a non-author review. By the owner's ruling this release is published from the PR #85 merge commit on the separate branch `release/v0.24.0`; master is not pushed and they are left out.
- This release is not installed on any host. Loading on a real host, card closure, and whether a model complies are all unverified.
