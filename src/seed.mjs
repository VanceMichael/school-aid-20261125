// 将 fixtures/records.json 的合成登记资料导入为业务初始状态。
// 不修改 fixtures 原文件；应用侧补充的合成角色、目录与隐私字段在此标注。
import { parseRatio } from './util.mjs';

// 应用侧补充的合成角色（fixtures 之外）：第二名团队审批、物流、仓库、捐方乙、学校乙经办。
const EXTRA_ACTORS = [
  { id: 'school-b', role: 'school', school: 'SCH-B', name: '合成小学乙经办' },
  { id: 'approver-2', role: 'approver', name: '团队审批乙' },
  { id: 'logistics-1', role: 'logistics', name: '合成物流员' },
  { id: 'warehouse-1', role: 'warehouse', name: '合成仓库员' },
  { id: 'donor-b', role: 'donor', donor: 'DN-B', name: '捐方乙' }
];

// 应用侧补充的合成目录项：用于替代品涉及用途变化的核对。
const EXTRA_CATALOG = [
  { id: 'SKU-ST-1', kind: 'stationery', size: null, unitMinor: 3000, available: true }
];

// 学生相关需求只用匿名编号；困难原因仅校内可见。此处为合成占位，不含真实儿童。
const SYNTH_PRIVACY = {
  'ND-1': { studentRefs: ['ANON-101', 'ANON-102'], hardshipNote: '合成困难说明：仅供校内核实，不得外传' },
  'ND-2': { studentRefs: ['ANON-103'], hardshipNote: '合成困难说明：尺码复核中' },
  'ND-3': { studentRefs: [], hardshipNote: null }
};

const SYNTH_ADDRESS = {
  'SCH-A': '合成省合成县希望路 1 号',
  'SCH-B': '合成省合成县育才街 2 号'
};

export function buildSeed(fixtures) {
  const state = {
    seq: 1000,
    schools: {},
    needs: {},
    donors: {},
    donations: {},
    pledges: {},
    matching: {},
    orders: {},
    orderKeys: {},
    shipments: {},
    acceptances: {},
    returns: {},
    stocks: {},
    consents: {},
    refunds: {},
    claims: {},
    catalog: {},
    actors: {},
    tokens: {},
    sourceChanges: {},
    audit: []
  };

  for (const school of fixtures.schools) {
    state.schools[school.id] = { id: school.id, name: school.name, address: SYNTH_ADDRESS[school.id] ?? '合成地址' };
  }
  for (const need of fixtures.needs) {
    const privacy = SYNTH_PRIVACY[need.id] ?? { studentRefs: [], hardshipNote: null };
    state.needs[need.id] = {
      id: need.id,
      school: need.school,
      kind: need.kind,
      size: need.size ?? null,
      age: need.age ?? null,
      quantity: need.quantity,
      originalQuantity: need.quantity,
      status: 'reported', // 申报后待核实；fixtures 明确 needs 是待核实数量
      verifiedBy: null,
      verifiedAt: null,
      studentRefs: privacy.studentRefs,
      hardshipNote: privacy.hardshipNote,
      reductions: [],
      substitutes: [],
      cancelledUnmet: null,
      createdAt: null
    };
  }
  for (const donor of fixtures.donors) {
    state.donors[donor.id] = { id: donor.id, scope: donor.scope ?? [], purposes: donor.purposes ?? [] };
  }
  // pledgeDrafts 是捐方承诺草稿，不证明实际到账；导入为“承诺中”的捐助。
  for (const draft of fixtures.pledgeDrafts) {
    state.donations[draft.id] = {
      id: draft.id,
      donor: draft.donor,
      intendedNeed: draft.need ?? null,
      kind: 'money',
      status: 'pledged',
      promisedMinor: draft.amountMinor,
      arrivedMinor: 0,
      arrivedAt: null,
      refundedMinor: 0,
      failedMinor: 0,
      earmarkedMinor: 0,
      reservedMinor: 0,
      spentMinor: 0,
      createdAt: null
    };
  }
  for (const rule of fixtures.matchingRules) {
    const { num, den } = parseRatio(rule.ratio);
    state.matching[rule.id] = {
      id: rule.id,
      donor: rule.donor,
      ratioNum: num,
      ratioDen: den,
      capMinor: rule.capMinor,
      deadline: rule.deadline,
      record: { entitledMinor: 0, arrivedMinor: 0, reservedMinor: 0, spentMinor: 0, responsibilityMinor: 0, excessMinor: 0 }
    };
  }
  for (const sku of [...fixtures.catalog, ...EXTRA_CATALOG]) {
    state.catalog[sku.id] = { id: sku.id, kind: sku.kind, size: sku.size ?? null, age: sku.age ?? null, unitMinor: sku.unitMinor, available: sku.available ?? true };
  }
  // deliveries 是待提交物流资料：导入为草稿批次，绑定已付款采购单后才真正在途。
  for (const delivery of fixtures.deliveries) {
    state.shipments[delivery.id] = {
      id: delivery.id,
      school: delivery.school,
      sku: delivery.sku,
      need: null,
      order: null,
      pledge: null,
      stock: null,
      kind: null,
      size: null,
      quantity: delivery.quantity,
      waybill: delivery.waybill ?? null,
      status: 'draft',
      delivered: null,
      shortage: null,
      shippedAt: null,
      deliveredAt: null
    };
  }
  for (const actor of [...fixtures.actors, ...EXTRA_ACTORS]) {
    state.actors[actor.id] = { ...actor, name: actor.name ?? actor.id };
    state.tokens[`tok-${actor.id}`] = actor.id;
  }
  for (const change of fixtures.sourceChanges) {
    state.sourceChanges[change.id] = { ...change, applied: false, appliedAt: null };
  }
  return state;
}
