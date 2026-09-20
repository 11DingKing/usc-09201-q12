import http from 'node:http';
import path from 'node:path';
import { EventStore } from './domain/eventStore.mjs';
import { TraceabilityService } from './domain/traceability.mjs';
import { createApp } from './http/app.mjs';

/**
 * 组装并启动可独立运行的履历服务。
 * 事件账本默认持久化到 data/ledger.jsonl；设置 LEDGER_FILE=memory 可使用纯内存账本。
 */
export function createServer({ ledgerFile } = {}) {
  const resolvedFile = ledgerFile ?? (process.env.LEDGER_FILE === 'memory' ? null : process.env.LEDGER_FILE || path.resolve('data/ledger.jsonl'));
  const store = new EventStore({ filePath: resolvedFile });
  const service = new TraceabilityService(store);
  return createApp(service);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`林产品批次履历服务已启动：http://0.0.0.0:${port}`);
  });
}
