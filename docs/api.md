# 业务接口说明（学校、团队、捐方、采购）

本服务是定向捐助的业务后端：学校申报并核实需求，团队按捐方限制接受认捐，采购或调拨后分批送到学校，凭实际验收处理缺件、用途变化及剩余款物。所有金额单位为分（minor），数量为整数件。所有机构、人员、金额均为合成资料。

- 启动：`npm run start:app`（默认 4318 端口；`PARTNER_URL` 指向采购结款方，默认 `http://127.0.0.1:4317`；`APP_STATE` 指定持久状态文件，默认 `.local/app.json`）。
- 结款方：`npm run start:partner`（默认 4317），协议见 `docs/partner.md`。
- 认证：除公开接口外，一律 `Authorization: Bearer tok-<角色编号>`。合成角色令牌见下表。
- 错误：统一返回 `{ "error": { "code", "message", "details" } }`，本文列出主要 `code`。

## 角色与令牌

| 角色 | 合成令牌 | 能做什么 |
| --- | --- | --- |
| 学校 school-a / school-b | `tok-school-a` / `tok-school-b` | 申报需求、缩减、撤销未满足部分、确认替代品、签收验收 |
| 校内核实 verifier | `tok-verifier` | 核实需求；**不能批准使用捐款**（职责分离，接口强制） |
| 团队审批 approver / approver-2 | `tok-approver` / `tok-approver-2` | 登记捐助与到账、接受认捐、配捐核算、提出替代品、发起捐方同意、库存调拨 |
| 采购 buyer | `tok-buyer` | 创建采购单、提交付款、对账、取消、发货、更新目录报价 |
| 捐方 donor-a / donor-b | `tok-donor-a` / `tok-donor-b` | 查询本人捐助去向、申请退款、决定同意请求 |
| 物流 logistics-1 | `tok-logistics-1` | 查看面单（无学生信息）、回报送达与短少 |
| 仓库 warehouse-1 | `tok-warehouse-1` | 退回实物确认入库 |

核实了某需求的人，不能再批准该需求的用款（`DUTY_SEPARATION`），即使其持有其他角色令牌。

## 核心口径（贯穿全部接口）

- **承诺 ≠ 到账 ≠ 已收到**：认捐（promised）只是有人答应；采购付款到账（procured）与在途（inTransit）才是可等收货；只有验收合格（usable）算实际收到的帮助。公开汇总只按 usable 计。
- **规格不可替代**：用品按 类别+尺码+适用年龄 精确匹配（尺码、年龄为可选维度，标注了就必须一致）；相似商品不能自动算成满足（`SPEC_MISMATCH`）。替代品须学校确认能用；涉及原定用途变化还须捐方同意，两个确认缺一不可。
- **捐方限制不可改写**：捐方的限定学校（scope）与限定类别（purposes）是原始事实；改配或用途变化以单独的同意记录生效，原限制字段永不被修改。
- **资金分账**：每笔捐款分 承诺/到账/已承诺(earmarked)/付款中(reserved)/已采购(spent)/已退/失败；只有到账且未被占用的部分可承诺、可退。
- **配捐分账**：资格（按合格到账×比例、封顶、截止）/实际到账/已花分列；承诺配捐不算到账；资格缩小时已花配捐转为“需追回或由团队补足”的责任（responsibilityMinor），不从账上消失。
- **来源文书**：fixtures 的 sourceChanges 是未处理申请；处理时带 `change` 字段，系统核对内容一致且只生效一次（`CHANGE_MISMATCH`、`CHANGE_APPLIED`）。

## 需求进度口径

`GET /needs/{id}/progress`（学校/核实/团队/采购）与 `GET /public/needs/{id}`（公开）返回：

| 字段 | 含义 |
| --- | --- |
| quantity / originalQuantity | 当前需求数 / 原始申报数（缩减留痕于 reductions） |
| verified | 核实人与时间；未核实为 null |
| promised | 有人答应（认捐承诺中，未采购） |
| procured | 已采购未发货（可等收货） |
| inTransit / deliveredPending | 在途 / 已送达待验收 |
| received / usable / damaged / sizeMismatch | 签收合计 / 合格（实际满足量）/ 破损 / 尺码不符 |
| shortage / returnPending | 物流短少 / 退回待入库 |
| remaining | 仍需承诺数量 |

学校与核实人员另见 `studentRefs`（匿名编号）与 `hardshipNote`（困难原因）；团队、采购、捐方与公开口径**不含**这两项；物流面单只有学校地址、规格与数量。

## 接口一览

### 公开（无需令牌）

- `GET /public/schools/{school}/summary` — 按类别汇总：需求数、有人答应、可等收货、**实际收到（合格）**。
- `GET /public/needs/{id}` — 单项公开进度（聚合口径，无隐私字段）。
- `GET /health`

### 学校

- `POST /schools/{school}/needs` — 申报需求 `{ kind, size?, age?, quantity, studentRefs?, hardshipNote? }`（studentRefs 只用匿名编号）。→ 201 需求（状态 reported）
- `GET /schools/{school}/needs` — 本校全部需求进度。
- `POST /needs/{id}/reduce` — 需求缩减 `{ quantity, reason?, change? }`。不能低于已合格数（`REDUCE_BELOW_USABLE`）；自动释放多余认捐、缩减未发货采购。
- `POST /needs/{id}/cancel-unmet` — 撤销未满足部分 `{ reason? }`。解除全部未兑现认捐、未发货采购与配捐占用；已发放、在途事实保留，需求收缩到已被有效物资覆盖的数量，状态 `closed_partial`。付款未明的采购单会阻断（`FUNDS_UNCLEAR`），须先对账。
- `POST /needs/{id}/substitutes/{sub}/school-confirm` — 学校确认替代品能用。
- `POST /shipments/{id}/acceptance` — 签收验收 `{ received, usable, damaged, sizeMismatch, reason?, change? }`。received 须等于物流送达数；合格+破损+尺码不符须等于签收数（签收数不等于全部合格）。破损与尺码不符自动生成退回记录。

### 校内核实

- `POST /needs/{id}/verify` — 核实需求（reported → verified）。核实后才能接受认捐与采购。

### 团队（审批）

- `POST /donations` — 登记捐助承诺 `{ donor, amountMinor, need? }`。
- `POST /donations/{id}/arrive` — 登记到账 `{ amountMinor? }`（默认全部未兑现额）。到账才可用于认捐。
- `POST /donations/{id}/fail` — 登记付款失败 `{ amountMinor, reason? }`；缺口在去向中可见，并触发配捐资格重算。
- `POST /pledges` — 接受认捐 `{ need, quantity, donation? , stock? }`（二选一）。
  - 捐款认捐：须已到账且余额足够；捐方限制不覆盖时需先取得同意（`CONSENT_REQUIRED`）。
  - 库存认捐：规格须精确匹配；在途与未入库数量不算库存（`STOCK_INSUFFICIENT`）。
  - 并发安全：同一需求剩余可承诺数量在事务内核算，两名志愿者同时认捐只有一笔成功（`NEED_OVERPLEDGED`）。
- `POST /pledges/{id}/release` — 解除承诺中的认捐。
- `POST /pledges/{id}/shipments` — 库存调拨发货 `{ waybill?, quantity? }`。
- `POST /needs/{id}/substitutes` — 提出替代品 `{ sku, quantity?, change? }`。用途变化（类别不同）自动生成捐方同意请求，状态 `pending_consent`。
- `POST /matching/{rule}/compute` — 按合格到账重算配捐资格。
- `POST /matching/{rule}/arrive` — 登记配捐实际到账 `{ amountMinor }`（承诺配捐不算到账）。
- `POST /matching/{rule}/terms` — 调整规则 `{ ratio?, capMinor?, deadline? }` 并重算；资格缩小产生的责任立即显形。
- `GET /matching/{rule}` — 配捐账：资格/到账/可用/已花/责任/超额。
- `POST /consents` — 发起捐方同意 `{ donation, type: redirect|purpose_change, need?, note? }`。
- `GET /needs/{id}/progress`、`GET /donations/{id}/whereabouts`、`GET /audit`、`GET /stock`。

### 捐方

- `GET /my/donations` — 本人全部捐助去向。
- `GET /donations/{id}/whereabouts` — 单笔去向：原始限制、承诺/到账/已承诺/付款中/已采购/已退/剩余/缺口，以及认捐、采购单、配捐责任、退款、同意记录。只能查本人（`NOT_OWN_DONATION`）。
- `POST /donations/{id}/refund` — 申请退款 `{ amountMinor, reason?, change? }`。已承诺、付款未明、已采购部分不可退（`REFUND_EXCEEDS_AVAILABLE`）。
- `POST /consents/{id}/decide` — 决定同意请求 `{ approve, note? }`（仅本捐方）。
- `GET /matching/{rule}` — 与本人捐助相关的配捐账。

### 采购

- `POST /orders` — 创建采购单 `{ need, quantity, funding: [{type:'pledge',id} | {type:'matching',rule,amountMinor}] }`，请求头 `Idempotency-Key` 幂等（同键重发返回原单，不重复采购）。校验：需求已核实且当前数量足够（`OVER_PROCURE`）、供应商有货（`SPEC_UNAVAILABLE`，缺码）、资金合计等于按**当前报价**计算的总额（`FUNDING_MISMATCH`，涨价后需补足或减量）、配捐已到账（`MATCHING_NOT_ARRIVED`）、用途变化已有捐方同意（`PURPOSE_CONSENT_REQUIRED`）。已取得捐方同意仍须通过资金与需求校验。
- `POST /orders/{id}/pay` — 向结款方提交付款。结款方受理后断线 → 状态 `payment_processing` + `payment.state=unclear`（**资金未明**）：同需求不能再建采购单、不能取消、被占用资金不能退，须查单对账。同一请求键重发不重复形成流水。
- `POST /orders/{id}/reconcile` — 按结款方查单结果对账：`confirmed` 到账（转 paid，认捐履约、资金转已花）；`returned` 退回（释放占用）；`rejected` 未通过（释放占用）。供货取消后到达的终态记为**迟到回执**（lateReceipts）：退回 → 释放占用；误确认 → 钱记已花并生成待追回责任（claims），全程可经 `GET /orders/{id}` 与 `GET /audit` 追查。
- `POST /orders/{id}/cancel` — 供货取消。未付款直接取消；已受理未终态先取消待终态核对；已付款退回各资金来源（配捐退回后重算责任）。付款未明时不能取消。
- `POST /orders/{id}/reduce` — 缩减未发货部分 `{ quantity }`；释放资金先退自有捐款、后退配捐，配捐责任保持显性。
- `POST /orders/{id}/shipments` — 分批发货 `{ delivery? }` 或 `{ quantity, waybill? }`；`delivery` 采用 fixtures 待提交物流资料（核对学校与规格后转在途）。
- `POST /catalog/{sku}/quote` — 更新供应商报价 `{ unitMinor?, available? }`（涨价、缺码直接影响后续能买什么）。
- `GET /orders/{id}` — 采购单详情（含付款状态、迟到回执）。

### 物流

- `GET /shipments/{id}/manifest` — 面单：运单号、学校地址、规格、数量；无学生信息、无捐方与金额。
- `POST /shipments/{id}/deliver` — 送达回报 `{ delivered, shortage }`；送达+短少须等于发货数。

### 仓库

- `POST /returns/{id}/confirm` — 退回实物确认入库 `{ change? }`。尺码不符部分成为可重配库存；破损部分记残损库存不可再承诺。**未确认入库前不能重配**。

## 主要错误码

| code | 含义 |
| --- | --- |
| NEED_NOT_VERIFIED | 需求未核实或已关闭 |
| NEED_OVERPLEDGED | 超出剩余可承诺数量（防止重复许诺） |
| FUNDS_NOT_ARRIVED / FUNDS_INSUFFICIENT | 捐款未到账 / 可用余额不足 |
| MATCHING_NOT_ARRIVED | 承诺配捐不算到账，可用配捐不足 |
| CONSENT_REQUIRED / PURPOSE_CONSENT_REQUIRED | 改配 / 用途变化须先取得捐方同意 |
| SPEC_MISMATCH / SPEC_UNAVAILABLE | 规格不符不能算满足 / 供应商缺码 |
| FUNDS_UNCLEAR | 付款状态未明，禁止重复采购、取消或挪用 |
| FUNDING_MISMATCH / OVER_PROCURE | 资金合计不等于当前报价总额 / 超过学校当前需求 |
| REFUND_EXCEEDS_AVAILABLE | 已承诺、付款中或已采购部分不可退 |
| REDUCE_BELOW_USABLE / REDUCE_BELOW_SHIPPED | 不能缩减到已合格 / 已发货数量以下 |
| CHANGE_MISMATCH / CHANGE_APPLIED | 处理与来源文书不符 / 来源文书已生效 |
| DUTY_SEPARATION / ROLE_NOT_ALLOWED / NOT_OWN_DONATION / NOT_OWN_SCHOOL | 职责与权限边界 |

## 本地检查

`npm test` 使用合成资料完成，覆盖：

- `tests/app.aid-round.test.mjs` — **同一援助轮次**中核对需求缩减（NEED-REDUCE）、配捐资格变化（DONOR-RETURN 引发的配捐责任）、部分不合格签收（ARRIVAL-1），以及退回入库（GOODS-RETURN）后的重配；结尾核对需求台账、捐助去向、配捐账、公开口径全链路一致。
- `tests/app.concurrency.test.mjs` — 两名志愿者同时认捐同一份需求只有一笔成功；同一幂等键并发建单只形成一张采购单。
- `tests/app.payment.test.mjs` — 结款方受理后断线（资金未明阻断重复采购与退款）、查单对账到账、供货取消后迟到回执（退回与误确认）可追查、拒付后资金可再用、重复对账不重复入账。
- `tests/app.lifecycle.test.mjs` — 替代品双确认（一个确认不能代替另一个）、学校撤销未满足部分（约束解除、事实保留）、剩余款物改配需同意且不改写原限制、涨价与缺码影响采购。
- `tests/app.privacy.test.mjs` — 公开页面与物流面单不含匿名编号、困难原因与捐方信息；核实人员不能批准用款；捐方只能看本人。
