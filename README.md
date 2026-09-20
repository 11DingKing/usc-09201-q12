# 林产品批次履历

面向石斛、天麻及特色经济林产品加工环节的批次履历系统。以**追加式事件溯源**记录采收、检验、分级、合批、拆包、交付等事件，任何成品都能反向追溯到来源地块、林农与当时有效的质量标准；支持批次失效模拟（锁定范围、库存余量、下游通知）与供应商数据隔离。

纯 Node.js（>=20）实现，无外部依赖，可独立运行。

## 快速开始

```bash
npm start          # 启动服务（默认 0.0.0.0:3000，PORT 可覆盖）
npm run demo       # 端到端演示：混批加工 -> 抽检追溯 -> 失效模拟 -> 供应商视角
npm test           # 运行测试
```

事件默认持久化到 `data/events.jsonl`（追加式 JSONL，只增不改），可用环境变量 `DATA_FILE` 指定其他路径；重启后从事件流完整重放状态。

## 角色与认证（演示级）

通过请求头标识身份：

| 请求头 | 角色 | 权限 |
| --- | --- | --- |
| `x-role: quality` | 质量负责人 | 全部读写 |
| `x-role: supplier` + `x-supplier-id: <id>` | 供应商（林农） | 只读，且仅可见与自身相关的批次、追溯与处置；其他供应商/地块身份脱敏，下游客户脱敏 |

无有效请求头访问 `/api/*` 返回 401；供应商执行写操作返回 403。

## 事件模型

所有业务都是追加事件（`POST /api/events`，仅 quality）：

```json
{
  "type": "harvested",
  "payload": { "...": "..." },
  "occurredAt": "2026-03-01T08:00:00Z",
  "idempotencyKey": "scan-0001"
}
```

- `occurredAt` 为业务发生时间（可早于录入时间，支持**迟到检验**）；`recordedAt` 由系统记录。
- `idempotencyKey` 幂等去重：**重复扫码**/网络重试返回首次事件（`deduplicated: true`），不产生重复效果。
- 既有事件不可改写：**批次重编号**（`renumbered` 追加新编码）、**部分报废**、**跨仓转移**都以新事件追加，历史链路保持不变。

| type | 关键 payload | 说明 |
| --- | --- | --- |
| `plot_registered` | `plotId, name, location?, ownerName?, area?` | 登记地块 |
| `supplier_registered` | `supplierId, name, contact?` | 登记供应商（林农） |
| `standard_published` | `standardId, product, version, effectiveFrom, limits{moistureMax?, pesticideResidueMax?}` | 发布标准版本 |
| `harvested` | `product, plotId, supplierId, quantity, unit, batchId?, grade?, location?` | 采收，创建原料批次 |
| `inspected` | `batchId, moisture, pesticideResidue, lab?, note?` | 检验，按 `occurredAt` 当时有效标准判定 |
| `graded` | `batchId, grade` | 分级 |
| `merged` | `sources:[{batchId, quantity}], targetBatchId?, product?, unit?, location?` | 合批（≥2 个来源） |
| `split` | `sourceBatchId, parts:[{batchId?, quantity, location?}]` | 拆包（可留余量） |
| `transferred` | `batchId, toLocation, fromLocation?` | 跨仓转移（`fromLocation` 做乐观校验） |
| `delivered` | `batchId, customer, quantity, note?` | 交付下游客户 |
| `scrapped` | `batchId, quantity, reason` | 报废（可部分，锁定批次也允许） |
| `renumbered` | `batchId, newCode` | 追加新编码，旧编码仍可用 |
| `locked` / `unlocked` | `batchId, reason?` | 质量冻结/解冻；锁定批次禁止合批、拆包、交付、转移 |

## 查询接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/batches` | 批次列表（按角色过滤；`?product= &location= &locked= &flagged=`） |
| `GET /api/batches/:id` | 批次详情 + 事件履历 + 检验记录（`:id` 支持重编号后的任意编码） |
| `GET /api/batches/:id/trace-back` | 反向追溯：来源采收批次、地块、林农、贡献数量、**当时有效标准版本**、链路检验记录 |
| `GET /api/batches/:id/trace-forward` | 正向追溯：全部下游批次（含来源占比）、交付与报废记录 |
| `POST /api/simulations/failure` | 失效模拟 `{batchId, applyLock?}`：锁定范围、分仓库存余量、按客户汇总的下游通知；`applyLock:true` 时真正冻结范围内批次（幂等） |
| `GET /api/dispositions` | 处置记录（锁定/报废/检验不合格），供应商仅见与自身相关项 |
| `GET /api/events` | 事件流（quality；`?batchId= &type=`） |
| `GET /api/standards` `/api/suppliers` `/api/plots` | 标准版本 / 供应商 / 地块（后两者仅 quality） |

## 组成比例与追溯精度

合批/拆包按数量比例记录物料流向（`lineage` 边），追溯时沿链路按比例分摊：拆分后再合批的菱形链路也能精确计算每个来源批次在成品中的含量，避免"召回过宽造成浪费"或"找不到已流向下游的拆分批"。

## 错误码

`400 validation_failed / unknown_event_type / invalid_json`，`401 unauthorized`，`403 forbidden`，`404 unknown_batch / unknown_plot / unknown_supplier`、`409 batch_code_exists / insufficient_quantity / batch_locked / already_locked / not_locked / location_mismatch / plot_exists / supplier_exists / standard_exists`。
