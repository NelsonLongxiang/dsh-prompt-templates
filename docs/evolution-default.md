# Atelier 演化自评估：默认会话模板 v1

## 合同

本插件仅在已有 `agent/pre-step` 轮次注入通道补充提示词，不执行评估、训练模型、迁移目录、授权、安装、部署或 A2A 成员操作。Atelier 负责方法论；A2A Net 负责其角色/身份/规则约束；业务成果、反馈和价值决定是否演变，不是满 100 轮就升级。

- 方法论：[Agent Atelier](https://github.com/NelsonLongxiang/agent-atelier)，拟新增 `references/evolution-self-assessment.md`（跨仓变更需随对应 PR 验收，不能假定已发布）。
- 身份治理：[dsh-open-a2a-net](https://github.com/NelsonLongxiang/dsh-open-a2a-net)。提醒不能代替 `propose → owner 后续亲自确认 → apply`，也不扩大授权。
- 实现：`src/evolution-default.ts` / `src/store.ts` / `src/inject.ts`。

## 自动补充与优先级

默认 `evolutionAssessmentEnabled: true`。同时需 `injectEnabled: true`；任一关闭不自动补充。每个会话首次获准的非空 pre-step，事务内检查并补一份可见会话模板 `工坊·演化自评估`，默认每 100 **用户轮次**，非工具调用/模型 step/时间间隔。新会话第 1 轮登记，从第 100 轮注入；已有会话首次遇到第 200 轮只登记，从 300 轮开始，不补发历史检查。可改模板间隔，沿用绝对用户轮数取模，不改成登记后滚动 100 轮。

1. 存在同名全局或当前会话模板时，保留原文、启用状态、间隔，记一次“已有”登记，不再自动补。包括已关闭模板。
2. 新建模板后，编辑/改名/关闭/删除均保留；删除后的登记相当于 tombstone，重启、升级或再次开会话不复活。需恢复时由用户在面板手动创建。
3. 后增同名全局模板时，自动生成的会话模板停止注入，避免双份；全局开关和周期完全按用户配置执行。删除该全局模板后，原会话模板恢复其配置。并不自动合并/删除任何模板。
4. 任意其他名称不以模糊文本猜测同义。已有异名等价模板，请关闭自动功能或关闭生成项，自行取舍。
5. 自动项若被用户显式“设为全局”，沿用普通全局轮次规则；`evolutionAssessmentEnabled:false` 仍抑制该自动来源的模板。用户自己创建的模板不受此开关控制，需自身关闭或 `injectEnabled:false`。
6. `injectMaxEvery < 100` 时不创建，避免绕过已有部署上限。

## 持久性、升级与证据

schema v6 新增 `evolution_defaults(session_id, template_id, source, version, enrolled_turn, disposition)`，不记录任务内容、提示词历史或私密材料。`BEGIN IMMEDIATE` + 会话主键保证多连接补充幂等；模板创建与登记同事务。v1–v5 单事务迁移，原模板不改；CLI 兼容 v6，但模板导出不包含 enrollment/tombstone。

自动来源为 `agent-atelier/evolution-self-assessment@1`，写入登记及模板 description。升级只影响未登记的新会话，绝不自动覆盖已有模板。日志继续沿用 `prompt-template-schedule` 的模板 ID/名称/间隔与 turn；描述可被用户改写，SQLite 登记才是来源事实。注入日志不是评估完成证据，更不是迁移成功证据。

相同 turn 的耐久日志去重与进程内去重沿用原注入器。**未支持同一 DSH 会话由两个独立宿主并发执行**：本次并发保证针对 SQLite 模板补充，不声称跨宿主注入 exactly-once。技能不可用时提示词要求明确报告缺失，不自动安装或杜撰通过；这属于模型遵守的指令，并非宿主检测器。

## 停用与回滚

- 本版本功能回滚：设置 `evolutionAssessmentEnabled:false`，仅停本功能补充/自动来源注入；不删模板，不改事件提醒。全部定时注入关闭用 `injectEnabled:false`。
- 单会话关闭：面板关闭或删除生成模板，不会再补。
- 包降级至仅支持 v5 的版本前，需停止写入并使用升级前的一致 SQLite 备份恢复；不得仅改 `user_version` 或删除表冒充回滚。模板 JSON 不是完整运行态备份。回滚/部署均需单独授权，本 PR 不执行。
- 新宿主/全新数据库有独立登记。导出导入不复制删除意图；跨机迁移需明确关闭/授权策略，不能称 JSON 导入完整恢复。

## 验证边界

新增 store 测试覆盖两会话隔离、未来边界、编辑/关闭/删除后重启、同名全局/会话、晚到全局、v5迁移、4 worker 并发迁移与补充、来源版本、间隔上限。host wiring 测试覆盖空步骤不创建、100轮注入、同轮去重和关闭。

本地无 DSH/Cordis/TypeScript 依赖（typecheck: `tsc: not found`）：纯 store/CLI 31 tests PASS；host wiring、全量 verify、真实 DSH、技能加载、模型行为/真实迁移 NOT_RUN。不得把源码与单元测试当真实演化有效性证明。
