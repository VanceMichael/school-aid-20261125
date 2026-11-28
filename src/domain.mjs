// 业务领域操作。约定：先完成全部校验，再统一写入；写操作必须在 store.transact 中执行。
// 金额一律为分（minor）；承诺、到账、采购、在途、签收、合格分账记录，互不混用。
import {
  requireRole, badRequest, forbidden, notFound, conflict,
  assertPositiveInt, assertNonNegativeInt, sameSpec, restrictionCovers, sumBy, parseRatio
} from './util.mjs';

// ---------- 取用与守卫 ----------

export const getNeed = (store, id) => store.state.needs[id] ?? notFound('NEED_NOT_FOUND', `需求不存在：${id}`);
export const getDonation = (store, id) => store.state.donations[id] ?? notFound('DONATION_NOT_FOUND', `捐助不存在：${id}`);
export const getPledge = (store, id) => store.state.pledges[id] ?? notFound('PLEDGE_NOT_FOUND', `认捐不存在：${id}`);
export const getOrder = (store, id) => store.state.orders[id] ?? notFound('ORDER_NOT_FOUND', `采购单不存在：${id}`);
export const getShipment = (store, id) => store.state.shipments[id] ?? notFound('SHIPMENT_NOT_FOUND', `物流批次不存在：${id}`);
export const getRule = (store, id) => store.state.matching[id] ?? notFound('MATCHING_NOT_FOUND', `配捐规则不存在：${id}`);
export const getStock = (store, id) => store.state.stocks[id] ?? notFound('STOCK_NOT_FOUND', `库存不存在：${id}（未确认入库的退回实物不是库存）`);
export const getReturn = (store, id) => store.state.returns[id] ?? notFound('RETURN_NOT_FOUND', `退回记录不存在：${id}`);
export const getConsent = (store, id) => store.state.consents[id] ?? notFound('CONSENT_NOT_FOUND', `同意请求不存在：${id}`);
export const getSku = (store, id) => store.state.catalog[id] ?? notFound('SKU_NOT_FOUND', `目录不存在：${id}`);

function ownSchool(actor, need) {
  if (actor.school !== need.school) forbidden('NOT_OWN_SCHOOL', '只能操作本校的需求与签收');
}

// 职责分离：校内核实人员能确认需求，但不能自己批准使用捐款。
function ensureNotVerifier(actor, need) {
  if (need.verifiedBy && need.verifiedBy === actor.id) {
    forbidden('DUTY_SEPARATION', '校内核实人员不能批准同一需求的用款');
  }
}

function donorOf(store, donation) {
  return store.state.donors[donation.donor] ?? null;
}

// 捐方原始限制不可改写；改配、用途变化以单独的同意记录为准。
function hasApprovedConsent(store, donationId, needId, types) {
  return Object.values(store.state.consents).some(c =>
    c.donation === donationId && c.status === 'approved' &&
    types.includes(c.type) && (c.need === needId || c.need === null));
}

// 来源变更（fixtures.sourceChanges）：文书存在不等于批准，需由有权限角色在对应接口确认，
// 处理内容必须与来源资料一致，且同一变更只能生效一次。
function checkChange(store, changeId, expected) {
  if (changeId === undefined || changeId === null) return null;
  const change = store.state.sourceChanges[changeId] ?? notFound('CHANGE_NOT_FOUND', `来源变更不存在：${changeId}`);
  if (change.applied) conflict('CHANGE_APPLIED', `来源变更已处理，不能重复生效：${changeId}`);
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && change[field] !== value) {
      conflict('CHANGE_MISMATCH', `处理内容与来源变更不符：字段 ${field}`, { 来源: change[field], 提交: value });
    }
  }
  return change;
}

function applyChange(store, change) {
  if (!change) return;
  change.applied = true;
  change.appliedAt = store.now();
}

// ---------- 规格与目录 ----------

function needSpec(need) {
  return { kind: need.kind, size: need.size ?? null, age: need.age ?? null };
}

// 生效中的替代品（学校已确认；涉及用途变化的还须捐方同意齐备）替换原规格。
export function effectiveSpec(store, need) {
  const sub = need.substitutes.find(s => s.status === 'effective');
  if (sub) {
    const sku = getSku(store, sub.sku);
    return { kind: sku.kind, size: sku.size ?? null, age: sku.age ?? null };
  }
  return needSpec(need);
}

function findSkuBySpec(store, spec) {
  return Object.values(store.state.catalog).find(sku => sameSpec(sku, spec)) ?? null;
}

function catalogPrice(store, spec) {
  const sku = findSkuBySpec(store, spec);
  if (!sku) conflict('SPEC_UNAVAILABLE', '目录中没有该规格，无法估价', { spec });
  return sku.unitMinor;
}

// ---------- 需求台账 ----------

const ORDER_OPEN_STATUSES = ['pending_payment', 'payment_processing', 'paid'];

export function needTally(store, needId) {
  const s = store.state;
  const pledges = Object.values(s.pledges).filter(p => p.need === needId && p.status === 'active');
  const orders = Object.values(s.orders).filter(o => o.need === needId && ORDER_OPEN_STATUSES.includes(o.status));
  const shipments = Object.values(s.shipments).filter(x => x.need === needId);
  const acceptances = Object.values(s.acceptances).filter(a => a.need === needId);
  const returns = Object.values(s.returns).filter(r => r.need === needId && r.status === 'pending_warehouse');
  return {
    promised: sumBy(pledges, 'quantity'), // 有人答应（认捐承诺，未采购）
    procured: orders.reduce((total, o) => total + (o.quantity - o.shippedQuantity), 0), // 已采购未发货
    inTransit: sumBy(shipments.filter(x => x.status === 'in_transit'), 'quantity'),
    deliveredPending: sumBy(shipments.filter(x => x.status === 'delivered'), 'delivered'),
    received: sumBy(acceptances, 'received'),
    usable: sumBy(acceptances, 'usable'), // 实际满足量（验收合格、可直接使用）
    damaged: sumBy(acceptances, 'damaged'),
    sizeMismatch: sumBy(acceptances, 'sizeMismatch'),
    shortage: sumBy(shipments, 'shortage'),
    returnPending: sumBy(returns, 'quantity')
  };
}

// 仍可承诺数量：当前需求减去已被合格、待验收、在途、采购、认捐覆盖的部分。
export function remainingToPromise(store, need) {
  const t = needTally(store, need.id);
  return need.quantity - t.usable - t.deliveredPending - t.inTransit - t.procured - t.promised;
}

// ---------- 捐助 ----------

export function donationAvailable(d) {
  return d.arrivedMinor - d.refundedMinor - d.earmarkedMinor - d.reservedMinor - d.spentMinor;
}

export function registerDonation(store, actor, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const donor = store.state.donors[body.donor] ?? notFound('DONOR_NOT_FOUND', `捐方不存在：${body.donor}`);
    assertPositiveInt(body.amountMinor, '承诺金额');
    const donation = {
      id: store.id('DON'),
      donor: donor.id,
      intendedNeed: body.need ?? null,
      kind: 'money',
      status: 'pledged',
      promisedMinor: body.amountMinor,
      arrivedMinor: 0,
      arrivedAt: null,
      refundedMinor: 0,
      failedMinor: 0,
      earmarkedMinor: 0,
      reservedMinor: 0,
      spentMinor: 0,
      createdAt: store.now()
    };
    store.state.donations[donation.id] = donation;
    store.audit(actor, 'donation.register', 'donation', donation.id, { donor: donor.id, promisedMinor: donation.promisedMinor });
    return donation;
  });
}

export function arriveDonation(store, actor, donationId, body = {}) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const d = getDonation(store, donationId);
    const outstanding = d.promisedMinor - d.arrivedMinor - d.failedMinor;
    const amount = body.amountMinor ?? outstanding;
    assertPositiveInt(amount, '到账金额');
    if (amount > outstanding) conflict('ARRIVAL_EXCEEDS_PROMISED', '到账金额超过承诺未兑现部分', { outstanding });
    d.arrivedMinor += amount;
    d.arrivedAt = store.now();
    d.status = d.arrivedMinor >= d.promisedMinor ? 'arrived' : 'partially_arrived';
    store.audit(actor, 'donation.arrive', 'donation', d.id, { amountMinor: amount });
    for (const rule of Object.values(store.state.matching).filter(r => r.donor === d.donor)) recomputeMatching(store, rule.id);
    return d;
  });
}

export function failDonation(store, actor, donationId, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const d = getDonation(store, donationId);
    const outstanding = d.promisedMinor - d.arrivedMinor - d.failedMinor;
    const amount = body.amountMinor ?? outstanding;
    assertPositiveInt(amount, '失败金额');
    if (amount > outstanding) conflict('FAIL_EXCEEDS_PROMISED', '失败金额超过承诺未兑现部分', { outstanding });
    d.failedMinor += amount;
    d.status = 'failed';
    store.audit(actor, 'donation.fail', 'donation', d.id, { amountMinor: amount, reason: body.reason ?? null });
    for (const rule of Object.values(store.state.matching).filter(r => r.donor === d.donor)) recomputeMatching(store, rule.id);
    return d;
  });
}

export function refundDonation(store, actor, donationId, body) {
  const d = getDonation(store, donationId);
  if (actor.role === 'donor') {
    if (actor.donor !== d.donor) forbidden('NOT_OWN_DONATION', '只能操作本捐方的捐助');
  } else {
    requireRole(actor, ['approver']);
  }
  return store.transact(() => {
    const change = checkChange(store, body.change, { pledge: donationId, amountMinor: body.amountMinor });
    assertPositiveInt(body.amountMinor, '退款金额');
    const available = donationAvailable(d);
    if (body.amountMinor > available) {
      conflict('REFUND_EXCEEDS_AVAILABLE', '可退金额不足：已承诺、付款未明或已采购部分不可退', { available });
    }
    d.refundedMinor += body.amountMinor;
    d.status = 'partially_refunded';
    const refund = {
      id: store.id('RFD'),
      donation: d.id,
      amountMinor: body.amountMinor,
      reason: body.reason ?? null,
      change: change?.id ?? null,
      by: actor.id,
      at: store.now()
    };
    store.state.refunds[refund.id] = refund;
    applyChange(store, change);
    store.audit(actor, 'donation.refund', 'donation', d.id, { amountMinor: body.amountMinor, refund: refund.id });
    // 退款改变配捐合格基数：已用于采购的配捐不悄悄消失，转为显性责任。
    for (const rule of Object.values(store.state.matching).filter(r => r.donor === d.donor)) recomputeMatching(store, rule.id);
    return { donation: d, refund };
  });
}

// ---------- 配捐 ----------

// 合格基数：该捐方在截止时间前实际到账且未退还的捐款。承诺配捐不算到账。
export function recomputeMatching(store, ruleId) {
  const rule = getRule(store, ruleId);
  const base = Object.values(store.state.donations)
    .filter(d => d.donor === rule.donor && d.arrivedAt && d.arrivedAt <= rule.deadline)
    .reduce((total, d) => total + d.arrivedMinor - d.refundedMinor, 0);
  const r = rule.record;
  r.entitledMinor = Math.min(rule.capMinor, Math.floor(base * rule.ratioNum / rule.ratioDen));
  // 已花配捐超过新资格：显示需向配捐方追回或由团队补足的责任，不从账上消失。
  r.responsibilityMinor = Math.max(0, r.spentMinor - r.entitledMinor);
  // 已到账但超出资格且未花：不可再用于采购，应退回配捐方。
  r.excessMinor = Math.max(0, r.arrivedMinor - Math.max(r.entitledMinor, r.spentMinor));
  return r;
}

export function matchingSpendable(rule) {
  const r = rule.record;
  return Math.max(0, Math.min(r.arrivedMinor, r.entitledMinor) - r.spentMinor - r.reservedMinor);
}

export function computeMatching(store, actor, ruleId) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const record = recomputeMatching(store, ruleId);
    store.audit(actor, 'matching.compute', 'matching', ruleId, { ...record });
    return record;
  });
}

export function arriveMatching(store, actor, ruleId, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const rule = getRule(store, ruleId);
    recomputeMatching(store, ruleId);
    assertPositiveInt(body.amountMinor, '配捐到账金额');
    rule.record.arrivedMinor += body.amountMinor;
    recomputeMatching(store, ruleId);
    store.audit(actor, 'matching.arrive', 'matching', ruleId, { amountMinor: body.amountMinor });
    return rule.record;
  });
}

export function changeMatchingTerms(store, actor, ruleId, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const rule = getRule(store, ruleId);
    if (body.ratio !== undefined) {
      const { num, den } = parseRatio(body.ratio);
      rule.ratioNum = num;
      rule.ratioDen = den;
    }
    if (body.capMinor !== undefined) {
      assertNonNegativeInt(body.capMinor, '配捐上限');
      rule.capMinor = body.capMinor;
    }
    if (body.deadline !== undefined) rule.deadline = body.deadline;
    const record = recomputeMatching(store, ruleId);
    store.audit(actor, 'matching.terms', 'matching', ruleId, { terms: body, record: { ...record } });
    return record;
  });
}

// ---------- 认捐（承诺） ----------

export function acceptPledge(store, actor, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const need = getNeed(store, body.need);
    ensureNotVerifier(actor, need);
    if (need.status !== 'verified') conflict('NEED_NOT_VERIFIED', '需求未核实或已关闭，不能接受认捐');
    assertPositiveInt(body.quantity, '认捐数量');
    const remaining = remainingToPromise(store, need);
    if (body.quantity > remaining) {
      conflict('NEED_OVERPLEDGED', '超出需求剩余可承诺数量，同一份需求不能重复许诺给多位捐方', { remaining });
    }
    const spec = effectiveSpec(store, need);

    if (body.donation) {
      const d = getDonation(store, body.donation);
      const donor = donorOf(store, d);
      if (!restrictionCovers(donor, need.school, spec.kind) &&
          !hasApprovedConsent(store, d.id, need.id, ['redirect', 'purpose_change'])) {
        conflict('CONSENT_REQUIRED', '捐方限制不覆盖该需求，剩余款物改配须先取得捐方同意');
      }
      if (donationAvailable(d) <= 0) conflict('FUNDS_NOT_ARRIVED', '捐款未到账或已用完，承诺不能当作可使用的帮助');
      const unitMinor = catalogPrice(store, spec);
      const amountMinor = body.quantity * unitMinor;
      const available = donationAvailable(d);
      if (amountMinor > available) conflict('FUNDS_INSUFFICIENT', '捐款可用余额不足', { available, required: amountMinor });
      d.earmarkedMinor += amountMinor;
      const pledge = {
        id: store.id('PLG'), source: 'donation', donation: d.id, stock: null,
        need: need.id, quantity: body.quantity, unitMinor, amountMinor,
        shippedQuantity: 0, status: 'active', order: null,
        createdBy: actor.id, createdAt: store.now()
      };
      store.state.pledges[pledge.id] = pledge;
      store.audit(actor, 'pledge.accept', 'pledge', pledge.id, { need: need.id, donation: d.id, quantity: pledge.quantity, amountMinor });
      return pledge;
    }

    if (body.stock) {
      const stock = getStock(store, body.stock);
      if (stock.status !== 'available') conflict('STOCK_NOT_AVAILABLE', '该库存不可承诺（破损待处理或未确认入库）');
      if (!sameSpec(stock, spec)) conflict('SPEC_MISMATCH', '用品规格不符，相似商品不能自动算成满足', { 库存规格: { kind: stock.kind, size: stock.size }, 需求规格: spec });
      if (stock.restriction && !restrictionCovers(stock.restriction, need.school, spec.kind) &&
          !hasApprovedConsent(store, stock.restriction.donation, need.id, ['redirect'])) {
        conflict('CONSENT_REQUIRED', '库存受捐方限制约束，改配须先取得捐方同意');
      }
      const free = stock.quantity - stock.reservedQuantity - stock.shippedQuantity;
      if (body.quantity > free) conflict('STOCK_INSUFFICIENT', '可承诺库存不足；在途与未入库数量不算库存', { free });
      stock.reservedQuantity += body.quantity;
      const pledge = {
        id: store.id('PLG'), source: 'stock', donation: null, stock: stock.id,
        need: need.id, quantity: body.quantity, unitMinor: 0, amountMinor: 0,
        shippedQuantity: 0, status: 'active', order: null,
        createdBy: actor.id, createdAt: store.now()
      };
      store.state.pledges[pledge.id] = pledge;
      store.audit(actor, 'pledge.accept', 'pledge', pledge.id, { need: need.id, stock: stock.id, quantity: pledge.quantity });
      return pledge;
    }

    badRequest('认捐必须指定捐款（donation）或库存（stock）');
  });
}

function releasePledgeRecord(store, pledge, quantity = null) {
  const cut = quantity ?? pledge.quantity;
  if (pledge.source === 'donation') {
    const d = getDonation(store, pledge.donation);
    d.earmarkedMinor -= cut * pledge.unitMinor;
  } else {
    const stock = getStock(store, pledge.stock);
    stock.reservedQuantity -= cut;
  }
  pledge.quantity -= cut;
  pledge.amountMinor -= cut * pledge.unitMinor;
  if (pledge.quantity === 0) pledge.status = 'released';
}

export function releasePledge(store, actor, pledgeId, body = {}) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const pledge = getPledge(store, pledgeId);
    if (pledge.status !== 'active') conflict('PLEDGE_NOT_ACTIVE', '只有承诺中的认捐可以解除');
    releasePledgeRecord(store, pledge);
    store.audit(actor, 'pledge.release', 'pledge', pledge.id, { reason: body.reason ?? null });
    return pledge;
  });
}

// ---------- 替代品 ----------

export function proposeSubstitute(store, actor, needId, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const need = getNeed(store, needId);
    if (!['verified', 'reported'].includes(need.status)) conflict('NEED_CLOSED', '需求已关闭，不能提出替代');
    const sku = getSku(store, body.sku);
    const change = checkChange(store, body.change, { need: needId, sku: body.sku, quantity: body.quantity });
    if (sameSpec(sku, needSpec(need))) badRequest('SUBSTITUTE_SAME_SPEC', '与原规格相同，无需替代');
    if (need.substitutes.some(s => ['pending', 'pending_consent', 'effective'].includes(s.status))) {
      conflict('SUBSTITUTE_EXISTS', '已有处理中的替代品，请先办结');
    }
    const kindChanged = sku.kind !== need.kind;
    const sub = {
      id: store.id('SUB'),
      need: needId,
      sku: sku.id,
      quantity: body.quantity ?? null,
      kindChanged,
      schoolConfirmed: false,
      status: 'pending',
      change: change?.id ?? null,
      createdBy: actor.id,
      createdAt: store.now()
    };
    need.substitutes.push(sub);
    // 涉及原定用途变化：自动向该需求已承诺捐款的捐方发起同意请求。
    if (kindChanged) {
      const donationIds = [...new Set(Object.values(store.state.pledges)
        .filter(p => p.need === needId && p.source === 'donation' && ['active', 'committed'].includes(p.status))
        .map(p => p.donation))];
      for (const donationId of donationIds) {
        const consent = {
          id: store.id('CNS'), type: 'purpose_change', donation: donationId, need: needId,
          substitute: sub.id, status: 'pending', note: '替代品涉及原定用途变化，需捐方同意',
          requestedBy: actor.id, requestedAt: store.now(), decidedBy: null, decidedAt: null, decisionNote: null
        };
        store.state.consents[consent.id] = consent;
        store.audit(actor, 'consent.request', 'consent', consent.id, { type: consent.type, donation: donationId, substitute: sub.id });
      }
      sub.status = 'pending_consent';
    }
    applyChange(store, change);
    store.audit(actor, 'substitute.propose', 'need', needId, { substitute: sub.id, sku: sku.id, kindChanged });
    return sub;
  });
}

function refreshSubstituteStatus(store, need, sub) {
  if (!sub.schoolConfirmed) return;
  if (!sub.kindChanged) {
    sub.status = 'effective';
    return;
  }
  const pending = Object.values(store.state.consents).filter(c => c.substitute === sub.id && c.status !== 'approved');
  sub.status = pending.length === 0 ? 'effective' : 'pending_consent';
}

export function confirmSubstituteBySchool(store, actor, needId, subId) {
  requireRole(actor, ['school']);
  return store.transact(() => {
    const need = getNeed(store, needId);
    ownSchool(actor, need);
    const sub = need.substitutes.find(s => s.id === subId) ?? notFound('SUBSTITUTE_NOT_FOUND', '替代品不存在');
    if (sub.schoolConfirmed) conflict('SUBSTITUTE_ALREADY_CONFIRMED', '学校已确认过该替代品');
    sub.schoolConfirmed = true;
    refreshSubstituteStatus(store, need, sub);
    store.audit(actor, 'substitute.school_confirm', 'need', needId, { substitute: sub.id, status: sub.status });
    return sub;
  });
}

// ---------- 捐方同意 ----------

export function requestConsent(store, actor, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const d = getDonation(store, body.donation);
    if (!['redirect', 'purpose_change'].includes(body.type)) badRequest('同意类型须为 redirect（改配）或 purpose_change（用途变化）');
    const consent = {
      id: store.id('CNS'), type: body.type, donation: d.id, need: body.need ?? null,
      substitute: null, status: 'pending', note: body.note ?? null,
      requestedBy: actor.id, requestedAt: store.now(), decidedBy: null, decidedAt: null, decisionNote: null
    };
    store.state.consents[consent.id] = consent;
    store.audit(actor, 'consent.request', 'consent', consent.id, { type: consent.type, donation: d.id, need: consent.need });
    return consent;
  });
}

export function decideConsent(store, actor, consentId, body) {
  requireRole(actor, ['donor']);
  return store.transact(() => {
    const consent = getConsent(store, consentId);
    const d = getDonation(store, consent.donation);
    if (actor.donor !== d.donor) forbidden('NOT_OWN_DONATION', '只能决定本捐方捐助的同意请求');
    if (consent.status !== 'pending') conflict('CONSENT_DECIDED', '该同意请求已有决定');
    consent.status = body.approve ? 'approved' : 'rejected';
    consent.decidedBy = actor.id;
    consent.decidedAt = store.now();
    consent.decisionNote = body.note ?? null;
    if (consent.substitute) {
      const need = getNeed(store, consent.need);
      const sub = need.substitutes.find(s => s.id === consent.substitute);
      if (sub) refreshSubstituteStatus(store, need, sub);
    }
    store.audit(actor, 'consent.decide', 'consent', consent.id, { status: consent.status });
    return consent;
  });
}

// ---------- 需求：申报、核实、缩减、撤销 ----------

export function createNeed(store, actor, schoolId, body) {
  requireRole(actor, ['school']);
  if (actor.school !== schoolId) forbidden('NOT_OWN_SCHOOL', '只能为本校申报需求');
  return store.transact(() => {
    const school = store.state.schools[schoolId] ?? notFound('SCHOOL_NOT_FOUND', `学校不存在：${schoolId}`);
    assertPositiveInt(body.quantity, '需求数量');
    if (!body.kind) badRequest('缺少用品类别 kind');
    const need = {
      id: store.id('ND'),
      school: school.id,
      kind: body.kind,
      size: body.size ?? null,
      age: body.age ?? null,
      quantity: body.quantity,
      originalQuantity: body.quantity,
      status: 'reported',
      verifiedBy: null,
      verifiedAt: null,
      studentRefs: Array.isArray(body.studentRefs) ? body.studentRefs : [], // 只用匿名编号
      hardshipNote: body.hardshipNote ?? null, // 仅校内与核实可见
      reductions: [],
      substitutes: [],
      cancelledUnmet: null,
      createdAt: store.now()
    };
    store.state.needs[need.id] = need;
    store.audit(actor, 'need.create', 'need', need.id, { school: school.id, kind: need.kind, quantity: need.quantity });
    return need;
  });
}

export function verifyNeed(store, actor, needId) {
  requireRole(actor, ['verifier']);
  return store.transact(() => {
    const need = getNeed(store, needId);
    if (need.status !== 'reported') conflict('NEED_NOT_REPORTED', '只有待核实的需求可以核实');
    need.status = 'verified';
    need.verifiedBy = actor.id;
    need.verifiedAt = store.now();
    store.audit(actor, 'need.verify', 'need', need.id, {});
    return need;
  });
}

export function reduceNeed(store, actor, needId, body) {
  requireRole(actor, ['school']);
  return store.transact(() => {
    const need = getNeed(store, needId);
    ownSchool(actor, need);
    const change = checkChange(store, body.change, { need: needId, quantity: body.quantity });
    assertPositiveInt(body.quantity, '缩减后数量');
    const t = needTally(store, needId);
    if (body.quantity < t.usable) conflict('REDUCE_BELOW_USABLE', '不能缩减到已验收合格数量以下', { usable: t.usable });
    if (body.quantity >= need.quantity) badRequest('缩减后数量必须小于当前数量', { current: need.quantity });
    const from = need.quantity;
    need.quantity = body.quantity;
    need.reductions.push({ from, to: body.quantity, reason: body.reason ?? null, change: change?.id ?? null, by: actor.id, at: store.now() });

    // 释放多余的认捐承诺（后承诺的先释放，支持部分释放）。
    const coveredFixed = t.usable + t.deliveredPending + t.inTransit;
    let excessPromised = Math.max(0, t.promised - Math.max(0, need.quantity - coveredFixed - t.procured));
    const activePledges = Object.values(store.state.pledges)
      .filter(p => p.need === needId && p.status === 'active')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const pledge of activePledges) {
      if (excessPromised <= 0) break;
      const cut = Math.min(pledge.quantity, excessPromised);
      releasePledgeRecord(store, pledge, cut);
      store.audit(actor, 'pledge.release', 'pledge', pledge.id, { reason: '需求缩减', quantity: cut });
      excessPromised -= cut;
    }
    // 缩减未发货的采购（已发货事实保留）。
    let excessProcured = Math.max(0, t.procured - Math.max(0, need.quantity - coveredFixed));
    const openOrders = Object.values(store.state.orders)
      .filter(o => o.need === needId && ORDER_OPEN_STATUSES.includes(o.status) && o.quantity > o.shippedQuantity)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const order of openOrders) {
      if (excessProcured <= 0) break;
      const cut = Math.min(order.quantity - order.shippedQuantity, excessProcured);
      reduceOrderRecord(store, order, order.quantity - cut, actor);
      excessProcured -= cut;
    }
    applyChange(store, change);
    store.audit(actor, 'need.reduce', 'need', needId, { from, to: body.quantity });
    return need;
  });
}

export function cancelUnmet(store, actor, needId, body = {}) {
  requireRole(actor, ['school']);
  return store.transact(() => {
    const need = getNeed(store, needId);
    ownSchool(actor, need);
    if (need.status === 'closed_partial') conflict('NEED_ALREADY_CLOSED', '未满足部分已撤销');
    const t = needTally(store, needId);
    // 解除全部未兑现认捐。
    for (const pledge of Object.values(store.state.pledges).filter(p => p.need === needId && p.status === 'active')) {
      releasePledgeRecord(store, pledge);
      store.audit(actor, 'pledge.release', 'pledge', pledge.id, { reason: '学校撤销未满足部分' });
    }
    // 解除采购与配捐约束：未发货的采购单取消或缩减到已发货数量；已发货事实保留。
    for (const order of Object.values(store.state.orders).filter(o => o.need === needId && ORDER_OPEN_STATUSES.includes(o.status))) {
      if (order.status === 'payment_processing' && order.payment.state === 'unclear') {
        conflict('FUNDS_UNCLEAR', `采购单 ${order.id} 付款状态未明，查账前不能撤销，请先对账`);
      }
      if (order.shippedQuantity === 0) cancelOrderRecord(store, order, actor, '学校撤销未满足部分');
      else reduceOrderRecord(store, order, order.shippedQuantity, actor);
    }
    // 需求收缩到已被有效物资覆盖的数量；已发放、在途事实保留。
    need.quantity = t.usable + t.deliveredPending + t.inTransit;
    need.status = 'closed_partial';
    need.cancelledUnmet = { at: store.now(), by: actor.id, reason: body.reason ?? null };
    store.audit(actor, 'need.cancel_unmet', 'need', needId, { quantity: need.quantity });
    return need;
  });
}

// ---------- 采购 ----------

function releaseOrderReservations(store, order) {
  for (const entry of order.funding) {
    const releasable = entry.amountMinor - (entry.releasedMinor ?? 0);
    if (releasable <= 0) continue;
    if (entry.type === 'pledge') {
      const pledge = getPledge(store, entry.id);
      const d = getDonation(store, pledge.donation);
      d.reservedMinor -= releasable;
      d.earmarkedMinor += releasable;
      if (pledge.status === 'committed') pledge.status = 'active';
    } else {
      const rule = getRule(store, entry.rule);
      rule.record.reservedMinor -= releasable;
    }
    entry.releasedMinor = 0;
  }
}

// 缩减采购单：释放的资金先退自有捐款、后退配捐，使配捐责任保持显性。
function reduceOrderRecord(store, order, newQuantity, actor) {
  assertNonNegativeInt(newQuantity, '采购数量');
  if (newQuantity < order.shippedQuantity) conflict('REDUCE_BELOW_SHIPPED', '不能缩减到已发货数量以下', { shipped: order.shippedQuantity });
  const delta = order.quantity - newQuantity;
  if (delta <= 0) return;
  let credit = delta * order.unitMinor;
  order.quantity = newQuantity;
  order.totalMinor -= credit;
  const paid = order.status === 'paid';
  const ordered = [...order.funding].sort((a, b) => (a.type === 'pledge' ? 0 : 1) - (b.type === 'pledge' ? 0 : 1));
  for (const entry of ordered) {
    if (credit <= 0) break;
    const release = Math.min(entry.amountMinor - (entry.releasedMinor ?? 0), credit);
    if (release <= 0) continue;
    entry.releasedMinor = (entry.releasedMinor ?? 0) + release;
    if (entry.type === 'pledge') {
      const pledge = getPledge(store, entry.id);
      const d = getDonation(store, pledge.donation);
      if (paid) d.spentMinor -= release;
      else d.reservedMinor -= release;
      if (entry.releasedMinor >= entry.amountMinor && pledge.status === 'committed') pledge.status = 'released';
    } else {
      const rule = getRule(store, entry.rule);
      if (paid) rule.record.spentMinor -= release;
      else rule.record.reservedMinor -= release;
      recomputeMatching(store, rule.id);
    }
    credit -= release;
  }
  store.audit(actor, 'order.reduce', 'order', order.id, { newQuantity, releasedMinor: delta * order.unitMinor });
}

function cancelOrderRecord(store, order, actor, reason) {
  if (order.status === 'pending_payment') {
    releaseOrderReservations(store, order);
    order.status = 'cancelled';
  } else if (order.status === 'payment_processing' && order.payment.state === 'sent') {
    // 结款方已受理未终态：先取消，等待终态作为迟到回执核对。
    order.status = 'supplier_cancelled';
  } else if (order.status === 'paid') {
    // 已付款：资金退回各来源账面，配捐退回后重新核算责任。
    for (const entry of order.funding) {
      const releasable = entry.amountMinor - (entry.releasedMinor ?? 0);
      if (releasable <= 0) continue;
      entry.releasedMinor = entry.amountMinor;
      if (entry.type === 'pledge') {
        const pledge = getPledge(store, entry.id);
        const d = getDonation(store, pledge.donation);
        d.spentMinor -= releasable;
        if (pledge.status === 'committed') pledge.status = 'released';
      } else {
        const rule = getRule(store, entry.rule);
        rule.record.spentMinor -= releasable;
        recomputeMatching(store, rule.id);
      }
    }
    order.status = 'supplier_cancelled';
  } else {
    conflict('ORDER_NOT_CANCELLABLE', `当前状态不能取消：${order.status}`);
  }
  store.audit(actor, 'order.cancel', 'order', order.id, { reason });
}

export function createOrder(store, actor, body, idempotencyKey) {
  requireRole(actor, ['buyer']);
  return store.transact(() => {
    // 幂等键检查必须在临界区内：并发同一键只形成一张采购单。
    if (idempotencyKey) {
      const existing = store.state.orderKeys[idempotencyKey];
      if (existing) return { order: getOrder(store, existing), reused: true };
    }
    const need = getNeed(store, body.need);
    ensureNotVerifier(actor, need);
    if (need.status !== 'verified') conflict('NEED_NOT_VERIFIED', '需求未核实或已关闭，不能采购');
    const processing = Object.values(store.state.orders)
      .find(o => o.need === need.id && o.status === 'payment_processing');
    if (processing) conflict('FUNDS_UNCLEAR', `采购单 ${processing.id} 付款状态未明，资金未明时不能重复采购`, { order: processing.id });
    assertPositiveInt(body.quantity, '采购数量');
    const t = needTally(store, need.id);
    const remaining = need.quantity - t.usable - t.deliveredPending - t.inTransit - t.procured;
    if (body.quantity > remaining) conflict('OVER_PROCURE', '采购数量超过学校当前需求（学校人数变化会影响能买什么）', { remaining });
    const spec = effectiveSpec(store, need);
    const sku = findSkuBySpec(store, spec);
    if (!sku || !sku.available) conflict('SPEC_UNAVAILABLE', '供应商当前无此规格（缺码），不能采购', { spec });
    const totalMinor = sku.unitMinor * body.quantity; // 以当前报价为准，涨价直接影响能买什么

    // 先校验全部资金来源，再统一写入。
    const funding = Array.isArray(body.funding) ? body.funding : [];
    let covered = 0;
    for (const entry of funding) {
      if (entry.type === 'pledge') {
        const pledge = getPledge(store, entry.id);
        if (pledge.source !== 'donation' || pledge.status !== 'active' || pledge.need !== need.id) {
          conflict('PLEDGE_NOT_USABLE', `认捐 ${entry.id} 不可用于该采购（须为本需求的承诺中认捐）`);
        }
        if (spec.kind !== need.kind) {
          const d = getDonation(store, pledge.donation);
          const donor = donorOf(store, d);
          if (!restrictionCovers(donor, need.school, spec.kind) &&
              !hasApprovedConsent(store, d.id, need.id, ['purpose_change'])) {
            conflict('PURPOSE_CONSENT_REQUIRED', '替代品涉及原定用途变化，须先取得捐方同意');
          }
        }
        covered += pledge.amountMinor;
      } else if (entry.type === 'matching') {
        const rule = getRule(store, entry.rule);
        recomputeMatching(store, rule.id);
        assertPositiveInt(entry.amountMinor, '配捐使用金额');
        const spendable = matchingSpendable(rule);
        if (entry.amountMinor > spendable) {
          conflict('MATCHING_NOT_ARRIVED', '承诺配捐不算到账，可使用的配捐不足', { spendable });
        }
        covered += entry.amountMinor;
      } else {
        badRequest('资金来源类型须为 pledge（认捐）或 matching（配捐）');
      }
    }
    if (covered !== totalMinor) {
      conflict('FUNDING_MISMATCH', '资金来源合计必须等于按当前报价计算的采购总额（涨价后需补足或减少数量）', { totalMinor, covered });
    }

    const order = {
      id: store.id('PO'),
      need: need.id,
      sku: sku.id,
      quantity: body.quantity,
      unitMinor: sku.unitMinor,
      totalMinor,
      funding: funding.map(entry => entry.type === 'pledge'
        ? { type: 'pledge', id: entry.id, donation: getPledge(store, entry.id).donation, amountMinor: getPledge(store, entry.id).amountMinor, releasedMinor: 0 }
        : { type: 'matching', rule: entry.rule, amountMinor: entry.amountMinor, releasedMinor: 0 }),
      shippedQuantity: 0,
      status: 'pending_payment',
      payment: { id: null, key: null, state: 'none', attempts: [] },
      lateReceipts: [],
      needsReconciliation: false,
      createdBy: actor.id,
      createdAt: store.now()
    };
    for (const entry of order.funding) {
      if (entry.type === 'pledge') {
        const pledge = getPledge(store, entry.id);
        const d = getDonation(store, pledge.donation);
        d.earmarkedMinor -= entry.amountMinor;
        d.reservedMinor += entry.amountMinor;
        pledge.status = 'committed';
        pledge.order = order.id;
      } else {
        const rule = getRule(store, entry.rule);
        rule.record.reservedMinor += entry.amountMinor;
      }
    }
    store.state.orders[order.id] = order;
    if (idempotencyKey) store.state.orderKeys[idempotencyKey] = order.id;
    store.audit(actor, 'order.create', 'order', order.id, { need: need.id, quantity: order.quantity, totalMinor, idempotencyKey: idempotencyKey ?? null });
    return { order, reused: false };
  });
}

// 向结款方提交付款。受理后断线 → 资金未明；受理 ≠ 到账，终态以对账为准。
export async function payOrder(store, actor, orderId, partner) {
  requireRole(actor, ['buyer']);
  const order = getOrder(store, orderId);
  const payable = order.status === 'pending_payment' ||
    (order.status === 'payment_processing' && order.payment.state === 'unclear');
  if (!payable) conflict('ORDER_NOT_PAYABLE', `当前状态不能提交付款：${order.status}`);
  const paymentId = order.payment.id ?? `pp-${order.id}`;
  const key = order.payment.key ?? `purchase-${order.id}`;
  const items = [{ purchasePayment: paymentId, reference: order.id, amountMinor: order.totalMinor, need: order.need, sku: order.sku }];
  let outcome;
  try {
    outcome = await partner.submit({ key, items });
  } catch (error) {
    if (error.code !== 'PARTNER_CONFLICT') {
      // 网络断线：结款方可能已受理，资金未明，不能重复采购，待查单对账。
      store.transact(() => {
        order.status = 'payment_processing';
        order.payment = { id: paymentId, key, state: 'unclear', attempts: [...order.payment.attempts, { at: store.now(), result: 'disconnect' }] };
        store.audit(actor, 'order.payment_unclear', 'order', order.id, { paymentId });
      });
      return { order, outcome: 'unclear' };
    }
    throw error;
  }
  return store.transact(() => {
    const first = outcome.results[0] ?? {};
    const state = first.status === 'rejected' ? 'rejected' : 'sent';
    order.payment = { id: paymentId, key, state, attempts: [...order.payment.attempts, { at: store.now(), result: first.status ?? 'accepted' }] };
    if (state === 'rejected') {
      releaseOrderReservations(store, order);
      order.status = 'payment_failed';
    } else {
      order.status = 'payment_processing';
    }
    store.audit(actor, 'order.payment_submit', 'order', order.id, { paymentId, partnerStatus: first.status ?? null });
    return { order, outcome: first.status ?? 'accepted' };
  });
}

// 按结款方查单结果对账：confirmed 到账、returned 退回、rejected 未通过；
// 供货取消后到达的终态记为迟到回执，保留追查线索。
export async function reconcileOrder(store, actor, orderId, partner) {
  requireRole(actor, ['buyer']);
  const order = getOrder(store, orderId);
  if (!order.payment.id) conflict('NOT_SUBMITTED', '尚未提交付款，无需对账');
  const record = await partner.lookup(order.payment.id);
  return store.transact(() => {
    if (!record) {
      order.payment.attempts.push({ at: store.now(), result: 'lookup-404' });
      store.audit(actor, 'order.reconcile', 'order', order.id, { partner: null });
      return { order, partner: null };
    }
    const status = record.status;
    // 终态已处理过（含重复对账、已付款后取消等）：直接返回现状，不重复入账。
    if (['confirmed', 'returned', 'rejected'].includes(status) && order.payment.state === status) {
      return { order, partner: record };
    }
    if (status === 'confirmed') {
      if (order.status === 'payment_processing') {
        for (const entry of order.funding) {
          const amount = entry.amountMinor - (entry.releasedMinor ?? 0);
          if (amount <= 0) continue;
          if (entry.type === 'pledge') {
            const pledge = getPledge(store, entry.id);
            const d = getDonation(store, pledge.donation);
            d.reservedMinor -= amount;
            d.spentMinor += amount;
            pledge.status = 'fulfilled';
          } else {
            const rule = getRule(store, entry.rule);
            rule.record.reservedMinor -= amount;
            rule.record.spentMinor += amount;
            recomputeMatching(store, rule.id);
          }
        }
        order.status = 'paid';
        order.payment.state = 'confirmed';
      } else if (order.status === 'supplier_cancelled' || order.status === 'cancelled') {
        // 迟到回执：订单已取消但付款被确认 → 钱已付出，形成待追回责任。
        order.lateReceipts.push({ paymentId: order.payment.id, status, details: record.details ?? {}, at: store.now() });
        order.needsReconciliation = true;
        order.payment.state = 'confirmed';
        let claimTotal = 0;
        for (const entry of order.funding) {
          const amount = entry.amountMinor - (entry.releasedMinor ?? 0);
          if (amount <= 0) continue;
          entry.releasedMinor = entry.amountMinor;
          claimTotal += amount;
          if (entry.type === 'pledge') {
            const pledge = getPledge(store, entry.id);
            const d = getDonation(store, pledge.donation);
            d.reservedMinor -= amount;
            d.spentMinor += amount;
            if (pledge.status === 'committed') pledge.status = 'released';
          } else {
            const rule = getRule(store, entry.rule);
            rule.record.reservedMinor -= amount;
            rule.record.spentMinor += amount;
            recomputeMatching(store, rule.id);
          }
        }
        const claim = { id: store.id('CLM'), order: order.id, amountMinor: claimTotal, reason: '供货取消后付款被确认，需向结款方或供货方追回', status: 'pending', at: store.now() };
        store.state.claims[claim.id] = claim;
        store.audit(actor, 'order.late_receipt', 'order', order.id, { status, claim: claim.id, amountMinor: claimTotal });
        return { order, partner: record };
      }
    } else if (status === 'returned') {
      if (order.status === 'payment_processing') {
        releaseOrderReservations(store, order);
        order.status = 'payment_returned';
        order.payment.state = 'returned';
      } else if (order.status === 'supplier_cancelled' || order.status === 'cancelled') {
        // 迟到回执：取消后款项退回，释放占用，保留追查记录。
        order.lateReceipts.push({ paymentId: order.payment.id, status, details: record.details ?? {}, at: store.now() });
        releaseOrderReservations(store, order);
        order.payment.state = 'returned';
        store.audit(actor, 'order.late_receipt', 'order', order.id, { status });
        return { order, partner: record };
      }
    } else if (status === 'rejected') {
      if (order.status === 'payment_processing') {
        releaseOrderReservations(store, order);
        order.status = 'payment_failed';
        order.payment.state = 'rejected';
      }
    }
    store.audit(actor, 'order.reconcile', 'order', order.id, { partner: status });
    return { order, partner: record };
  });
}

export function cancelOrder(store, actor, orderId, body = {}) {
  requireRole(actor, ['buyer']);
  return store.transact(() => {
    const order = getOrder(store, orderId);
    if (order.shippedQuantity > 0) conflict('ORDER_HAS_SHIPMENTS', '已有发货事实的采购单不能整体取消，可按未发货部分缩减');
    if (order.status === 'payment_processing' && order.payment.state === 'unclear') {
      conflict('FUNDS_UNCLEAR', '付款状态未明，不能取消，请先查单对账');
    }
    cancelOrderRecord(store, order, actor, body.reason ?? null);
    return order;
  });
}

export function reduceOrder(store, actor, orderId, body) {
  requireRole(actor, ['buyer']);
  return store.transact(() => {
    const order = getOrder(store, orderId);
    if (!ORDER_OPEN_STATUSES.includes(order.status)) conflict('ORDER_NOT_OPEN', '只有进行中的采购单可以缩减');
    reduceOrderRecord(store, order, body.quantity, actor);
    return order;
  });
}

// ---------- 发货与物流 ----------

export function shipFromOrder(store, actor, orderId, body) {
  requireRole(actor, ['buyer']);
  return store.transact(() => {
    const order = getOrder(store, orderId);
    if (order.status !== 'paid') conflict('ORDER_NOT_PAID', '付款到账后才能发货');
    const need = getNeed(store, order.need);
    let shipment;
    if (body.delivery) {
      // 采用待提交的物流资料（fixtures deliveries）：核对学校与规格后转为在途。
      shipment = getShipment(store, body.delivery);
      if (shipment.status !== 'draft') conflict('DELIVERY_USED', '该物流资料已使用');
      if (shipment.school !== need.school) conflict('DELIVERY_SCHOOL_MISMATCH', '物流资料学校与需求不符');
      const sku = getSku(store, shipment.sku);
      if (sku.id !== order.sku) conflict('DELIVERY_SKU_MISMATCH', '物流资料规格与采购单不符');
    } else {
      assertPositiveInt(body.quantity, '发货数量');
      shipment = {
        id: store.id('DEL'), school: need.school, sku: order.sku, need: null, order: null,
        pledge: null, stock: null, kind: null, size: null, quantity: body.quantity,
        waybill: body.waybill ?? null, status: 'draft', delivered: null, shortage: null,
        shippedAt: null, deliveredAt: null
      };
      store.state.shipments[shipment.id] = shipment;
    }
    if (shipment.quantity > order.quantity - order.shippedQuantity) {
      conflict('OVER_SHIP', '发货数量超过采购未发货数量', { remaining: order.quantity - order.shippedQuantity });
    }
    const sku = getSku(store, order.sku);
    Object.assign(shipment, {
      need: need.id, order: order.id, kind: sku.kind, size: sku.size ?? null,
      status: 'in_transit', shippedAt: store.now()
    });
    order.shippedQuantity += shipment.quantity;
    store.audit(actor, 'shipment.create', 'shipment', shipment.id, { order: order.id, quantity: shipment.quantity, waybill: shipment.waybill });
    return shipment;
  });
}

// 库存调拨发货：只有确认入库的库存可发；在途不等于库存。
export function shipFromPledge(store, actor, pledgeId, body) {
  requireRole(actor, ['approver']);
  return store.transact(() => {
    const pledge = getPledge(store, pledgeId);
    if (pledge.source !== 'stock') conflict('PLEDGE_NOT_STOCK', '只有库存调拨认捐可以直接发货');
    if (pledge.status !== 'active') conflict('PLEDGE_NOT_ACTIVE', '认捐不在承诺中状态');
    const quantity = body.quantity ?? pledge.quantity - pledge.shippedQuantity;
    assertPositiveInt(quantity, '发货数量');
    if (quantity > pledge.quantity - pledge.shippedQuantity) conflict('OVER_SHIP', '超过认捐未发货数量');
    const stock = getStock(store, pledge.stock);
    const need = getNeed(store, pledge.need);
    stock.reservedQuantity -= quantity;
    stock.shippedQuantity += quantity;
    const shipment = {
      id: store.id('DEL'), school: need.school, sku: stock.sku, need: need.id, order: null,
      pledge: pledge.id, stock: stock.id, kind: stock.kind, size: stock.size ?? null,
      quantity, waybill: body.waybill ?? null, status: 'in_transit', delivered: null, shortage: null,
      shippedAt: store.now(), deliveredAt: null
    };
    store.state.shipments[shipment.id] = shipment;
    pledge.shippedQuantity += quantity;
    if (pledge.shippedQuantity >= pledge.quantity) pledge.status = 'fulfilled';
    store.audit(actor, 'shipment.create', 'shipment', shipment.id, { pledge: pledge.id, stock: stock.id, quantity });
    return shipment;
  });
}

export function deliverShipment(store, actor, shipmentId, body) {
  requireRole(actor, ['logistics']);
  return store.transact(() => {
    const shipment = getShipment(store, shipmentId);
    if (shipment.status !== 'in_transit') conflict('SHIPMENT_NOT_IN_TRANSIT', '只有在途批次可以回报送达');
    assertNonNegativeInt(body.delivered, '送达数量');
    assertNonNegativeInt(body.shortage ?? 0, '短少数量');
    if (body.delivered + (body.shortage ?? 0) !== shipment.quantity) {
      badRequest('送达数量与短少数量之和须等于发货数量', { quantity: shipment.quantity });
    }
    shipment.delivered = body.delivered;
    shipment.shortage = body.shortage ?? 0;
    shipment.status = 'delivered';
    shipment.deliveredAt = store.now();
    store.audit(actor, 'shipment.deliver', 'shipment', shipment.id, { delivered: shipment.delivered, shortage: shipment.shortage });
    return shipment;
  });
}

// 学校签收：签收数量不等于全部验收合格；破损、尺码不符、可直接使用分别记录。
export function acceptShipment(store, actor, shipmentId, body) {
  requireRole(actor, ['school']);
  return store.transact(() => {
    const shipment = getShipment(store, shipmentId);
    const need = getNeed(store, shipment.need);
    ownSchool(actor, need);
    if (shipment.status !== 'delivered') conflict('SHIPMENT_NOT_DELIVERED', '只有已送达批次可以签收验收');
    const change = checkChange(store, body.change, { delivery: shipmentId, received: body.received, usable: body.usable });
    assertNonNegativeInt(body.received, '签收数量');
    assertNonNegativeInt(body.usable, '合格数量');
    assertNonNegativeInt(body.damaged ?? 0, '破损数量');
    assertNonNegativeInt(body.sizeMismatch ?? 0, '尺码不符数量');
    if (body.received !== shipment.delivered) conflict('RECEIVED_MISMATCH', '签收数量须等于物流送达数量', { delivered: shipment.delivered });
    if (body.usable + (body.damaged ?? 0) + (body.sizeMismatch ?? 0) !== body.received) {
      badRequest('合格、破损、尺码不符之和须等于签收数量');
    }
    const acceptance = {
      id: store.id('ACC'),
      shipment: shipment.id,
      need: need.id,
      received: body.received,
      usable: body.usable,
      damaged: body.damaged ?? 0,
      sizeMismatch: body.sizeMismatch ?? 0,
      reason: body.reason ?? null,
      change: change?.id ?? null,
      by: actor.id,
      at: store.now()
    };
    store.state.acceptances[acceptance.id] = acceptance;
    shipment.status = 'accepted';
    let returnRecord = null;
    const returnQuantity = acceptance.damaged + acceptance.sizeMismatch;
    if (returnQuantity > 0) {
      returnRecord = {
        id: store.id('RET'),
        shipment: shipment.id,
        need: need.id,
        sku: shipment.sku,
        kind: shipment.kind,
        size: shipment.size ?? null,
        quantity: returnQuantity,
        damaged: acceptance.damaged,
        sizeMismatch: acceptance.sizeMismatch,
        status: 'pending_warehouse',
        createdAt: store.now()
      };
      store.state.returns[returnRecord.id] = returnRecord;
    }
    applyChange(store, change);
    store.audit(actor, 'shipment.accept', 'shipment', shipment.id, { acceptance: acceptance.id, usable: acceptance.usable, damaged: acceptance.damaged, sizeMismatch: acceptance.sizeMismatch });
    return { acceptance, return: returnRecord };
  });
}

// ---------- 退回与库存 ----------

// 退回实物确认入库后才可重配；破损部分记为残损库存，不可再承诺。
export function confirmReturn(store, actor, returnId, body = {}) {
  requireRole(actor, ['warehouse']);
  return store.transact(() => {
    const record = getReturn(store, returnId);
    if (record.status !== 'pending_warehouse') conflict('RETURN_ALREADY_CONFIRMED', '该退回已确认入库');
    const change = checkChange(store, body.change, { delivery: record.shipment, quantity: record.quantity });
    record.status = 'warehouse_confirmed';
    record.confirmedAt = store.now();
    record.confirmedBy = actor.id;
    const stocks = [];
    if (record.sizeMismatch > 0) {
      const stock = {
        id: store.id('STK'), sku: record.sku, kind: record.kind, size: record.size ?? null,
        quantity: record.sizeMismatch, reservedQuantity: 0, shippedQuantity: 0,
        restriction: null, source: record.id, status: 'available', createdAt: store.now()
      };
      store.state.stocks[stock.id] = stock;
      stocks.push(stock);
    }
    if (record.damaged > 0) {
      const stock = {
        id: store.id('STK'), sku: record.sku, kind: record.kind, size: record.size ?? null,
        quantity: record.damaged, reservedQuantity: 0, shippedQuantity: 0,
        restriction: null, source: record.id, status: 'defective', createdAt: store.now()
      };
      store.state.stocks[stock.id] = stock;
      stocks.push(stock);
    }
    applyChange(store, change);
    store.audit(actor, 'return.confirm', 'return', record.id, { stocks: stocks.map(s => s.id) });
    return { return: record, stocks };
  });
}

// ---------- 目录报价 ----------

export function quoteCatalog(store, actor, skuId, body) {
  requireRole(actor, ['buyer']);
  return store.transact(() => {
    const sku = getSku(store, skuId);
    if (body.unitMinor !== undefined) {
      assertPositiveInt(body.unitMinor, '单价');
      sku.unitMinor = body.unitMinor;
    }
    if (body.available !== undefined) sku.available = Boolean(body.available);
    store.audit(actor, 'catalog.quote', 'catalog', sku.id, { unitMinor: sku.unitMinor, available: sku.available });
    return sku;
  });
}
