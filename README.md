# 林产品批次履历系统

面向石斛、天麻与特色经济林产品加工环节的**可独立运行批次履历服务**。采收、检验、分级、合批、拆包、交付、跨仓转移、重编号、扫码、锁定与报废全部以**只追加事件**入账，任何成品批次都能正反向追到来源地块、多户林农与当时执行的质量标准。

零外部依赖，Node.js ≥ 20 即可运行；事件默认持久化到 `data/ledger.jsonl`（每行一条），重启完整重放。

## 要解决的问题

- 收购商把不同林地、采收日期、质量等级混成一批，抽检发现异常后要能**从混合成品反向追到多户林农**；
- 模拟某批失效时，需要精确的**锁定范围、在库余量、已流向下游的拆分批及客户通知清单**——既不召回过宽造成浪费，也不漏掉已经流出的拆分批；
- 迟到检验、批次重编号、部分报废、跨仓转移、重复扫码**只能新增事实，不能改写既有链路**；
- 林农（供应商）**只能查看与自身相关的处置**，其他主体被脱敏；
- 任意时点都能回答“当时执行的是哪个标准、当时库存是多少”。

## 运行与测试

```bash
npm start                 # 启动服务，默认 http://localhost:3000
LEDGER_FILE=memory npm start   # 纯内存账本（不落盘）
npm test                  # 运行全部测试（领域 + HTTP）
GET  /health              # 健康检查
GET  /api/ledger/verify   # 哈希链完整性审计（企业端）
```

## 架构

```
src/
├─ domain/
│  ├─ events.mjs        事件类型、角色、等级、检验结论目录
│  ├─ eventStore.mjs    只追加账本：seq + prevHash/哈希链 + JSONL 持久化
│  ├─ projections.mjs   事件流 → 只读状态；支持 asOfTime/asOfSeq 历史重放
│  ├─ traceability.mjs  应用服务：命令校验、权限、追溯与失效影响算法、DTO 脱敏
│  ├─ ids.mjs           标识/批次号（单调不复用）/稳定序列化
│  └─ errors.mjs        领域错误码
├─ http/app.mjs         路由、X-API-Key 鉴权、错误码到 HTTP 状态码映射
└─ server.mjs           组装与启动
```

关键不变量：

1. **只追加**：没有更新/删除接口。迟到检验标记 `late:true` 补记；重编号分配新号且旧号保留为别名；报废与转移叠加新事件。
2. **哈希链**：每条事件含前一条哈希，`GET /api/ledger/verify` 可发现任何对历史载荷、时间或操作人的篡改。
3. **内部标识与对外批次号分离**：重编号不改标识，血缘边不断。
4. **血缘按数量边记录**：合批/拆包生成有向边，追溯沿边遍历，干净批次不在失效影响面内。
5. **当时标准**：检验默认按检验发生时刻取已生效标准版本；追溯返回血缘最早采收时刻的标准。

## API 摘要

除注册外所有接口需要请求头 `X-API-Key`（注册一次性返回明文密钥）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册 enterprise / supplier，返回 apiKey |
| POST/GET | `/api/plots` | 登记/查询林地（企业端） |
| POST/GET | `/api/standards/:product` | 发布质量标准版本（可带 `?at=` 查当时版本） |
| POST | `/api/batches/harvest` | 采收登记 |
| POST | `/api/inspections` | 检验记录（允许迟到补记，自动判合格/不合格） |
| POST | `/api/grades` | 分级 |
| POST | `/api/batches/merge` | 合批（多来源、校验余量与同产品/单位） |
| POST | `/api/batches/split` | 拆包（生成两个以上子批） |
| POST | `/api/batches/deliver` | 交付下游客户 |
| POST | `/api/batches/renumber` | 重编号（旧号保留别名） |
| POST | `/api/batches/transfer` | 跨仓转移 |
| POST | `/api/batches/scan` | 扫码（重复码返回 duplicate 与首见批次） |
| POST | `/api/batches/partial-scrap` `/dispose` | 部分报废 / 整批处置（锁定后仍允许） |
| POST | `/api/lockdowns/impact` | 失效影响模拟（dry-run，不落事件） |
| POST | `/api/lockdowns` | 正式管控：锁定在库批 + 林农协查/下游召回通知 |
| GET | `/api/batches` `/:ref` `/:ref/trace` | 列表/详情（支持 `?asOf=` 时点重放）/全链路履历 |
| GET | `/api/notifications` | 通知（供应商只见与自己相关的） |
| GET | `/api/ledger/verify` `/events` | 哈希链审计 / 事件浏览（企业端） |

`ref` 可传内部 batchId、当前批次号或历史别名。典型演练见 `test/http.test.mjs`。
