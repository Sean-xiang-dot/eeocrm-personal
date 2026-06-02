---
name: xiaoshouyi
description: |
  调用销售易（Xiaoshouyi）CRM 系统的 MCP 技能。覆盖客户、联系人、商机、线索、产品、价格手册、报价单、订单、收款、EEO 账号等全部业务对象的查询和操作。
  当用户提到客户管理、商机、报价、订单、CRM 等相关话题时使用本技能。
  所有写入操作须向用户展示预览并获确认后才执行。
---

# 销售易 CRM MCP 技能

本技能通过 **xiaoshouyi-mcp** Server 操作销售易 sandbox 环境。

---

## 一、工具速查表

### 基础工具

| 工具 | 用途 |
|---|---|
| `crm_login` | 用户名密码登录 |
| `crm_whoami` | 查看登录状态 |
| `crm_soql_query` | 执行原生 SOQL |
| `crm_query_records` | 结构化参数查询（自动构建 SOQL） |
| `crm_get_record` | 按 ID 获取单条记录 |
| `crm_create_record` | 通用创建记录 |
| `crm_update_record` | 通用更新记录 |
| `crm_delete_record` | 删除记录 |
| `crm_transfer_owner` | 转移负责人 |

### 元数据工具

| 工具 | 用途 |
|---|---|
| `crm_describe_fields` | 获取对象字段定义 |
| `crm_describe_object` | 获取对象元信息 |
| `crm_list_objects` | 列出所有业务对象 |

| `crm_entity_type_map` | 获取对象的 entityType 枚举（id→名称映射） |

### 业务查询工具

| 工具 | 对象 | 说明 |
|---|---|---|
| `crm_query_accounts` | account | 客户查询（支持关键词搜索） |
| `crm_query_contacts` | contact | 联系人查询 |
| `crm_query_opportunities` | opportunity | 商机查询 |
| `crm_query_leads` | lead | 线索查询 |
| `crm_query_products` | product | 产品查询（默认只显示启用） |
| `crm_query_price_books` | priceBook / priceBookEntry | 价格手册及明细 |
| `crm_query_orders` | order | 订单查询 |
| `crm_query_quotes` | quote | 报价单查询 |
| `crm_query_quote_lines` | quoteLine | 报价明细查询 |
| `crm_query_collections` | Collection__c | 收款查询 |
| `crm_query_eeo_accounts` | ShroffAccount__c | EEO 账号查询 |

### 复合操作工具

| 工具 | 说明 |
|---|---|
| `crm_create_quote` | 创建报价单（自动填充 entityType/dimDepart） |
| `crm_create_quote_line` | 创建单行报价明细 |
| `crm_create_quote_with_lines` | **一步创建报价单 + 所有明细行** |
| `crm_account_360` | 客户 360° 视图（基本信息+联系人+商机+订单+报价） |
| `crm_opportunity_detail` | 商机详情（含报价单+订单） |

### MCP Resources

| URI | 说明 |
|---|---|
| `xiaoshouyi://objects` | 全部业务对象列表 |
| `xiaoshouyi://objects/{apiKey}` | 单个对象元信息 |
| `xiaoshouyi://objects/{apiKey}/fields` | 对象字段定义 |
| `xiaoshouyi://reference/business-objects` | 常用对象速查手册 |

---

## 二、对象对照表

| 用户说的 | apiKey |
|---|---|
| 客户、公司 | `account` |
| 联系人 | `contact` |
| 商机 | `opportunity` |
| 线索 | `lead` |
| 产品 | `product` |
| 价格手册 | `priceBook` |
| 价格明细 | `priceBookEntry` |
| 报价单 | `quote` |
| 报价明细 | `quoteLine` |
| 订单 | `order` |
| 合同 | `contract` |
| 收款 | `Collection__c` |
| EEO账号 | `ShroffAccount__c` |
| 收款计划 | `CollectionPlan__c` |
| 财务信息 | `FinancialInformation__c` |
| 上课信息 | `ClassInformation__c` |
| 资源变动信息 | `ResourceInformation__c` |

---

## 二-A、EEO 账号业务模型

EEO 账号（`ShroffAccount__c`）是 ClassIn 产品的核心对象，对应一个机构的 ClassIn 使用账号。下属 3 个子对象。

### EEO 账号关键字段

| apiKey | 说明 | 备注 |
|---|---|---|
| `uid__c` | 机构 UID | 唯一标识 |
| `schoolName__c` | 机构名称 | |
| `Account__c` | 关联客户 | → account |
| `expireTime__c` | 服务期限 | **ClassIn 到期日期**，type=7(日期) |
| `DateBack__c` | 到期日期 | 另一个到期字段 |
| `service_version__c` | 服务版本 | picklist |
| `select_version__c` | 选择版本 | picklist |
| `Version__c` | 版本 | 公式字段 |
| `PriceType__c` | 计价方式 | picklist |
| `currency__c` | 账户余额（后台） | **单位：分**，type=6(数字) |
| `currencyShow__c` | 账户余额 | **单位：元**，公式字段(type=27)，用这个展示 |
| `CurrencyAmount__c` | 余额-欠费额度（剩余可用金额） | 公式字段 |
| `GotBy__c` | 欠费额度（后台） | |
| `PersonHour__c` | 人.课时数量 | 课时维度 |
| `PersonHourMargin__c` | 课节（人.时）余量 | **周期版课时余量** |
| `PersonHourStatus__c` | 课节余量状态 | |
| `Refill__c` | 充值额汇总（后台） | 单位：分 |
| `RefillShow__c` | 充值额汇总 | 公式字段，元 |
| `ConsumptionTotal__c` | 课耗金额汇总（后台） | |
| `RecordConsumptionTotal__c` | 录课汇总（后台） | |
| `LiveYun__c` | 直播消耗(元) | |
| `TotalClassNum__c` | 累计开课课节数 | |
| `totalHoursAll__c` | 累计计费课节时长 | |
| `LastClassDate__c` | 最近一次上课时间 | |
| `serviceState__c` | 服务状态 | picklist |
| `ServiceStatus__c` | 服务状态 | 公式字段 |
| `ContractStartDate__c` | 合同开始时间 | |
| `ContractEndDate__c` | 合同结束时间 | |
| `ContractStatus__c` | 合同状态 | picklist |

### EEO 账号两种计价类型

| 类型 | 说明 | 关注的字段 |
|---|---|---|
| **周期消耗版** | 按课时消耗，买的是课时额度 | `PersonHourMargin__c`(课时余量), `PersonHour__c`(课时数量) |
| **余额消耗版** | 充值消耗，买的是余额 | `currencyShow__c`(余额/元), `currency__c`(余额/分) |

⚠️ **余额有两个字段**：`currency__c` 是后台推送的(单位**分**)，`currencyShow__c` 是公式字段(单位**元**)。展示给用户永远用 `currencyShow__c`。

### 子对象 1: 上课信息（ClassInformation__c）

记录 EEO 账号的上课数据汇总，通过 `AccClassInfo__c` 关联父 EEO 账号。

**时间维度（`timeRange__c`）**：每天 / 每周 / 每月 三种维度**会重叠**，统计汇总时**只取一种维度**，不要混用。

| 维度 | `ClassDate__c` 含义 | 生成时机 |
|---|---|---|
| 每天 | 当天日期 | 当天 |
| 每周 | 当周一的日期 | 当周结束后生成 |
| 每月 | 当月1号的日期 | 当月结束后生成 |

**关键字段**：

| apiKey | 说明 |
|---|---|
| `AccClassInfo__c` | 父 EEO 账号 ID |
| `ClassDate__c` | 上课日期（含义取决于时间维度） |
| `timeRange__c` | 时间维度 (每天/每周/每月) |
| `classFee__c` | 课程消耗金额（后台，分） |
| `AmountReal__c` | 课程消耗金额（元，公式） |
| `recordClassFee__c` | 录课消耗金额 |
| `recordClassFeeYuan__c` | 录课消耗金额（元，公式） |
| `liveFluxFee__c` | 直播消耗金额 |
| `liveFluxFeeYuan__c` | 直播消耗金额（元，公式） |
| `threeamountYun__c` | 课耗总金额（元，公式） |
| `totalHours__c` | 人.课时 |
| `validClassNum__c` | 开课总数 |
| `studentNum__c` | 学生人数 |
| `teacherNum__c` | 老师人数 |
| `classFeeNum__c` | 周期版课时消耗 |
| `liveFluxFeeNum__c` | 周期版直播流量消耗 |
| `recordClassFeeNum__c` | 周期版录课消耗 |

### 子对象 2: 财务信息（FinancialInformation__c）

记录 EEO 账号下发生的所有金额变动，通过 `ShroffAccInfor__c` 关联父 EEO 账号。

**关键字段**：

| apiKey | 说明 |
|---|---|
| `ShroffAccInfor__c` | 父 EEO 账号 ID |
| `currency__c` | 金额（分） |
| `AmountReal__c` | 金额（元，公式） |
| `BackendAmount__c` | 金额（后台） |
| `GetDate__c` | 到款日期 |
| `orderType__c` | 类型 |
| `PaymentType__c` | 付款类型 |
| `orderId__c` | 订单号 |
| `ServiceVersion__c` | 充值版本 |
| `newType__c` | 新签类型 |
| `refunded__c` | 是否已退单 |

### 子对象 3: 资源变动信息（ResourceInformation__c）

记录 EEO 账号下发生的所有资源变动，通过 `ShroffAccount__c` 关联父 EEO 账号。

**关键字段**：

| apiKey | 说明 |
|---|---|
| `ShroffAccount__c` | 父 EEO 账号 ID |
| `ChangeType__c` | 变动类型 |
| `ChangeCause__c` | 变动原因 |
| `ChangeDetail__c` | 变动详情 |
| `ChangeNumber__c` | 变动数值 |
| `ChangeTime__c` | 变动时间 |
| `Margin__c` | 余量 |
| `ServiceType__c` | 服务版本 |
| `Amount__c` | 合同金额 |

### 常见业务场景的查询方式

**1. 查某客户的 ClassIn 到期时间**
```
SELECT id, uid__c, schoolName__c, expireTime__c, currencyShow__c, PersonHourMargin__c
FROM ShroffAccount__c WHERE Account__c = {客户ID}
```

**2. 查即将到期的 EEO 账号（30天内）**
```
SELECT id, uid__c, schoolName__c, expireTime__c, Account__c
FROM ShroffAccount__c WHERE expireTime__c <= NEXT_N_DAYS:30 AND expireTime__c >= TODAY
```

**3. 查余额不足的 EEO 账号**
注意用 `currency__c`（分）做条件，用 `currencyShow__c`（元）展示：
```
SELECT id, uid__c, schoolName__c, currencyShow__c, currency__c
FROM ShroffAccount__c WHERE currency__c < 200000 AND currency__c > 0
```
（200000分 = 2000元）

**4. 查某 EEO 账号的上课信息（按月汇总）**
```
SELECT ClassDate__c, threeamountYun__c, validClassNum__c, studentNum__c, totalHours__c
FROM ClassInformation__c WHERE AccClassInfo__c = {EEO账号ID} AND timeRange__c = {月维度值}
ORDER BY ClassDate__c DESC LIMIT 12
```
⚠️ timeRange__c 的值是 picklist，具体值需先查 `crm_describe_fields` 确认。

**5. 查某 EEO 账号的财务流水**
```
SELECT GetDate__c, AmountReal__c, orderType__c, PaymentType__c, orderId__c
FROM FinancialInformation__c WHERE ShroffAccInfor__c = {EEO账号ID}
ORDER BY GetDate__c DESC LIMIT 50
```

**6. 查某 EEO 账号的资源变动**
```
SELECT ChangeTime__c, ChangeType__c, ChangeCause__c, ChangeNumber__c, Margin__c
FROM ResourceInformation__c WHERE ShroffAccount__c = {EEO账号ID}
ORDER BY ChangeTime__c DESC LIMIT 50
```

### account
`accountName`(名称), `ownerId`(负责人), `entityType`(业务类型), `phone`(电话), `address`(地址)

### opportunity
`opportunityName`(名称), `money`(金额⚠️不是amount), `accountId`(客户), `saleStageId`(阶段), `closeDate`(预计成交)

### quote
`quotationTitle`(标题), `quotationEntityRelAccount`(客户ID), `quotationEntityRelOpportunity`(商机ID), `quotationAmount`(总金额), `priceListId`(价格手册), `quoteTime`(报价时间ms)

### quoteLine
`quotationDetailEntityRelQuotationEntity`(报价单ID), `quotationDetailEntityRelProduct`(产品ID), `price`(单价), `quantity`(数量), `amount`(金额=自动计算)

### order
`accountId`(客户), `opportunityId`(商机), `amount`(总金额), `transactionDate`(下单时间)

### lead
`name`(姓名), `companyName`(公司), `mobile`(手机), `email`(邮箱), `status`(跟进状态)

### ShroffAccount__c (EEO账号)
`uid__c`(UID), `schoolName__c`(机构名称), `Account__c`(客户), `expireTime__c`(服务期限/到期日期), `currency__c`(余额/分), `currencyShow__c`(余额/元⚠️展示用这个), `PersonHourMargin__c`(课时余量), `service_version__c`(服务版本), `PriceType__c`(计价方式)

### ClassInformation__c (上课信息)
`AccClassInfo__c`(EEO账号ID), `ClassDate__c`(上课日期), `timeRange__c`(时间维度⚠️每天/每周/每月会重叠不要混用), `threeamountYun__c`(课耗总金额/元), `validClassNum__c`(开课总数), `totalHours__c`(人.课时), `studentNum__c`(学生人数)

### FinancialInformation__c (财务信息)
`ShroffAccInfor__c`(EEO账号ID), `currency__c`(金额/分), `AmountReal__c`(金额/元), `GetDate__c`(到款日期), `orderType__c`(类型), `PaymentType__c`(付款类型)

### ResourceInformation__c (资源变动信息)
`ShroffAccount__c`(EEO账号ID), `ChangeType__c`(变动类型), `ChangeNumber__c`(变动数值), `ChangeTime__c`(变动时间), `Margin__c`(余量)

---

## 四、处理流程

### 查询流程（尤其涉及客户/联系人等可能重名的场景）

```
用户输入（可能是简称/手机号/UID）
  │
  ▼
① 分析用户提供了什么信息
  │
  ├─ 提供了客户名 → crm_smart_find_account(keyword: "华为")
  │
  ├─ 提供了手机号 → crm_smart_find_account(phone: "138...")
  │     自动搜索路径: 联系人(mobile) → accountId → 客户
  │                   EEO账号(name/userAccount__c) → Account__c → 客户
  │
  ├─ 提供了 UID → crm_smart_find_account(uid: "12345")
  │     自动搜索路径: EEO账号(uid__c) → Account__c → 客户
  │
  ├─ 同时有多种信息 → crm_smart_find_account(keyword+phone+uid)
  │     多路径并行搜索，结果去重
  │
  ▼
② 搜索结果判断
  │
  ├─ 只有 1 条 → 直接继续后续操作
  │
  ├─ 多条结果 → 列出候选让用户选择确认
  │     "找到以下客户,请确认是哪个:
  │      1. 华为技术有限公司 (ID: xxx)  来源: 客户名匹配
  │      2. 华为云计算 (ID: yyy)  来源: 联系人张三 → 客户"
  │
  └─ 零条结果 → 请用户提供更多信息（完整名称开头、手机号或 UID）
```

#### 客户查找准则

1. **优先使用 `crm_smart_find_account`** — 它会自动尝试所有搜索路径
2. **客户名只支持前缀匹配**（LIKE '华为%'），不支持包含匹配
3. **手机号和 UID 是精确匹配**，通常更可靠
4. **当用户提供多行客户名时**，建议让用户同时提供手机号或 UID 辅助定位
5. 搜索路径优先级: 手机号/UID（精确）> 客户名（模糊）
  └─ 写操作 → 展示预览 → 用户确认 → 执行
```

### 写入流程

```
用户请求写入（创建/更新/删除）
  │
  ▼
① 收集必要信息（如果不足,向用户询问）
  │
  ▼
② 展示操作预览（对象、字段、值）
  │
  ▼
③ 用户明确确认 → confirmedByUser: true → 执行
  │
  ▼
④ 返回结果（ownerId 自动设为当前登录用户）
```

### SOQL 搜索限制

- **LIKE 仅支持前缀匹配**: `accountName LIKE '华为%'` ✅，`'%华为%'` ❌
- 如果前缀搜不到，建议用户提供更完整的名称开头
- **不支持 GROUP BY**：聚合统计需在客户端侧处理

---

## 五、API 注意事项

- 对象 apiKey 全小写: `account`, `opportunity`
- 字段 apiKey 驼峰: `accountName`, `saleStageId`
- SOQL LIKE 仅支持前缀匹配: `accountName LIKE '华为%'`（不支持 `'%华为%'`）
- SOQL 查询不支持 `GROUP BY`
- 创建/更新请求体需要 `{ data: {...} }` 包裹（工具已自动处理）
- `entityType` 和 `dimDepart` 是每个对象创建时的必填字段（业务专用工具已自动填充）
- `ownerId` 创建时自动设为当前登录用户（无需手动传）
- `itemType=4`（picklist）字段自动包裹为数组（如 `Subject__c` 传 `1` 自动变 `[1]`）

---

## 五-A、SOQL/xoql 踩坑经验

### LIKE 只支持前缀

- `accountName LIKE '华为%'` ✅
- `accountName LIKE '%华为%'` ❌（包含匹配不支持）
- `accountName LIKE '%电商客户'` ❌（后缀匹配不支持）
- 需要包含匹配时，**先查出来再在代码中过滤**

### 字段名大小写

- 标准字段小写驼峰：`accountName`, `accountId`, `ownerId`, `createdAt`, `updatedAt`
- 自定义字段带 `__c` 后缀，大小写敏感：`IsGuidang__c`, `ArchiveDate__c`
- 同一字段在不同对象上大小写可能不同：order 用 `productType__c`，SalesPerformance__c 用 `ProductType__c`
- 部门表字段是 `departName`、`parentDepartId`（不是 `name`、`parentId`）

### entityType（业务类型/记录类型）

- 每个对象都有 `entityType` 标准字段，值是数字 ID（如 `11010003500001`）
- 在 **xoql**（二开内部调用）中可以用 devName：`entityType = 'defaultOrderBusiType'`
- 在 **外部 SOQL v2** 中必须用数字 ID：`entityType = 11010003500001`
- 外部 SOQL v2 中 `entityType` 字段 **SELECT 能查出值**，但 `WHERE entityType = 'devName'` 匹配不到
- 订单业务类型常量（来自 SystemConst.java）：
  - `order_sale` = 销售订单 = `11010003500001`（devName: `defaultOrderBusiType`）
  - `order_borrow` = 借用订单 = `3613022750802655`
  - `order_gift` = 赠送订单 = `3613022762615505`
  - `order_store` = 快捷订单 = `3697970438308574`

### picklist 字段值

- picklist 类型字段值是**数字**，不是文本（如 `IsABContract__c`: 1=否, 2=是）
- 多选 picklist（如 `productType__c`）返回**数字数组**，如 `[4]`, `[1,4]`
- `!= null` 对多选 picklist 可能无效，查不出数据
- `orderType__c`（财务信息类型）：1=充值, 101/102/202/205/206/222=其他类型（无"3"）
- `ContractStatus__c`（订单状态）：1/2/3/4，排除4
- `poStatus`（订单标准状态）：大部分=2，排除3

### 订单查询基础过滤

查询有效销售订单的标准条件：
```sql
-- xoql (二开内部)
entityType = 'defaultOrderBusiType' AND IsABContract__c = 1 AND poStatus != 3 AND ContractStatus__c != 4

-- SOQL v2 (外部API)
entityType = 11010003500001 AND IsABContract__c = 1 AND poStatus != 3 AND ContractStatus__c != 4
```

### 电商平台公用客户

以下客户是电商平台公用客户（名称含"电商客户"），订单量大但首次标签无意义，批处理时应排除：
- 企培专属抖音电商客户、抖音ClassIn/NB电商客户、小红书ClassIn/NB电商客户
- 视频号ClassIn/NB电商客户、淘宝ClassIn/NB电商客户、京东ClassIn电商客户
- 口袋微店NB电商客户、有赞NB电商客户、NB平台C端客户
- **排除方式**：代码中判断 `accountName.contains("电商客户")`（LIKE 不支持包含匹配）

### SalesPerformance__c（销售绩效）查询

`SalesPerformance__c` 不在 field-usage-report 中，是未被 MCP 系统录入的对象。可用 SOQL 查询。

**已知字段**：`id`, `Account__c`(客户), `ShroffAccount__c`(EEO账号), `order__c`(订单), `GetDate__c`(日期), `Amount__c`(金额), `ownerId`(负责人), `ProductType__c`(产品类型⚠️大写P), `newType__c`(新签类型)

**查询示例**：
```sql
SELECT id, Account__c, GetDate__c, Amount__c, ProductType__c, newType__c
FROM SalesPerformance__c WHERE Account__c = {客户ID}
```

**注意**：`count()` 对此对象返回空结果。早期测试中曾出现返回 0 的情况，后续复测稳定（可能是 token 失效或网络问题）。如遇查询返回空，先确认 token 是否有效。

### 时间戳与时区

- 销售易日期字段（type=7）存储的是**毫秒时间戳**，值为北京时间当天 00:00 对应的 UTC 时间
- 例：`1678896000000` = UTC 2023-03-15T**16:00:00** = 北京时间 **2023-03-16** 00:00:00
- **转日期时必须加 8 小时**（UTC+8），否则日期会少一天
- Java 代码直接用时间戳比较和写入，不存在时区问题
- Node.js/JavaScript 显示时：`new Date(ts + 8*3600*1000).toISOString().slice(0,10)`

---

## 六、日志与知识管理

### 自动记录

所有工具调用自动记录到 `logs/sessions/` 目录（JSONL 格式），包括：
- 工具名、参数、成功/失败、耗时、错误信息

### 知识库工具

| 工具 | 用途 |
|---|---|
| `crm_get_knowledge` | **开始工作前必读** — 查看所有已知坑和正确做法 |
| `crm_report_error_pattern` | 遇到错误并找到根因后，记录到知识库 |
| `crm_session_logs` | 查看当前会话的全部调用记录 |
| `crm_recent_errors` | 查看最近的错误（跨会话） |
| `crm_analyze_errors` | 自动分析最近错误，找出未记录的新模式 |
| `crm_save_session_summary` | 工作结束时保存会话总结（弯路+经验） |

### EEO 账号专用工具

| 工具 | 说明 |
|---|---|
| `crm_eeo_account_health` | EEO 账号健康检查：到期时间、余额、课时余量。支持按客户ID/UID/即将到期/余额不足查询 |
| `crm_query_class_info` | 查询上课信息(ClassInformation__c)，支持按天/周/月维度 |
| `crm_query_financial_info` | 查询财务流水(FinancialInformation__c) |
| `crm_query_resource_changes` | 查询资源变动(ResourceInformation__c) |

### MCP 知识资源

| URI | 说明 |
|---|---|
| `xiaoshouyi://knowledge/error-patterns` | 错误模式知识库（Markdown） |
| `xiaoshouyi://knowledge/session-history` | 历史会话总结 |

### 推荐工作流

```
开始新任务
  │
  ▼
① 调用 crm_get_knowledge 阅读已知坑位
  │
  ▼
② 正常执行任务...
  │
  ├─ 遇到错误 → 排查 → 调 crm_report_error_pattern 记录根因
  │
  ▼
③ 任务完成 → 调 crm_save_session_summary 记录弯路和经验
```

---

## 七、事业部数据域（Business Unit Scope）

### 客户业务类型 (account.entityType) 与事业部对应关系

| 事业部 | entityType 值 | 说明 |
|---|---|---|
| **基础教育** | `KA__c`（学校，主要）| 主要客户类型 |
| **基础教育** | `Education_Authority__c`（教育主管部门）| 辅助 |
| **企业培训** | `企培Account__c`（主要）| 企培事业部主要客户 |
| **企业培训** | `KA__c`（少量）| 有部分学校也归企培 |
| **高等教育** | `College__c`（高校/高职，主要）| 高教事业部 |
| **高等教育** | `Education_Authority__c`（教育主管部门）| 辅助 |

### 项目数据域约束

**当前活跃项目：**

| 项目 | 目标事业部 | 数据过滤条件 |
|---|---|---|
| **金牌销售 AI 智能体**（2026-06） | 基础教育 | `account.entityType` = KA__c（主要关注学校） |
| **飞书听记**（历史项目） | 企业培训 | `account.entityType` = 企培Account__c |

⚠️ **重要**：所有查询和分析必须先确认目标事业部，按 `account.entityType` 过滤后再操作。不同事业部的数据特征（字段填写率、销售流程、跟进习惯）差异很大，不过滤会导致采样偏差。

### MCP 调用约定

1. **登录人 = 数据权限**：MCP 使用登录人的账号访问数据，天然受权限控制
2. **事业部过滤**：做分析/统计时，必须显式加 `account.entityType` 条件限定目标事业部
3. **跨事业部查询**：除非用户明确要求，否则不要混合不同事业部数据
4. **account.entityType 的值是数字 ID**：用 `crm_entity_type_map` 获取 account 的 entityType 映射表，找到对应 ID 后再做 WHERE 过滤

---

## 八、EEO 账号数据规则

### 服务版本 (service_version__c)

| 值 | 含义 | 备注 |
|---|---|---|
| 1 | 免费版 | **MCP 所有场景忽略**，占 69%（194,374 个） |
| 2 | 付费版 | 35,862 |
| 3 | 付费版 | 439 |
| 4 | 付费版 | 2,648 |
| 5 | 付费版 | 32,375 |

⚠️ `service_version__c = 1` 的免费账号：`expireTime__c` 无意义（epoch 零值），不要用来判断到期。

### 服务状态 (serviceState__c)

| 值 | 含义 | 是否活跃 |
|---|---|---|
| 1 | 服务中 | ✅ 活跃 |
| 2 | 服务到期停用 | ❌ |
| 3 | 欠费暂停 | ❌ |
| 4 | 手动停用 | ❌ |
| 5 | 注销停用 | ❌ |
| 6 | 其他 | ❌ |

### EEO 查询标准过滤

```sql
-- 排除免费版（所有 MCP 场景）
WHERE service_version__c != 1

-- 只看活跃付费账号
WHERE service_version__c != 1 AND serviceState__c = 1

-- 即将到期（付费账号）
WHERE service_version__c != 1 AND serviceState__c = 1
  AND expireTime__c BETWEEN {now} AND {now + 60天}
```

---

## 九、活动记录 (activityrecord) 数据规则

### entityType 分布（2026-06 验证）

| entityType | 推测类型 | 数量 | 占比 | 特征 |
|---|---|---|---|---|
| `11010011100002` | 拜访/外出 | 63,968 | 67% | content 含"拜访"/"大屏体验"，belongId=1(客户来源) |
| `11010011100001` | 电话/联系 | 12,533 | 13% | content 含"邀约未接通"/"电话邀约"，有 TFollowUpSubject__c |
| `3588972666094228` | 自定义/其他 | 11,363 | 12% | content 含"方案演示"/"公司参访"，自定义类型 ID |

⚠️ **entityType 的中文 label 无法通过 API 获取**（getRecord 返回数字 ID，没有 `-label` 后缀；标准 entityTypes/businessTypes/selectitems 接口全部 404）。以上类型名称是基于 content 内容模式推断的，**需业务方确认具体含义后才能在工具中硬编码**。

### 关键字段

| 字段 | 说明 | 填写率 | 备注 |
|---|---|---|---|
| `content` | 跟进内容 | ~100% | 核心信息，自由文本 |
| `startTime` | 记录时间 | 100% | 毫秒时间戳 |
| `dbcRelation26` | 关联客户 ID | 87.6%（83,809/95,663）| 关联 account 的核心字段 |
| `ownerId` | 负责人 | 100% | |
| `entityType` | 活动类型 | 100% | 区分电话/拜访/其他（ID 级别） |
| `activityRecordFrom` | 来源对象类型 | 100% | 11=销售线索, 1=客户 |
| `TFollowUpSubject__c` | 跟进主题 | 仅电话类有 | 多选数组 |
| `VisitingType__c` | 拜访类型 | **0%** | 字段存在但无人填写 |
| `VistDate__c` | 拜访日期 | **0%** | 字段存在但无人填写 |
| `Subject__c` | 主题 | **0%** | 字段存在但无人填写 |

### 关联客户的跟进记录查询

```sql
-- 查某客户的活动记录（按时间倒序）
SELECT id, content, startTime, entityType, ownerId
FROM activityrecord WHERE dbcRelation26 = {客户ID}
ORDER BY startTime DESC LIMIT 20

-- 查某销售的活动记录
SELECT id, content, startTime, entityType, dbcRelation26
FROM activityrecord WHERE ownerId = {销售ID}
ORDER BY startTime DESC LIMIT 20
```

### ⚠️ 待确认事项（需业务方回答）

1. 三种 entityType 的准确业务含义（目前只能靠 content 推断）
2. 金牌销售场景需要区分到什么粒度（粗分三类够不够？还是需要按 content 做 NLP 分类？）
3. `TFollowUpSubject__c` 的 picklist 值含义（数字 → 文本映射）

---

## 十、数据质量问题清单（需暴露给业务方）

以下问题不是 MCP/技术团队能解决的，但金牌销售项目落地时需要业务方知道：

| 问题 | 影响 | 当前状态 | 谁推动 |
|---|---|---|---|
| `contactRole`（联系人角色）几乎无人填 | 无法区分决策人/中层/一线 | 658 条有值 | 业务方推动销售维护 |
| `AccountTypeJJ__c`（基教客户分级）仅 5% | 无法按 A/B/C 分级做差异化策略 | 7,701/约16万 | 业务方推动 |
| `VisitingType__c`（拜访类型）0% | 无法细分拜访目的 | 完全未使用 | 业务方推动 or 接受粗分 |
| `EstimatedTime__c`（回款计划时间）准确性 | 回款提醒可能不准 | 填写率 99.8%，准确性未知 | 财务/业务核对 |
| 产品后台用量/登录频率 API | 无法做使用下降触发规则 | 不存在 | 后台团队开发 |
