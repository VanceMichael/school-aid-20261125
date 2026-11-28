// 测试辅助：启动业务应用 + 采购结款方（均用随机本地端口与临时状态），返回带角色的客户端。
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeer } from '../support/peer.mjs';
import { createApp } from '../src/app.mjs';
import { createStore } from '../src/store.mjs';
import { createPartnerClient } from '../src/partner.mjs';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/records.json', import.meta.url)));
const partnerConfig = JSON.parse(await readFile(new URL('../fixtures/partner.json', import.meta.url)));

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

export async function startWorld() {
  const dir = await mkdtemp(join(tmpdir(), 'school-aid-'));
  const peer = createPeer(partnerConfig, join(dir, 'partner.json'));
  const partnerBase = await listen(peer);
  const store = createStore({ fixtures });
  const partner = createPartnerClient(partnerBase, partnerConfig);
  const app = createApp({ store, partner });
  const base = await listen(app);

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const as = actorId => ({
    get: path => call('GET', path, { token: `tok-${actorId}` }),
    post: (path, body, headers) => call('POST', path, { token: `tok-${actorId}`, body, headers })
  });

  // 结款方本地控制接口（测试直接驱动，模拟合作方行为）
  const partnerControl = {
    rule: (id, mode) => fetch(partnerBase + '/control/rules', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, mode })
    }),
    settle: (id, status, details) => fetch(partnerBase + '/control/settle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status, details })
    }).then(r => r.json()),
    lookup: id => fetch(partnerBase + partnerConfig.lookup + id).then(r => (r.status === 404 ? null : r.json()))
  };

  return {
    base,
    store,
    call,
    as,
    partnerControl,
    schoolA: as('school-a'),
    schoolB: as('school-b'),
    verifier: as('verifier'),
    approver: as('approver'),
    approver2: as('approver-2'),
    buyer: as('buyer'),
    donorA: as('donor-a'),
    donorB: as('donor-b'),
    logistics: as('logistics-1'),
    warehouse: as('warehouse-1'),
    close: async () => { await close(app); await close(peer); await rm(dir, { recursive: true, force: true }); }
  };
}

// 常用准备：核实 ND-1 并让 PL-1 到账。
export async function prepareVerifiedNeed(world, needId = 'ND-1') {
  await world.verifier.post(`/needs/${needId}/verify`);
  return needId;
}
