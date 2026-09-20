// 主流程：采收 -> 检验 -> 分级 -> 合批 -> 拆包 -> 转移 -> 重编号 -> 交付 -> 部分报废，
// 验证反向追溯（地块/林农/当时标准）、正向追溯与失效模拟。

import assert from 'node:assert/strict';
import test from 'node:test';
import { seedBase, startApp } from './helpers.mjs';

// 构建完整链路，返回应用句柄
async function buildChain(app) {
  await app.postEvent(
    'inspected',
    { batchId: 'B-SH-001', moisture: 0.1, pesticideResidue: 0.1, lab: '县质检站' },
    { occurredAt: '2026-03-02T09:00:00Z' },
  );
  await app.postEvent(
    'inspected',
    { batchId: 'B-SH-002', moisture: 0.09, pesticideResidue: 0.12, lab: '县质检站' },
    { occurredAt: '2026-03-04T09:00:00Z' },
  );
  await app.postEvent('graded', { batchId: 'B-SH-001', grade: '一级' });
  await app.postEvent('graded', { batchId: 'B-SH-002', grade: '二级' });
  await app.postEvent(
    'merged',
    {
      sources: [
        { batchId: 'B-SH-001', quantity: 60 },
        { batchId: 'B-SH-002', quantity: 50 },
      ],
      targetBatchId: 'B-MIX-001',
      location: '加工区',
    },
    { occurredAt: '2026-03-10T10:00:00Z' },
  );
  await app.postEvent(
    'split',
    {
      sourceBatchId: 'B-MIX-001',
      parts: [
        { batchId: 'B-RET-01', quantity: 40, location: '仓库A' },
        { batchId: 'B-RET-02', quantity: 40, location: '仓库A' },
      ],
    },
    { occurredAt: '2026-03-12T10:00:00Z' },
  );
  await app.postEvent('transferred', { batchId: 'B-RET-02', fromLocation: '仓库A', toLocation: '仓库B' });
  await app.postEvent('renumbered', { batchId: 'B-RET-01', newCode: 'RET-2026-0001' });
  await app.postEvent(
    'delivered',
    { batchId: 'RET-2026-0001', customer: '康泰药业', quantity: 30 },
    { occurredAt: '2026-03-15T10:00:00Z' },
  );
  await app.postEvent(
    'delivered',
    { batchId: 'B-RET-02', customer: '和顺堂', quantity: 20 },
    { occurredAt: '2026-03-16T10:00:00Z' },
  );
  await app.postEvent(
    'scrapped',
    { batchId: 'B-MIX-001', quantity: 5, reason: '局部霉变' },
    { occurredAt: '2026-03-18T10:00:00Z' },
  );
}

test('完整链路后各批次余量与位置正确', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await buildChain(app);
    const { body } = await app.call('GET', '/api/batches');
    const byId = new Map(body.batches.map((b) => [b.id, b]));
    assert.equal(byId.get('B-SH-001').remaining, 40);
    assert.equal(byId.get('B-SH-002').remaining, 30);
    assert.equal(byId.get('B-MIX-001').remaining, 25); // 110 - 40 - 40 - 5
    assert.equal(byId.get('B-RET-01').remaining, 10); // 40 - 30 交付
    assert.equal(byId.get('B-RET-01').location, '仓库A');
    assert.equal(byId.get('B-RET-02').remaining, 20); // 40 - 20 交付
    assert.equal(byId.get('B-RET-02').location, '仓库B');
    assert.deepEqual(byId.get('B-RET-01').codes, ['B-RET-01', 'RET-2026-0001']);
    assert.equal(byId.get('B-RET-01').grade, '未分级'); // 拆包继承混合批次等级
    assert.equal(byId.get('B-MIX-001').kind, 'merged');
  } finally {
    await app.close();
  }
});

test('成品反向追溯到地块、林农与当时有效标准', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await buildChain(app);
    // 用重编号后的新编码追溯，链路不变
    const { status, body } = await app.call('GET', '/api/batches/RET-2026-0001/trace-back');
    assert.equal(status, 200);
    assert.equal(body.batch.id, 'B-RET-01');
    assert.equal(body.ancestors.length, 2);

    const fromA = body.ancestors.find((a) => a.batchId === 'B-SH-001');
    assert.equal(fromA.supplierId, 'S-01');
    assert.equal(fromA.plotId, 'P-1001');
    assert.equal(fromA.harvestedAt, '2026-03-01T08:00:00Z');
    assert.equal(fromA.standardVersion, '2026-A'); // 采收时有效的标准版本
    assert.ok(Math.abs(fromA.contributedQuantity - 21.818182) < 1e-6); // 40 × 60/110

    const fromB = body.ancestors.find((a) => a.batchId === 'B-SH-002');
    assert.equal(fromB.supplierId, 'S-02');
    assert.equal(fromB.plotId, 'P-1002');
    assert.ok(Math.abs(fromB.contributedQuantity - 18.181818) < 1e-6); // 40 × 50/110

    assert.equal(body.batchStandard.version, '2026-A'); // 拆包发生时有效的标准
    // 检验记录覆盖成品链路上的来源批次
    const inspectedBatches = new Set(body.inspections.map((i) => i.batchId));
    assert.ok(inspectedBatches.has('B-SH-001'));
    assert.ok(inspectedBatches.has('B-SH-002'));
    assert.ok([...inspectedBatches].every((id) => ['B-SH-001', 'B-SH-002'].includes(id)));
    assert.equal(body.inspections[0].standardVersion, '2026-A');
  } finally {
    await app.close();
  }
});

test('来源批次正向追溯到下游批次与交付记录', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await buildChain(app);
    const { status, body } = await app.call('GET', '/api/batches/B-SH-002/trace-forward');
    assert.equal(status, 200);
    const descendantIds = body.descendants.map((d) => d.id);
    assert.deepEqual(descendantIds, ['B-MIX-001', 'B-RET-01', 'B-RET-02']);
    const mix = body.descendants.find((d) => d.id === 'B-MIX-001');
    assert.equal(mix.containedQuantity, 50); // 混合批次中有 50kg 来自 B-SH-002
    const customers = body.deliveries.map((d) => d.customer).sort();
    assert.deepEqual(customers, ['和顺堂', '康泰药业']);
    assert.equal(body.scraps.length, 1);
    assert.equal(body.scraps[0].quantity, 5);
  } finally {
    await app.close();
  }
});

test('失效模拟给出锁定范围、库存余量与下游通知，applyLock 真正冻结', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await buildChain(app);
    const { status, body } = await app.call('POST', '/api/simulations/failure', {
      body: { batchId: 'B-SH-002' },
    });
    assert.equal(status, 200);
    // 锁定范围：源批次余量 30 + 混合批 25 + 两个零售批 10 + 20
    const locked = new Map(body.lockScope.map((i) => [i.batchId, i]));
    assert.equal(locked.size, 4);
    assert.equal(locked.get('B-SH-002').remaining, 30);
    assert.equal(locked.get('B-MIX-001').remaining, 25);
    assert.equal(locked.get('B-RET-01').remaining, 10);
    assert.equal(locked.get('B-RET-02').remaining, 20);
    assert.equal(body.totals.lockedQuantity, 85);
    // 库存余量按仓库汇总
    const balance = new Map(body.inventoryBalance.map((i) => [i.location, i.quantity]));
    assert.equal(balance.get('待检区'), 30);
    assert.equal(balance.get('加工区'), 25);
    assert.equal(balance.get('仓库A'), 10);
    assert.equal(balance.get('仓库B'), 20);
    // 下游通知按客户汇总
    const notify = new Map(body.downstreamNotifications.map((n) => [n.customer, n.totalQuantity]));
    assert.equal(notify.get('康泰药业'), 30);
    assert.equal(notify.get('和顺堂'), 20);
    assert.equal(body.totals.notifiedCustomers, 2);
    // 来源信息：失效批次自身的林农与地块
    assert.deepEqual(body.origin.suppliers, ['S-02']);
    assert.deepEqual(body.origin.plots, ['P-1002']);

    // applyLock 真正冻结全部范围内批次
    const applied = await app.call('POST', '/api/simulations/failure', {
      body: { batchId: 'B-SH-002', applyLock: true },
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.appliedLocks.length, 4);
    const after = await app.call('GET', '/api/batches/B-RET-01');
    assert.equal(after.body.batch.locked, true);
    // 锁定批次禁止交付
    const blocked = await app.call('POST', '/api/events', {
      body: { type: 'delivered', payload: { batchId: 'B-RET-01', customer: '某客户', quantity: 1 } },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'batch_locked');
    // 重复执行 applyLock 幂等：已锁定的跳过，不报错
    const again = await app.call('POST', '/api/simulations/failure', {
      body: { batchId: 'B-SH-002', applyLock: true },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.appliedLocks.length, 0);
  } finally {
    await app.close();
  }
});

test('迟到检验按当时标准判定并追加，不改写既有链路', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await buildChain(app);
    // 监管复检迟到补录：采样时间早于合批，农残超标
    const late = await app.postEvent(
      'inspected',
      { batchId: 'B-SH-002', moisture: 0.11, pesticideResidue: 0.25, lab: '省监督抽检', note: '迟到补录' },
      { occurredAt: '2026-03-05T09:00:00Z' },
    );
    assert.equal(late.status, 201);
    // 判定依据是采样时（2026-03-05）有效的 2026-A 版标准（限值 0.2）
    const batch = await app.call('GET', '/api/batches/B-SH-002');
    assert.equal(batch.body.batch.flagged, true);
    const lateInspection = batch.body.inspections.find((i) => i.lab === '省监督抽检');
    assert.equal(lateInspection.result, 'fail');
    assert.equal(lateInspection.standardVersion, '2026-A');
    assert.deepEqual(lateInspection.failures, [
      { item: 'pesticideResidue 农残', value: 0.25, limit: 0.2 },
    ]);
    // 既有链路未被改写：成品追溯结果与之前一致
    const trace = await app.call('GET', '/api/batches/RET-2026-0001/trace-back');
    assert.equal(trace.body.ancestors.length, 2);
    const fromB = trace.body.ancestors.find((a) => a.batchId === 'B-SH-002');
    assert.ok(Math.abs(fromB.contributedQuantity - 18.181818) < 1e-6);
    // 迟到检验出现在成品的检验记录中
    assert.ok(trace.body.inspections.some((i) => i.lab === '省监督抽检'));
  } finally {
    await app.close();
  }
});

test('检验判定随标准版本切换：同一数值在不同时间结论不同', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    // 2026-03：2026-A 版水分上限 0.12，0.11 合格
    const spring = await app.postEvent(
      'inspected',
      { batchId: 'B-SH-001', moisture: 0.11, pesticideResidue: 0.1 },
      { occurredAt: '2026-03-02T09:00:00Z' },
    );
    assert.equal(spring.status, 201);
    // 2026-07：2026-B 版水分上限收紧到 0.10，0.11 不合格
    const summer = await app.postEvent(
      'inspected',
      { batchId: 'B-SH-001', moisture: 0.11, pesticideResidue: 0.1 },
      { occurredAt: '2026-07-02T09:00:00Z' },
    );
    assert.equal(summer.status, 201);
    const batch = await app.call('GET', '/api/batches/B-SH-001');
    const [first, second] = batch.body.inspections;
    assert.equal(first.result, 'pass');
    assert.equal(first.standardVersion, '2026-A');
    assert.equal(second.result, 'fail');
    assert.equal(second.standardVersion, '2026-B');
    assert.equal(batch.body.batch.flagged, true);
  } finally {
    await app.close();
  }
});
