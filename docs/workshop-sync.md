# 工坊同步（#106，默认关闭）

同一份 Node 实现运行在 DSH 宿主进程中，不创建 cron、launchd、Windows 任务或 DSH schedule。只在属主明确配置并启用后运行。

## 配置

插件设置中的 volatile 对象：

默认关闭：

```yaml
workshopSync:
  enabled: false
  repository: /absolute/path/to/agent-atelier
  intervalMinutes: 30
  timeoutMs: 30000
```

repository 必须是技能 Git 仓库顶层目录，不接受其子目录；由部署方填写目标系统本地路径。Windows/WSL 分别使用该宿主 Node 能访问的实际路径，不在代码里转换盘符。实现拒绝已识别的 DSH 安装/源码目录。启用时启动跑一次，其后每次结束后等间隔再跑；无关设置更新不触发额外尝试。关闭、改配置和卸载会取消本轮，卸载等待子进程结束。默认关闭不访问技能仓库、不启动 Git、不初始化同步数据库。

## 技能目录

使用 git argv，shell:false。先核根、主载荷、工作树与分支，向 origin 查询默认分支。仅干净默认分支执行 fetch 和 merge --ff-only，不 reset/stash/rebase/删文件。脏树、非默认分支、detached HEAD、无法快进原样保留并报原因；ignored 本地内容也不允许被快进覆盖。更新前再核HEAD/分支/脏树，更新后核实际提交。Git 自身并发锁仍适用；本插件不控制其他进程写入该仓库。

凭据只使用节点已有配置；HTTPS提示关闭、SSH BatchMode/严格已有主机密钥，缺凭据/主机信任只报安全码，不请求或记录密码。禁用hooks/fsmonitor/自动gc和maintenance/ext transport；不改仓库或全局Git配置。每轮整体Git时间预算1–120秒，单进程stdout8MiB、全部载荷16MiB、最多24载荷和每载荷200个历史提交；超过限制报错不覆盖卡。超时/取消只终止自己启动的Git子树，不杀DSH或其他工作。

## 卡库

载荷来自固定提交的 Git blob，路径为 assets/injection-templates*.json，当前载荷只认普通文件。主载荷 categories 中缺失的全局分类补建；其他载荷只有分类已存在时补卡。格式沿用 format=dsh-prompt-templates/version=1/kind=templates，只接受global且无session_id；新增卡不信任载荷的注入同意字段，始终inject_enabled=false、inject_every=null、system_prompt=false。

历史内容证明按同id/name/category取该路径历史载荷中的正文，现行正文逐字匹配才更新，只patch content：开关、间隔、模式、位置和描述保留。人改文本、同名异分类/会话私有行/重复名称均跳过，不重复建、不删卡；有歧义的载荷整批回滚。历史损坏/超限不作所有权证据，不覆盖。

已有全局system_prompt=true的卡保留原S1二次确认门，自动同步返回global-confirmation-required跳过，不带confirm_global偷偷授权。若期望连这类正文也自动更新，需要属主明确裁定；本实现不改变既有同意语义。

## 可见结果

GET /plugins/dsh-prompt-templates/workshop-sync 返回enabled/running/last；GET只读，不触发同步，POST返回405。面板工具条“工坊同步”显示最近时间、提交、新增/更新/跳过清单与安全错误码，刷新只是读取。最近一条结果存插件数据库附加表，不保存路径、原始Git输出或远端用户信息。跨进程共享库的last是最近写者，不是全节点审计历史。

## 验证边界

单测使用新建的本地合成git仓库与local bare源（不是clone/worktree），不更新已装技能或真实业务库。需要分别收集Windows/macOS/Linux的实际运行记录；WSL使用同Node/Git实现，未跑的平台标NOT_RUN。代码/测试通过、默认关闭安装、正式启用、实际技能加载更新是不同证据，不互相替代。节点升级、真实仓库启用、发布与凭据配置不由本功能开发自动执行。
