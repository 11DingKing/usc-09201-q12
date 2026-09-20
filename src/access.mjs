// 访问控制与脱敏呈现。
// 质量负责人（quality）全量可见；供应商（supplier）只能查看与自身相关的
// 批次、追溯与处置记录，其他供应商/地块身份一律脱敏。

import { DomainError } from './domain.mjs';
import { compositionOf } from './trace.mjs';

export function resolveActor(headers) {
  const role = headers['x-role'];
  if (role === 'quality') return { role: 'quality' };
  if (role === 'supplier') {
    const supplierId = headers['x-supplier-id'];
    if (!supplierId || typeof supplierId !== 'string') {
      throw new DomainError(401, 'unauthorized', '供应商角色必须同时提供 x-supplier-id 请求头');
    }
    return { role: 'supplier', supplierId };
  }
  throw new DomainError(401, 'unauthorized', '缺少有效身份：请提供 x-role: quality 或 x-role: supplier 请求头');
}

export function requireQuality(actor) {
  if (actor.role !== 'quality') {
    throw new DomainError(403, 'forbidden', '仅质量负责人可执行该操作');
  }
}

// 供应商可见的批次集合：其采收批次本身 + 所有含有其物料的下游批次
export function supplierScope(projection, supplierId) {
  const memo = new Map();
  const scope = new Set();
  for (const id of projection.batches.keys()) {
    const comp = compositionOf(projection, id, memo);
    for (const ancestorId of comp.keys()) {
      const ancestor = projection.batches.get(ancestorId);
      if (ancestor?.supplierId === supplierId) {
        scope.add(id);
        break;
      }
    }
  }
  return scope;
}

export function presentBatch(batch, actor) {
  const status = batch.locked ? 'locked' : batch.remaining <= 1e-9 ? 'depleted' : 'active';
  const base = {
    id: batch.id,
    codes: batch.codes,
    kind: batch.kind,
    product: batch.product,
    grade: batch.grade,
    unit: batch.unit,
    initialQuantity: batch.initialQuantity,
    remaining: batch.remaining,
    location: batch.location,
    status,
    locked: batch.locked,
    flagged: batch.flagged,
    harvestedAt: batch.harvestedAt,
    createdAt: batch.createdAt,
  };
  if (actor.role === 'quality') {
    return { ...base, supplierId: batch.supplierId, plotId: batch.plotId, lockReason: batch.lockReason };
  }
  const own = batch.supplierId !== null && batch.supplierId === actor.supplierId;
  return { ...base, supplierId: own ? batch.supplierId : null, plotId: own ? batch.plotId : null };
}

export function presentTraceBack(trace, actor) {
  const batch = presentBatch(trace.batch, actor);
  if (actor.role === 'quality') {
    return {
      batch,
      ancestors: trace.ancestors,
      inspections: trace.inspections,
      batchStandard: trace.batchStandard,
    };
  }
  // 供应商视角：自己的来源完整可见，其他贡献者只保留数量信息、身份脱敏
  let maskedContributors = 0;
  const ancestors = trace.ancestors.map((a) => {
    if (a.supplierId === actor.supplierId) return a;
    maskedContributors += 1;
    return {
      batchId: a.batchId,
      product: a.product,
      contributedQuantity: a.contributedQuantity,
      masked: true,
    };
  });
  const ownIds = new Set(
    trace.ancestors.filter((a) => a.supplierId === actor.supplierId).map((a) => a.batchId),
  );
  const inspections = trace.inspections.filter((i) => i.batchId === trace.batch.id || ownIds.has(i.batchId));
  return {
    batch,
    ancestors,
    maskedContributors,
    inspections,
    batchStandard: trace.batchStandard,
  };
}

export function presentTraceForward(trace, actor) {
  const descendants = trace.descendants.map((d) => ({
    ...presentBatch(d.batch, actor),
    sourceFraction: d.sourceFraction,
    containedQuantity: d.containedQuantity,
  }));
  const deliveries = trace.deliveries.map((d) =>
    actor.role === 'quality'
      ? d
      : { ...d, customer: '***' }, // 供应商可见交付事实与数量，客户身份脱敏
  );
  return { descendants, deliveries, scraps: trace.scraps };
}
