#!/usr/bin/env node
import dotenv from "dotenv";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { XiaoshouyiClient } from "./client.js";
import { registerTools, setSessionId } from "./tools.js";
import { registerResources } from "./resources.js";

const envFile = process.env.XIAOSHOUYI_ENV === "production" ? ".env.production" : ".env";
dotenv.config({ path: envFile });

// ── 环境变量（个人版：clientId/clientSecret 可选，优先个人 OAuth） ──
const PORT = parseInt(process.env.PORT || "3000");
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const BASE_URL = process.env.XIAOSHOUYI_BASE_URL || "https://api-tencent.xiaoshouyi.com";

console.log(`[config] env file: ${envFile}`);
console.log(`[config] 认证模式: 个人 OAuth 优先（~/.neocrm/credentials.json）`);

// ── Express 应用 ──────────────────────────────────────────
const app = express();
app.use(express.json());

// 简单鉴权中间件（可选）
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const token = req.headers["authorization"]?.replace("Bearer ", "");
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// 健康检查
app.get("/", (_req, res) => {
  res.json({
    service: "eeoCRM-personal MCP Server",
    auth: "个人 OAuth（操作归属你本人）",
    endpoints: {
      health: "GET /health",
      sse: "GET /sse",
      messages: "POST /messages?sessionId=xxx",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "eeoCRM-personal" });
});

// ── MCP SSE 端点 ──────────────────────────────────────────
const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req, res) => {
  console.log("🔌 新 SSE 连接:", req.ip);

  const server = new McpServer({
    name: "eeoCRM-personal",
    version: "2.0.0",
  });

  // 每个 SSE 会话创建独立的销售易客户端
  const sessionClient = new XiaoshouyiClient({
    clientId: process.env.XIAOSHOUYI_CLIENT_ID || "",
    clientSecret: process.env.XIAOSHOUYI_CLIENT_SECRET || "",
    baseUrl: BASE_URL,
  });

  // 尝试自动用个人 OAuth 登录
  const autoLogin = await sessionClient.loginWithPersonalToken();
  if (autoLogin.success) {
    console.log(`✅ 自动登录成功：${autoLogin.username}`);
  } else {
    console.log(`⚠️  个人 OAuth 未就绪，需手动 crm_login：${autoLogin.message}`);
  }

  // 注册所有工具和资源
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  setSessionId(sessionId);
  registerTools(server, sessionClient);
  registerResources(server, sessionClient);

  transports.set(sessionId, transport);

  res.on("close", () => {
    console.log("🔌 SSE 连接断开:", sessionId);
    transports.delete(sessionId);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ── 启动 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ eeoCRM Personal MCP Server 启动`);
  console.log(`   CRM API: ${BASE_URL}`);
  console.log(`   SSE 端点:  http://localhost:${PORT}/sse`);
  console.log(`   消息端点:  http://localhost:${PORT}/messages`);
  console.log(`   健康检查:  http://localhost:${PORT}/health`);
  console.log(`   认证模式:  个人 OAuth（~/.neocrm/credentials.json）`);
  if (AUTH_TOKEN) {
    console.log(`   🔒 已启用 Bearer Token 鉴权`);
  }
});
