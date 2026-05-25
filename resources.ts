import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XiaoshouyiClient } from "./client.js";
import { readErrorPatterns, readSessionSummaries } from "./logger.js";

export function registerResources(server: McpServer, client: XiaoshouyiClient) {

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
- SOQL: \`GET /rest/data/v2/query\` (v2 不是 v2.0)
- CRUD: \`/rest/data/v2.0/xobjects/{apiKey}\`
- 创建记录需要 entityType + dimDepart，工具已自动填充
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
