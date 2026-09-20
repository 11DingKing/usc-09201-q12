// HTTP 服务：薄路由层，所有业务规则在 domain.mjs / trace.mjs 中。
// 认证采用演示级请求头身份：x-role: quality | supplier（supplier 需附 x-supplier-id）。

import http from 'node:http';

import {
  DomainError,
  EVENT_TYPES,
  applyEvent,
  createProjection,
  resolveBatch,
} from './domain.mjs';
import {
  listDispositions,
  simulateFailure,
  traceBack,
  traceForward,
} from './trace.mjs';
import {
  presentBatch,
  presentTraceBack,
  presentTraceForward,
  requireQuality,
  resolveActor,
  supplierScope,
} from './access.mjs';
import { EventStore } from './store.mjs';

const MAX_BODY_BYTES = 1_000_000;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError(413, 'payload_too_large', '请求体超过大小限制');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function matchPattern(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// 事件是否触及某批次（采收/检验/合批来源与目标/拆包子批/转移/交付/报废/重编号/锁定）
function eventTouchesBatch(event, canonicalId, projection) {
  const p = event.payload ?? {};
  const ids = [
    p.batchId,
    p.sourceBatchId,
    p.targetBatchId,
    ...(Array.isArray(p.sources) ? p.sources.map((s) => s?.batchId) : []),
    ...(Array.isArray(p.parts) ? p.parts.map((s) => s?.batchId) : []),
  ].filter(Boolean);
  return ids.some((id) => resolveBatch(projection, id)?.id === canonicalId);
}

export async function createServer(options = {}) {
  const dataFile =
    options.dataFile === undefined
      ? process.env.DATA_FILE || 'data/events.jsonl'
      : options.dataFile;
  const store = new EventStore(dataFile);
  await store.load();
  const projection = createProjection();
  projection.events = store.events; // 投影事件列表与存储共享同一追加序列
  for (const event of store.events) applyEvent(projection, event);

  // 提交一条事件：幂等去重 -> 领域校验 -> 追加落盘。校验失败不会产生任何副作用。
  async function commit(type, payload, { occurredAt, idempotencyKey } = {}) {
    if (idempotencyKey) {
      const existing = store.findByKey(idempotencyKey);
      if (existing) return { event: existing, deduplicated: true };
    }
    const now = new Date().toISOString();
    const event = {
      id: `EV-${String(store.events.length + 1).padStart(6, '0')}`,
      seq: store.events.length + 1,
      type,
      payload,
      occurredAt: occurredAt ?? now,
      recordedAt: now,
      idempotencyKey: idempotencyKey ?? null,
    };
    applyEvent(projection, event);
    await store.append(event);
    return { event, deduplicated: false };
  }

  function mustResolveBatch(idOrCode) {
    const batch = resolveBatch(projection, idOrCode);
    if (!batch) throw new DomainError(404, 'unknown_batch', `批次不存在：${idOrCode}`);
    return batch;
  }

  function scopeFor(actor) {
    return actor.role === 'supplier' ? supplierScope(projection, actor.supplierId) : null;
  }

  const routes = [
    ['GET', '/health', () => [200, { status: 'ok' }]],
    [
      'GET',
      '/',
      () => [
        200,
        {
          name: '林产品批次履历系统',
          version: '0.1.0',
          roles: {
            quality: '质量负责人：全部读写权限',
            supplier: '供应商：只读，且仅可见与自身相关的批次与处置（需 x-supplier-id）',
          },
          endpoints: [
            'POST /api/events 追加事件（quality）：type + payload + occurredAt? + idempotencyKey?',
            'GET  /api/events 事件流（quality），可用 ?batchId= &type= 过滤',
            'GET  /api/batches 批次列表（按角色过滤），可用 ?product= &location= &locked= &flagged= 过滤',
            'GET  /api/batches/:id 批次详情（含事件履历与检验记录）',
            'GET  /api/batches/:id/trace-back 反向追溯：来源地块、林农、当时标准',
            'GET  /api/batches/:id/trace-forward 正向追溯：下游批次、交付与报废',
            'POST /api/simulations/failure 失效模拟（quality）：{batchId, applyLock?}',
            'GET  /api/dispositions 处置记录（锁定/报废/检验不合格，按角色过滤）',
            'GET  /api/standards 质量标准版本列表',
            'GET  /api/suppliers 供应商列表（quality）',
            'GET  /api/plots 地块列表（quality）',
          ],
          eventTypes: EVENT_TYPES,
        },
      ],
    ],
    [
      'POST',
      '/api/events',
      async ({ actor, body }) => {
        requireQuality(actor);
        const { type, payload, occurredAt, idempotencyKey } = body ?? {};
        if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) {
          throw new DomainError(400, 'unknown_event_type', `未知事件类型：${JSON.stringify(type)}`);
        }
        if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new DomainError(400, 'validation_failed', 'payload 必须是对象');
        }
        if (occurredAt !== undefined && occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) {
          throw new DomainError(400, 'validation_failed', 'occurredAt 必须是可解析的时间');
        }
        const { event, deduplicated } = await commit(type, payload, { occurredAt, idempotencyKey });
        return [deduplicated ? 200 : 201, { event, deduplicated }];
      },
    ],
    [
      'GET',
      '/api/events',
      ({ actor, query }) => {
        requireQuality(actor);
        let events = projection.events;
        const batchFilter = query.get('batchId');
        if (batchFilter) {
          const batch = mustResolveBatch(batchFilter);
          events = events.filter((ev) => eventTouchesBatch(ev, batch.id, projection));
        }
        const typeFilter = query.get('type');
        if (typeFilter) events = events.filter((ev) => ev.type === typeFilter);
        return [200, { events }];
      },
    ],
    [
      'GET',
      '/api/batches',
      ({ actor, query }) => {
        const scope = scopeFor(actor);
        let batches = [...projection.batches.values()];
        if (scope) batches = batches.filter((b) => scope.has(b.id));
        const product = query.get('product');
        if (product) batches = batches.filter((b) => b.product === product);
        const location = query.get('location');
        if (location) batches = batches.filter((b) => b.location === location);
        if (query.get('locked') === 'true') batches = batches.filter((b) => b.locked);
        if (query.get('flagged') === 'true') batches = batches.filter((b) => b.flagged);
        return [200, { batches: batches.map((b) => presentBatch(b, actor)) }];
      },
    ],
    [
      'GET',
      '/api/batches/:id',
      ({ actor, params }) => {
        const batch = mustResolveBatch(params.id);
        const scope = scopeFor(actor);
        if (scope && !scope.has(batch.id)) {
          throw new DomainError(404, 'unknown_batch', `批次不存在：${params.id}`);
        }
        const events = projection.events.filter((ev) => eventTouchesBatch(ev, batch.id, projection));
        const inspections = projection.inspections.filter((i) => i.batchId === batch.id);
        return [200, { batch: presentBatch(batch, actor), inspections, events }];
      },
    ],
    [
      'GET',
      '/api/batches/:id/trace-back',
      ({ actor, params }) => {
        const batch = mustResolveBatch(params.id);
        const scope = scopeFor(actor);
        if (scope && !scope.has(batch.id)) {
          throw new DomainError(404, 'unknown_batch', `批次不存在：${params.id}`);
        }
        return [200, presentTraceBack(traceBack(projection, batch.id), actor)];
      },
    ],
    [
      'GET',
      '/api/batches/:id/trace-forward',
      ({ actor, params }) => {
        const batch = mustResolveBatch(params.id);
        const scope = scopeFor(actor);
        if (scope && !scope.has(batch.id)) {
          throw new DomainError(404, 'unknown_batch', `批次不存在：${params.id}`);
        }
        return [200, presentTraceForward(traceForward(projection, batch.id), actor)];
      },
    ],
    [
      'POST',
      '/api/simulations/failure',
      async ({ actor, body }) => {
        requireQuality(actor);
        const { batchId, applyLock } = body ?? {};
        if (!batchId) throw new DomainError(400, 'validation_failed', '缺少必填字段：batchId');
        const batch = mustResolveBatch(batchId);
        const result = simulateFailure(projection, batch.id);
        const appliedLocks = [];
        if (applyLock === true) {
          for (const item of result.lockScope) {
            const target = projection.batches.get(item.batchId);
            if (!target || target.locked) continue;
            const { event } = await commit(
              'locked',
              { batchId: target.id, reason: `失效模拟锁定（源头批次：${batch.id}）` },
              { idempotencyKey: `auto-lock:${batch.id}:${target.id}` },
            );
            appliedLocks.push({ batchId: target.id, eventId: event.id });
          }
        }
        return [200, { ...result, appliedLocks }];
      },
    ],
    [
      'GET',
      '/api/dispositions',
      ({ actor }) => {
        const scope = scopeFor(actor);
        let dispositions = listDispositions(projection);
        if (scope) dispositions = dispositions.filter((d) => scope.has(d.batchId));
        return [200, { dispositions }];
      },
    ],
    ['GET', '/api/standards', () => [200, { standards: projection.standards }]],
    [
      'GET',
      '/api/suppliers',
      ({ actor }) => {
        requireQuality(actor);
        return [200, { suppliers: [...projection.suppliers.values()] }];
      },
    ],
    [
      'GET',
      '/api/plots',
      ({ actor }) => {
        requireQuality(actor);
        return [200, { plots: [...projection.plots.values()] }];
      },
    ],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let matched = null;
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const params = matchPattern(pattern, url.pathname);
        if (params) {
          matched = { handler, params };
          break;
        }
      }
      if (!matched) {
        send(res, 404, { error: 'not_found', message: '接口不存在' });
        return;
      }
      const actor = url.pathname.startsWith('/api/') ? resolveActor(req.headers) : { role: 'anonymous' };
      const body = req.method === 'POST' ? await readJson(req) : {};
      const [status, data] = await matched.handler({
        actor,
        params: matched.params,
        query: url.searchParams,
        body,
      });
      send(res, status, data);
    } catch (err) {
      if (err instanceof DomainError) {
        send(res, err.status, { error: err.code, message: err.message, details: err.details });
      } else {
        console.error(err);
        send(res, 500, { error: 'internal_error', message: '服务内部错误' });
      }
    }
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  const server = await createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`林产品批次履历系统已启动：http://0.0.0.0:${port}`);
  });
}
