# v0.13.4（2026-11-14）

> 发布说明中英双语；本文同文进入 GitHub Release。

## 中文

### 面向使用者

- **导入不再静默启用定时注入**：导入/同步模板包时，`inject_enabled` 强制为关闭状态——间隔（every）与交付模式（mode）保留不丢，但开关需要用户在面板里手动拨开才会生效。同名覆盖（overwrite）同样不碰目标实例的开关状态。

### 修复

- 修复：导入载荷中 `inject_enabled: true` 的模板会在目标实例立即开始定时注入，而用户从未手动开启过（0.13.3 引入分享功能时带入）。

## English

### For users

- **Import never silently enables scheduled injection**: when importing or syncing a template pack, `inject_enabled` is forced off — the interval (every) and delivery mode survive intact, but the switch must be toggled on manually in the panel. Same-name overwrites likewise never touch the target's own on/off state.

### Fixed

- Fix: templates with `inject_enabled: true` in a share payload would immediately start scheduled injection on the target instance without the user ever turning them on (introduced with the sharing feature in 0.13.3).
