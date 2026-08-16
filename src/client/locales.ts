/** Locale keys for the prompt-templates surface. */

/** Chinese dictionary. */
export const zh = {
  'panel.title': '快捷提示词',
  'panel.dragHint': '拖动移动，双击复位',
  'panel.sendNow': '直接发送',
  'panel.open': '打开提示词面板',
  'panel.close': '关闭提示词面板',
  'panel.empty': '暂无模板',
  'panel.global': '全局模板',
  'panel.session': '会话模板',
  'panel.add': '新增',
  'panel.addName': '模板名称',
  'panel.addContent': '模板内容',
  'panel.addSave': '保存',
  'panel.addCancel': '取消',
  'panel.insert': '插入',
  'panel.delete': '删除',
  'panel.edit': '编辑',
  'panel.makeGlobal': '设为全局',
  'panel.error': '操作失败',
  'panel.inserted': '已插入',
  'panel.none': '无',
} as const

/** English dictionary. */
export const en = {
  'panel.title': 'Quick prompts',
  'panel.dragHint': 'Drag to move, double-click to reset',
  'panel.sendNow': 'Send now',
  'panel.open': 'Open prompt panel',
  'panel.close': 'Close prompt panel',
  'panel.empty': 'No templates yet',
  'panel.global': 'Global templates',
  'panel.session': 'Session templates',
  'panel.add': 'Add',
  'panel.addName': 'Template name',
  'panel.addContent': 'Template content',
  'panel.addSave': 'Save',
  'panel.addCancel': 'Cancel',
  'panel.insert': 'Insert',
  'panel.delete': 'Delete',
  'panel.edit': 'Edit',
  'panel.makeGlobal': 'Make global',
  'panel.error': 'Operation failed',
  'panel.inserted': 'Inserted',
  'panel.none': 'None',
} as const

/** Key union of the prompt-templates dictionary. */
export type PromptTemplateKey = keyof typeof zh
