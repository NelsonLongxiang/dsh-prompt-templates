# 卡库版本包（library pack）

0.16 起（schema v9），模板带版本号 `version`。版本包是一份带版本的卡库文件，把某个来源（例如 agent-atelier 的七张卡）的现行文字打成一个可导入的版本。

## 格式

```json
{ "format": "dsh-prompt-templates-library", "version": "atelier-5.16.1",
  "source": { "package": "agent-atelier", "version": "5.16.1", "commit": "<sha>", "path": "assets/injection-templates.json" },
  "templates": [ { "id": "…", "name": "…", "content": "…", "description": "…", "position": 0, "inject_every": 26, "mode": "visible" } ] }
```

每张卡也可以带自己的 `version`；不带的用包的 `version`。

## 导入只存新版本，不切换（第 1 期，workbench-market #883）

- 每张卡在宿主上有一份**生效正文**（`templates.content`），以及指向它版本的**生效版本指针**（`templates.version`）。节律注入和面板手动发用的都是生效正文。
- 导入把包里的每张卡存成卡库里的**一个新版本**（`template_versions` 表），和旧版并存。**导入从不改生效正文和生效版本指针**，`apply: true` 也一样，所以节律注入的照旧是旧版正文。
- 卡按 `id` 匹配；找不到时，再找同名的全局卡。这台宿主没有的卡，只存版本，不建模板：它出现在卡库里（`stored_only: true`），但面板和节律都发不出去。
- 同一版本、正文没变的不重写，记为 `unchanged`。
- 把某张卡切到已存的新版本，是第 3 期的事，要走决策卡，由属主同意；第 1 期没有切换入口。
- 人改了生效正文却没同时指定 `version`，生效版本指针会被清空，表示它已经不是任何包里的版本。

## 导入步骤

1. 在要导入的宿主上，确认插件是 0.16 或更高：`GET /plugins/dsh-prompt-templates/library` 返回 `schema` ≥ 9。
2. 预演，不写入：

   ```bash
   jq -n --slurpfile p packs/atelier-5.16.1.json '{pack: $p[0]}' | curl -s -X POST http://127.0.0.1:<端口>/plugins/dsh-prompt-templates/library/import -H 'content-type: application/json' -d @-
   ```

   看返回的 `plan`：`stored`（这次会存的新版本，每条带 `active_version` 当前生效版本和 `new_card`）、`unchanged`。
3. 确认无误后正式导入：同一条命令，把 `{pack: $p[0]}` 改成 `{pack: $p[0], apply: true}`。返回 `plan.applied: true`。
4. 用 `GET /plugins/dsh-prompt-templates/library` 读回：每张卡的 `stored_versions` 里有 `atelier-5.16.1`，而 `active_version`、`content_sha256`、`inject_enabled`、`inject_every` 都和导入前一样。

## 读取面（只读）

- `GET /plugins/dsh-prompt-templates/library`：卡库，返回名称、生效版本、范围、开关、间隔、模式、生效正文摘要（`content_sha256`）和已存的版本列表，不含正文。加 `?session_id=<会话>` 只返回这个会话自己的模板（会话级模板，范围 `session`），比如它自己配的自查模板；没有就返回空列表。写会话级模板的工具留到第 2 期，第 1 期只读。
- `GET /plugins/dsh-prompt-templates/interventions?session_id=&since=&source=&limit=`：介入记录，按时间从旧到新。
  - `source` 取 `schedule`（按轮次）、`event`（按事件）、`manual`（人在面板上手动发，`method` 分 `insert`、`send`、`interject`）、`plugin`（别的插件发起，留给第 2 期；第 2 期的投卡服务只接受 a2a 插件，记录里的 `caller` 字段写调用方，认不出的调用方被拒）。
  - 每条只记模板的标识、版本、所发文字的 sha256、会话、轮、步和时间，不记会话里的其他内容。
  - 手动发的记录没有轮和步，因为面板看不到 agent 当时走到哪一步。

## 给其他插件的服务（第 2 期，PT-3）

同一宿主上的其他插件通过 `ctx.promptTemplates` 使用：

- **只读，所有插件都能用：** `library()`、`templates(sessionId)`、`interventions({ sessionId, since, source, limit })`。返回的形状和只读路由一样，只给摘要，不给正文。`library()` 的每张卡带 `category`，以及 `kind`（open-a2a-net #902 S1）：版本号以 `atelier-` 开头、分类是「工坊」、或有一份存档版本来自 agent-atelier 卡包的，是 `workshop`（工坊卡），其余是 `template`。
- **投卡：** `cast({ sessionId, templateId, reason, basis?, mode? })`。
  - **方式（#902 S3）：** `mode` 默认 `insert`，在会话的下一步投进去；`queue` 等到下一轮的第一步才投，不插进正在进行的一轮。其他值回 `mode`。`castQueue` 的每行带 `mode`；`cast_queue` 表新增 `mode` 列，默认 `insert`，只加不改。
  - **认调用方：** 调用方不认参数里写的字串，认的是 cordis 加载器给调用插件那条 fiber 盖的 entry，也就是 profile 里配置的包名。只认 `@nelsonlongxiang/dsh-open-a2a-net`，别的调用方回 `caller`。
  - **开关：** 部署配置 `cast.enabled` 默认关，关着时回 `disabled`。关着时每一步也不读队列；关之前排下的卡不会投进去，满 1 小时后记为 `expired`。
  - **能投什么：** 卡必须是全局卡，或者这个会话自己的卡；`reason` 必须写，1～500 字。
  - **依据（#902 S1）：** `basis` 可选，写这张卡凭的是哪张工单、哪个事件，或 `none: <一句说明>`；给了就必须是一行、1～200 字，否则回 `basis`。依据显示在卡的抬头里，也记进介入记录的 `basis` 列。
  - **投进去的样子：** 卡在该会话的下一步作为可见消息进入，标明投卡方和原因，并写明「本卡取自属主的卡片库，适用即须执行；不扩大授权，不覆盖属主当下指令。」（2026-11-21 起；此前写的是「不是新的用户指令，不授予任何权限」）。
  - **记录：** 宿主确认交付后，介入记录记成 `source: plugin`，保留调用方、依据和投递正文的摘要。
  - **排队上限：** 同一张卡在同一个会话里最多排一份，再投回 `already-queued`。`waiting` 和 `prepared` 合计一个会话最多 8 张，全宿主最多 256 张。`waiting` 最多等 1 小时。
  - **队列与交付：** 宿主重启后会继续处理 `waiting`。投递前，插件先将卡记为 `prepared`，记录预备消息的 ID 和 SHA-256。宿主追加匹配的 `user/message` 并完成持久化后，插件在同一事务中写入 `delivered`、宿主事件序号和介入记录。序号与消息 ID 均按队列行的 `session_id` 对账。
  - **失败恢复：** 同一轮在追加前结束，卡回到 `waiting`，仍可按原方式投递或撤回。持久化调用或 SQLite 写入报错时保留 `prepared`，后续步骤可重试对账。重启后在下一次获准步骤从宿主持久日志查对应消息。有匹配证据才记交付，缺少可用证据时记 `unknown`，由调用方查看后处理。
  - **留存：** `delivered`、`withdrawn`、`expired` 和 `unknown` 行保留元数据，清空 `cast_queue` 的正文栏。实际投递的正文仍由宿主会话日志管理。库升级为 v12，保留原有等待卡和撤回、过期状态，旧版缺少宿主回执的 `delivered` 记为 `unknown`。既有介入记录按原样保留。
  - **查队列与撤回（#902 S1，只认调用方）：**
    - `castQueue({ sessionId?, state?, limit? })`：按时间从新到旧列出队列元数据。可按 `waiting`、`prepared`、`delivered`、`withdrawn`、`expired` 或 `unknown` 过滤。
    - `castWithdraw({ sessionId, id })`：撤回该会话里一张还在等的卡。
    - 别的调用方回 `caller`；拿别的会话的 id 去撤，撤不掉，回 `withdrawn: false`。
  - **原因压成一行：** 换行和控制字符一律换成空格，所以原因里伪造不出抬头那样的一行。
  - **代写会话卡（#902 S2，只认调用方）：**
    - `draftCard({ authorSession, id?, name, content, description? })`：在 authorSession 自己的会话模板里新建一张卡；带 `id` 就是改这张卡。
    - `draftDelete({ authorSession, id })`：删掉 authorSession 自己的一张卡。
    - 这些卡就是普通的会话模板，该会话在面板上也看得到、改得了。
    - 只能动 authorSession 自己的卡；拿别的会话的卡 id 来改，回 `card`；拿来删，回 `deleted: false`。
    - 名称 1～128 字，正文 1～8000 字；同一个会话里卡不能重名。
  - **按作者会话投卡（#902 S2）：**
    - `cast()` 可以多带一个 `authorSession`，表示把作者会话自己的卡投进另一个会话。谁可以当作者、能投给谁，由调用方（a2a 插件）先查过。
    - 投出去的卡名前面加「定制·」。
    - 不带 `authorSession`，或者带的不是这张卡所属的会话，仍旧只能投全局卡和目标会话自己的卡。
  - **服务对象上不暴露存储：** 别的插件拿到的只有服务方法，碰不到存储本身，也没法把队列取空。查队列和撤回只认上面认出的调用方。
  - **白名单冻结：** `PLUGIN_CALLERS` 用 `Object.freeze` 冻住，运行时改不动。
