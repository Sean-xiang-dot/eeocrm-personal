import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XiaoshouyiClient } from "./client.js";
import { readErrorPatterns, readSessionSummaries } from "./logger.js";

export function registerResources(server: McpServer, client: XiaoshouyiClient) {

  // ── 快速指南（Agent 优先读取） ────────────────────────
  // URI: xiaoshouyi://guide
  server.resource(
    "quick-guide",
    "xiaoshouyi://guide",
    { description: "⭐ 必读：CRM 常用场景路由表。告诉你该用哪个工具、传什么字段，避免绕圈。连接后第一时间阅读此资源。", mimeType: "text/markdown" },
    async (uri) => {
      const guide = `# CRM 快速指南（场景 → 工具 → 字段）

> 连接后先读这份指南，不要盲目调 crm_list_objects 或 crm_describe_fields 探索。

## 常用对象速查（只列日常用到的）

| 用户说的 | apiKey | 关键字段 |
|---|---|---|
| 客户/公司 | account | accountName, ownerId, entityType, phone, RecentVisitDate__c, AccountTypeJJ__c |
| 联系人 | contact | contactName, mobile, email, accountId, contactRole |
| 商机 | opportunity | opportunityName, money(⚠️不是amount), accountId, saleStageId, closeDate |
| 订单 | order | orderEntityRelAccount, orderAmount, transactionDate, entityType=11010003500001(销售订单) |
| EEO账号 | ShroffAccount__c | uid__c, schoolName__c, Account__c, expireTime__c, service_version__c(1=免费忽略), serviceState__c(1=活跃), currencyShow__c(余额/元) |
| 收款计划 | CollectionPlan__c | EstimatedTime__c, collectStatus__c, Amount__c, accountId |
| 活动记录 | activityrecord | content, startTime, dbcRelation26(客户ID), ownerId, entityType(类型) |
| 线索 | lead | name, companyName, mobile, email, status |

## 场景路由表

### 找客户
- 知道名称 → \`crm_smart_find_account(keyword: "xx")\`
- 知道手机号 → \`crm_smart_find_account(phone: "138...")\`
- 知道 UID → \`crm_smart_find_account(uid: "12345")\`

### 客户全貌
→ \`crm_account_360(accountId: "xxx")\`
返回：基本信息 + 联系人 + 商机 + 订单 + 报价单

### EEO 账号健康
→ \`crm_eeo_account_health(accountId: "xxx")\` 或 \`crm_eeo_account_health(uid: "12345")\`
返回：到期时间、余额、课时余量

### 查活动记录/拜访
→ \`crm_soql_query\` + SQL:
\`\`\`sql
SELECT id, content, startTime, entityType, ownerId
FROM activityrecord WHERE dbcRelation26 = '{客户ID}'
ORDER BY startTime DESC LIMIT 20
\`\`\`

### 查即将到期的付费 EEO 账号
→ \`crm_soql_query\` + SQL:
\`\`\`sql
SELECT id, uid__c, schoolName__c, expireTime__c, Account__c
FROM ShroffAccount__c
WHERE service_version__c != 1 AND serviceState__c = 1
  AND expireTime__c <= NEXT_N_DAYS:60 AND expireTime__c >= TODAY
\`\`\`

### 查回款计划
→ \`crm_soql_query\` + SQL:
\`\`\`sql
SELECT id, EstimatedTime__c, Amount__c, collectStatus__c
FROM CollectionPlan__c WHERE accountId = '{客户ID}'
ORDER BY EstimatedTime__c DESC
\`\`\`

### 商机详情（含报价和订单）
→ \`crm_opportunity_detail(opportunityId: "xxx")\`

### 创建/更新记录
→ \`crm_create_record\` / \`crm_update_record\`（必须用户确认后才调用）

### 查某字段的枚举值含义
→ \`crm_entity_type_map(objectApiKey: "account")\`

## 关键规则

1. **EEO 账号排除免费版**：所有 ShroffAccount__c 查询加 \`WHERE service_version__c != 1\`
2. **金额字段**：opportunity 用 \`money\`（不是 amount）；余额展示用 \`currencyShow__c\`（元）
3. **时间字段**：全部是毫秒时间戳，显示时 +8h 转北京时间
4. **LIKE 只支持前缀**：\`accountName LIKE '华为%'\` ✅，\`'%华为%'\` ❌
5. **不支持 GROUP BY**：聚合需客户端处理
6. **ID 传字符串**：reference/owner 类型 ID 必须用字符串（JS 大数精度）
7. **分页**：\`LIMIT offset,count\`，单次最多 100 条

## 不要做的事

- ❌ 不要调 crm_list_objects 去"探索有什么对象"——上面已列全了常用的
- ❌ 不要调 crm_describe_fields 去"看字段"——除非用户明确要查某个不在上表的字段
- ❌ 不要用 crm_query_records 代替 crm_soql_query——后者更灵活且你能控制字段
- ❌ 不要查 ShroffAccount__c 时忘记排除 service_version__c = 1
`;
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: guide,
        }],
      };
    }
  );

  // ── 字段定义模板资源 ──────────────────────────────────
  // URI: xiaoshouyi://objects/{objectApiKey}/fields
  server.resource(
    "object-fields",
    new ResourceTemplate("xiaoshouyi://objects/{objectApiKey}/fields", { list: undefined }),
    { description: "获取销售易对象的字段定义列表（apiKey、类型、必填、关联对象等）", mimeType: "application/json" },
    async (uri, { objectApiKey }) => {
      const result: any = await client.describeFields(objectApiKey as string);
      const records = result?.data?.records;
      if (!Array.isArray(records)) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) }] };
      }

      const fields = records.map((f: any) => ({
        apiKey: f.apiKey,
        label: f.label,
        type: f.itemType,
        required: !!f.required,
        maxLength: f.maxLength || undefined,
        joinObject: f.joinObjectApiKey || undefined,
        defaultValue: f.defaultValue ?? undefined,
      }));

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ objectApiKey, totalFields: fields.length, fields }, null, 2),
        }],
      };
    }
  );

  // ── 对象信息模板资源 ──────────────────────────────────
  // URI: xiaoshouyi://objects/{objectApiKey}
  server.resource(
    "object-info",
    new ResourceTemplate("xiaoshouyi://objects/{objectApiKey}", { list: undefined }),
    { description: "获取销售易对象的基本元信息", mimeType: "application/json" },
    async (uri, { objectApiKey }) => {
      const result = await client.describeObject(objectApiKey as string);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // ── 所有对象列表（静态资源） ──────────────────────────
  // URI: xiaoshouyi://objects
  server.resource(
    "all-objects",
    "xiaoshouyi://objects",
    { description: "销售易所有业务对象列表（标准 + 自定义）", mimeType: "application/json" },
    async (uri) => {
      const result: any = await client.listObjects();
      const rawData = result?.data;
      const allObjs: any[] = Array.isArray(rawData) ? rawData : rawData?.records || [];
      const summary = allObjs.map((o: any) => ({
        apiKey: o.apiKey,
        label: o.label,
        custom: String(o.apiKey || "").endsWith("__c"),
        active: o.active,
      }));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ total: summary.length, objects: summary }, null, 2),
        }],
      };
    }
  );

  // ── 常用业务对象速查（静态资源） ──────────────────────
  server.resource(
    "business-objects-reference",
    "xiaoshouyi://reference/business-objects",
    { description: "销售易常用业务对象和字段速查手册", mimeType: "text/markdown" },
    async (uri) => {
      const reference = `# 销售易常用对象速查

## 标准对象

| apiKey | 名称 | 常用字段 |
|---|---|---|
| account | 客户 | accountName, ownerId, industry, phone, address |
| contact | 联系人 | contactName, mobile, email, accountId |
| opportunity | 商机 | opportunityName, money, accountId, saleStageId, closeDate |
| lead | 线索 | leadName, company, mobile, email, leadStatus |
| product | 产品 | productName, priceUnit, unit, enableStatus |
| priceBook | 价格手册 | name, enableFlg, standardFlg, currencyUnit |
| priceBookEntry | 价格明细 | priceBookId, productId, productPrice, bookPrice |
| quote | 报价单 | quotationTitle, quotationEntityRelAccount, quotationEntityRelOpportunity, quotationAmount, priceListId |
| quoteLine | 报价明细 | quotationDetailEntityRelQuotationEntity, quotationDetailEntityRelProduct, price, quantity, amount |
| order | 订单 | orderEntityRelAccount, orderEntityRelOpportunity, orderAmount |
| contract | 合同 | - |

## 重要自定义对象

| apiKey | 名称 | 数据量 |
|---|---|---|
| ShroffAccount__c | EEO账号 | 10,000+ |
| Collection__c | 收款 | 355 |
| CollectionPlan__c | 收款计划 | 13,000+ |
| FinancialInformation__c | 财务信息 | 15,000+ |
| ContractOA__c | 销售合同 | 70 |
| SalesPerformance__c | 销售绩效 | 7,000+ |

## API 注意事项

- 对象 apiKey 全小写: account, opportunity, quote
- 字段 apiKey 驼峰: accountName, opportunityName, money
- 金额字段: opportunity 用 **money** (不是 amount)
- 创建/更新请求体: \`{ data: { ...fields } }\`
- XOQL 查询: \`GET /rest/data/v2/query\` (v2 不是 v2.0)，官方称 XOQL，语法同 Salesforce SOQL
- CRUD: \`/rest/data/v2.0/xobjects/{apiKey}\`
- 创建记录需要 entityType + dimDepart，工具已自动填充
- **ownerName 不存在**！要查负责人姓名，先查 ownerId，再 \`SELECT id, name FROM user WHERE id = <ownerId>\`
- 数据权限由登录账号决定，无 impersonate/runAs 机制。如需按用户过滤，应用层加 WHERE ownerId 条件
- date/datetime 字段值是**毫秒时间戳**（Long），不是日期字符串
- reference/owner 类型的 ID 必须用**字符串**传参（JS 大数精度问题）
- picklist 字段传 selectitem 的 value（数字字符串如 \`"1"\`），不是 label（如"互联网"）
- 分页: \`LIMIT offset,count\`（如 \`LIMIT 100,100\` 取第二页），单次最多 100 条
`;
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/markdown",
          text: reference,
        }],
      };
    }
  );

  // ── 知识库资源（错误模式） ────────────────────────────
  // URI: xiaoshouyi://knowledge/error-patterns
  server.resource(
    "error-patterns",
    "xiaoshouyi://knowledge/error-patterns",
    { description: "已积累的错误模式知识库 — AI 开始工作前应先阅读此资源，避免已知的坑", mimeType: "text/markdown" },
    async (uri) => {
      const patterns = readErrorPatterns();
      if (patterns.length === 0) {
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# 知识库\n\n暂无记录。" }],
        };
      }
      let md = `# 已知错误模式 (${patterns.length} 条)\n\n`;
      md += "AI 在执行 CRM 操作前请先阅读以下已知的坑，避免重复犯错。\n\n";
      for (const p of patterns) {
        md += `## [${p.category}] ${p.errorSignature}\n`;
        md += `- **根因**: ${p.rootCause}\n`;
        md += `- **正确做法**: ${p.correctApproach}\n`;
        md += `- 出现 ${p.count} 次 | 最近: ${p.lastSeen.slice(0, 10)}\n\n`;
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    }
  );

  // ── 历史会话总结资源 ──────────────────────────────────
  // URI: xiaoshouyi://knowledge/session-history
  server.resource(
    "session-history",
    "xiaoshouyi://knowledge/session-history",
    { description: "历史会话执行总结 — 包含目标、弯路和经验教训", mimeType: "text/markdown" },
    async (uri) => {
      const summaries = readSessionSummaries();
      if (summaries.length === 0) {
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# 会话历史\n\n暂无记录。" }],
        };
      }
      let md = `# 历史会话总结 (最近 ${summaries.length} 次)\n\n`;
      for (const s of summaries.slice(-10).reverse()) {
        md += `## ${s.goal} [${s.outcome}]\n`;
        md += `- 时间: ${s.startTime.slice(0, 16)} ~ ${s.endTime.slice(0, 16)}\n`;
        md += `- 调用: ${s.totalCalls}次 (${s.errorCalls}次失败)\n`;
        if (s.detours.length) md += `- 弯路:\n${s.detours.map(d => `  - ${d}`).join("\n")}\n`;
        if (s.lessons.length) md += `- 经验:\n${s.lessons.map(l => `  - ${l}`).join("\n")}\n`;
        md += "\n";
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    }
  );
}
