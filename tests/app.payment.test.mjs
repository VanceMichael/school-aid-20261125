// 采购付款：结款方受理后断线（资金未明不能重复采购）、查单对账、
// 供货取消后迟到回执可追查、拒付后资金可再用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './helpers.mjs';

async function prepareOrder(w, { needQty = 3, orderQty = 2 } = {}) {
  let r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: needQty });
  const needId = r.body.id;
  await w.verifier.post(`/needs/${needId}/verify`);
  await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
  r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: orderQty });
  const pledgeId = r.body.id;
  r = await w.buyer.post('/orders', { need: needId, quantity: orderQty, funding: [{ type: 'pledge', id: pledgeId }] });
  return { needId, pledgeId, orderId: r.body.id, unitMinor: r.body.unitMinor };
}

test('受理后断线：资金未明阻断重复采购与资金挪用，查单对账后到账', async () => {
  const w = await startWorld();
  try {
    const { needId, orderId } = await prepareOrder(w);
    await w.partnerControl.rule(`pp-${orderId}`, 'accepted_disconnect');

    // 提交付款时结款方先持久受理再断开：业务侧只能记为资金未明。
    let r = await w.buyer.post(`/orders/${orderId}/pay`);
    assert.equal(r.body.outcome, 'unclear');
    assert.equal(r.body.order.status, 'payment_processing');
    assert.equal(r.body.order.payment.state, 'unclear');

    // 资金未明：不能重复采购（需求还剩 1 件也不行）。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 1 });
    const pledge2 = r.body.id;
    r = await w.buyer.post('/orders', { need: needId, quantity: 1, funding: [{ type: 'pledge', id: pledge2 }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'FUNDS_UNCLEAR');
    // 资金未明：不能取消、不能退被占用的款。
    r = await w.buyer.post(`/orders/${orderId}/cancel`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'FUNDS_UNCLEAR');
    r = await w.donorA.post('/donations/PL-1/refund', { amountMinor: 120000 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'REFUND_EXCEEDS_AVAILABLE');

    // 结款方侧确实已受理（受理 ≠ 到账）。
    const partnerRecord = await w.partnerControl.lookup(`pp-${orderId}`);
    assert.equal(partnerRecord.status, 'accepted');

    // 断线后重发同一请求键与资料：不重复形成流水，状态转为已受理。
    r = await w.buyer.post(`/orders/${orderId}/pay`);
    assert.equal(r.body.order.payment.state, 'sent');
    // 终态确认 → 对账到账，认捐转为已履约。
    await w.partnerControl.settle(`pp-${orderId}`, 'confirmed', { receipt: 'rcpt-1' });
    r = await w.buyer.post(`/orders/${orderId}/reconcile`);
    assert.equal(r.body.order.status, 'paid');
    const donation = w.store.state.donations['PL-1'];
    assert.equal(donation.spentMinor, 20000);
    assert.equal(donation.reservedMinor, 0);
  } finally {
    await w.close();
  }
});

test('供货取消后迟到回执：退回与误确认都可追查，误确认形成待追回责任', async () => {
  const w = await startWorld();
  try {
    // 情形一：受理后供货取消，随后结款方终态“退回”。
    let { orderId } = await prepareOrder(w, { orderQty: 1 });
    await w.buyer.post(`/orders/${orderId}/pay`);
    let r = await w.buyer.post(`/orders/${orderId}/cancel`, { reason: '供货取消' });
    assert.equal(r.body.status, 'supplier_cancelled');
    await w.partnerControl.settle(`pp-${orderId}`, 'returned', { note: '取消后退回' });
    r = await w.buyer.post(`/orders/${orderId}/reconcile`);
    assert.equal(r.body.order.lateReceipts.length, 1);
    assert.equal(r.body.order.lateReceipts[0].status, 'returned');
    // 占用释放，认捐恢复承诺中。
    let donation = w.store.state.donations['PL-1'];
    assert.equal(donation.reservedMinor, 0);
    assert.equal(donation.earmarkedMinor, 10000);
    // 审计可追查。
    const actions = w.store.state.audit.map(a => a.action);
    assert.ok(actions.includes('order.late_receipt'));

    // 情形二：受理后供货取消，随后结款方却终态“确认”——钱已付出，形成待追回。
    ({ orderId } = await prepareOrder(w, { orderQty: 1 }));
    await w.buyer.post(`/orders/${orderId}/pay`);
    await w.buyer.post(`/orders/${orderId}/cancel`, { reason: '供货取消' });
    await w.partnerControl.settle(`pp-${orderId}`, 'confirmed', { receipt: 'rcpt-late' });
    r = await w.buyer.post(`/orders/${orderId}/reconcile`);
    assert.equal(r.body.order.lateReceipts.length, 1);
    assert.equal(r.body.order.lateReceipts[0].status, 'confirmed');
    assert.equal(r.body.order.needsReconciliation, true);
    donation = w.store.state.donations['PL-1'];
    assert.equal(donation.spentMinor, 10000); // 钱实际付出，不悄悄冲销
    const claims = Object.values(w.store.state.claims);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].amountMinor, 10000);
    assert.equal(claims[0].status, 'pending');
    // GET 采购单可见迟到回执，供追查。
    r = await w.buyer.get(`/orders/${orderId}`);
    assert.equal(r.body.lateReceipts.length, 1);
  } finally {
    await w.close();
  }
});

test('结款方拒付：占用释放、资金可再用；重复对账不重复入账', async () => {
  const w = await startWorld();
  try {
    const { needId, pledgeId, orderId } = await prepareOrder(w, { orderQty: 2 });
    await w.partnerControl.rule(`pp-${orderId}`, 'rejected');
    let r = await w.buyer.post(`/orders/${orderId}/pay`);
    assert.equal(r.body.order.status, 'payment_failed');
    // 认捐恢复承诺中，捐款可用余额恢复。
    const pledge = w.store.state.pledges[pledgeId];
    assert.equal(pledge.status, 'active');
    const donation = w.store.state.donations['PL-1'];
    assert.equal(donation.earmarkedMinor, 20000);
    assert.equal(donation.reservedMinor, 0);
    // 同一认捐可再次用于采购。
    r = await w.buyer.post('/orders', { need: needId, quantity: 2, funding: [{ type: 'pledge', id: pledgeId }] });
    assert.equal(r.status, 201);
    const order2 = r.body.id;
    // 正常付款并重复对账：只入账一次。
    await w.buyer.post(`/orders/${order2}/pay`);
    await w.partnerControl.settle(`pp-${order2}`, 'confirmed', { receipt: 'rcpt-2' });
    await w.buyer.post(`/orders/${order2}/reconcile`);
    r = await w.buyer.post(`/orders/${order2}/reconcile`);
    assert.equal(r.body.order.status, 'paid');
    assert.equal(w.store.state.donations['PL-1'].spentMinor, 20000);
  } finally {
    await w.close();
  }
});
