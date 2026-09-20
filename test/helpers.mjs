// 测试辅助：启动内存模式服务并返回简洁的调用客户端。

import { createServer } from '../src/server.mjs';

export async function startApp(options = {}) {
  const server = await createServer({ dataFile: null, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, { body, role = 'quality', supplierId, headers = {} } = {}) {
    const finalHeaders = { 'content-type': 'application/json', ...headers };
    if (role) finalHeaders['x-role'] = role;
    if (supplierId) finalHeaders['x-supplier-id'] = supplierId;
    const response = await fetch(base + path, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json };
  }

  const postEvent = (type, payload, extra = {}) =>
    call('POST', '/api/events', { body: { type, payload, ...extra } });

  return {
    server,
    call,
    postEvent,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// 常用种子数据：两名林农、两块地、两版石斛标准
export async function seedBase(app) {
  await app.postEvent('supplier_registered', { supplierId: 'S-01', name: '林农甲' });
  await app.postEvent('supplier_registered', { supplierId: 'S-02', name: '林农乙' });
  await app.postEvent('plot_registered', { plotId: 'P-1001', name: '青溪阴坡林', ownerName: '林农甲' });
  await app.postEvent('plot_registered', { plotId: 'P-1002', name: '青溪阳坡林', ownerName: '林农乙' });
  await app.postEvent('standard_published', {
    standardId: 'STD-SH-V1',
    product: '石斛',
    version: '2026-A',
    effectiveFrom: '2026-01-01T00:00:00Z',
    limits: { moistureMax: 0.12, pesticideResidueMax: 0.2 },
  });
  await app.postEvent('standard_published', {
    standardId: 'STD-SH-V2',
    product: '石斛',
    version: '2026-B',
    effectiveFrom: '2026-06-01T00:00:00Z',
    limits: { moistureMax: 0.1, pesticideResidueMax: 0.15 },
  });
  await app.postEvent(
    'harvested',
    { batchId: 'B-SH-001', product: '石斛', plotId: 'P-1001', supplierId: 'S-01', quantity: 100, unit: 'kg' },
    { occurredAt: '2026-03-01T08:00:00Z' },
  );
  await app.postEvent(
    'harvested',
    { batchId: 'B-SH-002', product: '石斛', plotId: 'P-1002', supplierId: 'S-02', quantity: 80, unit: 'kg' },
    { occurredAt: '2026-03-03T08:00:00Z' },
  );
}
