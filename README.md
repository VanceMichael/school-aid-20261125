# 定向捐助的认捐履约与学校分批签收

本仓库保存该业务的合成登记资料、原始变更资料、采购结款方的本地协议服务，以及业务应用本体。所有机构、人员、金额和文书均为虚构，不连接真实业务系统。

业务链路：学校申报需求 → 校内核实 → 团队按捐方限制接受认捐 → 采购或库存调拨 → 分批发货、学校签收验收 → 凭实际合格数量处理缺件、用途变化与剩余款物。认捐承诺不等于到账，到账不等于学校已收到；公开口径只按验收合格计。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，package-lock.json 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
```

## 启动

结款方（模拟采购付款合作方，默认 4317）：

```bash
npm run start:partner
```

业务应用（默认 4318，PARTNER_URL 指向结款方，APP_STATE 指定状态文件，默认 .local/app.json）：

```bash
npm run start:app
```

停止后用同一状态文件启动会保留业务与结款方流水。也可以使用 Docker 启动结款方：

```bash
docker build -t school-aid:local .
docker run --rm -p 4317:4317 school-aid:local
```

容器要保留状态时，将可写目录挂载到 /app/.local；该目录需允许容器 node 用户写入。测试使用临时目录与随机本地端口，可独立运行。

## 接口与说明

- `docs/api.md` — 业务接口（学校、团队、捐方、采购、物流、仓库、公开查询）与中文说明：角色令牌、进度口径、状态流转、错误码、隐私边界。
- `docs/partner.md` — 采购结款方协议（受理、断线、终态、查单）。
- `docs/data.md` — 合成资料的计量与身份语义。

## 资料

fixtures/records.json 是业务原始资料，sourceChanges 保存后续收到的变更或申请，均没有自动导入成已批准决定；业务接口处理时携带 `change` 字段核对来源文书，且同一变更只生效一次。fixtures/relations.json 声明登记资料的关联字段。fixtures/partner.json 定义结款方接口名称及字段。support/peer.mjs 提供结款方行为。src/ 是业务应用：app.mjs（HTTP 层）、domain.mjs（业务规则）、views.mjs（分受众口径）、store.mjs（状态与事务）、seed.mjs（合成资料导入）、partner.mjs（结款方客户端）。

## 本地检查

npm test 使用合成资料核对：同一援助轮次中的需求缩减、配捐资格变化与部分不合格签收；两人同时认捐不重复许诺；结款方断线后资金未明不重复采购；供货取消后迟到回执可追查；退回实物入库确认后才可重配；学校撤销未满足部分时约束解除且已发放事实保留；配捐退款责任不悄悄消失；公开页面与物流方拿不到儿童隐私。详见 docs/api.md 末尾。
