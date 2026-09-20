import assert from 'node:assert/strict';
import test from 'node:test';
import { EventStore } from '../src/domain/eventStore.mjs';
import { TraceabilityService } from '../src/domain/traceability.mjs';
import { createApp } from '../src/http/app.mjs';

async function withServer(service, run) {
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function freshService() {
  return new TraceabilityService(new EventStore());
}

async function api(base, method, path, { apiKey, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

test('HTTP 全链路：注册→地块→标准→采收→合批拆包→交付→失效管控→供应商隔离查看', async () => {
  const service = freshService();
  await withServer(service, async (base) => {
    // 注册双方
    const entReg = await api(base, 'POST', '/api/auth/register', { body: { role: 'enterprise', name: '王质量' } });
    assert.equal(entReg.status, 200);
    const entKey = entReg.body.apiKey;
    const sup1 = await api(base, 'POST', '/api/auth/register', { body: { role: 'supplier', name: '张林农', supplierName: '张家林场' } });
    const sup2 = await api(base, 'POST', '/api/auth/register', { body: { role: 'supplier', name: '李药农', supplierName: '李家药园' } });
    assert.match(sup1.body.apiKey, /^key-supplier-/);

    // 无密钥 / 错误密钥被拒
    assert.equal((await api(base, 'GET', '/api/batches')).status, 401);
    assert.equal((await api(base, 'GET', '/api/batches', { apiKey: 'bad-key' })).status, 401);

    // 供应商不能注册地块（角色路由）
    const forbidden = await api(base, 'POST', '/api/plots', {
      apiKey: sup1.body.apiKey,
      body: { plotName: 'X', location: 'Y', product: '石斛', areaMu: 1 },
    });
    assert.equal(forbidden.status, 403);

    const plot1 = await api(base, 'POST', '/api/plots', {
      apiKey: entKey,
      body: { plotName: '一号山', location: '普洱1林班', product: '石斛', areaMu: 12, supplierId: sup1.body.supplierId },
    });
    const plot2 = await api(base, 'POST', '/api/plots', {
      apiKey: entKey,
      body: { plotName: '二号山', location: '普洱2林班', product: '石斛', areaMu: 8, supplierId: sup2.body.supplierId },
    });

    await api(base, 'POST', '/api/standards', {
      apiKey: entKey,
      body: { product: '石斛', version: 'v1', effectiveFrom: '2026-01-01', limits: { 农残: { max: 0.05 } } },
    });

    const h1 = await api(base, 'POST', '/api/batches/harvest', {
      apiKey: entKey,
      body: { plotRef: plot1.body.plotId, product: '石斛', quantity: 100, unit: 'kg', harvestedAt: '2026-07-01' },
    });
    const h2 = await api(base, 'POST', '/api/batches/harvest', {
      apiKey: entKey,
      body: { plotRef: plot2.body.plotId, product: '石斛', quantity: 60, unit: 'kg', harvestedAt: '2026-07-02' },
    });

    // 农残超标检验
    const insp = await api(base, 'POST', '/api/inspections', {
      apiKey: entKey,
      body: { batchRef: h1.body.batchId, inspectedAt: '2026-07-03', metrics: { 农残: 0.09 } },
    });
    assert.equal(insp.body.verdict, '不合格');
    assert.equal(insp.body.violations[0].metric, '农残');

    const merged = await api(base, 'POST', '/api/batches/merge', {
      apiKey: entKey,
      body: { sources: [{ batchRef: h1.body.batchId }, { batchRef: h2.body.batchId }] },
    });
    assert.equal(merged.body.quantity, 160);

    const split = await api(base, 'POST', '/api/batches/split', {
      apiKey: entKey,
      body: { batchRef: merged.body.batchId, children: [{ qty: 100 }, { qty: 60 }] },
    });
    const [c1, c2] = split.body.children;

    await api(base, 'POST', '/api/batches/deliver', {
      apiKey: entKey,
      body: { batchRef: c2.batchId, qty: 60, customer: '康健饮片厂', contact: 'buyer@x.example', deliveredAt: '2026-07-10' },
    });

    // 失效影响模拟（不落事件）
    const impact = await api(base, 'POST', '/api/lockdowns/impact', { apiKey: entKey, body: { batchRef: h1.body.batchId } });
    assert.equal(impact.status, 200);
    assert.deepEqual(impact.body.lockCandidates.map((x) => x.batchId), [c1.batchId]);
    assert.equal(impact.body.totals.deliveredQty, 60);
    assert.equal(impact.body.delivered[0].customer, '康健饮片厂');

    // 执行管控
    const lockdown = await api(base, 'POST', '/api/lockdowns', {
      apiKey: entKey,
      body: { batchRef: h1.body.batchId, reason: '农残超标' },
    });
    assert.equal(lockdown.status, 200);
    assert.equal(lockdown.body.locked, true);

    // 锁定后流转被拒
    const blocked = await api(base, 'POST', '/api/batches/deliver', {
      apiKey: entKey,
      body: { batchRef: c1.batchId, qty: 1, customer: 'X', deliveredAt: '2026-07-11' },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'batch_locked');

    // 追溯：任何成品追到来源地块
    const trace = await api(base, 'GET', `/api/batches/${merged.body.batchId}/trace`, { apiKey: entKey });
    const plotNames = trace.body.upstream.plots.map((p) => p.plotName).sort();
    assert.deepEqual(plotNames, ['一号山', '二号山']);
    assert.equal(trace.body.upstream.standardAtProduction.version, 'v1');

    // 旧批次号经重编号后仍可追溯
    await api(base, 'POST', '/api/batches/renumber', { apiKey: entKey, body: { batchRef: c1.batchId, reason: '统一编码' } });
    const byOld = await api(base, 'GET', `/api/batches/${c1.batchNo}`, { apiKey: entKey });
    assert.equal(byOld.status, 200);
    assert.equal(byOld.body.batchId, c1.batchId);

    // 供应商只能看到自己相关批次，且其他供应商被脱敏
    const s1List = await api(base, 'GET', '/api/batches', { apiKey: sup1.body.apiKey });
    const ids = s1List.body.map((b) => b.batchId);
    assert.ok(ids.includes(h1.body.batchId) && ids.includes(merged.body.batchId));
    assert.ok(!ids.includes(h2.body.batchId));
    const mergedForS1 = s1List.body.find((b) => b.batchId === merged.body.batchId);
    assert.equal(mergedForS1.suppliers.find((s) => !s.self).name, '其他供应商');

    // 供应商不能直查他家采收批
    assert.equal((await api(base, 'GET', `/api/batches/${h2.body.batchId}`, { apiKey: sup1.body.apiKey })).status, 403);

    // 每家供应商只收到自己的通知
    const n1 = await api(base, 'GET', '/api/notifications', { apiKey: sup1.body.apiKey });
    const n2 = await api(base, 'GET', '/api/notifications', { apiKey: sup2.body.apiKey });
    assert.equal(n1.body.length, 1);
    assert.equal(n2.body.length, 1);
    assert.deepEqual(n1.body[0].recipients.map((r) => r.supplierId), [sup1.body.supplierId]);
    // 企业可看到全部通知（1 条林农协查 + 1 条下游召回）
    const nEnt = await api(base, 'GET', '/api/notifications', { apiKey: entKey });
    assert.equal(nEnt.body.length, 2);

    // 账本完整性
    const verify = await api(base, 'GET', '/api/ledger/verify', { apiKey: entKey });
    assert.equal(verify.body.ok, true);
    // 供应商无权审计账本
    assert.equal((await api(base, 'GET', '/api/ledger/verify', { apiKey: sup1.body.apiKey })).status, 403);
  });
});

test('历史时点查询与重复扫码告警通过 HTTP 工作', async () => {
  const service = freshService();
  await withServer(service, async (base) => {
    const ent = await api(base, 'POST', '/api/auth/register', { body: { role: 'enterprise', name: 'Q' } });
    const key = ent.body.apiKey;
    const sup = await api(base, 'POST', '/api/auth/register', { body: { role: 'supplier', name: '张', supplierName: '张家' } });
    const plot = await api(base, 'POST', '/api/plots', {
      apiKey: key,
      body: { plotName: 'P', location: 'L', product: '天麻', areaMu: 3, supplierId: sup.body.supplierId },
    });
    const batch = await api(base, 'POST', '/api/batches/harvest', {
      apiKey: key,
      body: { plotRef: plot.body.plotId, product: '天麻', quantity: 50, unit: 'kg', harvestedAt: '2026-03-01' },
    });

    const scan1 = await api(base, 'POST', '/api/batches/scan', { apiKey: key, body: { batchRef: batch.body.batchId, scanCode: 'BOX-9' } });
    assert.equal(scan1.body.duplicate, false);
    const batch2 = await api(base, 'POST', '/api/batches/harvest', {
      apiKey: key,
      body: { plotRef: plot.body.plotId, product: '天麻', quantity: 8, unit: 'kg', harvestedAt: '2026-03-02' },
    });
    const scan2 = await api(base, 'POST', '/api/batches/scan', { apiKey: key, body: { batchRef: batch2.body.batchId, scanCode: 'BOX-9' } });
    assert.equal(scan2.body.duplicate, true);
    assert.equal(scan2.body.firstSeenBatchId, batch.body.batchId);

    await api(base, 'POST', '/api/batches/partial-scrap', { apiKey: key, body: { batchRef: batch.body.batchId, qty: 20 } });
    const nowView = await api(base, 'GET', `/api/batches/${batch.body.batchId}`, { apiKey: key });
    assert.equal(nowView.body.quantity, 30);
    const thenView = await api(base, 'GET', `/api/batches/${batch.body.batchId}?asOf=2026-03-05`, { apiKey: key });
    assert.equal(thenView.body.quantity, 50, '时点查询还原报废前库存');

    // 参数校验
    const bad = await api(base, 'POST', '/api/batches/harvest', {
      apiKey: key,
      body: { plotRef: plot.body.plotId, product: '天麻', quantity: -1, unit: 'kg', harvestedAt: '2026-03-01' },
    });
    assert.equal(bad.status, 400);
  });
});
