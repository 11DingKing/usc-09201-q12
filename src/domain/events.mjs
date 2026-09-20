/**
 * 事件类型目录。系统状态完全由这一串只追加事件推导：
 * 迟到检验、重编号、部分报废、跨仓转移、重复扫码都只能“再记一条”，
 * 不能修改或删除既有事件。
 */
export const EVENT_TYPES = Object.freeze({
  USER_REGISTERED: 'user.registered',
  PLOT_REGISTERED: 'plot.registered',
  STANDARD_PUBLISHED: 'standard.published',
  BATCH_HARVESTED: 'batch.harvested',
  INSPECTION_RECORDED: 'inspection.recorded',
  BATCH_GRADED: 'batch.graded',
  BATCHES_MERGED: 'batches.merged',
  BATCH_SPLIT: 'batch.split',
  BATCH_DELIVERED: 'batch.delivered',
  BATCH_RENUMBERED: 'batch.renumbered',
  BATCH_TRANSFERRED: 'batch.transferred',
  BATCH_SCANNED: 'batch.scanned',
  BATCH_LOCKED: 'batch.locked',
  BATCH_PARTIALLY_SCRAPPED: 'batch.partially_scrapped',
  BATCH_DISPOSED: 'batch.disposed',
  LOCKDOWN_RECORDED: 'lockdown.recorded',
  NOTIFICATION_SENT: 'notification.sent',
});

export const ROLES = Object.freeze({
  ENTERPRISE: 'enterprise', // 质量负责人 / 加工企业
  SUPPLIER: 'supplier', // 林农（供应商）
});

export const GRADES = Object.freeze(['特级', '一级', '二级', '三级', '等外']);

/** 检验结论：不合格批次是后续失效模拟与锁定的依据。 */
export const VERDICTS = Object.freeze({
  PASS: '合格',
  FAIL: '不合格',
  CONDITIONAL: '限改',
});
