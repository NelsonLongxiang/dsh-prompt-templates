# v0.13.3（2026-11-09）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **跨实例分享**：单模板（行内 ⧉）或整类目（类目 tab ⧉）一键复制为自描述剪贴板载荷；目标实例工具栏「导入」粘贴即用。缺失类目自动补建；同名同域模板有显式覆盖确认（覆盖＝更新现有模板，拒绝＝跳过），完成提示新建/覆盖/跳过三计数。分享的是原始文本——模板变量在目标实例投递时重新展开。

### 面向贡献者

- 分享规划器为 client-safe 纯函数（`src/client/share.ts`，5 例单测）；UI 仅做 IO，零 host 路由改动。
- face 动词 `create` 类型补齐 `description` 字段（host 路由本就接受）。

## English

### For users

- **Cross-instance sharing**: copy one template or a whole category as a self-describing clipboard payload; paste-import on the target instance. Missing categories are created; same-name same-scope templates raise an explicit overwrite confirm (overwrite updates the existing row, declining skips); the result reports created/overwritten/skipped. The raw text is shared — template variables re-expand at delivery on the receiving instance.

### For contributors

- The import planner is a client-safe pure module (`src/client/share.ts`, 5 unit tests); the UI is IO-only, with zero host-route changes.
- The `create` face verb type now carries the `description` field (the host route always accepted it).
