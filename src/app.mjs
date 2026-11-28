// HTTP 层：路由、令牌认证、JSON 解析与错误映射。业务规则全部在 domain.mjs。
import { createServer } from 'node:http';
import { HttpError, unauthorized, forbidden, notFound } from './util.mjs';
import * as domain from './domain.mjs';
import * as views from './views.mjs';

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new HttpError(413, 'TOO_LARGE', '资料过大');
  }
  return raw ? JSON.parse(raw) : {};
}

// 路由表：[方法, 路径模式, 允许角色(null=公开), 处理器]
// 处理器返回 [状态码, 响应体] 或响应体（默认 200）。
function buildRoutes(store, partner) {
  const audienceOf = actor => {
    if (!actor) return 'public';
    if (actor.role === 'school' || actor.role === 'verifier') return actor.role;
    return 'staff';
  };

  return [
    ['GET', '/health', null, () => [200, { status: 'ok', service: 'school-aid-app' }]],

    // ---- 公开查询（保护儿童隐私：聚合口径，无匿名编号与困难原因）----
    ['GET', '/public/schools/:school/summary', null, ({ params }) => {
      const school = store.state.schools[params.school] ?? notFound('SCHOOL_NOT_FOUND', '学校不存在');
      return [200, views.publicSchoolSummaryView(store, school.id)];
    }],
    ['GET', '/public/needs/:id', null, ({ params }) => {
      const need = domain.getNeed(store, params.id);
      return [200, views.needProgressView(store, need, 'public')];
    }],

    // ---- 学校 ----
    ['POST', '/schools/:school/needs', ['school'], ({ actor, params, body }) =>
      [201, domain.createNeed(store, actor, params.school, body)]],
    ['GET', '/schools/:school/needs', ['school', 'approver', 'buyer', 'verifier'], ({ actor, params }) => {
      if (actor.role === 'school' && actor.school !== params.school) forbidden('NOT_OWN_SCHOOL', '只能查看本校需求');
      const needs = Object.values(store.state.needs).filter(n => n.school === params.school);
      return [200, needs.map(n => views.needProgressView(store, n, audienceOf(actor)))];
    }],
    ['POST', '/needs/:id/reduce', ['school'], ({ actor, params, body }) =>
      [200, domain.reduceNeed(store, actor, params.id, body)]],
    ['POST', '/needs/:id/cancel-unmet', ['school'], ({ actor, params, body }) =>
      [200, domain.cancelUnmet(store, actor, params.id, body)]],
    ['POST', '/needs/:id/substitutes/:sub/school-confirm', ['school'], ({ actor, params }) =>
      [200, domain.confirmSubstituteBySchool(store, actor, params.id, params.sub)]],
    ['POST', '/shipments/:id/acceptance', ['school'], ({ actor, params, body }) =>
      [201, domain.acceptShipment(store, actor, params.id, body)]],

    // ---- 校内核实（能确认需求，不能批准用款）----
    ['POST', '/needs/:id/verify', ['verifier'], ({ actor, params }) =>
      [200, domain.verifyNeed(store, actor, params.id)]],

    // ---- 团队（审批）----
    ['POST', '/donations', ['approver'], ({ actor, body }) =>
      [201, domain.registerDonation(store, actor, body)]],
    ['POST', '/donations/:id/arrive', ['approver'], ({ actor, params, body }) =>
      [200, domain.arriveDonation(store, actor, params.id, body)]],
    ['POST', '/donations/:id/fail', ['approver'], ({ actor, params, body }) =>
      [200, domain.failDonation(store, actor, params.id, body)]],
    ['POST', '/pledges', ['approver'], ({ actor, body }) =>
      [201, domain.acceptPledge(store, actor, body)]],
    ['POST', '/pledges/:id/release', ['approver'], ({ actor, params, body }) =>
      [200, domain.releasePledge(store, actor, params.id, body)]],
    ['POST', '/pledges/:id/shipments', ['approver'], ({ actor, params, body }) =>
      [201, domain.shipFromPledge(store, actor, params.id, body)]],
    ['POST', '/needs/:id/substitutes', ['approver'], ({ actor, params, body }) =>
      [201, domain.proposeSubstitute(store, actor, params.id, body)]],
    ['POST', '/matching/:rule/compute', ['approver'], ({ actor, params }) =>
      [200, domain.computeMatching(store, actor, params.rule)]],
    ['POST', '/matching/:rule/arrive', ['approver'], ({ actor, params, body }) =>
      [200, domain.arriveMatching(store, actor, params.rule, body)]],
    ['POST', '/matching/:rule/terms', ['approver'], ({ actor, params, body }) =>
      [200, domain.changeMatchingTerms(store, actor, params.rule, body)]],
    ['POST', '/consents', ['approver'], ({ actor, body }) =>
      [201, domain.requestConsent(store, actor, body)]],
    ['GET', '/needs/:id/progress', ['school', 'verifier', 'approver', 'buyer'], ({ actor, params }) => {
      const need = domain.getNeed(store, params.id);
      if (actor.role === 'school' && actor.school !== need.school) forbidden('NOT_OWN_SCHOOL', '只能查看本校需求');
      return [200, views.needProgressView(store, need, audienceOf(actor))];
    }],
    ['GET', '/audit', ['approver', 'buyer'], () => [200, store.state.audit]],
    ['GET', '/stock', ['approver', 'buyer', 'warehouse'], () =>
      [200, Object.values(store.state.stocks).map(s => views.stockView(store, s))]],

    // ---- 捐方（仅本人）----
    ['GET', '/my/donations', ['donor'], ({ actor }) => {
      const mine = Object.values(store.state.donations).filter(d => d.donor === actor.donor);
      return [200, mine.map(d => views.donationWhereaboutsView(store, d))];
    }],
    ['GET', '/donations/:id/whereabouts', ['donor', 'approver'], ({ actor, params }) => {
      const d = domain.getDonation(store, params.id);
      if (actor.role === 'donor' && actor.donor !== d.donor) forbidden('NOT_OWN_DONATION', '只能查询本捐方的捐助');
      return [200, views.donationWhereaboutsView(store, d)];
    }],
    ['POST', '/donations/:id/refund', ['donor', 'approver'], ({ actor, params, body }) =>
      [200, domain.refundDonation(store, actor, params.id, body)]],
    ['POST', '/consents/:id/decide', ['donor'], ({ actor, params, body }) =>
      [200, domain.decideConsent(store, actor, params.id, body)]],
    ['GET', '/matching/:rule', ['approver', 'donor'], ({ actor, params }) => {
      const rule = domain.getRule(store, params.rule);
      if (actor.role === 'donor' && actor.donor !== rule.donor) forbidden('NOT_OWN_DONATION', '只能查询与本人捐助相关的配捐');
      return [200, views.matchingView(store, rule)];
    }],

    // ---- 采购 ----
    ['POST', '/orders', ['buyer'], ({ actor, body, headers }) => {
      const { order, reused } = domain.createOrder(store, actor, body, headers['idempotency-key']);
      return [reused ? 200 : 201, views.orderView(store, order)];
    }],
    ['GET', '/orders/:id', ['buyer', 'approver'], ({ params }) =>
      [200, views.orderView(store, domain.getOrder(store, params.id))]],
    ['POST', '/orders/:id/pay', ['buyer'], async ({ actor, params }) =>
      [200, await domain.payOrder(store, actor, params.id, partner)]],
    ['POST', '/orders/:id/reconcile', ['buyer'], async ({ actor, params }) =>
      [200, await domain.reconcileOrder(store, actor, params.id, partner)]],
    ['POST', '/orders/:id/cancel', ['buyer'], ({ actor, params, body }) =>
      [200, domain.cancelOrder(store, actor, params.id, body)]],
    ['POST', '/orders/:id/reduce', ['buyer'], ({ actor, params, body }) =>
      [200, domain.reduceOrder(store, actor, params.id, body)]],
    ['POST', '/orders/:id/shipments', ['buyer'], ({ actor, params, body }) =>
      [201, domain.shipFromOrder(store, actor, params.id, body)]],
    ['POST', '/catalog/:sku/quote', ['buyer'], ({ actor, params, body }) =>
      [200, domain.quoteCatalog(store, actor, params.sku, body)]],

    // ---- 物流 ----
    ['GET', '/shipments/:id/manifest', ['logistics'], ({ params }) =>
      [200, views.manifestView(store, domain.getShipment(store, params.id))]],
    ['POST', '/shipments/:id/deliver', ['logistics'], ({ actor, params, body }) =>
      [200, domain.deliverShipment(store, actor, params.id, body)]],

    // ---- 仓库 ----
    ['POST', '/returns/:id/confirm', ['warehouse'], ({ actor, params, body }) =>
      [200, domain.confirmReturn(store, actor, params.id, body)]]
  ];
}

function matchPath(pattern, pathname) {
  const pa = pattern.split('/').filter(Boolean);
  const pb = pathname.split('/').filter(Boolean);
  if (pa.length !== pb.length) return null;
  const params = {};
  for (let i = 0; i < pa.length; i += 1) {
    if (pa[i].startsWith(':')) params[pa[i].slice(1)] = decodeURIComponent(pb[i]);
    else if (pa[i] !== pb[i]) return null;
  }
  return params;
}

export function createApp({ store, partner }) {
  const routes = buildRoutes(store, partner);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let matched = null;
      let params = null;
      for (const route of routes) {
        const p = matchPath(route[1], url.pathname);
        if (p) { matched = route; params = p; break; }
      }
      if (!matched || matched[0] !== req.method) {
        // 路径存在但方法不符时也返回 404，避免暴露接口结构。
        return json(res, 404, { error: { code: 'NOT_FOUND', message: '没有对应的接口' } });
      }
      const [, , roles, handler] = matched;
      let actor = null;
      if (roles !== null) {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const actorId = token ? store.state.tokens[token] : null;
        actor = actorId ? store.state.actors[actorId] : null;
        if (!actor) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: '缺少或无效的访问令牌' } });
        if (!roles.includes(actor.role)) {
          return json(res, 403, { error: { code: 'ROLE_NOT_ALLOWED', message: `该操作仅限角色：${roles.join('、')}，当前角色：${actor.role}` } });
        }
      }
      const body = await readBody(req);
      const [status, value] = await handler({ store, actor, params, body, headers: req.headers, partner });
      return json(res, status, value);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(res, error.status, { error: { code: error.code, message: error.message, details: error.details ?? null } });
      }
      if (error instanceof SyntaxError) {
        return json(res, 400, { error: { code: 'BAD_JSON', message: 'JSON 格式不符' } });
      }
      return json(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误', details: String(error?.message ?? error) } });
    }
  });
}
