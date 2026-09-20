// 追溯与失效模拟：在事件投影上计算的纯函数。
// 组成比例（composition）按合批/拆批时的数量比例沿链路传递，
// 支持菱形链路（拆分后再合批）与多源混批的精确分摊。

import { resolveBatch, roundQty, standardFor } from './domain.mjs';

// 计算批次的来源组成：Map<祖先批次id, 比例>。采收批次的组成是其自身（比例 1）。
export function compositionOf(projection, batchId, memo = new Map()) {
  const cached = memo.get(batchId);
  if (cached) return cached;
  const batch = projection.batches.get(batchId);
  const comp = new Map();
  if (batch) {
    const incoming = projection.lineage.filter((e) => e.to === batchId);
    if (incoming.length === 0) {
      comp.set(batchId, 1);
    } else {
      for (const edge of incoming) {
        const parentComp = compositionOf(projection, edge.from, memo);
        const fraction = batch.initialQuantity > 0 ? edge.quantity / batch.initialQuantity : 0;
        for (const [ancestor, parentFraction] of parentComp) {
          comp.set(ancestor, (comp.get(ancestor) ?? 0) + parentFraction * fraction);
        }
      }
    }
  }
  memo.set(batchId, comp);
  return comp;
}

// 反向追溯：成品 -> 来源采收批次（地块、林农、采收时间、当时有效标准）+ 相关检验记录
export function traceBack(projection, batchId) {
  const batch = projection.batches.get(batchId);
  if (!batch) return null;
  const comp = compositionOf(projection, batchId);
  const ancestors = [];
  for (const [ancestorId, fraction] of comp) {
    if (ancestorId === batchId) continue;
    const ancestor = projection.batches.get(ancestorId);
    if (!ancestor) continue;
    const std = ancestor.harvestedAt ? standardFor(projection, ancestor.product, ancestor.harvestedAt) : null;
    ancestors.push({
      batchId: ancestor.id,
      product: ancestor.product,
      supplierId: ancestor.supplierId,
      plotId: ancestor.plotId,
      harvestedAt: ancestor.harvestedAt,
      contributedQuantity: roundQty(fraction * batch.initialQuantity),
      standardId: std?.standardId ?? null,
      standardVersion: std?.version ?? null,
    });
  }
  ancestors.sort((a, b) => a.batchId.localeCompare(b.batchId));
  const scope = new Set([batchId, ...comp.keys()]);
  const inspections = projection.inspections.filter((i) => scope.has(i.batchId));
  const std = standardFor(projection, batch.product, batch.occurredAt ?? batch.createdAt);
  const batchStandard = std
    ? { standardId: std.standardId, version: std.version, effectiveFrom: std.effectiveFrom }
    : null;
  return { batch, ancestors, inspections, batchStandard };
}

// 正向追溯：来源批次 -> 全部下游派生批次 + 这些批次的交付与报废记录
export function traceForward(projection, batchId) {
  const childrenOf = new Map();
  for (const edge of projection.lineage) {
    if (!childrenOf.has(edge.from)) childrenOf.set(edge.from, []);
    childrenOf.get(edge.from).push(edge);
  }
  const found = new Set();
  const queue = [batchId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of childrenOf.get(current) ?? []) {
      if (!found.has(edge.to)) {
        found.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  const memo = new Map();
  const descendants = [...found]
    .map((id) => {
      const batch = projection.batches.get(id);
      if (!batch) return null;
      const fraction = compositionOf(projection, id, memo).get(batchId) ?? 0;
      return { batch, sourceFraction: roundQty(fraction), containedQuantity: roundQty(fraction * batch.initialQuantity) };
    })
    .filter(Boolean)
    .sort((a, b) => a.batch.id.localeCompare(b.batch.id));
  const scope = new Set([batchId, ...found]);
  const deliveries = projection.deliveries.filter((d) => scope.has(d.batchId));
  const scraps = projection.scraps.filter((s) => scope.has(s.batchId));
  return { descendants, deliveries, scraps };
}

// 失效模拟：假设某批次物料失效，计算锁定范围、库存余量与下游通知清单（只读，不改状态）
export function simulateFailure(projection, batchId) {
  const batch = projection.batches.get(batchId);
  if (!batch) return null;
  const back = traceBack(projection, batchId);
  const forward = traceForward(projection, batchId);
  const scopeBatches = [
    { batch, sourceFraction: 1, containedQuantity: batch.initialQuantity },
    ...forward.descendants,
  ];
  // 锁定范围：含有失效物料且仍有库存余量的批次
  const lockScope = scopeBatches
    .filter((item) => item.batch.remaining > 1e-9)
    .map((item) => ({
      batchId: item.batch.id,
      codes: item.batch.codes,
      product: item.batch.product,
      grade: item.batch.grade,
      remaining: item.batch.remaining,
      location: item.batch.location,
      alreadyLocked: item.batch.locked,
    }));
  // 库存余量：按仓库 + 产品汇总
  const balanceMap = new Map();
  for (const item of lockScope) {
    const key = `${item.location}::${item.product}`;
    const entry = balanceMap.get(key) ?? { location: item.location, product: item.product, quantity: 0 };
    entry.quantity = roundQty(entry.quantity + item.remaining);
    balanceMap.set(key, entry);
  }
  // 下游通知：已交付给客户的失效物料，按客户汇总
  const byCustomer = new Map();
  for (const d of forward.deliveries) {
    const entry = byCustomer.get(d.customer) ?? { customer: d.customer, totalQuantity: 0, deliveries: [] };
    entry.totalQuantity = roundQty(entry.totalQuantity + d.quantity);
    entry.deliveries.push({ deliveryId: d.id, batchId: d.batchId, quantity: d.quantity, occurredAt: d.occurredAt });
    byCustomer.set(d.customer, entry);
  }
  return {
    failedBatch: {
      batchId: batch.id,
      codes: batch.codes,
      product: batch.product,
      grade: batch.grade,
      remaining: batch.remaining,
      location: batch.location,
      flagged: batch.flagged,
    },
    origin: {
      suppliers: [...new Set([batch.supplierId, ...back.ancestors.map((a) => a.supplierId)].filter(Boolean))],
      plots: [...new Set([batch.plotId, ...back.ancestors.map((a) => a.plotId)].filter(Boolean))],
      ancestors: back.ancestors,
    },
    lockScope,
    inventoryBalance: [...balanceMap.values()],
    downstreamNotifications: [...byCustomer.values()],
    totals: {
      affectedBatches: lockScope.length,
      lockedQuantity: roundQty(lockScope.reduce((sum, item) => sum + item.remaining, 0)),
      notifiedCustomers: byCustomer.size,
      deliveredQuantity: roundQty(forward.deliveries.reduce((sum, d) => sum + d.quantity, 0)),
    },
  };
}

// 处置记录：锁定/解锁/报废/检验不合格，从事件流推导
export function listDispositions(projection) {
  const out = [];
  for (const ev of projection.events) {
    if (ev.type === 'locked' || ev.type === 'unlocked') {
      const batch = resolveBatch(projection, ev.payload.batchId);
      out.push({
        type: ev.type === 'locked' ? 'lock' : 'unlock',
        batchId: batch?.id ?? ev.payload.batchId,
        product: batch?.product ?? null,
        reason: ev.payload.reason ?? null,
        occurredAt: ev.occurredAt,
        eventId: ev.id,
      });
    } else if (ev.type === 'scrapped') {
      const batch = resolveBatch(projection, ev.payload.batchId);
      out.push({
        type: 'scrap',
        batchId: batch?.id ?? ev.payload.batchId,
        product: batch?.product ?? null,
        quantity: ev.payload.quantity,
        reason: ev.payload.reason,
        occurredAt: ev.occurredAt,
        eventId: ev.id,
      });
    }
  }
  for (const insp of projection.inspections) {
    if (insp.result === 'fail') {
      const batch = projection.batches.get(insp.batchId);
      out.push({
        type: 'inspection_failure',
        batchId: insp.batchId,
        product: batch?.product ?? null,
        failures: insp.failures,
        standardVersion: insp.standardVersion,
        occurredAt: insp.occurredAt,
        eventId: insp.eventId,
      });
    }
  }
  out.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || a.eventId.localeCompare(b.eventId));
  return out;
}
