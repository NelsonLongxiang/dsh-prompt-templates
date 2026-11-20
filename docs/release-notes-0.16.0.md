# v0.16.0（2026-11-20）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **事件提醒加一句交接话**：两类事件提醒（重复准备、重复失败）的正文末尾都加了一句：「按提醒查过仍解不开的，按所在环境的上报方式交出去，写清已查处、缺的那一句背景。」这句不写任何 a2a 工具名，插件不绑定 a2a。
- **「提醒后仍在重复」持久计数**：问题台账里每个问题新增一个计数，记录提醒之后同一模式又出现了几次。原来的 `signal: repeated` 会在下一次提醒时清空，这个计数不清空，面板显示为「提醒后仍在重复 ×N」。
- **介入记录（观察者第 1 期，只读、只记录）**：模板内容每次进入会话，都在插件自己的库里留一条记录，宿主重启后仍在。来源有四种：
  - 按轮次；
  - 按事件；
  - 人在面板上手动发（插入、发送、插话三种都记）；
  - 别的插件发起（留给第 2 期）。

  每条只记模板的标识、版本、所发文字的 sha256、会话、轮、步和时间，**不记会话正文，也不记模板正文**。
- **卡库与版本**：模板带生效版本号。agent-atelier 5.16.1 的七张卡打成了版本包 `packs/atelier-5.16.1.json`：
  - 导入只把它存成卡库里的**新版本**，和旧版并存；
  - **不切换任何宿主正在用的版本**，节律上注入的照旧；
  - 切换版本留到第 3 期，由属主经决策卡同意。

  导入步骤见 `docs/library-packs.md`。
- **只读读取面**：
  - `GET /plugins/dsh-prompt-templates/library` 列卡库，`?session_id=` 只列这个会话自己的模板；
  - `GET /plugins/dsh-prompt-templates/interventions` 按会话、按时间列介入记录。

  两者都只带摘要，不带正文。

### 已知限制

- 第 1 期的 `plugin` 来源白名单（只认 `@nelsonlongxiang/dsh-open-a2a-net`），比对的是调用方**自报**的字符串。第 2 期的投卡服务上线时，调用方必须由宿主按插件身份给出，不能再信自报。
- 面板手动发的记录没有轮和步，因为面板看不到 agent 当时走到哪一步。

### 面向贡献者

- **schema v7→v9**：
  - v8 新增 `event_episodes.repeated_after_reminder`；
  - v9 新增 `templates.version`（生效版本指针）、`template_versions`（卡库里存的各版本）和 `interventions`（介入记录，含为第 2 期预留的 `caller` 字段）。

  每一步迁移都会先检查列或表是否已存在，部分迁移过的库也能升上去。CLI 的 `SUPPORTED_DB_VERSIONS` 扩为 [4..9]。
- 新路由：
  - `GET /library[?session_id=]`
  - `POST /library/import`：默认只预演，`apply: true` 才写入，写入也只存版本、不切换
  - `GET /interventions`
  - `POST /interventions/manual`：面板登记手动发送
- 198 项测试全绿，包括：
  - 四种来源各一条真实记录；
  - 重启后记录仍在；
  - 记录里没有正文；
  - 导入并 apply 之后，节律注入的仍是旧版正文的 sha256。

## English

### For users

- **Hand-off line on event reminders**: both reminder kinds now end with one host-neutral line telling the agent what to do when checking does not resolve it: hand it off through the environment's own reporting path, stating what was checked and the one missing piece of background. It names no a2a tool; the plugin stays unbound from a2a.
- **Durable "repeated after reminder" count**: each problem in the ledger counts how many times the pattern came back after a reminder. Unlike `signal: repeated`, which the next reminder clears, it is never reset. The panel shows it as 「提醒后仍在重复 ×N」.
- **Intervention log (observer phase 1: read-only, record-only)**: each time template text goes into a session, the plugin's own database keeps a row, and the rows survive a host restart. There are four sources:
  - the turn schedule;
  - event reminders;
  - a person on the panel (insert, send and interject are all recorded);
  - another plugin (reserved for phase 2).

  A row holds the template's id, its version, a sha256 of the text sent, the session, the turn/step and the time. **It never holds the session's text, and never the template's text.**
- **Library and versions**: templates carry an active-version pointer. agent-atelier 5.16.1's seven cards ship as the pack `packs/atelier-5.16.1.json`.
  - Importing it stores each card as a **new version** beside the old one.
  - It **never switches the version a host is using**, so the schedule keeps injecting the same text.
  - Switching versions belongs to phase 3, on an owner decision card.

  See `docs/library-packs.md`.
- **Read-only faces**:
  - `GET /plugins/dsh-prompt-templates/library` lists the library; `?session_id=` narrows it to that session's own templates.
  - `GET /plugins/dsh-prompt-templates/interventions` reads the log by session and by time.

  Both carry digests only, never text.

### Known limits

- Phase 1's allowlist for the `plugin` source (only `@nelsonlongxiang/dsh-open-a2a-net`) compares a caller string the caller reports about itself. Phase 2's card service must take the caller from the host's plugin identity instead.
- Rows for the panel's manual sends have no turn or step: the panel cannot see the agent's step.

### For contributors

- **Schema v7→v9**:
  - v8 adds `event_episodes.repeated_after_reminder`.
  - v9 adds `templates.version` (the active-version pointer), `template_versions` (stored library versions) and `interventions` (with a `caller` field reserved for phase 2).

  Each migration step checks that a column or table is missing before adding it, so a partially migrated database upgrades too. The CLI's `SUPPORTED_DB_VERSIONS` now covers [4..9].
- New routes:
  - `GET /library[?session_id=]`
  - `POST /library/import`: a dry run unless `apply: true`, and even then it only stores versions, never switches them
  - `GET /interventions`
  - `POST /interventions/manual`: the panel's record of a manual send
- 198 tests green, including:
  - one real record per source;
  - rows surviving a restart;
  - no text in the log;
  - after import + apply, the scheduled injection still sends the old text's sha256.
