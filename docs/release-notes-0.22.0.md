# v0.22.0（2026-11-22）

> 发布说明中英双语；本文同文进入 GitHub Release。草稿：发版时与 package.json 版本号一起放进发版提交（release-guard 要求发版提交恰好包含这两个文件）。

## 中文

本版把体会改成「直接告诉模型、让它自己用」（规格 §5.16，属主 2026-11-22 定），并在对话里加了一条常挂的体会飘带。同时带上外部结论和版本自报。

- **开工、恢复、压缩后把本会话的体会一次交给模型（#67）**：
  - 下一步发一条「【工坊·体会｜本会话】」，列出本会话全部体会（属主钉过的排最前，然后按收放找落验记续和已批准的自定类型），不超过 1600 字，超出的注明条数、让模型用 `lesson_timeline` 查。
  - 消息末尾说明怎么用：走到链路哪一环就看那一类；做完一件事回头看一眼，哪里做对、哪里做错，值得记就记。
  - 清空上下文时不发。日志记为 `delivered`。
- **不再按情境唤起，不开唤起轮，撤掉 `lesson_pin`**：
  - 同类调用只在后台计入「再犯」，不再注入体会，也不再记「未闭合」。工坊卡的卡片轮次不变。
  - `lesson_pin`（上一版草稿里的会话自管常驻）在发版前撤回，没有发布过。属主在面板上钉的旧数据照样排最前。
  - `lesson_keep` 随时可用：对本会话任何一条体会带证据保持，不再要求有唤起轮。
- **做错和做对都记（#67）**：`lesson_write` 加可选参数 `outcome`（`wrong` 或 `right`），不填就不标，旧数据不补标。消化提示改为两面都问：「这件事做对了什么、错在哪」，并要求写成「当……时，先……，因为……」。
- **面板「会话模板」里体会单独成行（#67）**：体会排在前面，整句显示，带「类型 · 做错／做对」标签和一行效果（保持几次、最近证据、改写几次、交给模型后同类有没有再出错、空转），按钮只留编辑、删除、⚖。普通会话模板保留插入、发送、编辑、删除，其余收进「⋯」。📌 撤掉，⚖ 每条体会都有。「体会」分类 tab 不变。
- **对话里的体会飘带（#67）**：
  - 飘带是对话头部的一部分，排在 tab 行正下方，和头部紧贴，对话区随之下移、不被盖住（#70、#71）。做错、做对两条左右并排，各自轮流展示本会话的体会：每条 6 秒，往上翻走、下一条马上翻上来；鼠标停住就不换；一行放不下的正文和小签横向滚动，滚完一遍才换下一条（#72）。
  - 做错是黄黑警戒带，做对是蓝色授带，没标的是灰带；带下垂一张小签，写最近一次的证据。
  - 新写、改写或保持的那条立刻插到最前，停 10 秒。
  - 可以收成 6 像素的细色带，每个会话在这台浏览器上记住收没收。系统开了「减少动态效果」时静止。
  - 头部右侧多一个小结，显示做错几条、做对几条，点开就是面板。
  - 只在宿主给插件的两个位置**追加**（`shell.overlay` 与 `conversation.session.header.utilities`），不改宿主原有的行和按钮。
  - 一定画得出来（#68、#69）：量不到头部时退到小结所在那一行，再不行贴在视口顶部；小结没挂上时飘带按输入框所在会话自己取体会；飘带挂在页面最外层，不被浮层容器裁掉。根节点的 `data-lesson-ribbon-anchor`（dock 表示已并进头部；header、knot、viewport 表示退回浮层时用的位置）说明用的是哪种位置。
- **外部结论（#63）**：属主可以给任何一条体会记外部结论（链接或编号，通过或不通过，`POST /lessons/:id/verdict`），**只记录**；不再要求这条体会被唤起过。入口在「体会」分类 tab 的 ☑，会话模板行上不放。
- **宿主实际加载的版本（#64）**：`GET /plugins/dsh-prompt-templates/version` 返回服务端版本、schema、加载时间与功能开关；面板页脚在版本不一致时显示「服务端 vX」。
- schema 仍为 **v11**：新增的 `lesson_outcomes` 表在打开时按需创建，不升版本；`delivered`、`round-verdict` 是 `lesson_log` 的新行类型。

### 已知限制

- 真实宿主**压缩后 `agent/created`（`source: compact`）**仍 NOT_RUN：不发这个事件，压缩后就不会交付体会。
- 首次真机测试（master `c0d9747`）飘带没有渲染（#68），#69 补了三处退路；修复后在 master `2e55c2b` 上真机复查通过：飘带渲染、轮换、收起按钮都在，控制台无报错（#68）。复查时发现飘带盖住了「对话｜轨迹」tab，#70 改成让开 tab；属主看过后要求飘带并进头部、做错做对并排，#71 已改，#71 在 `9f3cf68` 上真机复测通过（tab 完整可点、飘带紧贴 tab 行下方、三条并排、控制台无报错，#68）；#72（`5c26ef9`）加了长文字横向滚动，三项在 `5c26ef9` 上一起真机复测通过（并进头部、做错做对并排、107 字长体会命中滚动样式且减少动态时关闭，控制台无报错，#68；测试计划 L03）。
- 外部结论要属主手动记。`/version` 只报本插件自己的版本。

### 面向贡献者

- 模型工具 7 个（撤 `lesson_pin`）；`lesson_write` 加可选 `outcome`；`GET /lessons` 每条增 `outcome`、`latest_evidence`、`verdicts`；新路由 `GET /version`、`POST /lessons/:id/verdict`。
- 新客户端文件：`src/client/ribbon.ts`（飘带逻辑）、`ribbon-dock.ts`（并进头部）、`LessonRibbon.tsx`、`LessonKnot.tsx`、`Ribbon.module.css`。
- **292 项测试全绿（0.21.0 为 279）**：外部结论与版本路由 +6；§5.16 删去唤起轮次与 `lesson_pin` 的测试，加交付、上限、outcome、不再唤起、保持、飘带逻辑测试；#69 加飘带退路的 2 项；#70 加让开 tab 的 2 项；#71 加并进头部与并排的 3 项；#72 加滚动的 1 项。

## English

### For users

This release changes lessons to "tell the model, let it use them" (spec §5.16, owner decision 2026-11-22) and adds an always-on lesson ribbon in the conversation. It also carries external verdicts and the server version report.

- **The session's lessons are handed over at start, resume and compaction (#67)**:
  - The next step carries one "【工坊·体会｜本会话】" message with all of the session's lessons (owner-pinned first, then 收放找落验记续 and approved custom types), at most 1600 characters; the rest are counted and left to `lesson_timeline`.
  - It ends with how to use them: look at the type for the link you are at; after each piece of work, look back at what went right and what went wrong, and write it down when it is worth it.
  - `clear` sends nothing. Logged as `delivered`.
- **No situational recall, no recall rounds, `lesson_pin` withdrawn**:
  - Matching calls only count toward recurrence in the background; nothing is injected and nothing is marked missed. Workshop-card rounds are unchanged.
  - `lesson_pin` (session-managed pinning in the previous draft) is withdrawn before release; it was never published. Lessons the owner pinned on the panel still come first.
  - `lesson_keep` works at any time on any of the session's lessons, with evidence; no recall round needed.
- **Record what went right too (#67)**: `lesson_write` takes an optional `outcome` (`wrong` or `right`); untagged stays untagged, old data is not back-filled. The digest prompt asks about both sides and asks for "when …, first …, because …".
- **Lesson rows in the 会话模板 tab (#67)**: lessons first, full text, a "type · wrong/right" label and one effect line (kept, latest evidence, rewrites, same situation after hand-over, churn), with only edit, delete and ⚖. Plain session templates keep insert, send, edit and delete; the rest sit behind "⋯". 📌 is gone; ⚖ shows on every lesson. The 体会 category tab is unchanged.
- **Lesson ribbon in the conversation (#67)**:
  - The ribbon is part of the conversation header, right under the tab row; the header grows and the conversation moves down, nothing is covered (#70, #71). Wrong and right hang side by side, each rolling through its own lessons, 6 s each; hovering holds it; text that does not fit scrolls sideways and the lane waits for one full pass (#72).
  - Wrong is hazard tape, right a blue sash, untagged grey; a tab below shows the latest evidence.
  - A lesson just written, rewritten or kept jumps the queue for 10 s.
  - Collapsible to a 6 px band, remembered per session in this browser; still under reduced motion.
  - A knot on the right of the header counts wrong and right and opens the panel.
  - Both are **additions** to the host's plugin slots (`shell.overlay`, `conversation.session.header.utilities`); nothing of the host is replaced.
  - It always renders (#68, #69): without a header measurement it falls back to the knot's row, then the viewport top; without the knot it uses the composer's session and fetches the lessons itself; it is portalled to the page body so no overlay container can clip it. `data-lesson-ribbon-anchor` on its root tells which placement was used (dock when docked in the header; header, knot or viewport when it falls back to floating).
- **External verdicts (#63)**: the owner can record a verdict on any lesson (link or id, pass or fail, `POST /lessons/:id/verdict`). **Recorded only**; the lesson need not have been recalled. The ☑ entry stays in the 体会 category tab, not on 会话模板 rows.
- **The version the host actually loaded (#64)**: `GET /plugins/dsh-prompt-templates/version` reports the server version, schema, load time and feature switches; the panel footer shows "Server vX" on a mismatch.
- Schema stays **v11**: the new `lesson_outcomes` table is created on open without a version bump; `delivered` and `round-verdict` are new `lesson_log` row kinds.

### Known limits

- `agent/created` (`source: compact`) after compaction on a real host is still NOT_RUN; without it, nothing is handed over after compaction.
- On the first real-host test (master `c0d9747`) the ribbon did not render (#68); #69 adds three fallbacks. The real-host recheck on master `2e55c2b` passed: the ribbon renders, rotates, has its collapse button, and the console shows no errors (#68). The recheck also found the ribbon covering the 对话｜轨迹 view tabs; #70 moves it clear of the tabs; after the owner's look, #71 docks it in the header with wrong and right side by side, and #72 (`5c26ef9`) scrolls text that does not fit. #71 passed the real-host recheck on `9f3cf68` (tabs visible and clickable, ribbon flush under the tab row, three lanes side by side, no console errors, #68); all three were rechecked together on `5c26ef9` and passed (docked in the header, wrong and right side by side, a 107-character lesson picks up the scrolling style and reduced motion turns it off, no console errors, #68; test plan L03).
- External verdicts are entered by hand. `/version` reports this plugin's version only.

### For contributors

- Seven model tools (`lesson_pin` withdrawn); `lesson_write` gains optional `outcome`; `GET /lessons` items gain `outcome`, `latest_evidence` and `verdicts`; new routes `GET /version` and `POST /lessons/:id/verdict`.
- New client files: `src/client/ribbon.ts` (ribbon logic), `ribbon-dock.ts` (header dock), `LessonRibbon.tsx`, `LessonKnot.tsx`, `Ribbon.module.css`.
- **292 tests green (0.21.0 had 279)**: +6 for verdicts and the version route; §5.16 removed the recall-round and `lesson_pin` tests and added hand-over, cap, outcome, no-recall, keep and ribbon logic tests; #69 adds 2 for the ribbon fallbacks; #70 adds 2 for clearing the tabs; #71 adds 3 for the header dock and the side-by-side lanes; #72 adds 1 for scrolling.
