# 卡库版本包（library pack）

0.16 起（schema v9），模板带版本号 `version`。版本包是一份带版本的卡库文件，把某个来源（例如 agent-atelier 的七张卡）的现行文字打成一个可导入的版本。

## 格式

```json
{ "format": "dsh-prompt-templates-library", "version": "atelier-5.16.1",
  "source": { "package": "agent-atelier", "version": "5.16.1", "commit": "<sha>", "path": "assets/injection-templates.json" },
  "templates": [ { "id": "…", "name": "…", "content": "…", "description": "…", "position": 0, "inject_every": 26, "mode": "visible" } ] }
```

每张卡也可以带自己的 `version`；不带的用包的 `version`。

## 导入只换正文和版本

- 先按 `id` 找卡；找不到时，再找同名的全局卡。
- 找到的卡只替换 `content` 和 `version`。这台宿主上原有的开关、间隔、模式、名称、分类和排序都不动。
- 找不到的卡新建成全局卡，开关关闭，间隔和模式取包里的值。开不开由人决定。
- 正文和版本都没变的卡不写，记为 `unchanged`。
- 人后来改了正文（没有同时指定版本）的卡，版本会被清空，表示它已经不是包里的那个版本。

## 导入步骤

1. 在要导入的宿主上，确认插件是 0.16 或更高：`GET /plugins/dsh-prompt-templates/library` 返回 `schema` ≥ 9。
2. 预演，不写入：

   ```bash
   jq -n --slurpfile p packs/atelier-5.16.1.json '{pack: $p[0]}' | curl -s -X POST http://127.0.0.1:<端口>/plugins/dsh-prompt-templates/library/import -H 'content-type: application/json' -d @-
   ```

   看返回的 `plan`：`updates`（每张写明原版本和新版本）、`inserts`、`unchanged`。
3. 确认无误后正式导入：同一条命令，把 `{pack: $p[0]}` 改成 `{pack: $p[0], apply: true}`。返回 `plan.applied: true`。
4. 用 `GET /plugins/dsh-prompt-templates/library` 读回：每张卡的 `version` 是新版本，`inject_enabled` 和 `inject_every` 与导入前一致。

## 读取面（只读）

- `GET /plugins/dsh-prompt-templates/library`：卡库，返回名称、版本、范围、开关、间隔、模式和正文摘要（`content_sha256`），不含正文。
- `GET /plugins/dsh-prompt-templates/interventions?session_id=&since=&source=&limit=`：介入记录，按时间从旧到新。
  - `source` 取 `schedule`（按轮次）、`event`（按事件）、`manual`（人在面板上手动发，`method` 分 `insert`、`send`、`interject`）、`plugin`（别的插件发起，留给第 2 期）。
  - 每条只记模板的标识、版本、所发文字的 sha256、会话、轮、步和时间，不记会话里的其他内容。
  - 手动发的记录没有轮和步，因为面板看不到 agent 当时走到哪一步。
