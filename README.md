# eeoCRM Personal — 个人版 MCP Server

> 基于 eeoCRM 封装，使用个人 OAuth 认证。所有 CRM 操作归属你本人账号，非共享系统账号。

## 环境要求

- **Node.js 18+**（推荐 20+）
- macOS / Linux / Windows
- 销售易 CRM 账号（即你日常登录 CRM 用的账号）

## 快速开始

```bash
# 1. 克隆仓库
git clone <本仓库地址>
cd eeoCRM-personal

# 2. 安装依赖
npm install

# 3. 首次登录（只需一次，浏览器会自动打开销售易授权页）
npm run login
# → 浏览器打开 → 用你的销售易账号登录并授权 → 终端显示"授权成功！"

# 4. 启动 MCP Server
npm run dev
# → ✅ eeoCRM Personal MCP Server 启动
#      SSE 端点: http://localhost:3001/sse
```

## 在 AI 工具中配置

### VS Code Copilot (MCP)

在 `.vscode/mcp.json` 或用户级 MCP 配置中添加：

```json
{
  "servers": {
    "eeoCRM": {
      "type": "sse",
      "url": "http://localhost:3001/sse"
    }
  }
}
```

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "eeoCRM": {
      "type": "sse",
      "url": "http://localhost:3001/sse"
    }
  }
}
```

### Cursor / 其他支持 MCP 的工具

SSE 端点统一为：`http://localhost:3001/sse`

## 日常使用

```bash
# 启动（每次开工前）
cd eeoCRM-personal && npm run dev

# Token 过期后重新登录（约 2 小时过期，会提示"Token 验证失败"）
npm run login

# 检查健康状态
curl http://localhost:3001/health
```

启动后 AI 工具连接 SSE 端点时会自动用你的个人 OAuth 登录，无需手动操作。

## 常见问题

### Q: `npm run login` 浏览器没打开？
手动复制终端中打印的"授权 URL"到浏览器打开。

### Q: 启动时报"个人 Token 验证失败"？
Token 已过期，重新 `npm run login` 即可。

### Q: 换电脑了怎么办？
每台电脑需各自 `npm run login` 一次。凭证加密绑定当前机器（机器名+用户名），不能直接拷贝。

### Q: 端口 3001 被占用？
修改 `.env` 中的 `PORT=3001` 为其他端口。

## 与原版 eeoCRM 的区别

| | eeoCRM (原版) | eeoCRM-personal (本版) |
|---|---|---|
| 认证 | 系统账号 crm@eeoa.com | 个人 OAuth 令牌 |
| 操作归属 | 共享账号 | 你本人 |
| 数据权限 | 系统账号可见范围 | 你个人可见范围 |
| 启动方式 | 需要 .env.production 配凭证 | 一次 `npm run login` 后自动 |
| 工具能力 | 完全相同 | 完全相同 |

## 凭证安全

- 凭证存储在 `~/.neocrm/credentials.json`
- AES-256-GCM 加密，密钥由 `机器名 + 用户名` 派生（PBKDF2-SHA512）
- 仅本机当前用户可解密，其他人/其他机器拿到文件也无法使用
- Token 有效期约 2 小时

## 可用工具（30+）

| 类别 | 工具 |
|---|---|
| 基础 CRUD | crm_soql_query, crm_get_record, crm_create_record, crm_update_record, crm_delete_record |
| 身份 | crm_login, crm_whoami |
| 场景增强 | crm_account_360, crm_smart_find_account, crm_create_quote_with_lines, crm_opportunity_detail, crm_eeo_account_health |
| EEO 专属 | crm_query_eeo_accounts, crm_query_class_info, crm_query_financial_info, crm_query_resource_changes, crm_query_collections |
| 元数据 | crm_describe_fields, crm_describe_object, crm_list_objects, crm_entity_type_map |
| 可观测 | crm_session_logs, crm_recent_errors, crm_analyze_errors |
