// 领域核心：追加式事件溯源。
// 所有业务状态（批次余量、位置、锁定、检验结论）都由事件流推导，
// 既有事件不可改写——迟到检验、批次重编号、部分报废、跨仓转移、重复扫码
// 一律以新事件追加或被幂等去重，历史链路保持不变。

export class DomainError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const EVENT_TYPES = [
  'plot_registered', // 登记地块
  'supplier_registered', // 登记供应商（林农）
  'standard_published', // 发布质量标准版本
  'harvested', // 采收（创建原料批次）
  'inspected', // 检验（农残、水分；可迟到补录）
  'graded', // 分级
  'merged', // 合批（多源混合为新批次）
  'split', // 拆包（一个批次拆成多个子批次）
  'transferred', // 跨仓转移
  'delivered', // 交付下游客户
  'scrapped', // 报废（可部分）
  'renumbered', // 批次重编号（追加新编码，不改写链路）
  'locked', // 锁定（质量冻结）
  'unlocked', // 解除锁定
];

const EPS = 1e-9;

export function roundQty(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

export function createProjection() {
  return {
    plots: new Map(),
    suppliers: new Map(),
    standards: [],
    batches: new Map(),
    aliases: new Map(), // 重编号产生的新编码 -> 批次内部 id
    lineage: [], // { from, to, quantity, eventId } 物料流向边
    deliveries: [],
    inspections: [],
    scraps: [],
    events: [],
  };
}

function fail(status, code, message, details) {
  throw new DomainError(status, code, message, details);
}

function requireFields(payload, fields) {
  const missing = fields.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '');
  if (missing.length > 0) {
    fail(400, 'validation_failed', `缺少必填字段：${missing.join('、')}`, { missing });
  }
}

function requirePositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(400, 'validation_failed', `${name} 必须是正数`, { field: name, value });
  }
}

function requireNonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(400, 'validation_failed', `${name} 必须是非负数`, { field: name, value });
  }
}

export function resolveBatch(projection, idOrCode) {
  if (!idOrCode) return null;
  const direct = projection.batches.get(idOrCode);
  if (direct) return direct;
  const target = projection.aliases.get(idOrCode);
  return target ? projection.batches.get(target) ?? null : null;
}

function mustResolve(projection, idOrCode) {
  const batch = resolveBatch(projection, idOrCode);
  if (!batch) fail(404, 'unknown_batch', `批次不存在：${idOrCode}`);
  return batch;
}

function ensureBatchCodeFree(projection, code) {
  if (projection.batches.has(code) || projection.aliases.has(code)) {
    fail(409, 'batch_code_exists', `批次编码已被占用：${code}`);
  }
}

// 为批次保留一个未占用的编码；reserved 用于同一事件内一次性占住多个自动编码
function reserveBatchId(projection, reserved, explicit) {
  if (explicit) {
    ensureBatchCodeFree(projection, explicit);
    if (reserved.has(explicit)) fail(409, 'batch_code_exists', `批次编码已被占用：${explicit}`);
    reserved.add(explicit);
    return explicit;
  }
  let n = projection.batches.size + 1;
  let id = `B-${n}`;
  while (projection.batches.has(id) || projection.aliases.has(id) || reserved.has(id)) {
    n += 1;
    id = `B-${n}`;
  }
  reserved.add(id);
  return id;
}

// 查询某产品在某时间点有效的标准版本（effectiveFrom <= at 的最新一版）
export function standardFor(projection, product, at) {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  let best = null;
  for (const std of projection.standards) {
    if (std.product !== product) continue;
    const from = Date.parse(std.effectiveFrom);
    if (Number.isNaN(from)) continue;
    if (from <= time && (!best || from > Date.parse(best.effectiveFrom))) best = std;
  }
  return best;
}

function assertNotLocked(batch) {
  if (batch.locked) {
    fail(409, 'batch_locked', `批次 ${batch.id} 已锁定，禁止该操作（原因：${batch.lockReason ?? '未说明'}）`);
  }
}

function assertEnough(batch, quantity) {
  requirePositiveNumber(quantity, 'quantity');
  if (batch.remaining + EPS < quantity) {
    fail(409, 'insufficient_quantity', `批次 ${batch.id} 余量不足：剩余 ${batch.remaining}，需要 ${quantity}`);
  }
}

const handlers = {
  plot_registered(p, ev) {
    const d = ev.payload;
    requireFields(d, ['plotId', 'name']);
    if (p.plots.has(d.plotId)) fail(409, 'plot_exists', `地块已登记：${d.plotId}`);
    p.plots.set(d.plotId, {
      plotId: d.plotId,
      name: d.name,
      location: d.location ?? null,
      ownerName: d.ownerName ?? null,
      area: d.area ?? null,
    });
  },

  supplier_registered(p, ev) {
    const d = ev.payload;
    requireFields(d, ['supplierId', 'name']);
    if (p.suppliers.has(d.supplierId)) fail(409, 'supplier_exists', `供应商已登记：${d.supplierId}`);
    p.suppliers.set(d.supplierId, {
      supplierId: d.supplierId,
      name: d.name,
      contact: d.contact ?? null,
    });
  },

  standard_published(p, ev) {
    const d = ev.payload;
    requireFields(d, ['standardId', 'product', 'version', 'effectiveFrom']);
    if (Number.isNaN(Date.parse(d.effectiveFrom))) {
      fail(400, 'validation_failed', 'effectiveFrom 必须是可解析的日期');
    }
    if (p.standards.some((s) => s.standardId === d.standardId)) {
      fail(409, 'standard_exists', `标准已发布：${d.standardId}`);
    }
    const limits = d.limits ?? {};
    const hasMoisture = typeof limits.moistureMax === 'number';
    const hasResidue = typeof limits.pesticideResidueMax === 'number';
    if (!hasMoisture && !hasResidue) {
      fail(400, 'validation_failed', 'limits 至少包含 moistureMax 或 pesticideResidueMax');
    }
    p.standards.push({
      standardId: d.standardId,
      product: d.product,
      version: d.version,
      effectiveFrom: d.effectiveFrom,
      limits: {
        moistureMax: hasMoisture ? limits.moistureMax : null,
        pesticideResidueMax: hasResidue ? limits.pesticideResidueMax : null,
      },
    });
  },

  harvested(p, ev) {
    const d = ev.payload;
    requireFields(d, ['product', 'plotId', 'supplierId', 'quantity', 'unit']);
    requirePositiveNumber(d.quantity, 'quantity');
    if (!p.plots.has(d.plotId)) fail(404, 'unknown_plot', `地块不存在：${d.plotId}`);
    if (!p.suppliers.has(d.supplierId)) fail(404, 'unknown_supplier', `供应商不存在：${d.supplierId}`);
    const batchId = reserveBatchId(p, new Set(), d.batchId ?? null);
    const quantity = roundQty(d.quantity);
    p.batches.set(batchId, {
      id: batchId,
      codes: [batchId],
      kind: 'harvest',
      product: d.product,
      grade: d.grade ?? '未分级',
      unit: d.unit,
      initialQuantity: quantity,
      remaining: quantity,
      location: d.location ?? '待检区',
      plotId: d.plotId,
      supplierId: d.supplierId,
      harvestedAt: ev.occurredAt,
      occurredAt: ev.occurredAt,
      locked: false,
      lockReason: null,
      flagged: false,
      createdBy: ev.id,
      createdAt: ev.recordedAt,
    });
  },

  inspected(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId', 'moisture', 'pesticideResidue']);
    requireNonNegativeNumber(d.moisture, 'moisture');
    requireNonNegativeNumber(d.pesticideResidue, 'pesticideResidue');
    const batch = mustResolve(p, d.batchId);
    // 迟到检验同样追加：occurredAt 可早于合批/交付，结论按当时有效标准判定
    const std = standardFor(p, batch.product, ev.occurredAt);
    const failures = [];
    if (std) {
      if (std.limits.moistureMax !== null && d.moisture > std.limits.moistureMax) {
        failures.push({ item: 'moisture 水分', value: d.moisture, limit: std.limits.moistureMax });
      }
      if (std.limits.pesticideResidueMax !== null && d.pesticideResidue > std.limits.pesticideResidueMax) {
        failures.push({ item: 'pesticideResidue 农残', value: d.pesticideResidue, limit: std.limits.pesticideResidueMax });
      }
    }
    const result = !std ? 'unevaluated' : failures.length > 0 ? 'fail' : 'pass';
    p.inspections.push({
      id: `I-${String(p.inspections.length + 1).padStart(6, '0')}`,
      batchId: batch.id,
      moisture: d.moisture,
      pesticideResidue: d.pesticideResidue,
      lab: d.lab ?? null,
      note: d.note ?? null,
      result,
      failures,
      standardId: std?.standardId ?? null,
      standardVersion: std?.version ?? null,
      occurredAt: ev.occurredAt,
      recordedAt: ev.recordedAt,
      eventId: ev.id,
    });
    if (result === 'fail') batch.flagged = true;
  },

  graded(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId', 'grade']);
    mustResolve(p, d.batchId).grade = d.grade;
  },

  merged(p, ev) {
    const d = ev.payload;
    requireFields(d, ['sources']);
    if (!Array.isArray(d.sources) || d.sources.length < 2) {
      fail(400, 'validation_failed', '合批至少需要两个来源批次');
    }
    const sources = d.sources.map((s) => {
      requireFields(s, ['batchId', 'quantity']);
      const batch = mustResolve(p, s.batchId);
      assertNotLocked(batch);
      assertEnough(batch, s.quantity);
      return { batch, quantity: roundQty(s.quantity) };
    });
    if (new Set(sources.map((s) => s.batch.id)).size !== sources.length) {
      fail(400, 'validation_failed', '合批来源包含重复批次');
    }
    const products = new Set(sources.map((s) => s.batch.product));
    const units = new Set(sources.map((s) => s.batch.unit));
    const product = d.product ?? (products.size === 1 ? [...products][0] : null);
    if (!product) fail(400, 'validation_failed', '来源批次产品不一致，必须显式指定 product');
    const unit = d.unit ?? (units.size === 1 ? [...units][0] : null);
    if (!unit) fail(400, 'validation_failed', '来源批次单位不一致，必须显式指定 unit');
    const targetId = reserveBatchId(p, new Set(), d.targetBatchId ?? null);
    let total = 0;
    for (const { batch, quantity } of sources) {
      batch.remaining = roundQty(batch.remaining - quantity);
      total += quantity;
    }
    total = roundQty(total);
    p.batches.set(targetId, {
      id: targetId,
      codes: [targetId],
      kind: 'merged',
      product,
      grade: d.grade ?? '未分级',
      unit,
      initialQuantity: total,
      remaining: total,
      location: d.location ?? '加工区',
      plotId: null,
      supplierId: null,
      harvestedAt: null,
      occurredAt: ev.occurredAt,
      locked: false,
      lockReason: null,
      flagged: sources.some((s) => s.batch.flagged),
      createdBy: ev.id,
      createdAt: ev.recordedAt,
    });
    for (const { batch, quantity } of sources) {
      p.lineage.push({ from: batch.id, to: targetId, quantity, eventId: ev.id });
    }
  },

  split(p, ev) {
    const d = ev.payload;
    requireFields(d, ['sourceBatchId', 'parts']);
    const source = mustResolve(p, d.sourceBatchId);
    assertNotLocked(source);
    if (!Array.isArray(d.parts) || d.parts.length === 0) {
      fail(400, 'validation_failed', '拆包至少需要一个子批次');
    }
    let total = 0;
    for (const part of d.parts) {
      requireFields(part, ['quantity']);
      requirePositiveNumber(part.quantity, 'quantity');
      total += part.quantity;
    }
    if (source.remaining + EPS < total) {
      fail(409, 'insufficient_quantity', `批次 ${source.id} 余量不足：剩余 ${source.remaining}，拆出合计 ${roundQty(total)}`);
    }
    const reserved = new Set();
    const childIds = d.parts.map((part) => reserveBatchId(p, reserved, part.batchId ?? null));
    source.remaining = roundQty(source.remaining - total);
    d.parts.forEach((part, index) => {
      const childId = childIds[index];
      const quantity = roundQty(part.quantity);
      p.batches.set(childId, {
        id: childId,
        codes: [childId],
        kind: 'split',
        product: source.product,
        grade: source.grade,
        unit: source.unit,
        initialQuantity: quantity,
        remaining: quantity,
        location: part.location ?? source.location,
        plotId: null,
        supplierId: null,
        harvestedAt: null,
        occurredAt: ev.occurredAt,
        locked: false,
        lockReason: null,
        flagged: source.flagged,
        createdBy: ev.id,
        createdAt: ev.recordedAt,
      });
      p.lineage.push({ from: source.id, to: childId, quantity, eventId: ev.id });
    });
  },

  transferred(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId', 'toLocation']);
    const batch = mustResolve(p, d.batchId);
    assertNotLocked(batch);
    if (d.fromLocation !== undefined && d.fromLocation !== batch.location) {
      fail(409, 'location_mismatch', `批次 ${batch.id} 当前位于 ${batch.location}，与指定的转出地 ${d.fromLocation} 不一致`);
    }
    batch.location = d.toLocation;
  },

  delivered(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId', 'customer', 'quantity']);
    const batch = mustResolve(p, d.batchId);
    assertNotLocked(batch);
    assertEnough(batch, d.quantity);
    batch.remaining = roundQty(batch.remaining - d.quantity);
    p.deliveries.push({
      id: `D-${String(p.deliveries.length + 1).padStart(6, '0')}`,
      batchId: batch.id,
      customer: d.customer,
      quantity: roundQty(d.quantity),
      note: d.note ?? null,
      occurredAt: ev.occurredAt,
      recordedAt: ev.recordedAt,
      eventId: ev.id,
    });
  },

  scrapped(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId', 'quantity', 'reason']);
    const batch = mustResolve(p, d.batchId);
    // 锁定批次允许报废——报废正是处置手段
    assertEnough(batch, d.quantity);
    batch.remaining = roundQty(batch.remaining - d.quantity);
    p.scraps.push({
      id: `X-${String(p.scraps.length + 1).padStart(6, '0')}`,
      batchId: batch.id,
      quantity: roundQty(d.quantity),
      reason: d.reason,
      occurredAt: ev.occurredAt,
      recordedAt: ev.recordedAt,
      eventId: ev.id,
    });
  },

  renumbered(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId', 'newCode']);
    const batch = mustResolve(p, d.batchId);
    ensureBatchCodeFree(p, d.newCode);
    p.aliases.set(d.newCode, batch.id);
    batch.codes.push(d.newCode);
  },

  locked(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId']);
    const batch = mustResolve(p, d.batchId);
    if (batch.locked) fail(409, 'already_locked', `批次 ${batch.id} 已处于锁定状态`);
    batch.locked = true;
    batch.lockReason = d.reason ?? null;
  },

  unlocked(p, ev) {
    const d = ev.payload;
    requireFields(d, ['batchId']);
    const batch = mustResolve(p, d.batchId);
    if (!batch.locked) fail(409, 'not_locked', `批次 ${batch.id} 未锁定`);
    batch.locked = false;
    batch.lockReason = null;
  },
};

// 应用一条事件到投影；校验失败抛 DomainError，投影保持不变
export function applyEvent(projection, event) {
  const handler = handlers[event.type];
  if (!handler) fail(400, 'unknown_event_type', `未知事件类型：${event.type}`);
  handler(projection, event);
}
