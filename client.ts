import axios, { AxiosInstance } from "axios";
import { readFileSync } from "fs";
import { homedir, hostname, userInfo } from "os";
import { join } from "path";
import { pbkdf2Sync, createDecipheriv } from "crypto";

// ── 类型定义 ────────────────────────────────────────────

/** Token 默认有效期 2 小时（销售易 token 响应不含 expires_in） */
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

interface TokenCache {
  accessToken: string;
  expiresAt: number;
  username: string;
  /** token 响应中的 id 字段 = 当前登录用户的 user record ID */
  userId: string;
}

export interface UserContext {
  userId: string;
  dimDepart: unknown;
  ownerId: string;
}

export interface XiaoshouyiConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export interface LoginResult {
  success: boolean;
  username: string;
  message: string;
}

/** 从 ~/.neocrm/credentials.json 解密凭证 */
function loadNeoCredentials(): { accessToken: string; baseUrl: string; userId?: string; userName?: string; expiresAt?: string } | null {
  try {
    const credPath = join(homedir(), ".neocrm", "credentials.json");
    const raw = JSON.parse(readFileSync(credPath, "utf-8"));
    if (!raw.ciphertext) {
      // 明文格式
      return raw;
    }
    // AES-256-GCM 加密格式（neocrm CLI 标准）
    const salt = Buffer.from(raw.salt, "base64");
    const iv = Buffer.from(raw.iv, "base64");
    const authTag = Buffer.from(raw.authTag, "base64");
    const machineId = `neocrm-cli:${hostname()}:${userInfo().username}`;
    const key = pbkdf2Sync(machineId, salt, 100000, 32, "sha512");
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    let plaintext = decipher.update(raw.ciphertext, "base64", "utf8");
    plaintext += decipher.final("utf8");
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

export class XiaoshouyiClient {
  private config: XiaoshouyiConfig;
  private tokenCache: TokenCache | null = null;
  private http: AxiosInstance;
  /** 记录密码用于 token 过期后自动重新登录 */
  private lastPassword: string = "";
  /** 当前登录用户上下文（dimDepart 等），登录后自动缓存 */
  private _userContext: UserContext | null = null;
  /** 字段元数据缓存: objectApiKey → fieldApiKey → itemType */
  private fieldMetaCache: Record<string, Record<string, number>> = {};
  /** entityType id→label 枚举缓存 */
  private entityTypeLabelCache: Record<string, Record<string, string>> = {};

  constructor(config: XiaoshouyiConfig) {
    this.config = config;
    this.http = axios.create({ baseURL: config.baseUrl, timeout: 30000 });
  }

  // ── 认证方式 1：Password Grant（系统账号，保留兼容） ────

  async login(username: string, password: string): Promise<LoginResult> {
    try {
      const params = new URLSearchParams({
        grant_type: "password",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        username,
        password,
      });

      const res = await this.http.post("/oauth2/token", params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      const { access_token, expires_in, id: userId } = res.data;
      const now = Date.now();
      const ttl = expires_in ? (expires_in - 300) * 1000 : DEFAULT_TOKEN_TTL_MS;
      this.tokenCache = {
        accessToken: access_token,
        expiresAt: now + ttl,
        username,
        userId: String(userId),
      };
      this.lastPassword = password;

      // 登录成功后异步获取用户上下文（dimDepart 等）
      this.fetchUserContext().catch(() => {});

      return { success: true, username, message: `用户 ${username} 登录成功` };
    } catch (err: any) {
      const msg = err.response?.data?.error_description || err.response?.data?.message || err.message;
      return { success: false, username, message: `登录失败: ${msg}` };
    }
  }

  // ── 认证方式 2：个人 OAuth Token（从 ~/.neocrm/credentials.json） ────

  async loginWithPersonalToken(): Promise<LoginResult> {
    const cred = loadNeoCredentials();
    if (!cred || !cred.accessToken) {
      return { success: false, username: "", message: "未找到个人凭证。请先运行登录脚本：node login-tencent.mjs <clientId>" };
    }

    const expiresAt = cred.expiresAt ? new Date(cred.expiresAt).getTime() : Date.now() + DEFAULT_TOKEN_TTL_MS;
    this.tokenCache = {
      accessToken: cred.accessToken,
      expiresAt,
      username: cred.userName || "personal",
      userId: cred.userId || "",
    };

    // 验证 token 有效性
    try {
      const headers = { Authorization: `Bearer ${cred.accessToken}`, "Content-Type": "application/json" };
      const res = await this.http.get("/rest/data/v2/query", { headers, params: { q: "SELECT id,name FROM user WHERE id = '" + (cred.userId || "me") + "' LIMIT 1" } });
      const records = res.data?.data?.records || res.data?.records || [];
      const userName = records[0]?.name || cred.userName || "personal";
      this.tokenCache!.username = userName;
      if (records[0]?.id) this.tokenCache!.userId = String(records[0].id);

      this.fetchUserContext().catch(() => {});
      return { success: true, username: userName, message: `个人 OAuth 登录成功：${userName}，操作将归属你本人` };
    } catch (err: any) {
      // token 可能过期
      this.tokenCache = null;
      const msg = err.response?.data?.error_description || err.response?.data?.message || err.message;
      return { success: false, username: "", message: `个人 Token 验证失败（可能已过期），请重新运行登录脚本。错误: ${msg}` };
    }
  }

  get currentUser(): string | null {
    return this.tokenCache?.username ?? null;
  }

  get isLoggedIn(): boolean {
    return !!this.tokenCache && Date.now() < this.tokenCache.expiresAt;
  }

  /** 获取当前用户上下文（dimDepart 等），已缓存 */
  get userContext(): UserContext | null {
    return this._userContext;
  }

  /** 登录后获取用户的真实 dimDepart 和 ownerId (通过 token.id 查 user 对象) */
  private async fetchUserContext(): Promise<void> {
    try {
      const userId = this.tokenCache?.userId;
      if (!userId) return;
      // token.id 就是当前登录用户的 user record ID
      const res: any = await this.getRecord("user", userId);
      const rec = res?.data || res?.data?.record;
      if (rec) {
        this._userContext = {
          userId: userId,
          dimDepart: rec.dimDepart,
          ownerId: userId, // 当前用户就是 owner
        };
      }
    } catch {
      // 静默失败，不阻塞登录
    }
  }

  private async getAccessToken(): Promise<string> {
    if (!this.tokenCache) {
      throw new Error("未登录：请先使用 crm_login 工具进行登录。");
    }

    // Token 过期，自动重新登录
    if (Date.now() >= this.tokenCache!.expiresAt) {
      const username = this.tokenCache!.username;
      if (this.lastPassword) {
        const result = await this.login(username, this.lastPassword);
        if (!result.success) {
          throw new Error("Token 已过期且重新登录失败，请重新使用 crm_login 登录。");
        }
      } else {
        throw new Error("Token 已过期，请重新使用 crm_login 登录。");
      }
    }

    return this.tokenCache!.accessToken;
  }

  private async authHeaders() {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  // ── SOQL 查询 ─────────────────────────────────────────
  // 路径: GET /rest/data/v2/query?q={SOQL}

  async soqlQuery(soql: string): Promise<unknown> {
    const headers = await this.authHeaders();
    const res = await this.http.get("/rest/data/v2/query", {
      headers,
      params: { q: soql },
    });
    return res.data;
  }

  // ── 获取单条记录 ──────────────────────────────────────
  // 路径: GET /rest/data/v2.0/xobjects/{apiKey}/{id}

  async getRecord(objectApiKey: string, recordId: string, fields?: string[]): Promise<unknown> {
    const headers = await this.authHeaders();
    const params: Record<string, string> = {};
    if (fields?.length) {
      params.fields = fields.join(",");
    }
    const res = await this.http.get(
      `/rest/data/v2.0/xobjects/${objectApiKey}/${recordId}`,
      { headers, params }
    );
    return res.data;
  }

  // ── 创建记录 ──────────────────────────────────────────
  // 路径: POST /rest/data/v2.0/xobjects/{apiKey}

  async createRecord(objectApiKey: string, data: Record<string, unknown>): Promise<unknown> {
    const headers = await this.authHeaders();
    // 自动注入 ownerId（如果未提供且有用户上下文）= 当前登录用户
    if (!data.ownerId && this._userContext?.ownerId) {
      data.ownerId = this._userContext.ownerId;
    }
    // 自动注入 dimDepart（如果未提供且有用户上下文）= 当前登录用户的部门
    if (!data.dimDepart && this._userContext?.dimDepart) {
      data.dimDepart = this._userContext.dimDepart;
    }
    // 自动包裹 itemType=4 字段（标量 → 数组）
    const wrapped = await this.wrapPicklistFields(objectApiKey, data);
    const res = await this.http.post(
      `/rest/data/v2.0/xobjects/${objectApiKey}`,
      { data: wrapped },
      { headers }
    );
    return res.data;
  }

  // ── 更新记录 ──────────────────────────────────────────
  // 路径: PATCH /rest/data/v2.0/xobjects/{apiKey}/{id}

  async updateRecord(objectApiKey: string, recordId: string, data: Record<string, unknown>): Promise<unknown> {
    const headers = await this.authHeaders();
    // 自动包裹 itemType=4 字段（标量 → 数组）
    const wrapped = await this.wrapPicklistFields(objectApiKey, data);
    const res = await this.http.patch(
      `/rest/data/v2.0/xobjects/${objectApiKey}/${recordId}`,
      { data: wrapped },
      { headers }
    );
    return res.data;
  }

  // ── 删除记录 ──────────────────────────────────────────
  // 路径: DELETE /rest/data/v2.0/xobjects/{apiKey}/{id}

  async deleteRecord(objectApiKey: string, recordId: string): Promise<unknown> {
    const headers = await this.authHeaders();
    const res = await this.http.delete(
      `/rest/data/v2.0/xobjects/${objectApiKey}/${recordId}`,
      { headers }
    );
    return res.data;
  }

  // ── 转移负责人 ────────────────────────────────────────

  async transferOwner(objectApiKey: string, recordId: string, newOwnerId: string): Promise<unknown> {
    return this.updateRecord(objectApiKey, recordId, { ownerId: newOwnerId });
  }

  // ── 获取对象元数据 ────────────────────────────────────
  // 路径: GET /rest/metadata/v2.0/xobjects/{apiKey}

  async describeObject(objectApiKey: string): Promise<unknown> {
    const headers = await this.authHeaders();
    const res = await this.http.get(
      `/rest/metadata/v2.0/xobjects/${objectApiKey}`,
      { headers }
    );
    return res.data;
  }

  // ── 获取对象字段列表 ──────────────────────────────────
  // 路径: GET /rest/metadata/v2.0/xobjects/{apiKey}/items

  async describeFields(objectApiKey: string): Promise<unknown> {
    const headers = await this.authHeaders();
    const res = await this.http.get(
      `/rest/metadata/v2.0/xobjects/${objectApiKey}/items`,
      { headers }
    );
    return res.data;
  }

  // ── 获取全部对象列表 ──────────────────────────────────
  // 路径: GET /rest/metadata/v2.0/xobjects

  async listObjects(): Promise<unknown> {
    const headers = await this.authHeaders();
    const res = await this.http.get("/rest/metadata/v2.0/xobjects", { headers });
    return res.data;
  }

  // ── 获取对象的 entityType / dimDepart 默认值 ──────────
  // 从已有记录中取样获取，用于创建新记录时自动填充

  private entityTypeCache: Record<string, { entityType: unknown; dimDepart: unknown }> = {};

  async getObjectDefaults(objectApiKey: string): Promise<{ entityType: unknown; dimDepart: unknown }> {
    if (this.entityTypeCache[objectApiKey]) {
      return this.entityTypeCache[objectApiKey];
    }
    const res: any = await this.soqlQuery(
      `SELECT entityType, dimDepart FROM ${objectApiKey} LIMIT 1`
    );
    const rec = res?.result?.records?.[0];
    if (!rec) {
      throw new Error(`无法获取 ${objectApiKey} 的 entityType，对象中没有已有记录。`);
    }
    this.entityTypeCache[objectApiKey] = {
      entityType: rec.entityType,
      dimDepart: rec.dimDepart,
    };
    return this.entityTypeCache[objectApiKey];
  }

  // ── entityType id→label 枚举 ──────────────────────────

  /**
   * 获取指定对象的 entityType 枚举映射 (id → label)。
   * 通过拉取已有记录的不同 entityType 值，再用 getRecord 带 -label 反查。
   * 结果会被缓存。
   */
  async getEntityTypeMap(objectApiKey: string): Promise<Record<string, string>> {
    if (this.entityTypeLabelCache[objectApiKey]) {
      return this.entityTypeLabelCache[objectApiKey];
    }

    // 拉取最多 200 条记录的 entityType（去重在客户端侧）
    const res: any = await this.soqlQuery(
      `SELECT id, entityType FROM ${objectApiKey} LIMIT 200`
    );
    const records: any[] = res?.result?.records || [];
    const uniqueTypes = new Map<string, string>(); // entityType id → recordId (任一)
    for (const r of records) {
      const etId = String(r.entityType);
      if (etId && !uniqueTypes.has(etId)) {
        uniqueTypes.set(etId, String(r.id));
      }
    }

    const mapping: Record<string, string> = {};
    for (const [etId, recordId] of uniqueTypes) {
      try {
        const detail: any = await this.getRecord(objectApiKey, recordId, ["entityType", "entityType-label"]);
        const label = detail?.data?.record?.["entityType-label"] || detail?.data?.["entityType-label"] || etId;
        mapping[etId] = label;
      } catch {
        mapping[etId] = etId; // fallback
      }
    }

    this.entityTypeLabelCache[objectApiKey] = mapping;
    return mapping;
  }

  // ── itemType=4 字段自动包裹 ───────────────────────────

  /** 获取并缓存对象的字段 itemType 映射 */
  private async getFieldItemTypes(objectApiKey: string): Promise<Record<string, number>> {
    if (this.fieldMetaCache[objectApiKey]) {
      return this.fieldMetaCache[objectApiKey];
    }
    try {
      const res: any = await this.describeFields(objectApiKey);
      const items: any[] = res?.data?.items || res?.items || [];
      const map: Record<string, number> = {};
      for (const f of items) {
        if (f.apiKey && f.itemType !== undefined) {
          map[f.apiKey] = f.itemType;
        }
      }
      this.fieldMetaCache[objectApiKey] = map;
      return map;
    } catch {
      return {};
    }
  }

  /** 对 itemType=4（picklist）字段的标量值自动包裹为数组 */
  private async wrapPicklistFields(
    objectApiKey: string,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const fieldTypes = await this.getFieldItemTypes(objectApiKey);
    const result = { ...data };
    for (const [key, val] of Object.entries(result)) {
      if (fieldTypes[key] === 4 && val !== null && val !== undefined && !Array.isArray(val)) {
        result[key] = [val];
      }
    }
    return result;
  }
}
