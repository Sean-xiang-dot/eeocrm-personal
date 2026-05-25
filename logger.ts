import fs from "fs";
import path from "path";

// ── 类型定义 ────────────────────────────────────────────

export interface ToolCallLog {
  /** 调用时间 ISO */
  timestamp: string;
  /** 会话 ID */
  sessionId: string;
  /** 工具名称 */
  toolName: string;
  /** 传入参数 */
  params: Record<string, unknown>;
  /** 是否成功 */
  success: boolean;
  /** 耗时(ms) */
  durationMs: number;
  /** 错误信息（失败时） */
  error?: string;
  /** API 错误码（如果有） */
  apiErrorCode?: number | string;
  /** 结果摘要（成功时，截断到200字） */
  resultSummary?: string;
}

export interface ErrorPattern {
  /** 模式 ID */
  id: string;
  /** 首次出现时间 */
  firstSeen: string;
  /** 最近出现时间 */
  lastSeen: string;
  /** 出现次数 */
  count: number;
  /** 涉及的工具 */
  toolName: string;
  /** 错误特征（用于匹配） */
  errorSignature: string;
  /** 根因分析 */
  rootCause: string;
  /** 正确做法 */
  correctApproach: string;
  /** 分类标签 */
  category: "field-name" | "soql-syntax" | "body-format" | "auth" | "permission" | "api-path" | "data-type" | "other";
}

export interface SessionSummary {
  sessionId: string;
  startTime: string;
  endTime: string;
  /** 用户意图/目标 */
  goal: string;
  /** 总调用次数 */
  totalCalls: number;
  /** 失败次数 */
  errorCalls: number;
  /** 走的弯路描述 */
  detours: string[];
  /** 最终结果 */
  outcome: "success" | "partial" | "failed";
  /** 经验教训 */
  lessons: string[];
}

// ── 日志管理器 ──────────────────────────────────────────

const LOG_DIR = path.join(process.cwd(), "logs");
const KNOWLEDGE_FILE = path.join(process.cwd(), "knowledge", "error-patterns.json");
const SESSIONS_DIR = path.join(LOG_DIR, "sessions");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── 工具调用日志 ────────────────────────────────────────

/** 记录一次工具调用 */
export function logToolCall(entry: ToolCallLog): void {
  ensureDir(SESSIONS_DIR);
  const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(SESSIONS_DIR, `${date}_${entry.sessionId.slice(0, 8)}.jsonl`);
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

/** 读取指定会话的日志 */
export function readSessionLogs(sessionId: string): ToolCallLog[] {
  ensureDir(SESSIONS_DIR);
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.includes(sessionId.slice(0, 8)));
  const logs: ToolCallLog[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as ToolCallLog;
        if (entry.sessionId === sessionId) logs.push(entry);
      } catch { /* skip malformed lines */ }
    }
  }
  return logs;
}

/** 读取最近 N 条错误日志（跨会话） */
export function readRecentErrors(limit = 50): ToolCallLog[] {
  ensureDir(SESSIONS_DIR);
  const files = fs.readdirSync(SESSIONS_DIR).sort().reverse();
  const errors: ToolCallLog[] = [];
  for (const file of files) {
    if (errors.length >= limit) break;
    const content = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as ToolCallLog;
        if (!entry.success) errors.push(entry);
        if (errors.length >= limit) break;
      } catch { /* skip */ }
    }
  }
  return errors;
}

// ── 错误模式知识库 ──────────────────────────────────────

/** 读取所有已知错误模式 */
export function readErrorPatterns(): ErrorPattern[] {
  ensureDir(path.dirname(KNOWLEDGE_FILE));
  if (!fs.existsSync(KNOWLEDGE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

/** 保存错误模式 */
export function saveErrorPatterns(patterns: ErrorPattern[]): void {
  ensureDir(path.dirname(KNOWLEDGE_FILE));
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(patterns, null, 2));
}

/** 添加或更新一条错误模式 */
export function upsertErrorPattern(pattern: Omit<ErrorPattern, "id" | "firstSeen" | "lastSeen" | "count">): ErrorPattern {
  const patterns = readErrorPatterns();
  const existing = patterns.find(p => p.errorSignature === pattern.errorSignature);
  const now = new Date().toISOString();

  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    existing.rootCause = pattern.rootCause;
    existing.correctApproach = pattern.correctApproach;
    saveErrorPatterns(patterns);
    return existing;
  }

  const newPattern: ErrorPattern = {
    id: `ep_${Date.now().toString(36)}`,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    ...pattern,
  };
  patterns.push(newPattern);
  saveErrorPatterns(patterns);
  return newPattern;
}

// ── 会话总结 ────────────────────────────────────────────

const SUMMARIES_FILE = path.join(LOG_DIR, "session-summaries.json");

export function saveSessionSummary(summary: SessionSummary): void {
  ensureDir(LOG_DIR);
  const summaries = readSessionSummaries();
  summaries.push(summary);
  // 只保留最近 100 条
  if (summaries.length > 100) summaries.splice(0, summaries.length - 100);
  fs.writeFileSync(SUMMARIES_FILE, JSON.stringify(summaries, null, 2));
}

export function readSessionSummaries(): SessionSummary[] {
  if (!fs.existsSync(SUMMARIES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUMMARIES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

// ── 自动分析：从最近错误中提取新模式 ────────────────────

export function analyzeRecentErrors(): {
  newPatterns: ErrorPattern[];
  existingMatches: Array<{ error: ToolCallLog; pattern: ErrorPattern }>;
  unmatched: ToolCallLog[];
} {
  const errors = readRecentErrors(100);
  const patterns = readErrorPatterns();
  const newPatterns: ErrorPattern[] = [];
  const existingMatches: Array<{ error: ToolCallLog; pattern: ErrorPattern }> = [];
  const unmatched: ToolCallLog[] = [];

  for (const err of errors) {
    const sig = extractErrorSignature(err);
    const match = patterns.find(p => p.errorSignature === sig);
    if (match) {
      existingMatches.push({ error: err, pattern: match });
    } else {
      unmatched.push(err);
    }
  }

  // 对未匹配的错误按签名分组，出现 >= 2 次的自动标记为待分析
  const sigGroups = new Map<string, ToolCallLog[]>();
  for (const err of unmatched) {
    const sig = extractErrorSignature(err);
    if (!sigGroups.has(sig)) sigGroups.set(sig, []);
    sigGroups.get(sig)!.push(err);
  }

  return { newPatterns, existingMatches, unmatched };
}

/** 从错误日志中提取签名（用于去重和匹配） */
function extractErrorSignature(log: ToolCallLog): string {
  const error = log.error || "";
  // 归一化：去掉具体 ID、时间戳等动态部分
  const normalized = error
    .replace(/\d{10,}/g, "<ID>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, "<TIME>")
    .replace(/'[^']+'/g, "'<VAL>'")
    .trim();
  return `${log.toolName}::${normalized}`.slice(0, 200);
}
