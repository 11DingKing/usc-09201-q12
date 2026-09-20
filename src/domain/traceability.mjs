import { EventStore } from './eventStore.mjs';
import { createReadModel, effectiveStandardAt, resolveBatchId, findUserByApiKey, projectEvent } from './projections.mjs';
import { BatchNumberGenerator, generateApiKey, newBatchIdentity, randomId, sha256Hex } from './ids.mjs';
import { EVENT_TYPES, GRADES, ROLES, VERDICTS } from './events.mjs';
import { DomainError, fail } from './errors.mjs';

const T = EVENT_TYPES;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function normalizeDateInput(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail('validation_error', `缺少 ${field}`);
  if (DATE_ONLY.test(value)) return `${value}T00:00:00.000Z`;
  const time = Date.parse(value);
  if (Number.isNaN(time)) fail('validation_error', `${field} 不是合法时间：${value}`);
  // 统一输出毫秒精度 UTC，保证字符串比较与时点重放稳定
  return new Date(time).toISOString();
}

function requireFields(input, fields) {
  for (const field of fields) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      fail('validation_error', `缺少必填字段：${field}`);
    }
  }
}

function positiveQty(value, field) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty <= 0) fail('validation_error', `${field} 必须为正数`);
  return qty;
}

/**
 * 林产品批次履历应用服务。
 *
 * 所有写操作都以“追加一条事件”的方式完成；迟到检验只补记事件、
 * 重编号只增加别名、部分报废与跨仓转移只叠加新事实，既有链路不可改写。
 * 读取侧基于实时投影，历史问题（“当时标准/当时库存”）以时点重放回答。
 */
export class TraceabilityService {
  constructor(store = new EventStore()) {
    this.store = store;
    this.model = createReadModel(store.all());
    this.numbers = new BatchNumberGenerator();
    for (const batch of this.model.batches.values()) {
      this.numbers.seed(batch.batchNo);
      batch.aliases.forEach((alias) => this.numbers.seed(alias));
    }
    store.subscribe((event) => projectEvent(this.model, event));
  }

  // ---------- 基础工具 ----------

  #requireEnterprise(actor) {
    if (actor?.role !== ROLES.ENTERPRISE) fail('forbidden', '仅质量负责人（企业端）可执行该操作');
  }

  #resolve(ref) {
    const id = resolveBatchId(this.model, ref);
    if (!id) fail('not_found', `批次不存在：${ref}`);
    return this.model.batches.get(id);
  }

  #requireWritable(batch) {
    if (batch.locked) {
      fail('batch_locked', `批次 ${batch.batchNo} 已锁定，禁止流转操作（${batch.lockReason ?? '失效管控'}）`, {
        lockdownId: batch.lockdownId,
      });
    }
  }

  #append(type, payload, actor, occurredAt) {
    return this.store.append(type, payload, {
      actor: actor ? { userId: actor.id ?? actor.userId, role: actor.role } : null,
      occurredAt,
    });
  }

  // ---------- 用户与供应商 ----------

  registerUser({ role, name, supplierName, contact }) {
    requireFields({ role, name }, ['role', 'name']);
    if (!Object.values(ROLES).includes(role)) fail('validation_error', `未知角色：${role}`);
    const userId = randomId('usr');
    const apiKey = generateApiKey(role);
    let supplierId = null;
    if (role === ROLES.SUPPLIER) {
      requireFields({ supplierName }, ['supplierName']);
      supplierId = randomId('sup');
    }
    this.store.append(T.USER_REGISTERED, {
      userId,
      name,
      role,
      supplierId,
      supplierName: supplierName ?? null,
      contact: contact ?? null,
      apiKeyHash: sha256Hex(apiKey),
    });
    return { userId, role, name, supplierId, apiKey };
  }

  authenticate(apiKey) {
    return findUserByApiKey(this.model, apiKey) ?? null;
  }

  registerPlot(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['plotName', 'location', 'product', 'areaMu']);
    let supplierId = input.supplierId;
    let supplierName = input.supplierName;
    let supplierContact = input.contact ?? null;
    if (!supplierId) {
      requireFields(input, ['supplierName']);
      supplierId = randomId('sup');
    } else if (!this.model.suppliers.has(supplierId)) {
      fail('not_found', `供应商不存在：${supplierId}`);
    } else {
      supplierName = this.model.suppliers.get(supplierId).name;
    }
    const plotId = randomId('plot');
    this.#append(
      T.PLOT_REGISTERED,
      {
        plotId,
        plotName: input.plotName,
        location: input.location,
        product: input.product,
        areaMu: positiveQty(input.areaMu, 'areaMu'),
        supplierId,
        supplierName,
        supplierContact,
      },
      actor,
    );
    return this.model.plots.get(plotId);
  }

  // ---------- 标准版本 ----------

  publishStandard(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['product', 'version', 'effectiveFrom']);
    const effectiveFrom = normalizeDateInput(input.effectiveFrom, 'effectiveFrom');
    const entry = this.model.standards.get(input.product);
    if (entry?.versions.some((v) => v.version === input.version)) {
      fail('conflict', `${input.product} 标准版本 ${input.version} 已发布`);
    }
    this.#append(
      T.STANDARD_PUBLISHED,
      {
        product: input.product,
        version: input.version,
        effectiveFrom,
        limits: input.limits ?? {},
        notes: input.notes ?? null,
      },
      actor,
    );
    return effectiveStandardAt(this.model, input.product, effectiveFrom);
  }

  // ---------- 采收 ----------

  harvest(actor, input) {
    requireFields(input, ['plotRef', 'product', 'quantity', 'unit', 'harvestedAt']);
    const plot = this.model.plots.get(input.plotRef) ?? [...this.model.plots.values()].find((p) => p.plotName === input.plotRef);
    if (!plot) fail('not_found', `地块不存在：${input.plotRef}`);
    if (actor.role === ROLES.SUPPLIER && actor.supplierId !== plot.supplierId) {
      fail('forbidden', '林农只能为自家林地登记采收');
    }
    const qty = positiveQty(input.quantity, 'quantity');
    const harvestedAt = normalizeDateInput(input.harvestedAt, 'harvestedAt');
    const identity = newBatchIdentity('harvest', this.numbers);
    this.#append(
      T.BATCH_HARVESTED,
      {
        ...identity,
        plotId: plot.plotId,
        product: input.product,
        quantity: qty,
        unit: input.unit,
        harvestedAt,
        warehouse: input.warehouse ?? null,
        remarks: input.remarks ?? null,
      },
      actor,
      harvestedAt,
    );
    return toBatchDTO(this.model, this.model.batches.get(identity.batchId), actor);
  }

  // ---------- 检验（允许迟到补记） ----------

  recordInspection(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'inspectedAt', 'metrics']);
    const batch = this.#resolve(input.batchRef);
    const inspectedAt = normalizeDateInput(input.inspectedAt, 'inspectedAt');

    // “当时标准”：未指定版本时按检验发生时刻取已生效的标准，而不是最新标准
    const standard = input.standardVersion
      ? this.model.standards.get(batch.product)?.versions.find((v) => v.version === input.standardVersion) ??
        fail('not_found', `标准版本不存在：${batch.product}@${input.standardVersion}`)
      : effectiveStandardAt(this.model, batch.product, inspectedAt);

    const violations = evaluateLimits(input.metrics ?? {}, standard?.limits ?? {});
    const verdict = input.verdict ?? (violations.length ? VERDICTS.FAIL : VERDICTS.PASS);
    if (!Object.values(VERDICTS).includes(verdict)) fail('validation_error', `未知检验结论：${verdict}`);

    // 迟到检验：检验实际发生时批次已经向下游流转（合批/拆包/交付），事后补记。
    // 只依据账本内既成事实判定，不依赖墙钟，避免历史数据迁移被误判。
    const movedDownstream = batch.children.length > 0 || batch.deliveredQty > 0 || batch.status === '已合批';
    const late = Boolean(input.late) || movedDownstream;

    const inspectionId = randomId('insp');
    this.#append(
      T.INSPECTION_RECORDED,
      {
        inspectionId,
        batchId: batch.id,
        inspectedAt,
        standardVersion: standard?.version ?? null,
        standardProduct: standard?.product ?? batch.product,
        verdict,
        metrics: input.metrics ?? {},
        violations,
        method: input.method ?? null,
        inspector: input.inspector ?? actor.name,
        late,
      },
      actor,
      inspectedAt,
    );
    return this.model.inspections.find((i) => i.id === inspectionId);
  }

  // ---------- 分级 ----------

  grade(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'grade']);
    if (!GRADES.includes(input.grade)) fail('validation_error', `非法等级：${input.grade}`);
    const batch = this.#resolve(input.batchRef);
    this.#append(T.BATCH_GRADED, { batchId: batch.id, grade: input.grade, reason: input.reason ?? null }, actor);
    return toBatchDTO(this.model, this.model.batches.get(batch.id), actor);
  }

  // ---------- 合批 ----------

  merge(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['sources']);
    if (!Array.isArray(input.sources) || input.sources.length < 2) {
      fail('validation_error', '合批至少需要两个来源批次');
    }
    const resolved = [];
    let product;
    let unit;
    for (const source of input.sources) {
      const batch = this.#resolve(source.batchRef);
      this.#requireWritable(batch);
      const qty = positiveQty(source.qty ?? batch.quantity, 'sources.qty');
      if (batch.quantity < qty) fail('conflict', `批次 ${batch.batchNo} 可用量 ${batch.quantity} 不足 ${qty}`);
      product = product ?? batch.product;
      unit = unit ?? batch.unit;
      if (batch.product !== product) fail('validation_error', '合批来源必须是同一产品');
      if (batch.unit !== unit) fail('validation_error', '合批来源计量单位不一致');
      resolved.push({ batch, qty });
    }
    if (new Set(resolved.map((r) => r.batch.id)).size < resolved.length) {
      fail('validation_error', '合批来源批次重复');
    }
    const identity = newBatchIdentity('merged', this.numbers);
    const occurredAt = input.mergedAt ? normalizeDateInput(input.mergedAt, 'mergedAt') : undefined;
    this.#append(
      T.BATCHES_MERGED,
      {
        ...identity,
        product,
        unit,
        warehouse: input.warehouse ?? resolved[0].batch.warehouse,
        sources: resolved.map((r) => ({ batchId: r.batch.id, batchNo: r.batch.batchNo, qty: r.qty })),
      },
      actor,
      occurredAt,
    );
    return toBatchDTO(this.model, this.model.batches.get(identity.batchId), actor);
  }

  // ---------- 拆包 ----------

  split(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'children']);
    if (!Array.isArray(input.children) || input.children.length < 2) {
      fail('validation_error', '拆包至少生成两个子批');
    }
    const parent = this.#resolve(input.batchRef);
    this.#requireWritable(parent);
    const children = input.children.map((child) => ({ qty: positiveQty(child.qty, 'children.qty'), warehouse: child.warehouse ?? null }));
    const total = children.reduce((sum, child) => sum + child.qty, 0);
    if (total - parent.quantity > 1e-9) fail('conflict', `拆出总量 ${total} 超过批次余量 ${parent.quantity}`);
    for (const child of children) Object.assign(child, newBatchIdentity('split', this.numbers));
    this.#append(
      T.BATCH_SPLIT,
      {
        batchId: parent.id,
        children: children.map((child) => ({ batchId: child.batchId, batchNo: child.batchNo, qty: child.qty, warehouse: child.warehouse })),
      },
      actor,
    );
    return {
      parent: toBatchDTO(this.model, this.model.batches.get(parent.id), actor),
      children: children.map((c) => toBatchDTO(this.model, this.model.batches.get(c.batchId), actor)),
    };
  }

  // ---------- 交付 ----------

  deliver(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'qty', 'customer', 'deliveredAt']);
    const batch = this.#resolve(input.batchRef);
    this.#requireWritable(batch);
    const qty = positiveQty(input.qty, 'qty');
    if (batch.quantity < qty) fail('conflict', `批次 ${batch.batchNo} 余量 ${batch.quantity} 不足交付 ${qty}`);
    const deliveredAt = normalizeDateInput(input.deliveredAt, 'deliveredAt');
    const deliveryId = randomId('dlv');
    this.#append(
      T.BATCH_DELIVERED,
      {
        deliveryId,
        batchId: batch.id,
        qty,
        customer: input.customer,
        contact: input.contact ?? null,
        deliveredAt,
      },
      actor,
      deliveredAt,
    );
    return this.model.batches.get(batch.id).deliveries.at(-1);
  }

  // ---------- 重编号（旧号永不消失） ----------

  renumber(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef']);
    const batch = this.#resolve(input.batchRef);
    const newBatchNo = this.numbers.next(batch.kind);
    this.#append(T.BATCH_RENUMBERED, { batchId: batch.id, oldBatchNo: batch.batchNo, newBatchNo, reason: input.reason ?? null }, actor);
    return { batchId: batch.id, batchNo: newBatchNo, aliases: this.model.batches.get(batch.id).aliases };
  }

  // ---------- 跨仓转移 ----------

  transfer(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'toWarehouse']);
    const batch = this.#resolve(input.batchRef);
    this.#requireWritable(batch);
    const qty = input.qty ? positiveQty(input.qty, 'qty') : batch.quantity;
    if (qty > batch.quantity) fail('conflict', `转移数量 ${qty} 超过批次余量 ${batch.quantity}`);
    if (input.toWarehouse === batch.warehouse) fail('validation_error', '目标仓库与当前仓库相同');
    this.#append(
      T.BATCH_TRANSFERRED,
      { batchId: batch.id, qty, fromWarehouse: batch.warehouse, toWarehouse: input.toWarehouse, reason: input.reason ?? null },
      actor,
    );
    return toBatchDTO(this.model, this.model.batches.get(batch.id), actor);
  }

  // ---------- 扫码（重复扫码只追加记录，不改链路） ----------

  scan(actor, input) {
    requireFields(input, ['batchRef', 'scanCode']);
    const batch = this.#resolve(input.batchRef);
    if (actor?.role === ROLES.SUPPLIER && !batch.supplierIds.has(actor.supplierId)) {
      fail('forbidden', '只能扫描与自身相关的批次');
    }
    const prior = this.model.scanIndex.get(input.scanCode);
    const duplicate = Boolean(prior);
    this.#append(
      T.BATCH_SCANNED,
      {
        scanCode: input.scanCode,
        batchId: batch.id,
        duplicate,
        firstBatchId: prior?.batchId ?? batch.id,
        scannerAt: actor?.name ?? null,
      },
      actor,
    );
    return {
      scanCode: input.scanCode,
      batchId: batch.id,
      batchNo: batch.batchNo,
      duplicate,
      firstSeenBatchId: prior?.batchId ?? batch.id,
      firstSeenAt: prior?.firstSeenAt ?? null,
      scanCount: this.model.batches.get(batch.id).scanCount,
    };
  }

  // ---------- 报废处置（锁定后允许报废） ----------

  partialScrap(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'qty']);
    const batch = this.#resolve(input.batchRef);
    const qty = positiveQty(input.qty, 'qty');
    if (qty > batch.quantity) fail('conflict', `报废数量 ${qty} 超过批次余量 ${batch.quantity}`);
    this.#append(
      T.BATCH_PARTIALLY_SCRAPPED,
      { batchId: batch.id, qty, reason: input.reason ?? null, lockdownId: batch.lockdownId },
      actor,
    );
    return toBatchDTO(this.model, this.model.batches.get(batch.id), actor);
  }

  dispose(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef']);
    const batch = this.#resolve(input.batchRef);
    this.#append(T.BATCH_DISPOSED, { batchId: batch.id, reason: input.reason ?? null, lockdownId: batch.lockdownId }, actor);
    return toBatchDTO(this.model, this.model.batches.get(batch.id), actor);
  }

  // ---------- 失效模拟与锁定 ----------

  /**
   * 计算某批次失效后的影响面，不落任何事件（dry-run）。
   * - 上游：来源采收批、地块、多户林农（混合成品可反向追到多户）；
   * - 下游：沿合批/拆包边正向展开，仍有库存的批次即精确锁定范围，
   *   不含该物料的拆分兄弟批不在范围内，避免“召回过宽”；
   * - 已交付部分生成下游客户通知清单；
   * - 库存余量按在库/已交付/已报废分别汇总。
   */
  impactOf(batchRef) {
    const origin = this.#resolve(batchRef);
    return computeImpact(this.model, origin.id);
  }

  /**
   * 正式执行失效管控：写 lockdown 记录、逐批写锁定事件、写通知事件。
   * 同一来源批次二次执行会被拒绝，避免重复通知。
   */
  lockdown(actor, input) {
    this.#requireEnterprise(actor);
    requireFields(input, ['batchRef', 'reason']);
    const origin = this.#resolve(input.batchRef);
    const existing = this.model.lockdowns.find((l) => l.originBatchId === origin.id);
    if (existing) {
      fail('already_locked', `来源批次 ${origin.batchNo} 已存在管控单 ${existing.lockdownId}（${existing.reason}）`, {
        lockdownId: existing.lockdownId,
      });
    }
    const impact = computeImpact(this.model, origin.id);
    if (input.dryRun) return impact;

    const lockdownId = randomId('ldk');
    const nowIso = new Date().toISOString();
    this.#append(
      T.LOCKDOWN_RECORDED,
      {
        lockdownId,
        originBatchId: origin.id,
        originBatchNo: origin.batchNo,
        reason: input.reason,
        inspectionId: input.inspectionId ?? null,
        affectedBatchIds: impact.lockCandidates.map((b) => b.batchId),
        deliveredImpact: impact.delivered,
        supplierIds: impact.suppliers.map((s) => s.supplierId),
        totals: impact.totals,
      },
      actor,
    );
    for (const candidate of impact.lockCandidates) {
      if (candidate.alreadyLocked) continue; // 已被另一管控单锁定的汇合批不重复写锁定事件
      this.#append(
        T.BATCH_LOCKED,
        { batchId: candidate.batchId, lockdownId, reason: input.reason, originBatchId: origin.id, lockedAt: nowIso },
        actor,
      );
    }
    if (impact.suppliers.length) {
      this.#append(
        T.NOTIFICATION_SENT,
        {
          notificationId: randomId('ntf'),
          lockdownId,
          kind: 'supplier_notice',
          channel: 'account_inbox',
          recipients: impact.suppliers.map((s) => ({ type: 'supplier', supplierId: s.supplierId })),
          subject: `批次 ${origin.batchNo} 失效协查通知`,
          body: `您交售的物料经批次 ${origin.batchNo} 判定受 ${input.reason} 影响，请配合封存与溯源。`,
          refBatchId: origin.id,
        },
        actor,
      );
    }
    for (const delivery of impact.delivered) {
      this.#append(
        T.NOTIFICATION_SENT,
        {
          notificationId: randomId('ntf'),
          lockdownId,
          kind: 'downstream_recall_notice',
          channel: 'customer_contact',
          recipients: [{ type: 'customer', customer: delivery.customer, contact: delivery.contact }],
          subject: `拆分批 ${delivery.batchNo} 召回/暂扣通知`,
          body: `${delivery.deliveredAt} 交付的 ${delivery.product} ${delivery.qty}${delivery.unit}（批次 ${delivery.batchNo}）受来源 ${origin.batchNo} 失效影响，请暂停使用并回执。`,
          refBatchId: delivery.batchId,
        },
        actor,
      );
    }
    return { lockdownId, ...computeImpact(this.model, origin.id), locked: true };
  }

  // ---------- 查询 ----------

  listPlots(actor) {
    let rows = [...this.model.plots.values()];
    if (actor.role === ROLES.SUPPLIER) rows = rows.filter((p) => p.supplierId === actor.supplierId);
    return rows;
  }

  getStandard(actor, product, at = null) {
    const entry = this.model.standards.get(product);
    if (!entry) fail('not_found', `产品暂无已发布标准：${product}`);
    if (at) {
      return { product, queriedAt: at, effective: effectiveStandardAt(this.model, product, normalizeDateInput(at, 'at')) };
    }
    return { product, current: entry.versions.at(-1), versions: entry.versions };
  }

  listLockdowns(actor) {
    this.#requireEnterprise(actor);
    return this.model.lockdowns;
  }

  listEvents(actor, { limit = 200 } = {}) {
    this.#requireEnterprise(actor);
    return this.store.all().slice(-limit).map((e) => ({
      seq: e.seq,
      id: e.id,
      type: e.type,
      payload: e.payload,
      actor: e.actor,
      occurredAt: e.occurredAt,
      prevHash: e.prevHash,
      hash: e.hash,
    }));
  }

  listBatches(actor, filters = {}) {
    let rows = [...this.model.batches.values()];
    if (actor.role === ROLES.SUPPLIER) rows = rows.filter((b) => b.supplierIds.has(actor.supplierId));
    if (filters.product) rows = rows.filter((b) => b.product === filters.product);
    if (filters.warehouse) rows = rows.filter((b) => b.warehouse === filters.warehouse);
    if (filters.status) rows = rows.filter((b) => b.status === filters.status);
    if (filters.locked !== undefined) rows = rows.filter((b) => b.locked === (filters.locked === 'true' || filters.locked === true));
    return rows.map((b) => toBatchDTO(this.model, b, actor));
  }

  getBatch(actor, ref, { asOf = null } = {}) {
    const model = asOf ? createReadModel(this.store.all(), { asOfTime: normalizeDateInput(asOf, 'asOf') }) : this.model;
    const id = resolveBatchId(model, ref);
    if (!id) fail('not_found', `批次不存在：${ref}`);
    const batch = model.batches.get(id);
    if (actor.role === ROLES.SUPPLIER && ![...batch.supplierIds].includes(actor.supplierId)) {
      fail('forbidden', '只能查看与自身相关的批次');
    }
    return toBatchDTO(model, batch, actor, { asOf });
  }

  trace(actor, ref) {
    const batch = this.#resolve(ref);
    if (actor.role === ROLES.SUPPLIER && ![...batch.supplierIds].includes(actor.supplierId)) {
      fail('forbidden', '只能查看与自身相关的批次');
    }
    const upstreamIds = traverse(this.model, batch.id, 'up');
    const downstreamIds = traverse(this.model, batch.id, 'down');
    const lineageIds = new Set([batch.id, ...upstreamIds, ...downstreamIds]);
    const plotIds = new Set();
    const supplierIds = new Set();
    let earliestProducedAt = batch.producedAt;
    for (const id of [batch.id, ...upstreamIds]) {
      const b = this.model.batches.get(id);
      b.plotIds.forEach((p) => plotIds.add(p));
      b.supplierIds.forEach((s) => supplierIds.add(s));
      if (b.producedAt && b.producedAt < earliestProducedAt) earliestProducedAt = b.producedAt;
    }
    const timeline = buildTimeline(this.store, this.model, lineageIds);
    return {
      batch: toBatchDTO(this.model, batch, actor),
      upstream: {
        batches: [...upstreamIds].map((id) => toBatchDTO(this.model, this.model.batches.get(id), actor)),
        plots: [...plotIds].map((id) => toPlotDTO(this.model, this.model.plots.get(id), actor)),
        suppliers: [...supplierIds].map((id) => toSupplierDTO(this.model, this.model.suppliers.get(id), actor)),
        standardAtProduction: effectiveStandardAt(this.model, batch.product, earliestProducedAt),
      },
      downstream: {
        batches: [...downstreamIds].map((id) => toBatchDTO(this.model, this.model.batches.get(id), actor)),
        deliveries: [...downstreamIds, batch.id].flatMap((id) =>
          this.model.batches.get(id).deliveries.map((d) => ({
            ...d,
            batchId: id,
            batchNo: this.model.batches.get(id).batchNo,
            product: this.model.batches.get(id).product,
            unit: this.model.batches.get(id).unit,
            // 林农只应看到与自身相关的处置存在性，不暴露下游客户身份
            ...(actor.role === ROLES.SUPPLIER ? { customer: '下游企业', contact: null } : {}),
          })),
        ),
      },
      timeline,
    };
  }

  listNotifications(actor) {
    const rows = this.model.notifications.filter((n) => {
      if (actor.role === ROLES.ENTERPRISE) return true;
      return n.recipients.some((r) => r.type === 'supplier' && r.supplierId === actor.supplierId);
    });
    return rows.map((n) => ({
      ...n,
      recipients: actor.role === ROLES.SUPPLIER ? n.recipients.filter((r) => r.type !== 'supplier' || r.supplierId === actor.supplierId) : n.recipients,
    }));
  }

  verifyChain() {
    return this.store.verify();
  }
}

// ---------- 追溯与影响面算法 ----------

function traverse(model, startId, direction) {
  const result = new Set();
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of model.edges) {
      const hit = direction === 'down' ? edge.from === current : edge.to === current;
      const next = direction === 'down' ? edge.to : edge.from;
      if (hit && next !== startId && !result.has(next)) {
        result.add(next);
        queue.push(next);
      }
    }
  }
  return result;
}

function computeImpact(model, originId) {
  const downstream = traverse(model, originId, 'down');
  const upstream = traverse(model, originId, 'up');
  const inScope = [originId, ...downstream];

  const lockCandidates = [];
  const delivered = [];
  let stockQty = 0;
  let deliveredQty = 0;
  let scrappedQty = 0;
  const supplierIds = new Set();

  for (const id of inScope) {
    const batch = model.batches.get(id);
    batch.supplierIds.forEach((s) => supplierIds.add(s));
    if (batch.quantity > 0 && batch.status !== '已报废') {
      lockCandidates.push({
        batchId: batch.id,
        batchNo: batch.batchNo,
        kind: batch.kind,
        warehouse: batch.warehouse,
        qty: batch.quantity,
        unit: batch.unit,
        alreadyLocked: batch.locked,
      });
      stockQty += batch.quantity;
    }
    scrappedQty += batch.disposedQty;
    for (const d of batch.deliveries) {
      deliveredQty += d.qty;
      delivered.push({ deliveryId: d.id, batchId: batch.id, batchNo: batch.batchNo, product: batch.product, qty: d.qty, unit: batch.unit, customer: d.customer, contact: d.contact, deliveredAt: d.deliveredAt });
    }
  }
  for (const id of upstream) {
    model.batches.get(id).supplierIds.forEach((s) => supplierIds.add(s));
  }

  const suppliers = [...supplierIds].map((sid) => {
    const supplier = model.suppliers.get(sid);
    return { supplierId: sid, name: supplier?.name ?? sid, contact: supplier?.contact ?? null };
  });

  return {
    originBatchId: originId,
    lockCandidates,
    delivered,
    suppliers,
    upstreamBatchIds: [...upstream],
    downstreamBatchIds: [...downstream],
    totals: { stockQty, deliveredQty, scrappedQty, unit: model.batches.get(originId).unit, affectedBatchCount: inScope.length },
  };
}

function evaluateLimits(metrics, limits) {
  const violations = [];
  for (const [name, spec] of Object.entries(limits ?? {})) {
    const value = metrics[name];
    if (value === undefined) continue;
    if (typeof spec === 'number') {
      if (value > spec) violations.push({ metric: name, value, limit: spec, rule: 'max' });
    } else if (spec?.max !== undefined && value > spec.max) {
      violations.push({ metric: name, value, limit: spec.max, rule: 'max' });
    } else if (spec?.min !== undefined && value < spec.min) {
      violations.push({ metric: name, value, limit: spec.min, rule: 'min' });
    }
  }
  return violations;
}

// ---------- DTO 与供应商视角脱敏 ----------

function maskSupplier(model, supplierId, viewer) {
  if (viewer?.role === ROLES.ENTERPRISE) return null;
  return viewer?.supplierId !== supplierId;
}

function toBatchDTO(model, batch, viewer) {
  const suppliers = [...batch.supplierIds].map((sid) => {
    const supplier = model.suppliers.get(sid);
    const masked = maskSupplier(model, sid, viewer);
    return {
      supplierId: sid,
      name: masked ? '其他供应商' : supplier?.name ?? sid,
      contact: masked ? null : supplier?.contact ?? null,
      self: viewer?.role === ROLES.SUPPLIER && viewer.supplierId === sid,
    };
  });
  const plots = batch.plotIds.map((pid) => toPlotDTO(model, model.plots.get(pid), viewer));
  return {
    batchId: batch.id,
    batchNo: batch.batchNo,
    aliases: batch.aliases,
    kind: batch.kind,
    product: batch.product,
    grade: batch.grade,
    status: batch.status,
    quantity: batch.quantity,
    initialQty: batch.initialQty,
    disposedQty: batch.disposedQty,
    deliveredQty: batch.deliveredQty,
    unit: batch.unit,
    warehouse: batch.warehouse,
    locked: batch.locked,
    lockReason: batch.lockReason,
    lockdownId: batch.lockdownId,
    createdAt: batch.createdAt,
    producedAt: batch.producedAt,
    parents: batch.parents,
    children: batch.children,
    suppliers,
    plots,
    inspections: viewer?.role === ROLES.SUPPLIER ? batch.inspections.map((i) => ({ inspectedAt: i.inspectedAt, verdict: i.verdict, standardVersion: i.standardVersion })) : batch.inspections,
    deliveries: viewer?.role === ROLES.SUPPLIER ? [] : batch.deliveries,
    scanCount: batch.scanCount,
    lastScannedAt: batch.lastScannedAt,
    transfers: batch.transfers,
  };
}

function toPlotDTO(model, plot, viewer) {
  if (!plot) return null;
  const masked = maskSupplier(model, plot.supplierId, viewer);
  return {
    plotId: plot.plotId,
    plotName: masked ? '其他地块' : plot.plotName,
    location: masked ? null : plot.location,
    product: plot.product,
    areaMu: plot.areaMu,
    supplierId: plot.supplierId,
    supplierName: masked ? '其他供应商' : plot.supplierName,
  };
}

function toSupplierDTO(model, supplier, viewer) {
  if (!supplier) return null;
  const masked = maskSupplier(model, supplier.id, viewer);
  return { supplierId: supplier.id, name: masked ? '其他供应商' : supplier.name, contact: masked ? null : supplier.contact };
}

function buildTimeline(store, model, batchIdSet) {
  const ids = batchIdSet instanceof Set ? batchIdSet : new Set([batchIdSet]);
  const items = [];
  for (const event of store.all()) {
    const p = event.payload;
    let related = ids.has(p.batchId);
    if (!related && p.sources?.some((s) => ids.has(s.batchId))) related = true;
    if (!related && p.children?.some((c) => ids.has(c.batchId))) related = true;
    if (!related) continue;
    items.push({
      seq: event.seq,
      occurredAt: event.occurredAt,
      type: event.type,
      actor: event.actor,
      summary: summarizeEvent(event, model),
    });
  }
  return items;
}

function summarizeEvent(event, model) {
  const p = event.payload;
  const batchNo = (id) => model.batches.get(id)?.batchNo ?? id;
  switch (event.type) {
    case T.BATCH_HARVESTED:
      return `采收登记 ${p.quantity}${p.unit}（${batchNo(p.batchId)}）`;
    case T.INSPECTION_RECORDED:
      return `${p.verdict}检验${p.late ? '（迟到补记）' : ''}，标准 ${p.standardVersion ?? '未指定'}`;
    case T.BATCH_GRADED:
      return `定级为 ${p.grade}`;
    case T.BATCHES_MERGED:
      return `合批生成 ${p.batchNo}，来源 ${p.sources.map((s) => s.batchNo).join('、')}`;
    case T.BATCH_SPLIT:
      return `拆包生成 ${p.children.map((c) => c.batchNo).join('、')}`;
    case T.BATCH_DELIVERED:
      return `交付 ${p.customer} ${p.qty}${model.batches.get(p.batchId)?.unit ?? ''}`;
    case T.BATCH_RENUMBERED:
      return `重编号：${p.oldBatchNo} → ${p.newBatchNo}（旧号保留为别名）`;
    case T.BATCH_TRANSFERRED:
      return `跨仓转移：${p.fromWarehouse ?? '未指定'} → ${p.toWarehouse}`;
    case T.BATCH_SCANNED:
      return p.duplicate ? `重复扫码（首见于 ${batchNo(p.firstBatchId)}）` : '首次扫码';
    case T.BATCH_LOCKED:
      return `批次锁定：${p.reason}`;
    case T.BATCH_PARTIALLY_SCRAPPED:
      return `部分报废 ${p.qty}`;
    case T.BATCH_DISPOSED:
      return `整批报废处置`;
    default:
      return event.type;
  }
}

export { DomainError };
