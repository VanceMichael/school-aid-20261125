// 并发与幂等：两名志愿者同时接受认捐，同一份需求不能分别许诺给两位捐方。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorld } from './helpers.mjs';

test('两名志愿者同时认捐最后一件：只有一笔成功，需求不会被重复许诺', async () => {
  const w = await startWorld();
  try {
    // 需求：只剩 1 件。
    let r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 1 });
    const needId = r.body.id;
    await w.verifier.post(`/needs/${needId}/verify`);
    // 两位捐方的捐款都已到账（PL-1 为 fixtures 草稿；DON-B 现场登记）。
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    r = await w.approver.post('/donations', { donor: 'DN-A', amountMinor: 10000 });
    const donation2 = r.body.id;
    await w.approver.post(`/donations/${donation2}/arrive`, { amountMinor: 10000 });

    // 两名志愿者同时接受认捐同一需求。
    const [a, b] = await Promise.all([
      w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 1 }),
      w.approver2.post('/pledges', { donation: donation2, need: needId, quantity: 1 })
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.error.code, 'NEED_OVERPLEDGED');

    // 台账：只有 1 件被承诺，剩余可承诺为 0。
    r = await w.approver.get(`/needs/${needId}/progress`);
    assert.equal(r.body.promised, 1);
    assert.equal(r.body.remaining, 0);
    const activePledges = Object.values(w.store.state.pledges).filter(p => p.need === needId && p.status === 'active');
    assert.equal(activePledges.length, 1);
  } finally {
    await w.close();
  }
});

test('同一幂等键并发建采购单：只形成一张单', async () => {
  const w = await startWorld();
  try {
    let r = await w.schoolA.post('/schools/SCH-A/needs', { kind: 'winter-coat', size: '140', quantity: 2 });
    const needId = r.body.id;
    await w.verifier.post(`/needs/${needId}/verify`);
    await w.approver.post('/donations/PL-1/arrive', { amountMinor: 120000 });
    r = await w.approver.post('/pledges', { donation: 'PL-1', need: needId, quantity: 2 });
    const pledgeId = r.body.id;

    const headers = { 'Idempotency-Key': 'concurrent-order-1' };
    const payload = { need: needId, quantity: 2, funding: [{ type: 'pledge', id: pledgeId }] };
    const [a, b] = await Promise.all([
      w.buyer.post('/orders', payload, headers),
      w.buyer.post('/orders', payload, headers)
    ]);
    const ids = [a.body.id, b.body.id];
    assert.equal(ids[0], ids[1]);
    assert.equal(Object.keys(w.store.state.orders).length, 1);
  } finally {
    await w.close();
  }
});
