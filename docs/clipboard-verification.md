# 分享复制：隔离浏览器复验

用于 issue #14 的可重复验收。先验插件复制链，再核原故障页面；二者结果不混用。默认只用合成模板，不连接 DSH、不改模板库/权限/全局设置，不读取剪贴板。

## 1. 生成与打开

在已有依赖和已核对的维护检出运行（不需要新安装）：

```sh
pnpm build
node tests/clipboard-browser.mjs zh    # 或 en
```

输出为本项目 `tmp/test-runs/clipboard-browser-*/index.html` 的 file URL。该 HTML 内联当前构建的插件与本地 React，可在浏览器打开，也可把这个**合成页面**带到获准的 macOS 测试机；不用复制真实 DSH profile 或模板库。记录插件提交、构建摘要、操作系统、浏览器版本、访问方式；不同 origin/iframe 条件不能外推。

页面提供“复制场景”下拉框及“刷新只读环境”。原生/兼容成功场景会覆盖剪贴板为合成 JSON，开始前由操作者确认剪贴板中无需要保留的内容；其余模拟失败场景不会写系统剪贴板。不要为测试读取剪贴板、改浏览器安全策略或开启全局权限。

## 2. 交互判据

| 场景 | 操作与期待 |
|---|---|
| API 缺失 | 点分享分类/单模板；出现只读 JSON，自动聚焦/全选；提示 API 不可用而非系统剪贴板损坏 |
| 写入拒绝 | 选择 Denied 再点分享；显示 NotAllowedError 与拒绝文案，仍能手动复制 |
| 安全限制 | 选择 Security restriction；显示 SecurityError，保留相同 JSON |
| 手动键盘流 | Tab 到全选，Enter；再 Tab 到关闭，Enter；面板关闭，焦点回原分享按钮 |
| 兼容复制 | 选择 Compatibility，明确允许合成剪贴板写入后点分享；只有浏览器 execCommand 返回 true 才提示成功，否则降为手动 |
| 原生复制 | 选择 Native，明确允许合成剪贴板写入后点分享；只有实际 writeText resolved 才提示成功；拒绝则兼容/手动降级 |

JSON 应保留中文、换行和 `{{date}}` 字面量；分类分享包含分类定义，单模板分享不混入其他模板。关闭不会删除模板。不要用“复制成功”文案冒充内容已被目标实例验收。

自动回归 `tests/client-clipboard.test.ts` 覆盖错误分类、同一载荷、焦点/选区恢复、旧请求晚失败不再执行兼容复制；异步乱序的浏览器探针可使用夹具的 delayed 模式，不需改生产。

## 3. 原故障页面：先只读核验

以下片段不读取或写入剪贴板：

```js
({
  origin: location.origin,
  secure: window.isSecureContext,
  clipboardAPI: typeof navigator.clipboard?.writeText,
  focused: document.hasFocus(),
  embedded: window.self !== window.top
})
```

`http://127.0.0.1` 等回环来源可以属于可信来源，不能仅凭 HTTP 判断不安全。API 存在不等于写入获准，NotAllowedError 也不单独证明权限、焦点或系统哪一项是根因。保留实际异常类与页面环境，不输出模板内容、凭证或原始错误中可能的秘密。

原页面复验仍需获得该目标的操作授权、实际故障/修复制品身份与完整轨迹；没有入口或证据时记 NOT_RUN，不擅自重装/重启/改全局设置。

## 4. 记录与收口

在原 issue/PR 留：精确提交/制品、系统与浏览器、页面条件、逐项 PASS/FAIL/NOT_RUN、是否写入合成剪贴板、限制与下一步。合成夹具 PASS 不关闭 macOS 原现场未复验项，不代替独立运维复验或授权合并。页面临时产物留在项目 tmp；确认记录可追溯后按获准生命周期处理，不把唯一证据交给临时区。