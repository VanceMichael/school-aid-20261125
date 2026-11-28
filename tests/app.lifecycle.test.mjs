// 生命周期：替代品双确认、学校撤销未满足部分、剩余款物改配需同意、
// 涨价与缺码影响采购、已取得同意仍看资金与需求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './helpers.mjs';

test('替代品：同类替代学校确认即可；用途变化须学校与捐方分别确认，一个不能代替另一个', async () => {
  const w = await startWorld();
  try {
    await w.verifier.post('/needs/ND-1/verify');
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });

    // 同类替代（SUBSTITUTE-1：140 码 → 150 码，同为冬衣）：学校确认后生效。
    let r = await w.approver.post('/needs/ND-1/substitutes', { sku: 'SKU-150', quantity: 2, change: 'SUBSTITUTE-1' });
    assert.equal(r.status, 201);
    const sub1 = r.body.id;
    assert.equal(r.body.kindChanged, false);
    r = await w.schoolA.post(`/needs/ND-1/substitutes/${sub1}/school-confirm`);
    assert.equal(r.body.status, 'effective');
    // 生效后认捐按替代规格计价（SKU-150 单价 11000）。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-1', quantity: 1 });
    assert.equal(r.body.unitMinor, 11000);

    // 用途变化（冬衣 → 文具）：自动生成捐方同意请求，学校确认不能代替捐方同意。
    await w.verifier.post('/needs/ND-2/verify');
    await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-2', quantity: 1 });
    r = await w.approver.post('/needs/ND-2/substitutes', { sku: 'SKU-ST-1', quantity: 1 });
    const sub2 = r.body.id;
    assert.equal(r.body.kindChanged, true);
    assert.equal(r.body.status, 'pending_consent');
    const consent = Object.values(w.store.state.consents).find(c => c.substitute === sub2);
    assert.ok(consent, '用途变化应自动生成捐方同意请求');
    // 捐方同意在先、学校未确认：仍不生效。
    r = await w.donorB.post(`/consents/${consent.id}/decide`, { approve: true });
    assert.equal(r.status, 403); // 非本捐方无权决定
    await w.donorA.post(`/consents/${consent.id}/decide`, { approve: true });
    r = await w.approver.get('/needs/ND-2/progress');
    assert.notEqual(r.body.substitutes.find(s => s.id === sub2).status, 'effective');
    // 学校确认后双方齐备，替代品生效。
    await w.schoolA.post(`/needs/ND-2/substitutes/${sub2}/school-confirm`);
    r = await w.approver.get('/needs/ND-2/progress');
    assert.equal(r.body.substitutes.find(s => s.id === sub2).status, 'effective');
    // 生效后采购按新用途执行（已有捐方同意）。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-2', quantity: 1 });
    assert.equal(r.body.unitMinor, 3000);
    r = await w.buyer.post('/orders', { need: 'ND-2', quantity: 1, funding: [{ type: 'pledge', id: r.body.id }] });
    assert.equal(r.status, 201);
  } finally {
    await w.close();
  }
});

test('学校撤销未满足部分：认捐、采购、配捐约束解除，已发放有效物资保留事实', async () => {
  const w = await startWorld();
  try {
    let r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 5 });
    const needId = r.body.id;
    await w.verifier.post(`/needs/${needId}/verify`);
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    await w.approver.post('/matching/MATCH-1/compute');
    await w.approver.post('/matching/MATCH-1/arrive', { amountMinor: 50000 });

    // 认捐 A：2 件保持承诺中；认捐 B：2 件 + 配捐 10000 进入采购 3 件。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 2 });
    const pledgeA = r.body.id;
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 2 });
    const pledgeB = r.body.id;
    r = await w.buyer.post('/orders', {
      need: needId, quantity: 3,
      funding: [{ type: 'pledge', id: pledgeB }, { type: 'matching', rule: 'MATCH-1', amountMinor: 10000 }]
    });
    const orderId = r.body.id;
    await w.buyer.post(`/orders/${orderId}/pay`);
    await w.partnerControl.settle(`pp-${orderId}`, 'confirmed', { receipt: 'rcpt-c' });
    await w.buyer.post(`/orders/${orderId}/reconcile`);
    // 发货 1 件并验收合格：已发放事实。
    r = await w.buyer.post(`/orders/${orderId}/shipments`, { quantity: 1, waybill: 'WAY-C' });
    const shipmentId = r.body.id;
    await w.logistics.post(`/shipments/${shipmentId}/deliver`, { delivered: 1, shortage: 0 });
    await w.schoolA.post(`/shipments/${shipmentId}/acceptance`, { received: 1, usable: 1, damaged: 0, sizeMismatch: 0 });

    // 学校撤销未满足部分。
    r = await w.schoolA.post(`/needs/${needId}/cancel-unmet`, { reason: '学生转学，需求取消' });
    assert.equal(r.body.status, 'closed_partial');
    assert.equal(r.body.quantity, 1); // 收缩到已合格数量

    // 认捐 A 解除、捐款占用全部释放。
    const donation = w.store.state.donations['PL-1'];
    assert.equal(w.store.state.pledges[pledgeA].status, 'released');
    assert.equal(donation.earmarkedMinor, 0);
    assert.equal(donation.reservedMinor, 0);
    assert.equal(donation.spentMinor, 0); // 采购缩减退回自有捐款
    // 配捐约束解除到已发货部分：已花 10000（1 件），其余释放。
    const matching = w.store.state.matching['MATCH-1'].record;
    assert.equal(matching.spentMinor, 10000);
    assert.equal(matching.reservedMinor, 0);
    // 已发放事实保留：验收记录与合格数量不变。
    r = await w.schoolA.get(`/needs/${needId}/progress`);
    assert.equal(r.body.usable, 1);
    assert.equal(Object.keys(w.store.state.acceptances).length, 1);
    assert.equal(w.store.state.shipments[shipmentId].status, 'accepted');
  } finally {
    await w.close();
  }
});

test('剩余款物改配：须捐方同意且不改写原限制；已取得同意仍看资金与需求', async () => {
  const w = await startWorld();
  try {
    await w.verifier.post('/needs/ND-3/verify'); // SCH-B 文具
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });

    // DN-A 限制为 SCH-A 冬衣：改配 SCH-B 文具须先取得同意。
    let r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-3', quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CONSENT_REQUIRED');
    r = await w.approver.post('/consents', { donation: 'PL-1', type: 'redirect', need: 'ND-3' });
    const consentId = r.body.id;
    await w.donorA.post(`/consents/${consentId}/decide`, { approve: true });
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-3', quantity: 1 });
    assert.equal(r.status, 201);

    // 原始限制不被改写。
    r = await w.donorA.get('/donations/PL-1/whereabouts');
    assert.deepEqual(r.body.restriction.scope, ['SCH-A']);
    assert.deepEqual(r.body.restriction.purposes, ['winter-coat']);

    // 已取得同意仍看可用资金：超出余额的认捐不成立。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-3', quantity: 100 });
    assert.equal(r.status, 409);
    assert.ok(['FUNDS_INSUFFICIENT', 'NEED_OVERPLEDGED'].includes(r.body.error.code));
  } finally {
    await w.close();
  }
});

test('规格含适用年龄：年龄不符的库存不能自动算满足', async () => {
  const w = await startWorld();
  try {
    // 经采购→签收→退回入库，产生一笔可重配库存（140 码冬衣，无年龄标注）。
    let r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 1 });
    const needA = r.body.id;
    await w.verifier.post(`/needs/${needA}/verify`);
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needA, quantity: 1 });
    const pledgeId = r.body.id;
    r = await w.buyer.post('/orders', { need: needA, quantity: 1, funding: [{ type: 'pledge', id: pledgeId }] });
    const orderId = r.body.id;
    await w.buyer.post(`/orders/${orderId}/pay`);
    await w.partnerControl.settle(`pp-${orderId}`, 'confirmed', { receipt: 'rcpt-age' });
    await w.buyer.post(`/orders/${orderId}/reconcile`);
    r = await w.buyer.post(`/orders/${orderId}/shipments`, { quantity: 1, waybill: 'WAY-AGE' });
    const shipmentId = r.body.id;
    await w.logistics.post(`/shipments/${shipmentId}/deliver`, { delivered: 1, shortage: 0 });
    r = await w.schoolA.post(`/shipments/${shipmentId}/acceptance`, { received: 1, usable: 0, damaged: 0, sizeMismatch: 1 });
    const returnId = r.body.return.id;
    r = await w.warehouse.post(`/returns/${returnId}/confirm`);
    const stockId = r.body.stocks[0].id;

    // 需求标注适用年龄 10-12：库存无此标注，规格不符。
    r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', age: '10-12', quantity: 1 });
    const needB = r.body.id;
    await w.verifier.post(`/needs/${needB}/verify`);
    r = await w.approver.post('/pledges', { stock: stockId, need: needB, quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'SPEC_MISMATCH');
    // 不标注年龄的同尺码需求可以匹配。
    r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 1 });
    const needC = r.body.id;
    await w.verifier.post(`/needs/${needC}/verify`);
    r = await w.approver.post('/pledges', { stock: stockId, need: needC, quantity: 1 });
    assert.equal(r.status, 201);
  } finally {
    await w.close();
  }
});

test('涨价与缺码影响能买什么：报价以采购时为准，缺码不能采购', async () => {
  const w = await startWorld();
  try {
    let r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 2 });
    const needId = r.body.id;
    await w.verifier.post(`/needs/${needId}/verify`);
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 2 });
    const pledgeId = r.body.id;
    assert.equal(r.body.amountMinor, 20000);

    // 涨价：10000 → 12000，原认捐额不足，需补足或减少数量。
    await w.buyer.post('/catalog/SKU-140/quote', { unitMinor: 12000 });
    r = await w.buyer.post('/orders', { need: needId, quantity: 2, funding: [{ type: 'pledge', id: pledgeId }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'FUNDING_MISMATCH');
    // 减少数量到 1 件：12000 仍不等于认捐 20000，资金合计必须相等。
    r = await w.buyer.post('/orders', { need: needId, quantity: 1, funding: [{ type: 'pledge', id: pledgeId }] });
    assert.equal(r.status, 409);
    // 解除原认捐、按新价重新承诺后成交。
    await w.approver.post(`/pledges/${pledgeId}/release`);
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 2 });
    assert.equal(r.body.amountMinor, 24000);
    r = await w.buyer.post('/orders', { need: needId, quantity: 2, funding: [{ type: 'pledge', id: r.body.id }] });
    assert.equal(r.status, 201);

    // 缺码：供应商无货不能采购。
    await w.buyer.post('/catalog/SKU-140/quote', { available: false });
    r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 1 });
    const need2 = r.body.id;
    await w.verifier.post(`/needs/${need2}/verify`);
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: need2, quantity: 1 });
    r = await w.buyer.post('/orders', { need: need2, quantity: 1, funding: [{ type: 'pledge', id: r.body.id }] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'SPEC_UNAVAILABLE');
  } finally {
    await w.close();
  }
});
