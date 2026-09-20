import http from 'node:http';
import { DomainError } from '../domain/errors.mjs';
import { ROLES } from '../domain/events.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MAX_BODY_BYTES = 1_000_000;

const STATUS_BY_CODE = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  batch_locked: 409,
  already_locked: 409,
};

/**
 * 组装 HTTP 服务。鉴权方式：请求头 X-API-Key。
 * 供应商与企业看到的数据范围由领域层强制，HTTP 层只做角色路由。
 */
export function createApp(service) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return send(response, 200, {
          name: '林产品批次履历系统',
          docs: 'POST /api/* 需要 X-API-Key；注册接口 POST /api/auth/register 一次性返回 apiKey',
          endpoints: Object.keys(ROUTES),
        });
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(service, request, response, url);
      }
      return send(response, 404, { error: 'not_found' });
    } catch (error) {
      return handleError(response, error);
    }
  });
  return server;
}

/** 路由表：'METHOD /path/template' -> handler(ctx)。 */
const ROUTES = {
  'POST /api/auth/register': (ctx) => ctx.service.registerUser(ctx.body),

  'POST /api/plots': enterprise((ctx) => ctx.service.registerPlot(ctx.actor, ctx.body)),
  'GET /api/plots': (ctx) => listPlots(ctx),

  'POST /api/standards': enterprise((ctx) => ctx.service.publishStandard(ctx.actor, ctx.body)),
  'GET /api/standards/:product': (ctx) => getStandard(ctx),

  'POST /api/batches/harvest': (ctx) => ctx.service.harvest(ctx.actor, ctx.body),
  'POST /api/inspections': enterprise((ctx) => ctx.service.recordInspection(ctx.actor, ctx.body)),
  'POST /api/grades': enterprise((ctx) => ctx.service.grade(ctx.actor, ctx.body)),
  'POST /api/batches/merge': enterprise((ctx) => ctx.service.merge(ctx.actor, ctx.body)),
  'POST /api/batches/split': enterprise((ctx) => ctx.service.split(ctx.actor, ctx.body)),
  'POST /api/batches/deliver': enterprise((ctx) => ctx.service.deliver(ctx.actor, ctx.body)),
  'POST /api/batches/renumber': enterprise((ctx) => ctx.service.renumber(ctx.actor, ctx.body)),
  'POST /api/batches/transfer': enterprise((ctx) => ctx.service.transfer(ctx.actor, ctx.body)),
  'POST /api/batches/scan': (ctx) => ctx.service.scan(ctx.actor, ctx.body),
  'POST /api/batches/partial-scrap': enterprise((ctx) => ctx.service.partialScrap(ctx.actor, ctx.body)),
  'POST /api/batches/dispose': enterprise((ctx) => ctx.service.dispose(ctx.actor, ctx.body)),

  'POST /api/lockdowns/impact': enterprise((ctx) => ctx.service.impactOf(ctx.body.batchRef)),
  'POST /api/lockdowns': enterprise((ctx) => ctx.service.lockdown(ctx.actor, ctx.body)),
  'GET /api/lockdowns': enterprise((ctx) => listLockdowns(ctx)),

  'GET /api/batches': (ctx) => ctx.service.listBatches(ctx.actor, Object.fromEntries(ctx.url.searchParams)),
  'GET /api/batches/:ref': (ctx) => ctx.service.getBatch(ctx.actor, ctx.params.ref, { asOf: ctx.url.searchParams.get('asOf') }),
  'GET /api/batches/:ref/trace': (ctx) => ctx.service.trace(ctx.actor, ctx.params.ref),
  'GET /api/batches/:ref/impact': enterprise((ctx) => ctx.service.impactOf(ctx.params.ref)),

  'GET /api/notifications': (ctx) => ctx.service.listNotifications(ctx.actor),
  'GET /api/ledger/verify': enterprise((ctx) => ctx.service.verifyChain()),
  'GET /api/ledger/events': enterprise((ctx) => listEvents(ctx)),
};

function enterprise(handler) {
  return (ctx) => {
    if (ctx.actor.role !== ROLES.ENTERPRISE) throw new DomainError('forbidden', '该接口仅质量负责人可用');
    return handler(ctx);
  };
}

async function handleApi(service, request, response, url) {
  const { body, hasBody } = await readBody(request);
  if (hasBody && body === undefined) {
    return send(response, 400, { error: 'validation_error', message: '请求体不是合法 JSON' });
  }

  const routeKey = matchRoute(request.method, url.pathname);
  if (!routeKey) return send(response, 404, { error: 'not_found' });
  const [template, handler] = routeKey;

  let actor = null;
  if (template !== 'POST /api/auth/register') {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey) throw new DomainError('unauthorized', '缺少 X-API-Key 请求头');
    actor = service.authenticate(String(apiKey));
    if (!actor) throw new DomainError('unauthorized', 'API 密钥无效');
  }

  const params = extractParams(template, url.pathname);
  const result = await handler({ service, request, response, url, body: body ?? {}, params, actor });
  if (!response.writableEnded) send(response, 200, result);
}

function matchRoute(method, pathname) {
  for (const [template, handler] of Object.entries(ROUTES)) {
    const [templateMethod, templatePath] = template.split(' ');
    if (templateMethod !== method) continue;
    if (pathsMatch(templatePath, pathname)) return [template, handler];
  }
  return null;
}

function pathsMatch(templatePath, actualPath) {
  const templateParts = templatePath.split('/');
  const actualParts = actualPath.split('/');
  if (templateParts.length !== actualParts.length) return false;
  return templateParts.every((part, index) => part.startsWith(':') || part === actualParts[index]);
}

function extractParams(template, pathname) {
  const [, templatePath] = template.split(' ');
  const params = {};
  templatePath.split('/').forEach((part, index) => {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(pathname.split('/')[index]);
  });
  return params;
}

function listPlots(ctx) {
  return ctx.service.listPlots(ctx.actor);
}

function getStandard(ctx) {
  const at = ctx.url.searchParams.get('at');
  return ctx.service.getStandard(ctx.actor, ctx.params.product, at);
}

function listLockdowns(ctx) {
  return ctx.service.listLockdowns(ctx.actor);
}

function listEvents(ctx) {
  const limit = Number(ctx.url.searchParams.get('limit') || 200);
  return ctx.service.listEvents(ctx.actor, { limit: Math.min(limit, 1000) });
}

async function readBody(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return { hasBody: false };
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new DomainError('validation_error', '请求体超过 1MB 上限');
    chunks.push(chunk);
  }
  if (size === 0) return { hasBody: false };
  try {
    return { hasBody: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { hasBody: true, body: undefined };
  }
}

function handleError(response, error) {
  if (error instanceof DomainError) {
    return send(response, STATUS_BY_CODE[error.code] ?? 400, {
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  console.error(error);
  return send(response, 500, { error: 'internal_error', message: '服务内部错误' });
}

function send(response, status, payload) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}
