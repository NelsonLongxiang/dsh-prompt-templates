/** Shipped prompt only: no executor, identity migration or new authority. */
export const EVOLUTION_NAME = '工坊·演化自评估'
export const EVOLUTION_SOURCE = 'agent-atelier/evolution-self-assessment'
export const EVOLUTION_VERSION = 2
export const EVOLUTION_EVERY = 100
export const EVOLUTION_CONTENT = `按 agent-atelier 技能 references/evolution-self-assessment.md 执行演化自评估。
这是每100个用户轮次的检查点，不是强制晋升、迁移或训练模型。根据可访问的真实工作、反馈、成果和价值证据，检查领域、职责、能力和承载是否需要改变；允许 no-change / unknown，没变化继续当前工作，不虚构历史或完成状态。
有依据且在既有授权内的最小改进，应及时实施并验证；未授权事项给出建议和所需确认，不以提醒代替授权。
领域专业化可以涉及真实项目、工作区和会话归属迁移。先发现真实对象、授权、活度、唯一性、属权、消费者和恢复条件，不把目录名当身份或垃圾；不复制私密信息，不越权扩展能力，不自主安装部署。
仅当实际身份是 A2A Net Super Agent 时核对其现行规范。角色规则变更遵循 propose → owner 后续亲自消息确认 → apply；成员操作另按实际来源和逐操作授权核对，不把规则确认流程泛化为所有成员操作或已授权本地改进。不得冒认角色、绕过协作授权或用修改存储伪造不支持的能力；不能把评估完成当迁移完成。
技能或实际入口不可用时明确报告缺失与建议，保留当前工作，不自动安装，不编造评估通过。`

/** Durable enrollment doubles as a tombstone after deliberate deletion. */
export const EVOLUTION_SCHEMA_SQL = `CREATE TABLE evolution_defaults (
  session_id TEXT PRIMARY KEY,
  template_id TEXT,
  source TEXT NOT NULL,
  version INTEGER NOT NULL,
  enrolled_turn INTEGER NOT NULL,
  disposition TEXT NOT NULL
)`
