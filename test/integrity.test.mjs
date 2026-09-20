// 完整性与权限：幂等去重（重复扫码）、重编号/转移/报废不改写链路、
// 供应商数据隔离与脱敏、输入校验、事件流持久化重放。

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.mjs';
import { seedBase, startApp } from './helpers.mjs';

test('重复扫码被幂等去重：同一幂等键只生效一次', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    const payload = { batchId: 'B-SH-001', customer: '康泰药业', quantity: 30 };
    const first = await app.call('POST', '/api/events', {
      body: { type: 'delivered', payload, idempotencyKey: 'scan-0001' },
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.deduplicated, false);
    // 同一扫码重复提交（网络重试/扫码枪连发）
    const second = await app.call('POST', '/api/events', {
      body: { type: 'delivered', payload, idempotencyKey: 'scan-0001' },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.deduplicated, true);
    assert.equal(second.body.event.id, first.body.event.id);
    // 余量只扣减一次
    const batch = await app.call('GET', '/api/batches/B-SH-001');
    assert.equal(batch.body.batch.remaining, 70);
    const events = await app.call('GET', '/api/events?type=delivered');
    assert.equal(events.body.events.length, 1);
  } finally {
    await app.close();
  }
});

test('重编号、跨仓转移、部分报废不改写既有追溯链路', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await app.postEvent('merged', {
      sources: [
        { batchId: 'B-SH-001', quantity: 60 },
        { batchId: 'B-SH-002', quantity: 50 },
      ],
      targetBatchId: 'B-MIX-001',
    });
    await app.postEvent('split', {
      sourceBatchId: 'B-MIX-001',
      parts: [{ batchId: 'B-RET-01', quantity: 40 }],
    });
    const before = await app.call('GET', '/api/batches/B-RET-01/trace-back');
    // 重编号 + 跨仓转移 + 部分报废
    await app.postEvent('renumbered', { batchId: 'B-RET-01', newCode: 'RET-NEW-9' });
    await app.postEvent('transferred', { batchId: 'RET-NEW-9', toLocation: '仓库C' });
    await app.postEvent('scrapped', { batchId: 'RET-NEW-9', quantity: 4, reason: '抽检损耗' });
    const after = await app.call('GET', '/api/batches/RET-NEW-9/trace-back');
    // 链路（来源、贡献量、标准版本）完全一致
    assert.deepEqual(after.body.ancestors, before.body.ancestors);
    assert.equal(after.body.batch.id, 'B-RET-01');
    assert.equal(after.body.batch.location, '仓库C');
    assert.equal(after.body.batch.remaining, 36);
    // 新旧编码都能解析到同一批次
    const byOld = await app.call('GET', '/api/batches/B-RET-01');
    const byNew = await app.call('GET', '/api/batches/RET-NEW-9');
    assert.equal(byOld.body.batch.id, byNew.body.batch.id);
  } finally {
    await app.close();
  }
});

test('锁定批次禁止合批/拆包/交付/转移，解锁后恢复', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    await app.postEvent('locked', { batchId: 'B-SH-001', reason: '疑似农残超标，等待复检' });
    const attempts = [
      { type: 'delivered', payload: { batchId: 'B-SH-001', customer: '某客户', quantity: 1 } },
      { type: 'transferred', payload: { batchId: 'B-SH-001', toLocation: '仓库B' } },
      { type: 'split', payload: { sourceBatchId: 'B-SH-001', parts: [{ quantity: 10 }] } },
      {
        type: 'merged',
        payload: {
          sources: [
            { batchId: 'B-SH-001', quantity: 10 },
            { batchId: 'B-SH-002', quantity: 10 },
          ],
        },
      },
    ];
    for (const body of attempts) {
      const res = await app.call('POST', '/api/events', { body });
      assert.equal(res.status, 409, `${body.type} 应被拒绝`);
      assert.equal(res.body.error, 'batch_locked');
    }
    // 锁定批次允许报废（处置手段）
    const scrap = await app.postEvent('scrapped', { batchId: 'B-SH-001', quantity: 2, reason: '污染部分剔除' });
    assert.equal(scrap.status, 201);
    // 重复锁定报错；解锁后交付恢复
    const relock = await app.postEvent('locked', { batchId: 'B-SH-001', reason: '重复' });
    assert.equal(relock.status, 409);
    await app.postEvent('unlocked', { batchId: 'B-SH-001' });
    const deliver = await app.postEvent('delivered', { batchId: 'B-SH-001', customer: '康泰药业', quantity: 5 });
    assert.equal(deliver.status, 201);
    const batch = await app.call('GET', '/api/batches/B-SH-001');
    assert.equal(batch.body.batch.remaining, 93); // 100 - 2 报废 - 5 交付
  } finally {
    await app.close();
  }
});

test('输入校验与冲突处理', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    // 缺少必填字段
    const missing = await app.call('POST', '/api/events', {
      body: { type: 'harvested', payload: { product: '石斛' } },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'validation_failed');
    // 未知事件类型
    const unknownType = await app.call('POST', '/api/events', {
      body: { type: 'teleported', payload: {} },
    });
    assert.equal(unknownType.status, 400);
    assert.equal(unknownType.body.error, 'unknown_event_type');
    // 批次编码重复
    const dup = await app.postEvent('harvested', {
      batchId: 'B-SH-001',
      product: '石斛',
      plotId: 'P-1001',
      supplierId: 'S-01',
      quantity: 5,
      unit: 'kg',
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'batch_code_exists');
    // 合批余量不足
    const overMerge = await app.postEvent('merged', {
      sources: [
        { batchId: 'B-SH-001', quantity: 999 },
        { batchId: 'B-SH-002', quantity: 10 },
      ],
    });
    assert.equal(overMerge.status, 409);
    assert.equal(overMerge.body.error, 'insufficient_quantity');
    // 单一来源不能合批
    const single = await app.postEvent('merged', { sources: [{ batchId: 'B-SH-001', quantity: 10 }] });
    assert.equal(single.status, 400);
    // 拆包超出余量
    const overSplit = await app.postEvent('split', {
      sourceBatchId: 'B-SH-001',
      parts: [{ quantity: 60 }, { quantity: 60 }],
    });
    assert.equal(overSplit.status, 409);
    // 转移转出地不匹配（乐观并发）
    const mismatch = await app.postEvent('transferred', {
      batchId: 'B-SH-001',
      fromLocation: '仓库B',
      toLocation: '仓库C',
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error, 'location_mismatch');
    // 重编号到已占用编码
    const renumber = await app.postEvent('renumbered', { batchId: 'B-SH-001', newCode: 'B-SH-002' });
    assert.equal(renumber.status, 409);
    // 不存在的批次 / 地块 / 供应商
    const noBatch = await app.call('GET', '/api/batches/NOPE');
    assert.equal(noBatch.status, 404);
    const noPlot = await app.postEvent('harvested', {
      product: '石斛',
      plotId: 'P-XXXX',
      supplierId: 'S-01',
      quantity: 1,
      unit: 'kg',
    });
    assert.equal(noPlot.status, 404);
    assert.equal(noPlot.body.error, 'unknown_plot');
    // 非法 JSON
    const raw = await app.call('POST', '/api/events', { body: undefined });
    assert.equal(raw.status, 400); // 空 body 缺少 type
  } finally {
    await app.close();
  }
});

test('供应商只能查看与自身相关的批次、追溯与处置，其余脱敏', async () => {
  const app = await startApp();
  try {
    await seedBase(app);
    // 第三方供应商的独立批次
    await app.postEvent('supplier_registered', { supplierId: 'S-03', name: '林农丙' });
    await app.postEvent('plot_registered', { plotId: 'P-1003', name: '远处山林', ownerName: '林农丙' });
    await app.postEvent('harvested', {
      batchId: 'B-XX-001',
      product: '天麻',
      plotId: 'P-1003',
      supplierId: 'S-03',
      quantity: 50,
      unit: 'kg',
    });
    // 混批 + 交付 + 报废
    await app.postEvent('merged', {
      sources: [
        { batchId: 'B-SH-001', quantity: 60 },
        { batchId: 'B-SH-002', quantity: 50 },
      ],
      targetBatchId: 'B-MIX-001',
    });
    await app.postEvent('delivered', { batchId: 'B-MIX-001', customer: '康泰药业', quantity: 20 });
    await app.postEvent('locked', { batchId: 'B-MIX-001', reason: '复检等待' });
    await app.postEvent('scrapped', { batchId: 'B-XX-001', quantity: 5, reason: '虫蛀' });

    const asS01 = { role: 'supplier', supplierId: 'S-01' };
    // 批次列表：自己的采收批 + 含有自己物料的混合批；看不到他人批次
    const list = await app.call('GET', '/api/batches', asS01);
    const ids = list.body.batches.map((b) => b.id).sort();
    assert.deepEqual(ids, ['B-MIX-001', 'B-SH-001']);
    const own = list.body.batches.find((b) => b.id === 'B-SH-001');
    assert.equal(own.supplierId, 'S-01');
    assert.equal(own.plotId, 'P-1001');
    // 他人批次详情不可见（404，不泄露存在性）
    const other = await app.call('GET', '/api/batches/B-SH-002', asS01);
    assert.equal(other.status, 404);
    const unrelated = await app.call('GET', '/api/batches/B-XX-001', asS01);
    assert.equal(unrelated.status, 404);
    // 反向追溯：自己的来源完整，其他贡献者脱敏
    const trace = await app.call('GET', '/api/batches/B-MIX-001/trace-back', asS01);
    const ancestors = trace.body.ancestors;
    const ownAncestor = ancestors.find((a) => a.batchId === 'B-SH-001');
    assert.equal(ownAncestor.supplierId, 'S-01');
    const masked = ancestors.find((a) => a.batchId === 'B-SH-002');
    assert.equal(masked.masked, true);
    assert.equal(masked.supplierId, undefined);
    assert.equal(trace.body.maskedContributors, 1);
    // 正向追溯：可见下游，但客户身份脱敏
    const forward = await app.call('GET', '/api/batches/B-SH-001/trace-forward', asS01);
    assert.equal(forward.body.deliveries.length, 1);
    assert.equal(forward.body.deliveries[0].customer, '***');
    assert.equal(forward.body.deliveries[0].quantity, 20);
    // 处置记录：只看到与自身相关的（混合批锁定），看不到他人批次报废
    const dispositions = await app.call('GET', '/api/dispositions', asS01);
    assert.equal(dispositions.body.dispositions.length, 1);
    assert.equal(dispositions.body.dispositions[0].batchId, 'B-MIX-001');
    assert.equal(dispositions.body.dispositions[0].type, 'lock');
    // 供应商只读：写操作与质量专属接口被拒绝
    const write = await app.call('POST', '/api/events', {
      ...asS01,
      body: { type: 'graded', payload: { batchId: 'B-SH-001', grade: '特级' } },
    });
    assert.equal(write.status, 403);
    const events = await app.call('GET', '/api/events', asS01);
    assert.equal(events.status, 403);
    const suppliers = await app.call('GET', '/api/suppliers', asS01);
    assert.equal(suppliers.status, 403);
    const simulation = await app.call('POST', '/api/simulations/failure', {
      ...asS01,
      body: { batchId: 'B-SH-001' },
    });
    assert.equal(simulation.status, 403);
    // 未认证与缺供应商标识
    const noRole = await app.call('GET', '/api/batches', { role: null });
    assert.equal(noRole.status, 401);
    const noSupplierId = await app.call('GET', '/api/batches', { role: 'supplier' });
    assert.equal(noSupplierId.status, 401);
  } finally {
    await app.close();
  }
});

test('事件流持久化：重启后从 JSONL 完整重放状态', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lp-trace-'));
  const dataFile = path.join(dir, 'events.jsonl');
  try {
    const first = await createServer({ dataFile });
    await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
    const port = first.address().port;
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-role': 'quality' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 201);
    };
    await post({ type: 'supplier_registered', payload: { supplierId: 'S-01', name: '林农甲' } });
    await post({ type: 'plot_registered', payload: { plotId: 'P-1001', name: '青溪阴坡林' } });
    await post({
      type: 'harvested',
      payload: { batchId: 'B-SH-001', product: '石斛', plotId: 'P-1001', supplierId: 'S-01', quantity: 100, unit: 'kg' },
    });
    await post({
      type: 'delivered',
      payload: { batchId: 'B-SH-001', customer: '康泰药业', quantity: 30 },
      idempotencyKey: 'persist-scan-1',
    });
    await new Promise((resolve) => first.close(resolve));

    // 第二个服务实例从同一文件重放
    const second = await createServer({ dataFile });
    await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
    const port2 = second.address().port;
    const get = async (p) => {
      const res = await fetch(`http://127.0.0.1:${port2}${p}`, {
        headers: { 'x-role': 'quality' },
      });
      return res.json();
    };
    const detail = await get('/api/batches/B-SH-001');
    assert.equal(detail.batch.remaining, 70);
    assert.equal(detail.events.length, 2); // harvested + delivered
    // 幂等键在重启后仍然有效
    const res = await fetch(`http://127.0.0.1:${port2}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-role': 'quality' },
      body: JSON.stringify({
        type: 'delivered',
        payload: { batchId: 'B-SH-001', customer: '康泰药业', quantity: 30 },
        idempotencyKey: 'persist-scan-1',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deduplicated, true);
    const after = await get('/api/batches/B-SH-001');
    assert.equal(after.batch.remaining, 70);
    await new Promise((resolve) => second.close(resolve));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
