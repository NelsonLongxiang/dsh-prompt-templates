# @nelsonlongxiang/dsh-prompt-templates

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/@nelsonlongxiang/dsh-prompt-templates?label=npm)](https://www.npmjs.com/package/@nelsonlongxiang/dsh-prompt-templates)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 快捷提示词模板：全局与会话级模板、右侧浏览器面板、纯 TS 的 `node:sqlite` 持久化——一个自包含插件，`dsh plugin` 即装。

![模板面板](images/image-01.png)

## 安装

```sh
dsh plugin --profile web add @nelsonlongxiang/dsh-prompt-templates
```

重启 `dsh web`，在输入框工具行找到模板按钮。

无需 Python 工具链——0.3.0 起 host 面直接通过 `node:sqlite`（Node ≥ 24）在宿主进程内持久化，读写原来 Python 子进程持有的同一个 `$DSH_HOME/ext/prompt-templates/db.sqlite3`（数据零迁移）。

## 你能得到什么

- **全局 + 会话模板**——全局处处生效；会话模板只属于当前对话，一键提升为全局
- **插入或直发**——一键追加进草稿；send-now 立即发送；编辑、删除、转全局都在行内
- **搜索与滚动**——边输入边过滤，长列表滚动可靠
- **拖拽定位、双击复位**——面板记住你放的位置
- **设计即持久**——模板经纯 TS 存储（`node:sqlite`）落 SQLite，由 host 插件持有并随其生命周期关闭

## 工作原理

```text
src/                  TypeScript 插件（host 面 + 浏览器面）
  index.ts            Host：持有 TS 存储，暴露 HTTP 路由
  store.ts            纯 TS 模板存储（node:sqlite）
  client/             浏览器：面板 UI 注册进 shell.overlay 与
                      conversation.input.right
cordis.patch.yml      Bundle patch：挂插件行
```

存储是 host 面内的纯 TS 实现；不拉起任何子进程。

## 安全

- 模板内容只有经用户主动插入才作为普通用户文本进入模型请求——绝不自动注入任何提示词
- 面板仅经 Host 的插件路由访问 host 存储；无额外监听、无外联网络

## 数据同步 CLI

包内提供确定性的本地 CLI，用于跨 DSH home 对比、合并提示词模板数据库；禁止直接远程写库。

```sh
# 导出 schema-v2 快照（确定性排序 + data_sha256）
dsh-prompt-templates export --db /path/to/db.sqlite3 --out snapshot.json --output=json

# 对比快照（加 --fail-on-diff 时发现差异返回 exit 1）
dsh-prompt-templates diff left.json right.json --output=json --fail-on-diff

# 只生成合并 JSON；同时间异内容或同名异 ID 默认阻断
dsh-prompt-templates merge base.json incoming.json --strategy newer --out merged.json --output=json

# 导入默认只 dry-run：先审核 summary_sha256 与数据库 hash
dsh-prompt-templates import --db /path/to/db.sqlite3 --in merged.json --output=json

# 显式 apply 才写；绑定两个已审核值，先备份，再执行单事务
dsh-prompt-templates import --db /path/to/db.sqlite3 --in merged.json --apply \
  --expect-db-sha256 <db-sha256> --confirm-summary-hash <dry-run-summary-sha256> --output=json
```

`import` 仅按模板 ID 插入/更新，绝不自动删除；未知字段、错误 schema、hash 漂移、同名异 ID，以及超过 `--max-changes`（默认 100）的变更均阻断。

## 开发

```sh
pnpm install
pnpm verify            # typecheck
pnpm build             # tsc host + tsc client + tsdown 浏览器 bundle
```

## 已知限制

- **插入感知光标**——点击模板会替换当前选区，或插入到光标位置
- **会话模板需要当前会话**——无会话打开时只能用全局模板

## 许可证

MIT
