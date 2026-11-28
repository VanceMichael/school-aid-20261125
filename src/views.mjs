// 视图层：同一事实按受众给出不同口径。
// 公开页面与物流方拿不到家庭困难原因、匿名编号与姓名映射；捐方只能看自己的捐助。
import { needTally, donationAvailable, matchingSpendable } from './domain.mjs';

// 需求进度：核实、承诺、采购、在途、实际满足量分列；认捐额不当作已收到的帮助。
export function needProgressView(store, need, audience) {
  const t = needTally(store, need.id);
  const remaining = Math.max(0, need.quantity - t.usable - t.deliveredPending - t.inTransit - t.procured - t.promised);
  const base = {
    id: need.id,
    school: need.school,
    kind: need.kind,
    size: need.size,
    age: need.age ?? null,
    status: need.status,
    quantity: need.quantity,
    originalQuantity: need.originalQuantity,
    verified: need.verifiedBy ? { by: need.verifiedBy, at: need.verifiedAt } : null,
    promised: t.promised, // 有人答应（认捐承诺，不等于可收货）
    procured: t.procured, // 已采购未发货（可等收货）
    inTransit: t.inTransit, // 在途
    deliveredPending: t.deliveredPending, // 已送达待验收
    received: t.received, // 签收合计
    usable: t.usable, // 实际满足量（验收合格）
    damaged: t.damaged,
    sizeMismatch: t.sizeMismatch,
    shortage: t.shortage, // 物流短少
    returnPending: t.returnPending, // 退回待入库
    remaining, // 仍需承诺
    reductions: need.reductions,
    substitutes: need.substitutes.map(s => ({ id: s.id, sku: s.sku, quantity: s.quantity, status: s.status, schoolConfirmed: s.schoolConfirmed, kindChanged: s.kindChanged })),
    cancelledUnmet: need.cancelledUnmet
  };
  if (audience === 'public') {
    // 公开口径：只有聚合数量，没有匿名编号、困难原因、金额与经手人。
    return {
      id: base.id, school: base.school, kind: base.kind, size: base.size, age: base.age, status: base.status,
      quantity: base.quantity, promised: base.promised, procured: base.procured,
      inTransit: base.inTransit, usable: base.usable, remaining: base.remaining
    };
  }
  if (audience === 'school' || audience === 'verifier') {
    // 校内可见匿名编号与困难原因，用于核对；不出系统边界。
    return { ...base, studentRefs: need.studentRefs, hardshipNote: need.hardshipNote };
  }
  // 团队、采购、捐方：无学生信息。
  return base;
}

// 捐助去向：限制与去向、退款或缺口；原始限制不可改写，变更以同意记录为准。
export function donationWhereaboutsView(store, d) {
  const donor = store.state.donors[d.donor] ?? null;
  const pledges = Object.values(store.state.pledges).filter(p => p.donation === d.id);
  const orders = Object.values(store.state.orders).filter(o => o.funding.some(f => f.donation === d.id));
  const rules = Object.values(store.state.matching).filter(r => r.donor === d.donor);
  const refunds = Object.values(store.state.refunds).filter(r => r.donation === d.id);
  const consents = Object.values(store.state.consents).filter(c => c.donation === d.id);
  return {
    id: d.id,
    donor: d.donor,
    status: d.status,
    restriction: {
      scope: donor?.scope ?? [],
      purposes: donor?.purposes ?? [],
      note: '原始限制不可改写；改配或用途变化以捐方同意记录为准'
    },
    promisedMinor: d.promisedMinor,
    arrivedMinor: d.arrivedMinor,
    refundedMinor: d.refundedMinor,
    failedMinor: d.failedMinor,
    earmarkedMinor: d.earmarkedMinor, // 已承诺未采购
    reservedMinor: d.reservedMinor, // 采购付款中
    spentMinor: d.spentMinor, // 已用于采购
    surplusMinor: donationAvailable(d), // 剩余可用（仍受原限制约束）
    gapMinor: Math.max(0, d.promisedMinor - d.arrivedMinor - d.failedMinor), // 承诺未兑现缺口
    allocations: pledges.map(p => ({
      pledge: p.id, need: p.need, quantity: p.quantity, amountMinor: p.amountMinor, status: p.status
    })),
    orders: orders.map(o => ({
      order: o.id, need: o.need, status: o.status, totalMinor: o.totalMinor,
      fundedMinor: o.funding.filter(f => f.donation === d.id).reduce((total, f) => total + f.amountMinor - (f.releasedMinor ?? 0), 0)
    })),
    matching: rules.map(r => ({
      rule: r.id,
      entitledMinor: r.record.entitledMinor,
      arrivedMinor: r.record.arrivedMinor,
      spentMinor: r.record.spentMinor,
      responsibilityMinor: r.record.responsibilityMinor, // 需追回或由团队补足
      excessMinor: r.record.excessMinor // 超出资格、应退配捐方
    })),
    refunds: refunds.map(r => ({ id: r.id, amountMinor: r.amountMinor, reason: r.reason, at: r.at })),
    consents: consents.map(c => ({ id: c.id, type: c.type, need: c.need, status: c.status, decidedAt: c.decidedAt }))
  };
}

export function matchingView(store, rule) {
  return {
    id: rule.id,
    donor: rule.donor,
    ratio: `${rule.ratioNum}/${rule.ratioDen}`,
    capMinor: rule.capMinor,
    deadline: rule.deadline,
    entitledMinor: rule.record.entitledMinor, // 当前资格（按合格到账与比例、上限核算）
    arrivedMinor: rule.record.arrivedMinor, // 实际到账（承诺配捐不算到账）
    spendableMinor: matchingSpendable(rule),
    spentMinor: rule.record.spentMinor,
    responsibilityMinor: rule.record.responsibilityMinor,
    excessMinor: rule.record.excessMinor
  };
}

// 物流面单：只有配送必需信息，没有学生、困难原因、捐方与金额。
export function manifestView(store, shipment) {
  const school = store.state.schools[shipment.school] ?? null;
  return {
    id: shipment.id,
    waybill: shipment.waybill,
    status: shipment.status,
    quantity: shipment.quantity,
    kind: shipment.kind,
    size: shipment.size,
    age: shipment.age ?? null,
    school: school ? { id: school.id, name: school.name, address: school.address } : { id: shipment.school }
  };
}

// 公开汇总：已收到的帮助只按验收合格计，不认认捐额。
export function publicSchoolSummaryView(store, schoolId) {
  const school = store.state.schools[schoolId] ?? null;
  const needs = Object.values(store.state.needs).filter(n => n.school === schoolId);
  const byKind = {};
  for (const need of needs) {
    const t = needTally(store, need.id);
    const row = byKind[need.kind] ??= { kind: need.kind, needs: 0, quantity: 0, promised: 0, procured: 0, inTransit: 0, usable: 0 };
    row.needs += 1;
    row.quantity += need.quantity;
    row.promised += t.promised;
    row.procured += t.procured;
    row.inTransit += t.inTransit;
    row.usable += t.usable;
  }
  return {
    school: school ? { id: school.id, name: school.name } : { id: schoolId },
    kinds: Object.values(byKind),
    note: 'usable 为实际收到的帮助（验收合格）；promised 仅是有人答应，procured/inTransit 为可等收货'
  };
}

export function orderView(store, order) {
  return {
    ...order,
    funding: order.funding.map(f => ({ ...f }))
  };
}

export function stockView(store, stock) {
  return {
    id: stock.id,
    sku: stock.sku,
    kind: stock.kind,
    size: stock.size,
    status: stock.status,
    quantity: stock.quantity,
    reservedQuantity: stock.reservedQuantity,
    shippedQuantity: stock.shippedQuantity,
    freeQuantity: stock.quantity - stock.reservedQuantity - stock.shippedQuantity,
    source: stock.source
  };
}
