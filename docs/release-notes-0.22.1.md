# v0.22.1（2026-11-22）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

- **「减少动态效果」开着也滚动**：系统开了减少动态效果（prefers-reduced-motion）时，放不下的体会正文与证据小签**照样横向滚动**——文字完整性优先，横向滚动是信息获取手段而非装饰；悬停仍可停住（满足动效无障碍的可暂停要求）。带面摆动、展开、翻入等**装饰性动效仍尊重系统偏好关闭**，省略号回退改为平裁。
- **悬停暂停滚动**：原先悬停只停轮换，文字仍在滚；现在鼠标悬停时滚动的文字也停住（`animation-play-state: paused`）。
- **未标体会挂「素纸」**：没有标做错/做对的体会（旧数据不补标）以米白素纸带＋虚线边呈现，符号用「·」——一眼可辨「还没下结论的笔记」。

## English

- **Scrolling survives reduced motion**: with the OS asking for reduced motion, lesson text and evidence tabs that do not fit **still scroll sideways** — text completeness first, and the hover pause satisfies the pause rule for moving text. Decorative motion (band sway, unfurl, roll-in) still honours the preference, and the ellipsis fallback becomes a clean clip.
- **Hover pauses the scrolling text**: hovering used to stop only the rotation; the scrolling text itself now pauses too (`animation-play-state: paused`).
- **Untagged lessons hang as plain paper**: lessons without a wrong/right tag (old data stays untagged) render as an off-white paper band with a dashed edge and a `·` sign — a note with no verdict yet, readable at a glance.
