# v0.26.1

> 0.26.0 未发布；0.26.1 接续其全部准备内容，并纳入已合并的发布守卫适配（PR #104）。本文件仍是发布准备，不代表已经上传 registry、创建标签或升级节点。 / 0.26.0 was not published. 0.26.1 carries all its prepared changes plus the merged release-guard adaptation (PR #104). These notes do not prove registry publication, tags or node installation.

## 中文

- **版本接续与合并材料发布守卫**（PR #104，master `aa3e5f7b2fc3b54a84e6655cb4fa614750bc73d5`）：0.26.0 未发布，改以 0.26.1 准备发布。新增显式 `--merged-prepared identity.json` 模式，钉完整仓库/PR、版本、合并头/树、有序双父与单提交准备分支；只允许版本号变更和新增本版说明，文件模式为 100644。正式 GitHub API 与全部漂移/标签/净树门仍需通过，不凭 merge 标题或旧发布票跳过门禁。

- **属主选择的系统提示词**（#96 S1，PR #99）：非体会模板逐条加入系统提示词，全局变更有二次确认；体会按批准类型、带做对/做错标签的正文版本选取，每类做对严格多于做错。总开关默认关闭，体会深度默认 0，预算 4000（UTF-16），位置 9000；升级不会自动打开任何模板。
- **只读系统贡献预览**（#96 S2，PR #101）：显示当前配置下本插件下一步贡献、字数/预算及各类体会选择原因。不是完整宿主提示词、历史发送记录或模型实际采用证明；读取不开开关、不调模型、不写模板。
- **模板库操作修复**（#97 / PR #98；PR #99 的分类反馈）：每会话的分类选择持久化并跨界面同步；新建会话分类可见、可取消；新增模板继承当前分类，手动改作用域时清理不兼容分类。
- **收尾自查固定部分 selfcheck-fixed-4**（PR #94）：补充目标、可核验证据对象和技能/文档维护提示。等待修复不改变底线条文。
- **登记等待后的插件侧重复自查抑制**（Refs #100，PR #102，合并提交 `0b9ffccbc9c58f940bbeb5b3db34458466bc11b5`）：自查/体会工具结果不再喂下一次自查；复合调用按真实同会话子调用归类，不扫描模型程序猜测。等待状态持久化并记录首次抑制；直接人类、A2A、定时输入、带时区期限到后的下一停轮或实际业务动作恢复检查。未知程序保守当业务动作；自然语言期限不猜时区，不创建定时任务。

### 范围与证据

- **#100 保持开放**：本版只停止插件侧的重复自查，不会让宿主自动目标驱动停止整轮续轮；宿主正式 continuation wait gate 仍待支持。不调用 pause/resume/disarm 绕过目标的人类授权门，不改目标 phase/revision/activation。
- #102 非作者 PASS 绑定完整头 `84a92a9478e3c8c98fcf17dbe6a86b746bd3de49`、基线 `3ba6b11c2fab620b9dc204022627c11e2766a632`、树 `d5b930c3fb141cd93e26636c874ee24eaf14d8eb`，合并树相同。非作者独立真实 ToolRuntime 1/1、#100 定向 5/5，四项断言变异检出；其完整 verify 报告 384 通过、0 跳过。本席同头完整门禁 344 通过、1 跳过、0 失败，五项变异检出；两份运行结果分开记录，不混为一次。
- #96 独立核心/增量复验及合并树已核，隔离宿主实际系统消息包含逐字预览；未测真实付费模型缓存收益、生产安装或升级。#83 的组织绑定验收未包含在本版已通过范围。
- SQLite 增量迁移到 schema 12，增加模板 system_prompt 默认 0；等待寄存表是幂等附加表。升级前须按正式运维流程备份数据库及 WAL/SHM，不能只回退版本号后假称兼容。
- 此材料不触发发布、标签、节点升级、3080 变更或真实组织操作。发布席应基于最终精确发布树重新核身份、门禁与包完整性。

## English

- **Version succession and explicit merged-prepared release guard** (PR #104, master `aa3e5f7b2fc3b54a84e6655cb4fa614750bc73d5`): 0.26.0 was not published; 0.26.1 supersedes that preparation. The opt-in `--merged-prepared identity.json` mode pins the repository/PR, version, full merge/head/tree identities and ordered parents. The prepared branch must contain exactly one version-only plus new-notes commit with regular 100644 modes. GitHub API identity, clean-tree, drift and tag checks remain mandatory; a merge-looking title or an older release ticket is not a bypass.

- **Owner-selected system sections** (#96 S1 / PR #99): per-template opt-in, confirmation for global changes and tagged lesson versions with a strict right-over-wrong majority per approved class. Master OFF, depth 0, budget 4000 UTF-16 units and order 9000 remain the defaults. Upgrades do not enable templates.
- **Read-only next-step plugin contribution preview** (#96 S2 / PR #101): text, count/budget and per-class selection reasons. It is neither the full host prompt nor a historical request or proof of model adoption; reading does not invoke a model, enable switches or edit templates.
- **Library fixes** (#97 / PR #98 and category feedback in PR #99): persisted per-session selection across surfaces, visible/cancellable category creation and category-aware new-template defaults.
- **selfcheck-fixed-4** (PR #94) adds objective/evidence/upkeep checks. The waiting repair leaves the fixed standard unchanged.
- **Partial waiting repair, Refs #100 / PR #102** (merge `0b9ffccbc9c58f940bbeb5b3db34458466bc11b5`): maintenance results no longer feed another check; real nested execution identities classify composite calls. Registered waits suppress repeated plugin checks with one first-suppression record; external input, an explicit timezone-qualified deadline at the next stopping boundary or actual business work wakes them.

### Limits and validation

**Issue #100 stays OPEN.** Plugin-side suppression does not stop the host automatic goal driver. A formal host continuation wait gate is still required; this release does not change goal phase/revision/activation or bypass human authorization with pause/resume/disarm.

Independent acceptance is bound to head `84a92a9478e3c8c98fcf17dbe6a86b746bd3de49` and tree `d5b930c3fb141cd93e26636c874ee24eaf14d8eb`, identical after merge. The independent full verify reports 384 pass / 0 skip; the implementation session reports 344 pass / 1 skip / 0 fail on that head. These are separate environment runs, not one combined result. Real ToolRuntime and synthetic event tests have explicitly different coverage.

Paid-provider cache benefits, production installation/upgrades, full live goal-driver waiting, browser acceptance for the waiting repair and #83 organizational binding are not claimed. Back up database/WAL/SHM through the deployment procedure before schema migration. Publication, tags and node upgrades are separate operations by the release/deployment seats.
