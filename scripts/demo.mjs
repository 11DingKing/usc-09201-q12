// 端到端演示：石斛混批加工 -> 抽检反向追踪 -> 失效模拟 -> 供应商视角。
// 运行：npm run demo

import { createServer } from '../src/server.mjs';

const server = await createServer({ dataFile: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const QUALITY = { 'content-type': 'application/json', 'x-role': 'quality' };

async function postEvent(type, payload, extra = {}) {
  const res = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: QUALITY,
    body: JSON.stringify({ type, payload, ...extra }),
  });
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${type} 失败：${JSON.stringify(json)}`);
  return json;
}

async function get(path, headers = { 'x-role': 'quality' }) {
  const res = await fetch(`${base}${path}`, { headers });
  return res.json();
}

function section(title) {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
}

function show(data) {
  console.log(JSON.stringify(data, null, 2));
}

// ─注册基础数据
section('1. 登记地块、林农与质量标准');
await postEvent('supplier_registered', { supplierId: 'S-01', name: '林农甲' });
await postEvent('supplier_registered', { supplierId: 'S-02', name: '林农乙' });
await postEvent('plot_registered', { plotId: 'P-1001', name: '青溪阴坡林', location: '青溪村一组', ownerName: '林农甲', area: '12亩' });
await postEvent('plot_registered', { plotId: 'P-1002', name: '青溪阳坡林', location: '青溪村二组', ownerName: '林农乙', area: '9亩' });
await postEvent('standard_published', {
  standardId: 'STD-SH-2026A',
  product: '石斛',
  version: '2026-A',
  effectiveFrom: '2026-01-01T00:00:00Z',
  limits: { moistureMax: 0.12, pesticideResidueMax: 0.2 },
});
console.log('已登记 2 名林农、2 块林地、石斛标准 2026-A（水分≤0.12，农残≤0.2）');

// 采收与检验
section('2. 采收、检验、分级');
await postEvent('harvested', { batchId: 'B-SH-001', product: '石斛', plotId: 'P-1001', supplierId: 'S-01', quantity: 100, unit: 'kg' }, { occurredAt: '2026-03-01T08:00:00Z' });
await postEvent('harvested', { batchId: 'B-SH-002', product: '石斛', plotId: 'P-1002', supplierId: 'S-02', quantity: 80, unit: 'kg' }, { occurredAt: '2026-03-03T08:00:00Z' });
await postEvent('inspected', { batchId: 'B-SH-001', moisture: 0.1, pesticideResidue: 0.1, lab: '县质检站' }, { occurredAt: '2026-03-02T09:00:00Z' });
await postEvent('inspected', { batchId: 'B-SH-002', moisture: 0.09, pesticideResidue: 0.12, lab: '县质检站' }, { occurredAt: '2026-03-04T09:00:00Z' });
await postEvent('graded', { batchId: 'B-SH-001', grade: '一级' });
await postEvent('graded', { batchId: 'B-SH-002', grade: '二级' });
console.log('B-SH-001（林农甲 100kg 一级）、B-SH-002（林农乙 80kg 二级），初检均合格');

// 加工：合批、拆包、转移、重编号
section('3. 合批、拆包、跨仓转移、重编号');
await postEvent('merged', {
  sources: [
    { batchId: 'B-SH-001', quantity: 60 },
    { batchId: 'B-SH-002', quantity: 50 },
  ],
  targetBatchId: 'B-MIX-001',
  location: '加工区',
}, { occurredAt: '2026-03-10T10:00:00Z' });
await postEvent('split', {
  sourceBatchId: 'B-MIX-001',
  parts: [
    { batchId: 'B-RET-01', quantity: 40, location: '仓库A' },
    { batchId: 'B-RET-02', quantity: 40, location: '仓库A' },
  ],
}, { occurredAt: '2026-03-12T10:00:00Z' });
await postEvent('transferred', { batchId: 'B-RET-02', fromLocation: '仓库A', toLocation: '仓库B' });
await postEvent('renumbered', { batchId: 'B-RET-01', newCode: 'RET-2026-0001' });
console.log('B-MIX-001 = 60kg(B-SH-001) + 50kg(B-SH-002)；拆出 B-RET-01/B-RET-02 各 40kg；');
console.log('B-RET-02 转移至仓库B；B-RET-01 重编号为 RET-2026-0001');

// 交付、部分报废、重复扫码
section('4. 交付、部分报废与重复扫码幂等');
await postEvent('delivered', { batchId: 'RET-2026-0001', customer: '康泰药业', quantity: 30 }, { occurredAt: '2026-03-15T10:00:00Z', idempotencyKey: 'scan-RET-01-30' });
await postEvent('delivered', { batchId: 'B-RET-02', customer: '和顺堂', quantity: 20 }, { occurredAt: '2026-03-16T10:00:00Z' });
await postEvent('scrapped', { batchId: 'B-MIX-001', quantity: 5, reason: '局部霉变' }, { occurredAt: '2026-03-18T10:00:00Z' });
const dup = await postEvent('delivered', { batchId: 'RET-2026-0001', customer: '康泰药业', quantity: 30 }, { idempotencyKey: 'scan-RET-01-30' });
console.log(`重复扫码同一交付事件 -> deduplicated=${dup.deduplicated}（余量不会被重复扣减）`);

// 反向追溯
section('5. 从成品 RET-2026-0001 反向追溯到地块与当时标准');
show(await get('/api/batches/RET-2026-0001/trace-back'));

// 迟到检验：监管复检发现农残超标
section('6. 迟到检验：监管复检补录，B-SH-002 农残超标');
await postEvent('inspected', { batchId: 'B-SH-002', moisture: 0.11, pesticideResidue: 0.25, lab: '省监督抽检', note: '采样于合批前，报告迟到' }, { occurredAt: '2026-03-05T09:00:00Z' });
console.log('迟到检验已追加（按采样时有效的 2026-A 版标准判定：农残 0.25 > 0.2，不合格）');

// 失效模拟
section('7. 对 B-SH-002 做失效模拟：锁定范围 / 库存余量 / 下游通知');
const simulation = await fetch(`${base}/api/simulations/failure`, {
  method: 'POST',
  headers: QUALITY,
  body: JSON.stringify({ batchId: 'B-SH-002', applyLock: true }),
}).then((r) => r.json());
show(simulation);

// 供应商视角
section('8. 供应商视角：林农乙（S-02）只能看到与自身相关的信息');
const asS02 = { 'x-role': 'supplier', 'x-supplier-id': 'S-02' };
console.log('-- 可见批次（自己的采收批 + 含有自己物料的下游批次）：');
show(await get('/api/batches', asS02));
console.log('-- 混合批反向追溯（其他林农身份脱敏）：');
show(await get('/api/batches/B-MIX-001/trace-back', asS02));
console.log('-- 与自身相关的处置记录：');
show(await get('/api/dispositions', asS02));

await new Promise((resolve) => server.close(resolve));
console.log('\n演示完成。');
