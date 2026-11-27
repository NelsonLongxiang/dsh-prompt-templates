# v0.27.0

> 发布准备材料，不代表已上传 registry、升级节点或启用同步。 / Release preparation does not prove registry publication, node upgrades or synchronization being enabled.

## 中文

- **可选工坊同步**（Refs #106，PR #107，合并提交 `89fb72a0b940c4467cdf8d75717af40617da6ae3`）：新增宿主内同步能力，**默认关闭**。只有属主明确配置技能仓库并启用后才在启动时运行一次，其后每轮结束按间隔运行，默认30分钟；不创建OS定时任务或DSH schedule。
- **技能文件与卡库分层保全**：只对干净默认分支fetch与merge --ff-only；脏树、分叉、非默认分支、detached及会覆盖ignored本地内容的更新不执行，不reset/stash/rebase或删用户文件。卡载荷取固定Git blob；主分类补缺，附加载荷只向已有全局分类补卡。
- **默认关卡及人改保护**：缺卡新建inject_enabled=false、inject_every=null、system_prompt=false。已有正文逐字匹配同一身份的仓库历史版本才更新content，保留开关、间隔、模式、描述与位置；人改卡、同名异分类或私有会话卡不覆盖、不重复建、不删卡。活跃全局system_prompt卡仍需原二次确认，自动同步跳过并报告global-confirmation-required，不隐式授权。
- **有界宿主任务与只读结果**：Git argv、shell:false，关闭交互提示，超时只终止自建子树；单模块同仓互斥，失败按间隔处理，不紧密重试凭据错误。面板和GET /plugins/dsh-prompt-templates/workshop-sync只读观察，POST 405；最近结果持久化单行，不保存原始Git输出、路径或远端用户信息。详见随包docs/workshop-sync.md。

### 验证与限制

- #107非作者Windows代码PASS绑定head06b0b480a6503850c9272450d94870e8f8a08eb4/basea98422be7ed3dcae70f2303338aafad74d207f4c/treef5a6740e27282f2ce9acc36f48ee2b2297217ad5；合并树相同。该席完整verify430通过、0跳过、0失败，4项断言变异检出、原定向17项及补充恢复3项通过；作者362通过/1跳过是另一次环境运行，不混记为同一结果。本次prepared树仍须重新验证并获非作者核对，旧结果不替新门禁。
- macOS正式报告在同#107树上verify393通过/37失败（均release脚本套件；原基线同37失败），随后独立build/package通过；不将其写成macOS完整verify通过。Linux真实宿主合成同步实跑仍待另派结果，WSL本票未验。统筹明确这些记录不再阻挡#107合入，但未测平台不因此变成已验；正式平台结果按原记录补充。
- 本版默认不启用任何真实技能目录同步。代码PASS、构建、发布、安装、启用与实际技能加载分别验收，节点升级及现场启用另行安排。Git快进与卡库更新不是跨系统原子事务；无效载荷或损坏/超限历史可使文件已快进而卡库保留，按安全码处理，不丢历史强行更新。互斥不等于跨进程分布式锁。
- 延续0.26.1既有功能及限制：#96系统提示词新开关默认false、lessonDepth0、maxChars4000、order9000；#100只抑制插件侧重复自查，宿主整轮自动目标续轮仍需正式continuation gate，不改变目标phase/revision/activation或绕人类授权。#83组织绑定、付费缓存收益、生产安装与真实依赖认证不冒称本版已验。升级前按正式流程备份数据库及WAL/SHM。
- 0.26.0未发布；0.26.1已经双registry发布并核收，不为本版重复发布或修改旧标签。本prepared PR仅单提交版本字段与新增本版说明；合并后发布席核真实merge完整SHA/tree/有序父及PR API，通过现行显式--merged-prepared入口发布，不猜未来源、不绕守卫。

## English

- **Opt-in host-owned workshop synchronization** (Refs #106 / PR #107, merge `89fb72a0b940c4467cdf8d75717af40617da6ae3`): **disabled by default**. Explicit owner configuration and enabling are required. Runs once at startup and then after each completed run at the configured interval (30 minutes by default), without OS jobs or DSH schedules.
- Only clean default branches fast-forward through argv-based Git. Dirty, divergent, detached or non-default checkouts and updates that would overwrite ignored local files are preserved. No reset, stash, rebase or deletion of user files. Card input is pinned Git content; missing cards start with injection OFF, no interval and system prompting OFF. Only historically matching managed text is updated; delivery settings and human edits stay intact. Existing active global system sections retain their confirmation gate and are skipped automatically.
- Bounded subprocesses, same-process per-repository exclusion and cancellation belong to the host lifecycle. The panel and observation GET are read-only; POST returns 405. A single latest status row omits raw Git output, repository paths and remote user information. See packaged docs/workshop-sync.md.
- Independent Windows implementation acceptance at the exact #107 tree reports full verify430 pass/0 skip/0 fail plus four assertion-sensitive mutations. These are not the author's separate362 pass/1 skip run and do not replace verification of this prepared version. macOS reports393 pass/37 fail in release tests (same failures on its baseline), followed by separate successful build/package; full macOS verify is not claimed. Linux live synthetic synchronization results are still pending separately; WSL is not claimed verified here.
- Publication is not installation or enabling. Git fast-forward and database updates are not one atomic transaction, and the lock is not distributed across hosts. Invalid or excessive history fails closed without overwriting cards. #96 remains OFF by default; #100 is only the plugin-side repair, with the host continuation gate still outstanding. Production activation, paid-provider benefits, real authentication and #83 organizational acceptance are not claimed. Back up DB/WAL/SHM before upgrades.
- 0.26.0 was not published; 0.26.1 was published and verified separately. This prepared change is version-only plus new notes; the actual future merge identity must be rechecked before the existing merged-prepared release flow. No tag, publication, node upgrade or enabling follows from these notes alone.
