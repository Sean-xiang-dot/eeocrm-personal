import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { XiaoshouyiClient } from "./client.js";
import {
  logToolCall,
  readSessionLogs,
  readRecentErrors,
  readErrorPatterns,
  upsertErrorPattern,
  saveSessionSummary,
  analyzeRecentErrors,
  type ToolCallLog,
  type ErrorPattern,
  type SessionSummary,
} from "./logger.js";

// 每个 registerTools 调用对应一个会话
let _sessionId = "default";

/** 设置当前会话 ID（由 index.ts 调用） */
export function setSessionId(id: string) {
  _sessionId = id;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

/** 统一错误包装：将异常转为 MCP 错误响应 */
function wrapError(err: unknown): ToolResult {
  const e = err as any;
  const status = e.response?.status;
  const apiMsg = e.response?.data?.msg || e.response?.data?.error_description;
  const message = apiMsg
    ? `销售易 API 错误 (${status || "?"}): ${apiMsg}`
    : `错误: ${e.message || String(err)}`;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** 带日志的工具处理器包装 */
function withLogging(
  toolName: string,
  handler: (params: any) => Promise<ToolResult>
): (params: any) => Promise<ToolResult> {
  return async (params: any) => {
    const start = Date.now();
    let result: ToolResult;
    try {
      result = await handler(params);
    } catch (err) {
      result = wrapError(err);
    }

    const isError = !!result.isError;
    const entry: ToolCallLog = {
      timestamp: new Date().toISOString(),
      sessionId: _sessionId,
      toolName,
      params: sanitizeParams(params),
      success: !isError,
      durationMs: Date.now() - start,
    };

    if (isError) {
      entry.error = result.content[0]?.text || "Unknown error";
      const apiMatch = entry.error.match(/\((\d+)\)/);
      if (apiMatch) entry.apiErrorCode = apiMatch[1];
    } else {
      const text = result.content[0]?.text || "";
      entry.resultSummary = text.slice(0, 200);
    }

    // 异步写日志，不阻塞响应
    try { logToolCall(entry); } catch { /* ignore */ }

    return result;
  };
}

/** 参数脱敏（隐藏密码） */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...params };
  if (clean.password) clean.password = "***";
  return clean;
}

function getOwnerKey(client: XiaoshouyiClient): string {
  return client.currentUser || client.userContext?.userId || "anonymous";
}

export function registerTools(server: McpServer, client: XiaoshouyiClient) {

  // ── 自动日志: 对所有 tool 注册进行拦截，包裹 withLogging ──
  const originalTool = server.tool.bind(server);
  server.tool = function (...args: any[]) {
    // server.tool(name, description, schema, handler)
    // handler 是最后一个参数
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      const toolName = args[0] as string;
      args[args.length - 1] = withLogging(toolName, handler);
    }
    return (originalTool as any)(...args);
  } as any;

  // ── 0. 登录 ───────────────────────────────────────────
  server.tool(
    "crm_login",
    "使用个人 OAuth 令牌登录（从 ~/.neocrm/credentials.json 读取）。操作归属你本人。如果个人令牌不可用，也可传入用户名密码走系统账号登录。",
    {
      username: z.string().optional().describe("（可选）销售易账号用户名，不传则自动使用个人 OAuth 令牌"),
      password: z.string().optional().describe("（可选）销售易账号密码"),
    },
    async ({ username, password }) => {
      let result;
      if (username && password) {
        result = await client.login(username, password);
      } else {
        result = await client.loginWithPersonalToken();
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ── 1. SOQL 查询 ──────────────────────────────────────
  server.tool(
    "crm_soql_query",
    `执行 XOQL（销售易官方叫法）/ SOQL 查询语句，从销售易查询数据。
常用标准对象 apiKey: account(客户), contact(联系人), opportunity(商机), lead(线索), task(任务), schedule(日程), activityrecord(活动记录), order(订单), quote(报价单), contract(合同), case(服务工单), product(产品)。
自定义对象以 __c 结尾，如 Event__c。
字段名使用 apiKey（如 id, accountName, ownerId），不确定字段名时先用 crm_describe_fields 查询。
⚠ LIKE 仅支持前缀匹配: accountName LIKE '华为%'（不支持 '%华为%'）。
⚠ 不支持 GROUP BY，需在客户端侧汇总。
⚠ ownerName 不是有效字段！要查负责人名称，先查 ownerId，再用 SELECT id, name FROM user WHERE id = <ownerId> 解析。
⚠ 查"我的"数据必须显式加 WHERE ownerId = '<我的userId>'，不会自动过滤。
⚠ 分页语法: LIMIT offset,count（如 LIMIT 100,100 取第二页），单次最多 100 条。
⚠ date/datetime 字段返回毫秒时间戳，不是字符串。
名称字段速查: account→accountName, contact→contactName, opportunity→opportunityName, lead→name, product→productName, priceBook→name, order→用id。
常用关联字段: ownerId(负责人 ID, 所有对象通用), createdBy(创建人 ID), phone(客户电话, account 上)。
示例: SELECT id, accountName FROM account WHERE accountName LIKE '华为%' LIMIT 20`,
    {
      soql: z.string().describe(
        "SOQL 查询语句，如: SELECT id, accountName FROM account LIMIT 50"
      ),
    },
    async ({ soql }) => {
      try {
        const result = await client.soqlQuery(soql);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return wrapError(err);
      }
    }
  );

  // ── 2. 结构化查询（LLM 友好） ────────────────────────
  server.tool(
    "crm_query_records",
    "用结构化参数查询销售易记录。内部自动构建 SOQL。适合不熟悉 SOQL 语法时使用。objectApiKey 使用小写，如 account, contact, opportunity, schedule 等。",
    {
      objectApiKey: z.string().describe("对象 apiKey（小写），如 account, contact, opportunity, schedule, activityrecord, Event__c 等"),
      fields: z.array(z.string()).describe("要查询的字段 apiKey 列表，如 ['id', 'accountName', 'ownerId']"),
      where: z.string().optional().describe("WHERE 条件，如: industry = 'IT' AND ownerId = '123'"),
      orderBy: z.string().optional().describe("排序，如: createdAt DESC"),
      limit: z.number().int().min(1).max(200).optional().default(20).describe("返回条数上限"),
      offset: z.number().int().min(0).optional().describe("分页偏移量"),
    },
    async (params) => {
      const fieldList = params.fields.join(", ");
      let soql = `SELECT ${fieldList} FROM ${params.objectApiKey}`;
      if (params.where) soql += ` WHERE ${params.where}`;
      if (params.orderBy) soql += ` ORDER BY ${params.orderBy}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 3. 获取单条记录详情 ───────────────────────────────
  server.tool(
    "crm_get_record",
    "根据记录 ID 获取销售易中某条记录的完整详情",
    {
      objectApiKey: z.string().describe("对象 apiKey（小写），如 account, contact"),
      recordId: z.string().describe("记录 ID"),
      fields: z.array(z.string()).optional().describe("指定返回字段 apiKey，不传返回全部"),
    },
    async ({ objectApiKey, recordId, fields }) => {
      const result = await client.getRecord(objectApiKey, recordId, fields);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 4. 创建记录 ───────────────────────────────────────
  server.tool(
    "crm_create_record",
    `在销售易中创建新记录。调用前必须已获得用户明确确认。
dimDepart 可不传（自动注入当前用户部门）。
itemType=4（picklist）字段自动包裹为数组，无需手动处理。`,
    {
      objectApiKey: z.string().describe("对象 apiKey（小写）"),
      data: z.record(z.unknown()).describe("字段 apiKey 键值对，如 { accountName: '客户A', phone: '138...' }"),
      confirmedByUser: z.boolean().describe("必须为 true，表示用户已确认此操作"),
    },
    async ({ objectApiKey, data, confirmedByUser }) => {
      if (!confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认，拒绝执行写入操作。请先展示操作预览并获得确认。" }] };
      }
      const result = await client.createRecord(objectApiKey, data);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 5. 更新记录 ───────────────────────────────────────
  server.tool(
    "crm_update_record",
    `更新销售易中已有记录的字段。调用前必须已获得用户明确确认。
itemType=4（picklist）字段自动包裹为数组，无需手动处理。`,
    {
      objectApiKey: z.string().describe("对象 apiKey（小写）"),
      recordId: z.string().describe("要更新的记录 ID"),
      data: z.record(z.unknown()).describe("要更新的字段 apiKey 键值对"),
      confirmedByUser: z.boolean().describe("必须为 true，表示用户已确认此操作"),
    },
    async ({ objectApiKey, recordId, data, confirmedByUser }) => {
      if (!confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认，拒绝执行写入操作。" }] };
      }
      const result = await client.updateRecord(objectApiKey, recordId, data);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 6. 删除记录 ───────────────────────────────────────
  server.tool(
    "crm_delete_record",
    "删除销售易中的记录。高危操作，调用前必须已获得用户明确确认。",
    {
      objectApiKey: z.string().describe("对象 apiKey（小写）"),
      recordId: z.string().describe("要删除的记录 ID"),
      confirmedByUser: z.boolean().describe("必须为 true，表示用户已确认此删除操作"),
    },
    async ({ objectApiKey, recordId, confirmedByUser }) => {
      if (!confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认，拒绝执行删除操作。" }] };
      }
      const result = await client.deleteRecord(objectApiKey, recordId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 7. 转移负责人 ─────────────────────────────────────
  server.tool(
    "crm_transfer_owner",
    "将销售易记录的负责人转移给其他用户。需用户确认。",
    {
      objectApiKey: z.string().describe("对象 apiKey（小写）"),
      recordId: z.string(),
      newOwnerId: z.string().describe("新负责人的用户 ID"),
      confirmedByUser: z.boolean(),
    },
    async ({ objectApiKey, recordId, newOwnerId, confirmedByUser }) => {
      if (!confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认。" }] };
      }
      const result = await client.transferOwner(objectApiKey, recordId, newOwnerId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 8. 获取对象字段列表 ───────────────────────────────
  server.tool(
    "crm_describe_fields",
    "获取销售易某个对象的所有字段定义（字段 apiKey、类型、必填等），不确定字段名时先调此工具。",
    {
      objectApiKey: z.string().describe("对象 apiKey（小写），如 account, contact, opportunity"),
    },
    async ({ objectApiKey }) => {
      const result = await client.describeFields(objectApiKey);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 9. 获取对象元信息 ─────────────────────────────────
  server.tool(
    "crm_describe_object",
    "获取销售易某个对象的基本信息（名称、类型、是否自定义等）。",
    {
      objectApiKey: z.string().describe("对象 apiKey（小写）"),
    },
    async ({ objectApiKey }) => {
      const result = await client.describeObject(objectApiKey);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 10. 列出所有对象 ──────────────────────────────────
  server.tool(
    "crm_list_objects",
    "获取销售易租户中所有可用的业务对象列表（标准 + 自定义），用于了解有哪些对象可查。",
    {},
    async () => {
      const result = await client.listObjects();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 10a. 获取 entityType 枚举 ─────────────────────────
  server.tool(
    "crm_entity_type_map",
    `获取指定对象的 entityType（业务类型）id → 名称映射。
结果会被缓存。用于了解某对象有哪些业务类型可选（如客户类型、商机类型等）。
注意: entityType 的选项不走标准 pickOption，只能通过已有记录反查。`,
    {
      objectApiKey: z.string().describe("对象 apiKey（小写），如 account, opportunity"),
    },
    async ({ objectApiKey }) => {
      try {
        const map = await client.getEntityTypeMap(objectApiKey);
        return { content: [{ type: "text", text: JSON.stringify(map, null, 2) }] };
      } catch (err) {
        return wrapError(err);
      }
    }
  );

  // ── 11. 查看当前登录状态 ──────────────────────────────
  server.tool(
    "crm_whoami",
    "查看当前 MCP 会话的登录状态、用户信息和用户上下文（dimDepart等）",
    {},
    async () => {
      const info = {
        loggedIn: client.isLoggedIn,
        currentUser: client.currentUser,
        userContext: client.userContext,
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════
  // 业务专用工具
  // ══════════════════════════════════════════════════════

  // ── 12. 客户查询 ──────────────────────────────────────
  server.tool(
    "crm_query_accounts",
    `查询销售易客户(account)列表。
常用字段: id, accountName(客户名称), ownerId(负责人), entityType(业务类型), phone(电话), website(网站), address(地址), createdAt(创建时间), updatedAt(修改时间)
⚠ 客户名可能重复或用户只提供简称。搜索只支持前缀匹配。
工作流建议：先搜索 → 如有多条结果，列出候选让用户选择确认 → 再执行后续操作。`,
    {
      keyword: z.string().optional().describe("按客户名称前缀搜索（仅支持前缀匹配，如'华为'能匹配'华为技术'）"),
      where: z.string().optional().describe("自定义 WHERE 条件，如: industry = 'IT'"),
      fields: z.array(z.string()).optional().describe("要返回的字段，默认: id, accountName, ownerId, entityType, phone, createdAt"),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, accountName, ownerId, entityType, phone, createdAt";
      let soql = `SELECT ${fields} FROM account`;
      const conditions: string[] = [];
      if (params.keyword) conditions.push(`accountName LIKE '${params.keyword}%'`);
      if (params.where) conditions.push(params.where);
      if (conditions.length) soql += ` WHERE ${conditions.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 13. 商机查询 ──────────────────────────────────────
  server.tool(
    "crm_query_opportunities",
    `查询销售易商机(opportunity)列表。
常用字段: id, opportunityName(商机名称), money(金额), ownerId(负责人), accountId(客户), saleStageId(销售阶段), closeDate(预计成交日期), createdAt(创建时间), updatedAt(修改时间), entityType(业务类型)`,
    {
      keyword: z.string().optional().describe("按商机名称模糊搜索"),
      accountId: z.string().optional().describe("按客户 ID 筛选"),
      where: z.string().optional().describe("自定义 WHERE 条件"),
      fields: z.array(z.string()).optional().describe("要返回的字段，默认: id, opportunityName, money, ownerId, accountId, saleStageId, closeDate"),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, opportunityName, money, ownerId, accountId, saleStageId, closeDate";
      let soql = `SELECT ${fields} FROM opportunity`;
      const conditions: string[] = [];
      if (params.keyword) conditions.push(`opportunityName LIKE '${params.keyword}%'`);
      if (params.accountId) conditions.push(`accountId = ${params.accountId}`);
      if (params.where) conditions.push(params.where);
      if (conditions.length) soql += ` WHERE ${conditions.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 14. 产品查询 ──────────────────────────────────────
  server.tool(
    "crm_query_products",
    `查询销售易产品(product)列表。
常用字段: id, productName(产品名称), priceUnit(标准价格), unit(单位), enableStatus(启用状态: 1=启用), ownerId(负责人), createdAt(创建时间)`,
    {
      keyword: z.string().optional().describe("按产品名称模糊搜索"),
      enabledOnly: z.boolean().optional().default(true).describe("是否只查启用的产品"),
      where: z.string().optional().describe("自定义 WHERE 条件"),
      fields: z.array(z.string()).optional().describe("要返回的字段，默认: id, productName, priceUnit, unit, enableStatus"),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, productName, priceUnit, unit, enableStatus";
      let soql = `SELECT ${fields} FROM product`;
      const conditions: string[] = [];
      if (params.keyword) conditions.push(`productName LIKE '${params.keyword}%'`);
      if (params.enabledOnly) conditions.push("enableStatus = 1");
      if (params.where) conditions.push(params.where);
      if (conditions.length) soql += ` WHERE ${conditions.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 15. 价格手册查询 ──────────────────────────────────
  server.tool(
    "crm_query_price_books",
    `查询销售易价格手册(priceBook)列表及其明细(priceBookEntry)。
priceBook 字段: id, name(名称), enableFlg(启用: 1=启用), standardFlg(标准: 1=标准), currencyUnit(币种)
priceBookEntry 字段: id, priceBookId(价格手册ID), productId(产品ID), productPrice(标准价), bookPrice(手册价), enableFlg(启用)`,
    {
      queryType: z.enum(["priceBook", "priceBookEntry"]).describe("查询价格手册还是价格手册明细"),
      priceBookId: z.string().optional().describe("按价格手册 ID 筛选明细"),
      productId: z.string().optional().describe("按产品 ID 筛选明细"),
      enabledOnly: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
    async (params) => {
      let soql: string;
      if (params.queryType === "priceBook") {
        soql = "SELECT id, name, enableFlg, standardFlg, currencyUnit FROM priceBook";
        const cond: string[] = [];
        if (params.enabledOnly) cond.push("enableFlg = 1");
        if (cond.length) soql += ` WHERE ${cond.join(" AND ")}`;
      } else {
        soql = "SELECT id, priceBookId, productId, productPrice, bookPrice, enableFlg FROM priceBookEntry";
        const cond: string[] = [];
        if (params.priceBookId) cond.push(`priceBookId = ${params.priceBookId}`);
        if (params.productId) cond.push(`productId = ${params.productId}`);
        if (params.enabledOnly) cond.push("enableFlg = 1");
        if (cond.length) soql += ` WHERE ${cond.join(" AND ")}`;
      }
      soql += ` LIMIT ${params.limit}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 16. 创建报价单 ────────────────────────────────────
  server.tool(
    "crm_create_quote",
    `在销售易中创建报价单(quote)。entityType 和 dimDepart 会自动从已有记录中获取。
必填: quotationEntityRelOpportunity(商机ID), priceListId(价格手册ID)。
常用字段: quotationEntityRelAccount(客户ID), quotationTitle(标题), quoteTime(报价时间戳ms,默认当前), ownerId(负责人,默认当前用户)。
调用前必须获得用户确认。`,
    {
      quotationEntityRelOpportunity: z.string().describe("关联商机 ID"),
      priceListId: z.string().describe("价格手册 ID"),
      quotationEntityRelAccount: z.string().optional().describe("关联客户 ID"),
      quotationTitle: z.string().optional().describe("报价单标题"),
      quoteTime: z.number().optional().describe("报价时间（毫秒时间戳），默认当前时间"),
      ownerId: z.string().optional().describe("负责人 ID，不传则使用系统默认"),
      extraFields: z.record(z.unknown()).optional().describe("其他自定义字段"),
      confirmedByUser: z.boolean().describe("必须为 true，表示用户已确认"),
    },
    async (params) => {
      if (!params.confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认，拒绝执行写入操作。请先展示操作预览并获得确认。" }] };
      }

      const defaults = await client.getObjectDefaults("quote");
      const data: Record<string, unknown> = {
        entityType: defaults.entityType,
        dimDepart: defaults.dimDepart,
        quotationEntityRelOpportunity: params.quotationEntityRelOpportunity,
        priceListId: params.priceListId,
        quoteTime: params.quoteTime ?? Date.now(),
        ...params.extraFields,
      };
      if (params.quotationEntityRelAccount) data.quotationEntityRelAccount = params.quotationEntityRelAccount;
      if (params.quotationTitle) data.quotationTitle = params.quotationTitle;
      if (params.ownerId) data.ownerId = params.ownerId;

      const result = await client.createRecord("quote", data);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 17. 创建报价单明细 ────────────────────────────────
  server.tool(
    "crm_create_quote_line",
    `在销售易中创建报价单明细行(quoteLine)。entityType 和 dimDepart 会自动获取。
必填: quotationDetailEntityRelQuotationEntity(报价单ID), quotationDetailEntityRelProduct(产品ID), price(单价), quantity(数量), priceListId(价格手册ID)。
amount(销售金额) 由系统自动计算 = price × quantity。
调用前必须获得用户确认。`,
    {
      quotationDetailEntityRelQuotationEntity: z.string().describe("所属报价单 ID"),
      quotationDetailEntityRelProduct: z.string().describe("产品 ID"),
      price: z.number().describe("销售单价"),
      quantity: z.number().describe("数量"),
      priceListId: z.string().describe("价格手册 ID"),
      extraFields: z.record(z.unknown()).optional().describe("其他自定义字段"),
      confirmedByUser: z.boolean().describe("必须为 true，表示用户已确认"),
    },
    async (params) => {
      if (!params.confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认，拒绝执行写入操作。" }] };
      }

      const defaults = await client.getObjectDefaults("quoteLine");
      const data: Record<string, unknown> = {
        entityType: defaults.entityType,
        dimDepart: defaults.dimDepart,
        quotationDetailEntityRelQuotationEntity: params.quotationDetailEntityRelQuotationEntity,
        quotationDetailEntityRelProduct: params.quotationDetailEntityRelProduct,
        price: params.price,
        quantity: params.quantity,
        priceListId: params.priceListId,
        ...params.extraFields,
      };

      const result = await client.createRecord("quoteLine", data);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 18. 查询报价单 ────────────────────────────────────
  server.tool(
    "crm_query_quotes",
    `查询销售易报价单(quote)列表。
常用字段: id, name(编号), quotationTitle(标题), quotationEntityRelAccount(客户ID), quotationEntityRelOpportunity(商机ID), quotationAmount(总金额), quotationStage(阶段), priceListId(价格手册), ownerId(负责人), quoteTime(报价时间), createdAt(创建时间)`,
    {
      opportunityId: z.string().optional().describe("按商机 ID 筛选"),
      accountId: z.string().optional().describe("按客户 ID 筛选"),
      where: z.string().optional().describe("自定义 WHERE 条件"),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, name, quotationTitle, quotationEntityRelAccount, quotationEntityRelOpportunity, quotationAmount, quotationStage, ownerId, quoteTime";
      let soql = `SELECT ${fields} FROM quote`;
      const conditions: string[] = [];
      if (params.opportunityId) conditions.push(`quotationEntityRelOpportunity = ${params.opportunityId}`);
      if (params.accountId) conditions.push(`quotationEntityRelAccount = ${params.accountId}`);
      if (params.where) conditions.push(params.where);
      if (conditions.length) soql += ` WHERE ${conditions.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 19. 查询报价单明细 ────────────────────────────────
  server.tool(
    "crm_query_quote_lines",
    `查询销售易报价单明细(quoteLine)列表。
常用字段: id, quotationDetailEntityRelQuotationEntity(报价单ID), quotationDetailEntityRelProduct(产品ID), price(单价), quantity(数量), amount(金额), discount(折扣), priceUnit(价格表价格), priceListId(价格手册)`,
    {
      quoteId: z.string().describe("报价单 ID"),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, quotationDetailEntityRelQuotationEntity, quotationDetailEntityRelProduct, price, quantity, amount, discount, priceUnit, priceListId";
      const soql = `SELECT ${fields} FROM quoteLine WHERE quotationDetailEntityRelQuotationEntity = ${params.quoteId} LIMIT ${params.limit}`;

      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════
  // 复合操作（简化多步流程）
  // ══════════════════════════════════════════════════════

  // ── 20. 创建报价单 + 明细行（一步完成） ──────────────
  server.tool(
    "crm_create_quote_with_lines",
    `一步创建报价单 + 所有明细行。自动填充 entityType/dimDepart。
报价单必填: quotationEntityRelOpportunity(商机ID), priceListId(价格手册ID)。
每行明细必填: productId(产品ID), price(单价), quantity(数量)。
amount 由系统自动计算。如果任何明细行创建失败，会返回部分成功结果。
调用前必须获得用户确认。`,
    {
      quote: z.object({
        quotationEntityRelOpportunity: z.string().describe("商机 ID"),
        priceListId: z.string().describe("价格手册 ID"),
        quotationEntityRelAccount: z.string().optional().describe("客户 ID"),
        quotationTitle: z.string().optional().describe("标题"),
        quoteTime: z.number().optional().describe("报价时间(ms时间戳)"),
        ownerId: z.string().optional().describe("负责人 ID"),
        extraFields: z.record(z.unknown()).optional(),
      }).describe("报价单信息"),
      lines: z.array(z.object({
        productId: z.string().describe("产品 ID"),
        price: z.number().describe("销售单价"),
        quantity: z.number().describe("数量"),
        extraFields: z.record(z.unknown()).optional(),
      })).min(1).describe("明细行列表"),
      confirmedByUser: z.boolean().describe("必须为 true"),
    },
    async (params) => {
      if (!params.confirmedByUser) {
        return { content: [{ type: "text", text: "ERROR: 用户尚未确认，拒绝执行写入操作。" }] };
      }

      const quoteDefaults = await client.getObjectDefaults("quote");
      const quoteData: Record<string, unknown> = {
        entityType: quoteDefaults.entityType,
        dimDepart: quoteDefaults.dimDepart,
        quotationEntityRelOpportunity: params.quote.quotationEntityRelOpportunity,
        priceListId: params.quote.priceListId,
        quoteTime: params.quote.quoteTime ?? Date.now(),
        ...params.quote.extraFields,
      };
      if (params.quote.quotationEntityRelAccount) quoteData.quotationEntityRelAccount = params.quote.quotationEntityRelAccount;
      if (params.quote.quotationTitle) quoteData.quotationTitle = params.quote.quotationTitle;
      if (params.quote.ownerId) quoteData.ownerId = params.quote.ownerId;

      const quoteRes: any = await client.createRecord("quote", quoteData);
      if (quoteRes.code !== "200" && quoteRes.code !== 200) {
        return { content: [{ type: "text", text: `报价单创建失败: ${JSON.stringify(quoteRes)}` }] };
      }

      const quoteId = quoteRes.data?.id;
      const quoteName = quoteRes.data?.name;
      const lineDefaults = await client.getObjectDefaults("quoteLine");
      const lineResults: Array<{ productId: string; success: boolean; id?: string; error?: string }> = [];

      for (const line of params.lines) {
        try {
          const lineData: Record<string, unknown> = {
            entityType: lineDefaults.entityType,
            dimDepart: lineDefaults.dimDepart,
            quotationDetailEntityRelQuotationEntity: quoteId,
            quotationDetailEntityRelProduct: line.productId,
            price: line.price,
            quantity: line.quantity,
            priceListId: params.quote.priceListId,
            ...line.extraFields,
          };
          const lineRes: any = await client.createRecord("quoteLine", lineData);
          if (lineRes.code === "200" || lineRes.code === 200) {
            lineResults.push({ productId: line.productId, success: true, id: lineRes.data?.id });
          } else {
            lineResults.push({ productId: line.productId, success: false, error: lineRes.msg });
          }
        } catch (err: any) {
          lineResults.push({ productId: line.productId, success: false, error: err.message });
        }
      }

      const summary = {
        quote: { id: quoteId, name: quoteName },
        lines: lineResults,
        totalLines: params.lines.length,
        successLines: lineResults.filter(l => l.success).length,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════
  // 更多业务查询工具
  // ══════════════════════════════════════════════════════

  // ── 21. 联系人查询 ────────────────────────────────────
  server.tool(
    "crm_query_contacts",
    `查询销售易联系人(contact)列表。
常用字段: id, contactName(姓名), mobile(手机), email(邮箱), accountId(客户ID), ownerId(负责人), createdAt(创建时间)`,
    {
      keyword: z.string().optional().describe("按姓名模糊搜索"),
      accountId: z.string().optional().describe("按客户 ID 筛选"),
      where: z.string().optional(),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, contactName, mobile, email, accountId, ownerId, createdAt";
      let soql = `SELECT ${fields} FROM contact`;
      const cond: string[] = [];
      if (params.keyword) cond.push(`contactName LIKE '${params.keyword}%'`);
      if (params.accountId) cond.push(`accountId = ${params.accountId}`);
      if (params.where) cond.push(params.where);
      if (cond.length) soql += ` WHERE ${cond.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;
      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 22. 线索查询 ──────────────────────────────────────
  server.tool(
    "crm_query_leads",
    `查询销售易线索(lead)列表。
常用字段: id, name(姓名), companyName(公司名称), mobile(手机), email(邮箱), ownerId(负责人), leadSourceId(来源), status(跟进状态), createdAt(创建时间)`,
    {
      keyword: z.string().optional().describe("按姓名或公司模糊搜索"),
      where: z.string().optional(),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, name, companyName, mobile, email, ownerId, leadSourceId, status, createdAt";
      let soql = `SELECT ${fields} FROM lead`;
      const cond: string[] = [];
      if (params.keyword) cond.push(`name LIKE '${params.keyword}%'`);
      if (params.where) cond.push(params.where);
      if (cond.length) soql += ` WHERE ${cond.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;
      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 23. 订单查询 ──────────────────────────────────────
  server.tool(
    "crm_query_orders",
    `查询销售易订单(order)列表。
常用字段: id, accountId(客户ID), opportunityId(商机ID), amount(总金额), initAmount(原始金额), ownerId(负责人), transactionDate(下单时间), createdAt(创建时间)`,
    {
      keyword: z.string().optional().describe("按订单编号模糊搜索"),
      accountId: z.string().optional().describe("按客户 ID 筛选"),
      opportunityId: z.string().optional().describe("按商机 ID 筛选"),
      where: z.string().optional(),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, accountId, opportunityId, amount, ownerId, transactionDate, createdAt";
      let soql = `SELECT ${fields} FROM order`;
      const cond: string[] = [];
      if (params.keyword) cond.push(`id LIKE '${params.keyword}%'`);
      if (params.accountId) cond.push(`accountId = ${params.accountId}`);
      if (params.opportunityId) cond.push(`opportunityId = ${params.opportunityId}`);
      if (params.where) cond.push(params.where);
      if (cond.length) soql += ` WHERE ${cond.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;
      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 24. 收款查询 ──────────────────────────────────────
  server.tool(
    "crm_query_collections",
    `查询销售易收款(Collection__c)记录。
常用字段: id, name(收款编号)。适合按客户/订单筛选。`,
    {
      where: z.string().optional().describe("WHERE 条件"),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, name, createdAt, ownerId";
      let soql = `SELECT ${fields} FROM Collection__c`;
      if (params.where) soql += ` WHERE ${params.where}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;
      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 25. EEO 账号查询 ─────────────────────────────────
  server.tool(
    "crm_query_eeo_accounts",
    `查询 EEO 账号(ShroffAccount__c)记录（10000+条）。`,
    {
      keyword: z.string().optional().describe("按名称模糊搜索"),
      where: z.string().optional(),
      fields: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
      offset: z.number().int().min(0).optional(),
    },
    async (params) => {
      const fields = params.fields?.length
        ? params.fields.join(", ")
        : "id, name, createdAt, ownerId";
      let soql = `SELECT ${fields} FROM ShroffAccount__c`;
      const cond: string[] = [];
      if (params.keyword) cond.push(`name LIKE '${params.keyword}%'`);
      if (params.where) cond.push(params.where);
      if (cond.length) soql += ` WHERE ${cond.join(" AND ")}`;
      soql += ` LIMIT ${params.limit}`;
      if (params.offset) soql += ` OFFSET ${params.offset}`;
      const result = await client.soqlQuery(soql);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 26. 客户360视图 ──────────────────────────────────
  server.tool(
    "crm_account_360",
    `获取客户 360° 全景视图：客户基本信息 + 联系人 + 商机列表 + 订单列表 + 报价单列表。一次调用返回完整客户画像。`,
    {
      accountId: z.string().describe("客户 ID"),
    },
    async ({ accountId }) => {
      const [acctRes, contactRes, oppRes, orderRes, quoteRes] = await Promise.all([
        client.soqlQuery(`SELECT id, accountName, ownerId, entityType, phone, website, address, createdAt, updatedAt FROM account WHERE id = ${accountId}`),
        client.soqlQuery(`SELECT id, contactName, mobile, email, createdAt FROM contact WHERE accountId = ${accountId} LIMIT 50`),
        client.soqlQuery(`SELECT id, opportunityName, money, saleStageId, closeDate, ownerId FROM opportunity WHERE accountId = ${accountId} LIMIT 50`),
        client.soqlQuery(`SELECT id, accountId, amount, ownerId, createdAt FROM order WHERE accountId = ${accountId} LIMIT 50`),
        client.soqlQuery(`SELECT id, name, quotationTitle, quotationAmount, quotationStage, quoteTime FROM quote WHERE quotationEntityRelAccount = ${accountId} LIMIT 50`),
      ]);

      const view = {
        account: (acctRes as any).result?.records?.[0] ?? null,
        contacts: { total: (contactRes as any).result?.totalSize, records: (contactRes as any).result?.records },
        opportunities: { total: (oppRes as any).result?.totalSize, records: (oppRes as any).result?.records },
        orders: { total: (orderRes as any).result?.totalSize, records: (orderRes as any).result?.records },
        quotes: { total: (quoteRes as any).result?.totalSize, records: (quoteRes as any).result?.records },
      };
      return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }] };
    }
  );

  // ── 27. 商机详情（含报价单+订单） ────────────────────
  server.tool(
    "crm_opportunity_detail",
    `获取商机完整详情：商机信息 + 关联报价单列表 + 关联订单列表。`,
    {
      opportunityId: z.string().describe("商机 ID"),
    },
    async ({ opportunityId }) => {
      const [oppRes, quoteRes, orderRes] = await Promise.all([
        client.soqlQuery(`SELECT id, opportunityName, money, accountId, saleStageId, closeDate, ownerId, createdAt, updatedAt FROM opportunity WHERE id = ${opportunityId}`),
        client.soqlQuery(`SELECT id, name, quotationTitle, quotationAmount, quotationStage, quoteTime FROM quote WHERE quotationEntityRelOpportunity = ${opportunityId} LIMIT 50`),
        client.soqlQuery(`SELECT id, accountId, amount, ownerId, createdAt FROM order WHERE opportunityId = ${opportunityId} LIMIT 50`),
      ]);

      const detail = {
        opportunity: (oppRes as any).result?.records?.[0] ?? null,
        quotes: { total: (quoteRes as any).result?.totalSize, records: (quoteRes as any).result?.records },
        orders: { total: (orderRes as any).result?.totalSize, records: (orderRes as any).result?.records },
      };
      return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
    }
  );

  // ── 28. 智能客户查找（多路径） ────────────────────────
  server.tool(
    "crm_smart_find_account",
    `智能查找客户：支持通过客户名、手机号、UID 等多路径定位客户。
当客户名模糊/有简称/搜不到时，可通过关联对象反查：
- 手机号 → 联系人(contact.mobile) → contact.accountId → 客户
- 手机号 → EEO账号(ShroffAccount__c.name / userAccount__c) → Account__c → 客户
- UID → EEO账号(ShroffAccount__c.uid__c) → Account__c → 客户
- 客户名 → 直接搜 account.accountName（前缀匹配）

返回所有命中的客户（去重），附带来源路径说明。多条结果时需让用户选择确认。`,
    {
      keyword: z.string().optional().describe("客户名称（前缀搜索）"),
      phone: z.string().optional().describe("手机号"),
      uid: z.string().optional().describe("EEO UID"),
    },
    async (params) => {
      const results: Array<{ accountId: string; accountName: string; source: string }> = [];
      const seenIds = new Set<string>();

      const addResult = (id: string, name: string, source: string) => {
        const sid = String(id);
        if (!seenIds.has(sid)) {
          seenIds.add(sid);
          results.push({ accountId: sid, accountName: name, source });
        }
      };

      // 路径 1: 客户名 → account
      if (params.keyword) {
        try {
          const r: any = await client.soqlQuery(
            `SELECT id, accountName FROM account WHERE accountName LIKE '${params.keyword}%' LIMIT 20`
          );
          for (const rec of r?.result?.records || []) {
            addResult(rec.id, rec.accountName, `客户名匹配: ${rec.accountName}`);
          }
        } catch { /* skip */ }
      }

      // 路径 2: 手机号 → 联系人 → 客户
      if (params.phone) {
        try {
          const r: any = await client.soqlQuery(
            `SELECT id, contactName, mobile, accountId FROM contact WHERE mobile = '${params.phone}' LIMIT 10`
          );
          for (const rec of r?.result?.records || []) {
            if (rec.accountId) {
              // 反查客户名
              try {
                const acct: any = await client.soqlQuery(
                  `SELECT id, accountName FROM account WHERE id = ${rec.accountId} LIMIT 1`
                );
                const name = acct?.result?.records?.[0]?.accountName || "未知";
                addResult(rec.accountId, name, `联系人 ${rec.contactName}(${rec.mobile}) → 客户`);
              } catch {
                addResult(rec.accountId, "未知", `联系人 ${rec.contactName}(${rec.mobile}) → 客户`);
              }
            }
          }
        } catch { /* skip */ }

        // 路径 3: 手机号 → EEO 账号 → 客户
        try {
          const r: any = await client.soqlQuery(
            `SELECT id, name, userAccount__c, Account__c FROM ShroffAccount__c WHERE name = '${params.phone}' OR userAccount__c = '${params.phone}' LIMIT 10`
          );
          for (const rec of r?.result?.records || []) {
            if (rec.Account__c) {
              try {
                const acct: any = await client.soqlQuery(
                  `SELECT id, accountName FROM account WHERE id = ${rec.Account__c} LIMIT 1`
                );
                const name = acct?.result?.records?.[0]?.accountName || "未知";
                addResult(String(rec.Account__c), name, `EEO账号 ${rec.name} → 客户`);
              } catch {
                addResult(String(rec.Account__c), "未知", `EEO账号 ${rec.name} → 客户`);
              }
            }
          }
        } catch { /* skip */ }
      }

      // 路径 4: UID → EEO 账号 → 客户
      if (params.uid) {
        try {
          const r: any = await client.soqlQuery(
            `SELECT id, name, uid__c, Account__c FROM ShroffAccount__c WHERE uid__c = '${params.uid}' LIMIT 10`
          );
          for (const rec of r?.result?.records || []) {
            if (rec.Account__c) {
              try {
                const acct: any = await client.soqlQuery(
                  `SELECT id, accountName FROM account WHERE id = ${rec.Account__c} LIMIT 1`
                );
                const name = acct?.result?.records?.[0]?.accountName || "未知";
                addResult(String(rec.Account__c), name, `UID ${rec.uid__c} → EEO账号 ${rec.name} → 客户`);
              } catch {
                addResult(String(rec.Account__c), "未知", `UID ${rec.uid__c} → EEO账号 → 客户`);
              }
            }
          }
        } catch { /* skip */ }
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: "未找到匹配的客户。请尝试提供更多信息（完整客户名开头、手机号或 UID）。" }] };
      }

      const text = results.length === 1
        ? `找到客户: ${results[0].accountName} (ID: ${results[0].accountId})\n来源: ${results[0].source}`
        : `找到 ${results.length} 个可能的客户，请确认:\n\n` +
          results.map((r, i) => `${i + 1}. ${r.accountName} (ID: ${r.accountId})\n   来源: ${r.source}`).join("\n\n");

      return { content: [{ type: "text", text }] };
    }
  );

  // ══════════════════════════════════════════════════════
  // 日志与知识管理工具
  // ══════════════════════════════════════════════════════

  // ── 28. 查看本次会话调用日志 ──────────────────────────
  server.tool(
    "crm_session_logs",
    "查看当前会话的所有工具调用记录，包括成功/失败、耗时、错误信息。用于回顾和分析执行路径。",
    {
      errorOnly: z.boolean().optional().default(false).describe("是否只看失败的调用"),
    },
    async ({ errorOnly }) => {
      const logs = readSessionLogs(_sessionId);
      const filtered = errorOnly ? logs.filter(l => !l.success) : logs;
      const summary = {
        total: logs.length,
        errors: logs.filter(l => !l.success).length,
        calls: filtered.map(l => ({
          time: l.timestamp,
          tool: l.toolName,
          success: l.success,
          durationMs: l.durationMs,
          error: l.error,
          params: l.params,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── 29. 查看最近错误 ──────────────────────────────────
  server.tool(
    "crm_recent_errors",
    "查看最近的工具调用错误（跨会话），用于分析常见错误模式。",
    {
      limit: z.number().int().min(1).max(200).optional().default(20),
    },
    async ({ limit }) => {
      const errors = readRecentErrors(limit);
      return { content: [{ type: "text", text: JSON.stringify(errors, null, 2) }] };
    }
  );

  // ── 30. 记录错误模式 ──────────────────────────────────
  server.tool(
    "crm_report_error_pattern",
    `记录一个错误模式到知识库，帮助后续调用避免同样的错误。
当你遇到一个错误并发现了根因和正确做法时，调用此工具记录下来。
category 可选: field-name(字段名错误), soql-syntax(SOQL语法), body-format(请求体格式), auth(认证), permission(权限), api-path(API路径), data-type(数据类型), other(其他)`,
    {
      toolName: z.string().describe("出错的工具名"),
      errorSignature: z.string().describe("错误特征描述（用于匹配后续相同错误）"),
      rootCause: z.string().describe("根因分析"),
      correctApproach: z.string().describe("正确做法/解决方案"),
      category: z.enum(["field-name", "soql-syntax", "body-format", "auth", "permission", "api-path", "data-type", "other"]),
    },
    async (params) => {
      const pattern = upsertErrorPattern(params);
      return {
        content: [{ type: "text", text: `✅ 已记录错误模式 [${pattern.id}]: ${pattern.errorSignature}\n累计出现 ${pattern.count} 次` }],
      };
    }
  );

  // ── 31. 查看知识库 ────────────────────────────────────
  server.tool(
    "crm_get_knowledge",
    `查看已积累的错误模式知识库。在开始新任务前调用此工具，可以避免已知的坑。
返回所有已记录的错误模式、根因和正确做法。`,
    {
      category: z.string().optional().describe("按分类筛选，如 field-name, soql-syntax"),
    },
    async ({ category }) => {
      let patterns = readErrorPatterns();
      if (category) {
        patterns = patterns.filter(p => p.category === category);
      }
      if (patterns.length === 0) {
        return { content: [{ type: "text", text: "知识库暂无记录。遇到错误时可通过 crm_report_error_pattern 记录。" }] };
      }
      const formatted = patterns.map(p =>
        `[${p.category}] ${p.errorSignature}\n  根因: ${p.rootCause}\n  正确做法: ${p.correctApproach}\n  出现: ${p.count}次 (最近: ${p.lastSeen.slice(0, 10)})`
      ).join("\n\n");
      return { content: [{ type: "text", text: `已知错误模式 (${patterns.length} 条):\n\n${formatted}` }] };
    }
  );

  // ── 32. 会话总结 ──────────────────────────────────────
  server.tool(
    "crm_save_session_summary",
    `保存当前会话的执行总结，包括目标、走过的弯路、经验教训。
工作结束时调用此工具，把经验沉淀下来供后续参考。`,
    {
      goal: z.string().describe("本次会话的目标/任务"),
      detours: z.array(z.string()).describe("走过的弯路（每条一句话）"),
      outcome: z.enum(["success", "partial", "failed"]).describe("最终结果"),
      lessons: z.array(z.string()).describe("经验教训（每条一句话）"),
    },
    async (params) => {
      const logs = readSessionLogs(_sessionId);
      const summary: SessionSummary = {
        sessionId: _sessionId,
        startTime: logs[0]?.timestamp || new Date().toISOString(),
        endTime: new Date().toISOString(),
        goal: params.goal,
        totalCalls: logs.length,
        errorCalls: logs.filter(l => !l.success).length,
        detours: params.detours,
        outcome: params.outcome,
        lessons: params.lessons,
      };
      saveSessionSummary(summary);
      return {
        content: [{ type: "text", text: `✅ 会话总结已保存\n调用: ${summary.totalCalls}次 (${summary.errorCalls}次失败)\n弯路: ${summary.detours.length}条\n经验: ${summary.lessons.length}条` }],
      };
    }
  );

  // ── 33. 自动分析错误 ──────────────────────────────────
  server.tool(
    "crm_analyze_errors",
    "自动分析最近的错误日志，找出是否有已知模式匹配，以及尚未记录的新错误。用于批量审查和知识库更新。",
    {},
    async () => {
      const analysis = analyzeRecentErrors();
      const result = {
        matchedKnown: analysis.existingMatches.length,
        unmatchedNew: analysis.unmatched.length,
        unmatchedErrors: analysis.unmatched.slice(0, 10).map(e => ({
          tool: e.toolName,
          error: e.error,
          time: e.timestamp,
        })),
        suggestion: analysis.unmatched.length > 0
          ? "发现未记录的错误模式，建议用 crm_report_error_pattern 逐条记录根因和正确做法。"
          : "所有错误均已有对应知识库条目。",
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 39. EEO 账号健康检查 ──────────────────────────────
  server.tool(
    "crm_eeo_account_health",
    "查询 EEO 账号(ShroffAccount__c)的健康状态：到期时间、余额、课时余量。可按客户ID查、按UID查、或直接查即将到期/余额不足的账号。",
    {
      accountId: z.string().optional().describe("CRM 客户 ID（Account__c），查该客户下所有 EEO 账号"),
      uid: z.string().optional().describe("EEO 机构 UID"),
      eeoAccountId: z.string().optional().describe("EEO 账号记录 ID（直接查某条记录）"),
      expiringDays: z.number().int().optional().describe("查N天内即将到期的账号（不传其他参数时使用）"),
      lowBalanceYuan: z.number().optional().describe("查余额低于N元的账号（不传其他参数时使用）"),
      limit: z.number().int().optional().default(20).describe("返回条数限制"),
    },
    async ({ accountId, uid, eeoAccountId, expiringDays, lowBalanceYuan, limit }) => {
      if (!client.isLoggedIn) {
        return { content: [{ type: "text", text: "ERROR: 请先登录（crm_login）。" }], isError: true };
      }
      const fields = "id,uid__c,schoolName__c,Account__c,expireTime__c,DateBack__c,currency__c,currencyShow__c,CurrencyAmount__c,PersonHourMargin__c,PersonHour__c,service_version__c,PriceType__c,serviceState__c,ServiceStatus__c,LastClassDate__c,TotalClassNum__c,ContractStartDate__c,ContractEndDate__c";
      let where = "";
      if (eeoAccountId) {
        where = `WHERE id = ${eeoAccountId}`;
      } else if (uid) {
        where = `WHERE uid__c = '${uid}'`;
      } else if (accountId) {
        where = `WHERE Account__c = ${accountId}`;
      } else if (expiringDays) {
        where = `WHERE expireTime__c <= NEXT_N_DAYS:${expiringDays} AND expireTime__c >= TODAY`;
      } else if (lowBalanceYuan != null) {
        const fen = Math.round(lowBalanceYuan * 100);
        where = `WHERE currency__c < ${fen} AND currency__c > 0`;
      } else {
        return { content: [{ type: "text", text: "ERROR: 请至少提供一个查询条件：accountId / uid / eeoAccountId / expiringDays / lowBalanceYuan" }], isError: true };
      }
      const soql = `SELECT ${fields} FROM ShroffAccount__c ${where} LIMIT ${limit}`;
      try {
        const result = await client.soqlQuery(soql);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return wrapError(err);
      }
    }
  );

  // ── 40. 查上课信息 ────────────────────────────────────
  server.tool(
    "crm_query_class_info",
    "查询 EEO 账号的上课信息(ClassInformation__c)。⚠️timeRange 有每天/每周/每月三种维度会重叠，统计汇总时只取一种。",
    {
      eeoAccountId: z.string().describe("EEO 账号记录 ID（AccClassInfo__c 的值）"),
      timeRange: z.enum(["daily", "weekly", "monthly"]).optional().default("monthly").describe("时间维度"),
      startDate: z.string().optional().describe("开始日期 (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("结束日期 (YYYY-MM-DD)"),
      limit: z.number().int().optional().default(20).describe("返回条数"),
    },
    async ({ eeoAccountId, timeRange, startDate, endDate, limit }) => {
      if (!client.isLoggedIn) {
        return { content: [{ type: "text", text: "ERROR: 请先登录（crm_login）。" }], isError: true };
      }
      const timeRangeMap: Record<string, string> = { daily: "每天", weekly: "每周", monthly: "每月" };
      const trVal = timeRangeMap[timeRange ?? "monthly"];
      const fields = "id,ClassDate__c,timeRange__c,classFee__c,AmountReal__c,threeamountYun__c,recordClassFee__c,recordClassFeeYuan__c,liveFluxFee__c,liveFluxFeeYuan__c,validClassNum__c,totalHours__c,studentNum__c,teacherNum__c,classFeeNum__c";
      let conditions = `AccClassInfo__c = ${eeoAccountId} AND timeRange__c = '${trVal}'`;
      if (startDate) conditions += ` AND ClassDate__c >= ${startDate}`;
      if (endDate) conditions += ` AND ClassDate__c <= ${endDate}`;
      const soql = `SELECT ${fields} FROM ClassInformation__c WHERE ${conditions} ORDER BY ClassDate__c DESC LIMIT ${limit}`;
      try {
        const result = await client.soqlQuery(soql);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `ERROR: ${msg}\n\n💡 如果是 timeRange 值不对，请先用 crm_describe_fields 查 ClassInformation__c 的 timeRange__c 字段的 picklist 选项。` }], isError: true };
      }
    }
  );

  // ── 41. 查财务信息 ────────────────────────────────────
  server.tool(
    "crm_query_financial_info",
    "查询 EEO 账号的财务流水(FinancialInformation__c)。返回金额变动明细。",
    {
      eeoAccountId: z.string().describe("EEO 账号记录 ID（ShroffAccInfor__c 的值）"),
      startDate: z.string().optional().describe("到款开始日期 (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("到款结束日期 (YYYY-MM-DD)"),
      orderType: z.string().optional().describe("类型筛选 (picklist 值)"),
      limit: z.number().int().optional().default(30).describe("返回条数"),
    },
    async ({ eeoAccountId, startDate, endDate, orderType, limit }) => {
      if (!client.isLoggedIn) {
        return { content: [{ type: "text", text: "ERROR: 请先登录（crm_login）。" }], isError: true };
      }
      const fields = "id,ShroffAccInfor__c,currency__c,AmountReal__c,GetDate__c,orderType__c,PaymentType__c,orderId__c,ServiceVersion__c,newType__c,refunded__c";
      let conditions = `ShroffAccInfor__c = ${eeoAccountId}`;
      if (startDate) conditions += ` AND GetDate__c >= ${startDate}`;
      if (endDate) conditions += ` AND GetDate__c <= ${endDate}`;
      if (orderType) conditions += ` AND orderType__c = '${orderType}'`;
      const soql = `SELECT ${fields} FROM FinancialInformation__c WHERE ${conditions} ORDER BY GetDate__c DESC LIMIT ${limit}`;
      try {
        const result = await client.soqlQuery(soql);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return wrapError(err);
      }
    }
  );

  // ── 42. 查资源变动 ────────────────────────────────────
  server.tool(
    "crm_query_resource_changes",
    "查询 EEO 账号的资源变动记录(ResourceInformation__c)。包含课时/流量等资源的增减明细。",
    {
      eeoAccountId: z.string().describe("EEO 账号记录 ID（ShroffAccount__c 的值）"),
      changeType: z.string().optional().describe("变动类型筛选 (picklist 值)"),
      startDate: z.string().optional().describe("变动开始日期 (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("变动结束日期 (YYYY-MM-DD)"),
      limit: z.number().int().optional().default(30).describe("返回条数"),
    },
    async ({ eeoAccountId, changeType, startDate, endDate, limit }) => {
      if (!client.isLoggedIn) {
        return { content: [{ type: "text", text: "ERROR: 请先登录（crm_login）。" }], isError: true };
      }
      const fields = "id,ShroffAccount__c,ChangeType__c,ChangeCause__c,ChangeDetail__c,ChangeNumber__c,ChangeTime__c,Margin__c,ServiceType__c,Amount__c";
      let conditions = `ShroffAccount__c = ${eeoAccountId}`;
      if (changeType) conditions += ` AND ChangeType__c = '${changeType}'`;
      if (startDate) conditions += ` AND ChangeTime__c >= ${startDate}`;
      if (endDate) conditions += ` AND ChangeTime__c <= ${endDate}`;
      const soql = `SELECT ${fields} FROM ResourceInformation__c WHERE ${conditions} ORDER BY ChangeTime__c DESC LIMIT ${limit}`;
      try {
        const result = await client.soqlQuery(soql);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return wrapError(err);
      }
    }
  );
}
