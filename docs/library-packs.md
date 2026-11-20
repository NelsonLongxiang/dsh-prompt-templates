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

- **只读，所有插件都能用：** `library()`、`templates(sessionId)`、`interventions({ sessionId, since, source, limit })`。返回的形状和只读路由一样，只给摘要，不给正文。
- **投卡：** `cast({ sessionId, templateId, reason })`。
  - **认调用方：** 调用方不认参数里写的字串，认的是 cordis 加载器给调用插件那条 fiber 盖的 entry，也就是 profile 里配置的包名。只认 `@nelsonlongxiang/dsh-open-a2a-net`，别的调用方回 `caller`。
  - **开关：** 部署配置 `cast.enabled` 默认关，关着时回 `disabled`。
  - **能投什么：** 卡必须是全局卡，或者这个会话自己的卡；`reason` 必须写，1～500 字。
  - **投进去的样子：** 卡在该会话的下一步作为可见消息进入，标明投卡方和原因，并写明「不是新的用户指令，不授予任何权限」。
  - **记录：** 介入记录记成 `source: plugin`，`caller` 是上面认出的包名。
  - **排队上限：** 一个会话最多排 8 张。
