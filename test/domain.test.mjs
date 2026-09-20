import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventStore } from '../src/domain/eventStore.mjs';
import { TraceabilityService } from '../src/domain/traceability.mjs';

function freshService() {
  return new TraceabilityService(new EventStore());
}

/** 构造两家供应商、两块林地、两条采收批的基础场景。 */
function seedTwoSuppliers(service, enterprise) {
  const s1User = service.registerUser({ role: 'supplier', name: '张林农', supplierName: '张家林场', contact: '13800000001' });
  const s2User = service.registerUser({ role: 'supplier', name: '李药农', supplierName: '李家药园', contact: '13800000002' });
  const plot1 = service.registerPlot(enterprise, {
    plotName: '一号山地块',
    location: '云南普洱-1林班',
    product: '石斛',
    areaMu: 12,
    supplierId: s1User.supplierId,
  });
  const plot2 = service.registerPlot(enterprise, {
    plotName: '二号山地块',
    location: '云南普洱-2林班',
    product: '石斛',
    areaMu: 8,
    supplierId: s2User.supplierId,
  });
  return { s1User, s2User, plot1, plot2 };
}

test('混合成品可反向追踪到多户林农、来源地块与当时标准', () => {
  const service = freshService();
  const ent = service.registerUser({ role: 'enterprise', name: '王质量' });
  const { s1User, s2User, plot1, plot2 } = seedTwoSuppliers(service, ent);

  // v1 标准年初生效，v2 标准六月生效；三月采收的批次“当时标准”应为 v1
  service.publishStandard(ent, { product: '石斛', version: 'S-2025-v1', effectiveFrom: '2026-01-01', limits: { 农残: { max: 0.05 }, 水分: { max: 14 } } });
  service.publishStandard(ent, { product: '石斛', version: 'S-2026-v2', effectiveFrom: '2026-06-01', limits: { 农残: { max: 0.02 }, 水分: { max: 13 } } });

  const b1 = service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 100, unit: 'kg', harvestedAt: '2026-03-10', warehouse: '初加工仓' });
  const b2 = service.harvest(ent, { plotRef: plot2.plotId, product: '石斛', quantity: 60, unit: 'kg', harvestedAt: '2026-03-11', warehouse: '初加工仓' });
  assert.match(b1.batchNo, /^RC\d{6}$/);
  assert.notEqual(b1.batchNo, b2.batchNo, '批次号不得重复');

  // 三月检验应自动套用 v1 而非最新的 v2
  const inspection = service.recordInspection(ent, { batchRef: b1.batchId, inspectedAt: '2026-03-12', metrics: { 农残: 0.03, 水分: 12 } });
  assert.equal(inspection.standardVersion, 'S-2025-v1');
  assert.equal(inspection.verdict, '合格');

  service.grade(ent, { batchRef: b1.batchId, grade: '一级' });
  service.grade(ent, { batchRef: b2.batchId, grade: '二级' });

  // 收购商把不同林地、等级混成一个批次
  const merged = service.merge(ent, { sources: [{ batchRef: b1.batchId }, { batchRef: b2.batchId }], warehouse: '成品仓' });
  assert.equal(merged.quantity, 160);
  assert.deepEqual(new Set(merged.suppliers.map((s) => s.supplierId)), new Set([s1User.supplierId, s2User.supplierId]));

  // 混合成品拆成两个下游拆分批
  const splitResult = service.split(ent, { batchRef: merged.batchId, children: [{ qty: 100, warehouse: '成品仓' }, { qty: 60, warehouse: '发货仓' }] });
  const [c1, c2] = splitResult.children;

  const trace = service.trace(ent, merged.batchId);
  assert.equal(trace.upstream.plots.length, 2);
  assert.equal(trace.upstream.suppliers.length, 2);
  assert.equal(trace.upstream.standardAtProduction.version, 'S-2025-v1', '应追溯到采收当时生效的标准');
  assert.deepEqual(new Set(trace.downstream.batches.map((b) => b.batchId)), new Set([c1.batchId, c2.batchId]));
});

test('失效模拟给出精确锁定范围、库存余量与下游通知，不错伤干净批次', () => {
  const service = freshService();
  const ent = service.registerUser({ role: 'enterprise', name: '王质量' });
  const { plot1 } = seedTwoSuppliers(service, ent);
  service.publishStandard(ent, { product: '石斛', version: 'v1', effectiveFrom: '2026-01-01', limits: { 农残: { max: 0.05 } } });

  // A(失效嫌疑) 与 B 合批后拆成 C1/C2；C1 又与干净批 D 合批
  const a = service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 50, unit: 'kg', harvestedAt: '2026-07-01' });
  const plotB = service.registerPlot(ent, { plotName: 'B地块', location: '林区B', product: '石斛', areaMu: 5, supplierName: 'B农户' });
  const b = service.harvest(ent, { plotRef: plotB.plotId, product: '石斛', quantity: 50, unit: 'kg', harvestedAt: '2026-07-02' });
  const plotD = service.registerPlot(ent, { plotName: 'D地块', location: '林区D', product: '石斛', areaMu: 5, supplierName: 'D农户' });
  const d = service.harvest(ent, { plotRef: plotD.plotId, product: '石斛', quantity: 30, unit: 'kg', harvestedAt: '2026-07-03' });

  const m = service.merge(ent, { sources: [{ batchRef: a.batchId }, { batchRef: b.batchId }] });
  const { children } = service.split(ent, { batchRef: m.batchId, children: [{ qty: 60 }, { qty: 40 }] });
  const [c1, c2] = children;
  const m2 = service.merge(ent, { sources: [{ batchRef: c1.batchId }, { batchRef: d.batchId }] });

  // C2 已交付给客户；M2 部分交付；D 本身已合批无库存
  service.deliver(ent, { batchRef: c2.batchId, qty: 40, customer: '康健饮片厂', contact: 'buyer@kangjian.example', deliveredAt: '2026-07-10' });
  service.deliver(ent, { batchRef: m2.batchId, qty: 50, customer: '济世堂连锁', contact: '13900000000', deliveredAt: '2026-07-11' });

  const impact = service.impactOf(a.batchId);

  // 精确范围：A→M→C1/C2→M2；干净批 D 不在影响面内
  const affectedIds = new Set([impact.originBatchId, ...impact.downstreamBatchIds]);
  assert.ok(affectedIds.has(m.batchId));
  assert.ok(affectedIds.has(c1.batchId));
  assert.ok(affectedIds.has(c2.batchId));
  assert.ok(affectedIds.has(m2.batchId));
  assert.ok(!affectedIds.has(d.batchId), '不含该物料的干净合批输入不得被锁定');

  // 锁定候选只计在库余量：C2/M/D 余量为 0，仅剩 M2 的 40kg
  const lockNos = impact.lockCandidates.map((c) => c.batchNo);
  assert.deepEqual(lockNos, [m2.batchNo]);
  assert.equal(impact.totals.stockQty, 40);
  assert.equal(impact.totals.deliveredQty, 90);

  // 下游通知按拆分批/交付逐户生成，且能找到“已流向下游的拆分批”
  const customers = impact.delivered.map((x) => x.customer).sort();
  assert.deepEqual(customers, ['康健饮片厂', '济世堂连锁']);

  // 正式锁定：写管控单、锁定事件与通知事件
  const result = service.lockdown(ent, { batchRef: a.batchId, reason: '农残超标' });
  assert.equal(result.locked, true);
  assert.equal(service.model.batches.get(m2.batchId).locked, true);
  assert.throws(() => service.deliver(ent, { batchRef: m2.batchId, qty: 1, customer: 'X', deliveredAt: '2026-07-12' }), /锁定/);
  // 锁定后允许报废处置
  service.partialScrap(ent, { batchRef: m2.batchId, qty: 10, reason: '农残超标销毁' });
  assert.equal(service.model.batches.get(m2.batchId).quantity, 30);
  // 重复执行锁定被拒绝
  assert.throws(() => service.lockdown(ent, { batchRef: a.batchId, reason: '再次' }), /already_locked|管控单/);
});

test('迟到检验、重编号、部分报废、跨仓转移、重复扫码均不可改写既有链路', () => {
  const service = freshService();
  const ent = service.registerUser({ role: 'enterprise', name: '王质量' });
  const { plot1 } = seedTwoSuppliers(service, ent);
  service.publishStandard(ent, { product: '石斛', version: 'v1', effectiveFrom: '2026-01-01', limits: { 水分: { max: 13 } } });

  const batch = service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 100, unit: 'kg', harvestedAt: '2026-05-01' });
  const merged = service.merge(ent, { sources: [{ batchRef: batch.batchId }, { batchRef: service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 10, unit: 'kg', harvestedAt: '2026-05-02' }).batchId }] });

  const eventCountBefore = service.store.size;

  // 1) 批次已经合批后才补检来源批：标记为迟到，但只是新增事件
  const late = service.recordInspection(ent, { batchRef: batch.batchId, inspectedAt: '2026-05-01', metrics: { 水分: 15 } });
  assert.equal(late.late, true);
  assert.equal(late.verdict, '不合格');

  // 2) 重编号：新号可用，旧号作为别名仍可定位同一批次
  const renumbered = service.renumber(ent, { batchRef: merged.batchId, reason: '客户要求统一编码' });
  assert.equal(service.getBatch(ent, renumbered.batchNo).batchId, merged.batchId);
  assert.equal(service.getBatch(ent, merged.batchNo).batchId, merged.batchId, '旧号必须仍可解析');
  assert.ok(renumbered.aliases.includes(merged.batchNo));

  // 3) 跨仓转移与 4) 部分报废：只追加事实，履历时间线可回放
  service.transfer(ent, { batchRef: renumbered.batchNo, toWarehouse: '隔离仓', reason: '待检' });
  service.partialScrap(ent, { batchRef: renumbered.batchNo, qty: 20, reason: '霉变' });
  const after = service.getBatch(ent, merged.batchId);
  assert.equal(after.warehouse, '隔离仓');
  assert.equal(after.disposedQty, 20);
  assert.equal(after.quantity, 90);

  // 5) 重复扫码：同一码扫到不同批次被标记，首次扫码事实不变
  const scan1 = service.scan(ent, { batchRef: merged.batchId, scanCode: 'BOX-001' });
  const scan2 = service.scan(ent, { batchRef: service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 5, unit: 'kg', harvestedAt: '2026-05-03' }).batchId, scanCode: 'BOX-001' });
  assert.equal(scan1.duplicate, false);
  assert.equal(scan2.duplicate, true);
  assert.equal(scan2.firstSeenBatchId, merged.batchId);

  // 全部操作只追加，未删改任何早期事件
  const earlyEvents = service.store.all().slice(0, eventCountBefore);
  assert.equal(earlyEvents.length, eventCountBefore);
  const verification = service.verifyChain();
  assert.equal(verification.ok, true);

  // 时间线完整呈现六类事件
  const timeline = service.trace(ent, merged.batchId).timeline.map((t) => t.type);
  for (const type of ['batch.harvested', 'batches.merged', 'inspection.recorded', 'batch.renumbered', 'batch.transferred', 'batch.partially_scrapped']) {
    assert.ok(timeline.includes(type), `时间线缺少 ${type}`);
  }
});

test('供应商只能查看与自身相关的处置，其他主体被脱敏', () => {
  const service = freshService();
  const ent = service.registerUser({ role: 'enterprise', name: '王质量' });
  const { s1User, s2User, plot1, plot2 } = seedTwoSuppliers(service, ent);
  service.publishStandard(ent, { product: '石斛', version: 'v1', effectiveFrom: '2026-01-01' });
  const b1 = service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 100, unit: 'kg', harvestedAt: '2026-04-01' });
  const b2 = service.harvest(ent, { plotRef: plot2.plotId, product: '石斛', quantity: 80, unit: 'kg', harvestedAt: '2026-04-02' });
  const merged = service.merge(ent, { sources: [{ batchRef: b1.batchId }, { batchRef: b2.batchId }] });
  service.lockdown(ent, { batchRef: b1.batchId, reason: '农残异常' });

  const s1 = service.authenticate(s1User.apiKey);
  const s2 = service.authenticate(s2User.apiKey);

  // 不能直接查看他家采收批
  assert.throws(() => service.getBatch(s1, b2.batchId), /forbidden|只能|质量负责人|林农/);
  // 列表只含与自己相关的批次（含共同合批批）
  const visibleNos = service.listBatches(s1).map((b) => b.batchId);
  assert.ok(visibleNos.includes(b1.batchId) && visibleNos.includes(merged.batchId));
  assert.ok(!visibleNos.includes(b2.batchId));
  // 共同批次中其他供应商身份脱敏
  const mergedView = service.getBatch(s1, merged.batchId);
  const other = mergedView.suppliers.find((s) => !s.self);
  assert.equal(other.name, '其他供应商');
  assert.equal(other.contact, null);
  // 通知只收到发给自己的，看不到其他收件人
  const notices = service.listNotifications(s1);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].recipients.map((r) => r.supplierId), [s1User.supplierId]);
  assert.equal(service.listNotifications(s2).length, 1);
  // 供应商不能执行管控或合批
  assert.throws(() => service.lockdown(s1, { batchRef: b1.batchId, reason: 'x' }), /forbidden|只能|质量负责人|林农/);
  assert.throws(() => service.merge(s1, { sources: [{ batchRef: b1.batchId }, { batchRef: b2.batchId }] }), /forbidden|只能|质量负责人|林农/);
});

test('历史时点重放回答“当时库存/当时状态”，且哈希链可发现篡改', () => {
  const service = freshService();
  const ent = service.registerUser({ role: 'enterprise', name: '王质量' });
  const { plot1 } = seedTwoSuppliers(service, ent);
  const batch = service.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 100, unit: 'kg', harvestedAt: '2026-02-01' });
  service.partialScrap(ent, { batchRef: batch.batchId, qty: 40, reason: '水分超标' });

  const nowView = service.getBatch(ent, batch.batchId);
  assert.equal(nowView.quantity, 60);
  const thenView = service.getBatch(ent, batch.batchId, { asOf: '2026-03-01' });
  assert.equal(thenView.quantity, 100, '历史时点重放应还原报废前库存');

  // 模拟有人改写历史采收事件
  const harvestEvent = service.store.all().find((e) => e.type === 'batch.harvested');
  const tamperedSeq = harvestEvent.seq;
  harvestEvent.payload.quantity = 999;
  const verification = service.verifyChain();
  assert.equal(verification.ok, false);
  assert.equal(verification.atSeq, tamperedSeq);
});

test('账本持久化到 JSONL 后重启可完整重放，批次号不复用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'ledger.jsonl');
  try {
    const store1 = new EventStore({ filePath: file });
    const service1 = new TraceabilityService(store1);
    const ent = service1.registerUser({ role: 'enterprise', name: '王质量' });
    const { plot1 } = seedTwoSuppliers(service1, ent);
    const b1 = service1.harvest(ent, { plotRef: plot1.plotId, product: '石斛', quantity: 10, unit: 'kg', harvestedAt: '2026-01-01' });

    const store2 = new EventStore({ filePath: file });
    const service2 = new TraceabilityService(store2);
    assert.equal(service2.verifyChain().ok, true);
    assert.equal(service2.getBatch(ent2(service2), b1.batchId).quantity, 10);
    const next = service2.harvest(ent2(service2), { plotRef: plot1.plotId, product: '石斛', quantity: 5, unit: 'kg', harvestedAt: '2026-01-02' });
    assert.notEqual(next.batchNo, b1.batchNo);
    assert.ok(next.batchNo > b1.batchNo, '重启后号码应继续递增，不复用旧号');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function ent2(service) {
  return [...service.model.users.values()].find((u) => u.role === 'enterprise');
}
