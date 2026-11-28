// 隐私与职责：公开页面和物流方拿不到家庭困难原因、匿名编号与姓名映射；
// 校内核实人员能确认需求但不能批准用款；捐方只能看自己的捐助。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './helpers.mjs';

test('公开查询与物流面单不包含儿童隐私；校内与团队口径分离', async () => {
  const w = await startWorld();
  try {
    // 申报含匿名编号与困难原因的需求（合成资料）。
    let r = await w.schoolA.post('/schools/SCH-A/needs', {
      kind: 'winter-coat', size: '140', quantity: 2,
      studentRefs: ['ANON-901'], hardshipNote: '合成困难说明：隐私'
    });
    const needId = r.body.id;
    await w.verifier.post(`/needs/${needId}/verify`);
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 2 });
    const pledgeId = r.body.id;
    r = await w.buyer.post('/orders', { need: needId, quantity: 2, funding: [{ type: 'pledge', id: pledgeId }] });
    const orderId = r.body.id;
    await w.buyer.post(`/orders/${orderId}/pay`);
    await w.partnerControl.settle(`pp-${orderId}`, 'confirmed', { receipt: 'rcpt-p' });
    await w.buyer.post(`/orders/${orderId}/reconcile`);
    r = await w.buyer.post(`/orders/${orderId}/shipments`, { quantity: 2, waybill: 'WAY-P' });
    const shipmentId = r.body.id;

    // 公开单项与汇总：无匿名编号、无困难原因、无金额。
    const pubNeed = await w.call('GET', `/public/needs/${needId}`);
    assert.equal(pubNeed.status, 200);
    const pubSummary = await w.call('GET', '/public/schools/SCH-A/summary');
    const publicText = JSON.stringify(pubNeed.body) + JSON.stringify(pubSummary.body);
    for (const leaked of ['ANON', '困难', 'hardshipNote', 'studentRefs', 'Minor', 'DN-A']) {
      assert.ok(!publicText.includes(leaked), `公开口径泄露：${leaked}`);
    }

    // 物流面单：只有配送必需信息。
    r = await w.logistics.get(`/shipments/${shipmentId}/manifest`);
    assert.equal(r.status, 200);
    assert.equal(r.body.waybill, 'WAY-P');
    assert.equal(r.body.quantity, 2);
    assert.ok(r.body.school.address);
    const manifestText = JSON.stringify(r.body);
    for (const leaked of ['ANON', '困难', 'hardshipNote', 'studentRefs', 'Minor', 'DN-A', 'PL-1']) {
      assert.ok(!manifestText.includes(leaked), `物流面单泄露：${leaked}`);
    }

    // 团队口径：无学生信息；学校与核实人员口径：可见（用于校内核对，不出系统）。
    r = await w.approver.get(`/needs/${needId}/progress`);
    assert.ok(!('studentRefs' in r.body) && !('hardshipNote' in r.body));
    r = await w.schoolA.get(`/needs/${needId}/progress`);
    assert.deepEqual(r.body.studentRefs, ['ANON-901']);
    assert.equal(r.body.hardshipNote, '合成困难说明：隐私');
    r = await w.verifier.get(`/needs/${needId}/progress`);
    assert.deepEqual(r.body.studentRefs, ['ANON-901']);

    // 捐方只能查自己的捐助；未认证一律 401。
    r = await w.donorA.get('/donations/PL-1/whereabouts');
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes('ANON'));
    r = await w.donorB.get('/donations/PL-1/whereabouts');
    assert.equal(r.status, 403);
    r = await w.call('GET', '/donations/PL-1/whereabouts');
    assert.equal(r.status, 401);
    r = await w.call('GET', `/needs/${needId}/progress`);
    assert.equal(r.status, 401);
  } finally {
    await w.close();
  }
});

test('职责分离：核实人员不能批准用款，各角色不能越权', async () => {
  const w = await startWorld();
  try {
    // 学校不能核实自己的需求；核实人员不能登记到账、接受认捐、创建采购单。
    let r = await w.schoolA.post('/needs/ND-1/verify');
    assert.equal(r.status, 403);
    await w.verifier.post('/needs/ND-1/verify');
    r = await w.verifier.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    assert.equal(r.status, 403);
    r = await w.verifier.post('/pledges', { donation: 'PL-1', need: 'ND-1', quantity: 1 });
    assert.equal(r.status, 403);
    r = await w.verifier.post('/orders', { need: 'ND-1', quantity: 1, funding: [] });
    assert.equal(r.status, 403);
    // 捐方不能代替团队操作；物流不能签收；学校不能跨校操作。
    r = await w.donorA.post('/pledges', { donation: 'PL-1', need: 'ND-1', quantity: 1 });
    assert.equal(r.status, 403);
    r = await w.logistics.post('/shipments/DEL-1/acceptance', { received: 6, usable: 6 });
    assert.equal(r.status, 403);
    r = await w.schoolB.post('/needs/ND-1/reduce', { quantity: 5 });
    assert.equal(r.status, 403);
    // 未核实的需求不能接受认捐。
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: 'ND-2', quantity: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'NEED_NOT_VERIFIED');
  } finally {
    await w.close();
  }
});
