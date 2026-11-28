// 同一援助轮次综合核对：需求缩减（NEED-REDUCE）、配捐资格变化（DONOR-RETURN）、
// 部分不合格签收（ARRIVAL-1）以及退回入库（GOODS-RETURN），全部使用 fixtures 合成资料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './helpers.mjs';

test('同一援助轮次：认捐→采购→分批签收→退款改资格→需求缩减→退回重配，全链路账目一致', async () => {
  const w = await startWorld();
  try {
    // 先核实需求（ND-1：冬衣 140 码 ×12，SKU-140 单价 10000 分）。
    await w.verifier.post('/needs/ND-1/verify');
    // 承诺未到账时不能接受认捐：认捐额不等于可使用的帮助。
    let r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-1', quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'FUNDS_NOT_ARRIVED');

    // 捐方承诺 120000 分实际到账。
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    // 配捐 MATCH-1：比例 0.5、上限 50000 → 资格 50000；登记实际到账 50000。
    r = await w.approver.post('/matching/MATCH-1/compute');
    assert.equal(r.body.entitledMinor, 50000);
    await w.approver.post('/matching/MATCH-1/arrive', { amountMinor: 50000 });

    // 团队接受认捐 7 件（70000 分）。学校视角：7 件“有人答应”，0 件“可等收货”。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-1', quantity: 7 });
    assert.equal(r.status, 201);
    const pledgeId = r.body.id;
    r = await w.schoolA.get('/needs/ND-1/progress');
    assert.equal(r.body.promised, 7);
    assert.equal(r.body.procured, 0);
    assert.equal(r.body.usable, 0);

    // 采购 12 件：认捐 70000 + 配捐 50000，幂等键防重复。
    const orderHeaders = { 'Idempotency-Key': 'aid-round-1' };
    r = await w.buyer.post('/orders', {
      need: 'ND-1', quantity: 12,
      funding: [{ type: 'pledge', id: pledgeId }, { type: 'matching', rule: 'MATCH-1', amountMinor: 50000 }]
    }, orderHeaders);
    assert.equal(r.status, 201);
    const orderId = r.body.id;
    assert.equal(r.body.totalMinor, 120000);
    // 同一幂等键重发不重复建单。
    r = await w.buyer.post('/orders', { need: 'ND-1', quantity: 12, funding: [] }, orderHeaders);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, orderId);

    // 付款：结款方受理 → 终态确认 → 对账到账。学校视角转为 12 件“可等收货”。
    await w.buyer.post(`/orders/${orderId}/pay`);
    await w.partnerControl.settle(`pp-${orderId}`, 'confirmed', { receipt: 'rcpt-aid-1' });
    r = await w.buyer.post(`/orders/${orderId}/reconcile`);
    assert.equal(r.body.order.status, 'paid');
    r = await w.schoolA.get('/needs/ND-1/progress');
    assert.equal(r.body.promised, 0);
    assert.equal(r.body.procured, 12);

    // 分批发货：采用待提交物流资料 DEL-1（6 件，运单 WAY-1）。
    r = await w.buyer.post(`/orders/${orderId}/shipments`, { delivery: 'DEL-1' });
    assert.equal(r.status, 201);
    r = await w.logistics.post('/shipments/DEL-1/deliver', { delivered: 6, shortage: 0 });
    assert.equal(r.status, 200);

    // 部分不合格签收（ARRIVAL-1）：签收 6，合格 4，尺码不符 2；签收数不等于合格数。
    r = await w.schoolA.post('/shipments/DEL-1/acceptance', {
      received: 6, usable: 4, damaged: 0, sizeMismatch: 2, reason: '两件尺码不符', change: 'ARRIVAL-1'
    });
    assert.equal(r.status, 201);
    const returnId = r.body.return.id;
    r = await w.schoolA.get('/needs/ND-1/progress');
    assert.equal(r.body.usable, 4);
    assert.equal(r.body.sizeMismatch, 2);
    assert.equal(r.body.returnPending, 2);

    // 来源文书与处理不符会被拒绝：NEED-REDUCE 要求缩减到 8，报 9 不行。
    r = await w.schoolA.post('/needs/ND-1/reduce', { quantity: 9, change: 'NEED-REDUCE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CHANGE_MISMATCH');

    // 捐方退款 40000（DONOR-RETURN）：配捐合格基数 120000→80000，资格 50000→40000；
    // 已用于采购的配捐 50000 不悄悄消失，显示 10000 需追回或由团队补足。
    r = await w.donorA.post('/donations/PL-1/refund', { amountMinor: 40000, reason: '捐方要求部分退款', change: 'DONOR-RETURN' });
    assert.equal(r.status, 200);
    r = await w.approver.get('/matching/MATCH-1');
    assert.equal(r.body.entitledMinor, 40000);
    assert.equal(r.body.arrivedMinor, 50000);
    assert.equal(r.body.spentMinor, 50000);
    assert.equal(r.body.responsibilityMinor, 10000);

    // 需求缩减（NEED-REDUCE：12→8，学校人数变化）：未发货采购随之缩减 2 件，
    // 释放先退自有捐款；配捐责任保持显性。
    r = await w.schoolA.post('/needs/ND-1/reduce', { quantity: 8, reason: '在校人数变化', change: 'NEED-REDUCE' });
    assert.equal(r.status, 200);
    // 同一来源变更不能重复生效。
    r = await w.schoolA.post('/needs/ND-1/reduce', { quantity: 8, change: 'NEED-REDUCE' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CHANGE_APPLIED');

    // —— 同一次援助的账目核对 ——
    // 需求台账：当前 8，合格 4，在采 4（10-6），剩余 0。
    r = await w.schoolA.get('/needs/ND-1/progress');
    assert.equal(r.body.quantity, 8);
    assert.equal(r.body.usable, 4);
    assert.equal(r.body.procured, 4);
    assert.equal(r.body.remaining, 0);
    assert.equal(r.body.reductions.length, 1);
    assert.equal(r.body.reductions[0].from, 12);

    // 捐助去向：到账 120000 = 已购 50000 + 已退 40000 + 剩余 30000；原始限制未改写。
    r = await w.donorA.get('/donations/PL-1/whereabouts');
    assert.equal(r.body.arrivedMinor, 120000);
    assert.equal(r.body.spentMinor, 50000);
    assert.equal(r.body.refundedMinor, 40000);
    assert.equal(r.body.surplusMinor, 30000);
    assert.deepEqual(r.body.restriction.scope, ['SCH-A']);
    assert.deepEqual(r.body.restriction.purposes, ['winter-coat']);
    assert.equal(r.body.orders[0].order, orderId);

    // 配捐责任仍在账上：资格 40000、到账 50000、已花 50000、责任 10000。
    r = await w.donorA.get('/matching/MATCH-1');
    assert.equal(r.body.responsibilityMinor, 10000);

    // 公开口径：实际收到的帮助只有合格 4 件，不认认捐额与发货数；且无隐私字段。
    r = await w.call('GET', '/public/schools/SCH-A/summary');
    const winterCoat = r.body.kinds.find(k => k.kind === 'winter-coat');
    assert.equal(winterCoat.usable, 4);
    const publicNeed = await w.call('GET', '/public/needs/ND-1');
    assert.equal(publicNeed.status, 200);
    assert.equal(publicNeed.body.usable, 4);
    const publicText = JSON.stringify(publicNeed.body) + JSON.stringify(r.body);
    assert.ok(!publicText.includes('ANON'), '公开页面不得出现匿名编号');
    assert.ok(!publicText.includes('困难'), '公开页面不得出现家庭困难原因');
    assert.ok(!('hardshipNote' in publicNeed.body) && !('studentRefs' in publicNeed.body));

    // 退回实物未确认入库前不是库存，不能重配。
    await w.verifier.post('/needs/ND-2/verify');
    r = await w.approver.post('/pledges', { stock: returnId, need: 'ND-2', quantity: 1 });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'STOCK_NOT_FOUND');
    // 仓库确认入库（GOODS-RETURN：2 件尺码不符）→ 成为可重配库存。
    r = await w.warehouse.post(`/returns/${returnId}/confirm`, { change: 'GOODS-RETURN' });
    assert.equal(r.status, 200);
    const stockId = r.body.stocks[0].id;
    // 相似商品不能自动算满足：140 码库存不能许诺给 150 码需求 ND-2。
    r = await w.approver.post('/pledges', { stock: stockId, need: 'ND-2', quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'SPEC_MISMATCH');
    // 同规格新需求可以重配：申报→核实→库存认捐→调拨发货。
    r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 3 });
    const need2 = r.body.id;
    await w.verifier.post(`/needs/${need2}/verify`);
    r = await w.approver.post('/pledges', { stock: stockId, need: need2, quantity: 2 });
    assert.equal(r.status, 201);
    const stockPledge = r.body.id;
    r = await w.approver.post(`/pledges/${stockPledge}/shipments`, { waybill: 'WAY-2' });
    assert.equal(r.status, 201);
    // 在途不算库存：2 件已全部发出，再承诺库存不足。
    r = await w.approver.post('/pledges', { stock: stockId, need: need2, quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'STOCK_INSUFFICIENT');
  } finally {
    await w.close();
  }
});
