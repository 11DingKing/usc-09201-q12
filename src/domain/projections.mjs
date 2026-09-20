import { sha256Hex } from './ids.mjs';
import { EVENT_TYPES } from './events.mjs';

const T = EVENT_TYPES;

/**
 * 只读投影：把只追加事件流重放为便于查询的状态。
 *
 * - createReadModel(events, { asOfTime }) 可重放任意历史时点，
 *   用于回答“当时执行的是哪个标准 / 当时库存是多少”；
 * - 在线服务持有一个订阅账本的实时投影；历史查询则临时重放。
 */
export function createReadModel(events = [], { asOfTime = null, asOfSeq = null } = {}) {
  const state = {
    users: new Map(), // userId -> { id, name, role, supplierId, apiKeyHash, createdAt }
    byApiKey: new Map(), // apiKeyHash -> userId
    plots: new Map(), // plotId -> plot
    suppliers: new Map(), // supplierId -> { id, name, contact, plotIds }
    standards: new Map(), // product -> { versions: [...] }
    batches: new Map(), // batchId -> batch state
    batchByNo: new Map(), // 当前号与所有历史别名 -> batchId
    edges: [], // { id, from, to, qty, kind }
    inspections: [],
    scanIndex: new Map(), // scanCode -> { batchId, firstSeenAt }
    notifications: [],
    lockdowns: [],
  };

  for (const event of events) {
    if (asOfSeq !== null && event.seq > asOfSeq) break;
    if (asOfTime !== null && event.occurredAt > asOfTime) continue;
    projectEvent(state, event);
  }

  return state;
}

function newBatch(event, { id, batchNo, kind, product, plotIds, supplierIds, quantity, unit, warehouse }) {
  return {
    id,
    batchNo,
    aliases: [],
    kind, // harvest | merged | split
    product,
    status: '在库',
    plotIds: plotIds ?? [],
    supplierIds: new Set(supplierIds ?? []),
    quantity,
    initialQty: quantity,
    disposedQty: 0,
    deliveredQty: 0,
    unit,
    grade: null,
    gradeHistory: [],
    warehouse: warehouse ?? null,
    createdAt: event.occurredAt,
    producedAt: event.payload.harvestedAt ?? event.occurredAt,
    parents: [],
    children: [],
    inspections: [],
    deliveries: [],
    transfers: [],
    scanCount: 0,
    lastScannedAt: null,
    locked: false,
    lockedAt: null,
    lockReason: null,
    lockdownId: null,
  };
}

function registerBatchNo(state, batchNo, batchId) {
  state.batchByNo.set(batchNo, batchId);
}

export function projectEvent(state, event) {
  const { type, payload: p, occurredAt } = event;
  switch (type) {
    case T.USER_REGISTERED: {
      const record = {
        id: p.userId,
        name: p.name,
        role: p.role,
        supplierId: p.supplierId ?? null,
        apiKeyHash: p.apiKeyHash,
        createdAt: occurredAt,
      };
      state.users.set(p.userId, record);
      state.byApiKey.set(p.apiKeyHash, p.userId);
      if (p.role === 'supplier' && p.supplierId && !state.suppliers.has(p.supplierId)) {
        state.suppliers.set(p.supplierId, {
          id: p.supplierId,
          name: p.supplierName ?? p.name,
          contact: p.contact ?? null,
          plotIds: [],
        });
      }
      break;
    }
    case T.PLOT_REGISTERED: {
      state.plots.set(p.plotId, { ...p, registeredAt: occurredAt });
      if (!state.suppliers.has(p.supplierId)) {
        state.suppliers.set(p.supplierId, {
          id: p.supplierId,
          name: p.supplierName,
          contact: p.supplierContact ?? null,
          plotIds: [],
        });
      }
      state.suppliers.get(p.supplierId).plotIds.push(p.plotId);
      break;
    }
    case T.STANDARD_PUBLISHED: {
      const entry = state.standards.get(p.product) ?? { versions: [] };
      entry.versions.push({
        version: p.version,
        product: p.product,
        effectiveFrom: p.effectiveFrom,
        limits: p.limits ?? {},
        notes: p.notes ?? null,
        publishedAt: occurredAt,
      });
      entry.versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      state.standards.set(p.product, entry);
      break;
    }
    case T.BATCH_HARVESTED: {
      const plot = state.plots.get(p.plotId);
      const batch = newBatch(event, {
        id: p.batchId,
        batchNo: p.batchNo,
        kind: 'harvest',
        product: p.product,
        plotIds: [p.plotId],
        supplierIds: plot ? [plot.supplierId] : [],
        quantity: p.quantity,
        unit: p.unit,
        warehouse: p.warehouse,
      });
      batch.producedAt = p.harvestedAt;
      state.batches.set(p.batchId, batch);
      registerBatchNo(state, p.batchNo, p.batchId);
      break;
    }
    case T.INSPECTION_RECORDED: {
      const batch = state.batches.get(p.batchId);
      const record = {
        id: p.inspectionId,
        batchId: p.batchId,
        inspectedAt: p.inspectedAt,
        standardVersion: p.standardVersion,
        verdict: p.verdict,
        metrics: p.metrics ?? {},
        violations: p.violations ?? [],
        method: p.method ?? null,
        inspector: p.inspector ?? null,
        late: Boolean(p.late),
        recordedAt: occurredAt,
      };
      state.inspections.push(record);
      if (batch) batch.inspections.push(record);
      break;
    }
    case T.BATCH_GRADED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.gradeHistory.push({ grade: p.grade, at: occurredAt, reason: p.reason ?? null });
      batch.grade = p.grade;
      break;
    }
    case T.BATCHES_MERGED: {
      let total = 0;
      const supplierIds = new Set();
      const plotIds = new Set();
      for (const source of p.sources) {
        const src = state.batches.get(source.batchId);
        if (!src) continue;
        total += source.qty;
        src.quantity = Math.max(0, src.quantity - source.qty);
        if (src.quantity === 0) src.status = '已合批';
        src.children.push(p.batchId);
        src.supplierIds.forEach((s) => supplierIds.add(s));
        src.plotIds.forEach((pl) => plotIds.add(pl));
        state.edges.push({ id: `${p.batchId}:${src.id}`, from: src.id, to: p.batchId, qty: source.qty, kind: 'merge' });
      }
      const out = newBatch(event, {
        id: p.batchId,
        batchNo: p.batchNo,
        kind: 'merged',
        product: p.product,
        plotIds: [...plotIds],
        supplierIds: [...supplierIds],
        quantity: total,
        unit: p.unit,
        warehouse: p.warehouse,
      });
      out.producedAt = occurredAt;
      out.parents = p.sources.map((s) => s.batchId);
      state.batches.set(p.batchId, out);
      registerBatchNo(state, p.batchNo, p.batchId);
      break;
    }
    case T.BATCH_SPLIT: {
      const parent = state.batches.get(p.batchId);
      if (!parent) break;
      let taken = 0;
      for (const child of p.children) {
        taken += child.qty;
        const cb = newBatch(event, {
          id: child.batchId,
          batchNo: child.batchNo,
          kind: 'split',
          product: parent.product,
          plotIds: parent.plotIds.slice(),
          supplierIds: [...parent.supplierIds],
          quantity: child.qty,
          unit: parent.unit,
          warehouse: child.warehouse ?? parent.warehouse,
        });
        cb.parents = [p.batchId];
        cb.grade = parent.grade;
        parent.children.push(child.batchId);
        state.batches.set(child.batchId, cb);
        registerBatchNo(state, child.batchNo, child.batchId);
        state.edges.push({
          id: `${p.batchId}:${child.batchId}`,
          from: p.batchId,
          to: child.batchId,
          qty: child.qty,
          kind: 'split',
        });
      }
      parent.quantity -= taken;
      if (parent.quantity <= 0) {
        parent.quantity = 0;
        parent.status = '已拆完';
      }
      break;
    }
    case T.BATCH_DELIVERED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.deliveries.push({
        id: p.deliveryId,
        qty: p.qty,
        customer: p.customer,
        contact: p.contact ?? null,
        deliveredAt: p.deliveredAt,
      });
      batch.deliveredQty += p.qty;
      batch.quantity = Math.max(0, batch.quantity - p.qty);
      if (batch.quantity === 0) batch.status = '已交付';
      break;
    }
    case T.BATCH_RENUMBERED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.aliases.push(batch.batchNo);
      registerBatchNo(state, batch.batchNo, batch.id);
      batch.batchNo = p.newBatchNo;
      registerBatchNo(state, p.newBatchNo, batch.id);
      break;
    }
    case T.BATCH_TRANSFERRED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.transfers.push({
        from: batch.warehouse,
        to: p.toWarehouse,
        qty: p.qty,
        at: occurredAt,
        reason: p.reason ?? null,
      });
      batch.warehouse = p.toWarehouse;
      break;
    }
    case T.BATCH_SCANNED: {
      const batch = state.batches.get(p.batchId);
      if (!state.scanIndex.has(p.scanCode)) {
        state.scanIndex.set(p.scanCode, { batchId: p.batchId, firstSeenAt: occurredAt });
      }
      if (batch) {
        batch.scanCount += 1;
        batch.lastScannedAt = occurredAt;
      }
      break;
    }
    case T.BATCH_LOCKED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.locked = true;
      batch.lockedAt = p.lockedAt ?? occurredAt;
      batch.lockReason = p.reason;
      batch.lockdownId = p.lockdownId ?? null;
      break;
    }
    case T.BATCH_PARTIALLY_SCRAPPED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.quantity = Math.max(0, batch.quantity - p.qty);
      batch.disposedQty += p.qty;
      batch.status = batch.quantity === 0 ? '已报废' : '部分报废';
      break;
    }
    case T.BATCH_DISPOSED: {
      const batch = state.batches.get(p.batchId);
      if (!batch) break;
      batch.disposedQty += batch.quantity;
      batch.quantity = 0;
      batch.status = '已报废';
      break;
    }
    case T.LOCKDOWN_RECORDED: {
      state.lockdowns.push({ ...p, recordedAt: occurredAt });
      break;
    }
    case T.NOTIFICATION_SENT: {
      state.notifications.push({
        id: p.notificationId,
        kind: p.kind,
        channel: p.channel,
        recipients: p.recipients,
        subject: p.subject,
        body: p.body,
        refBatchId: p.refBatchId ?? null,
        lockdownId: p.lockdownId ?? null,
        sentAt: occurredAt,
      });
      break;
    }
    default:
    // 未知事件忽略，保证旧版本账本可被新版本读取
  }
}

/** 解析某产品在指定时刻生效的标准版本（“当时标准”）。 */
export function effectiveStandardAt(state, product, at) {
  const entry = state.standards.get(product);
  if (!entry || entry.versions.length === 0) return null;
  const applicable = entry.versions.filter((v) => v.effectiveFrom <= at);
  return applicable.at(-1) ?? entry.versions[0];
}

/** 通过当前批次号或历史别名定位批次。 */
export function resolveBatchId(state, batchNoOrId) {
  if (state.batches.has(batchNoOrId)) return batchNoOrId;
  return state.batchByNo.get(batchNoOrId) ?? null;
}

export function findUserByApiKey(state, apiKey) {
  const userId = state.byApiKey.get(sha256Hex(apiKey));
  return userId ? state.users.get(userId) : null;
}
