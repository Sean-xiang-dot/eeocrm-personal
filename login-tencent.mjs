/**
 * 销售易 tencent 环境登录脚本
 * 解决问题：CLI --host crm-tencent.xiaoshouyi.com 会生成不存在的
 *   connectapps-tencent.xiaoshouyi.com 回调域，本脚本手动指定正确服务器组合：
 *   - 授权页：crm-tencent.xiaoshouyi.com（用户实际 CRM）
 *   - 回调/轮询：connectapps.xiaoshouyi.com（标准，实际存在）
 *   - BFF：crmclaw.xiaoshouyi.com（标准，所有环境共用）
 *
 * 用法：node login-tencent.mjs <clientId>
 */

import crypto from 'crypto';
import axios from 'axios';
import open from 'open';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const CLIENT_ID = process.argv[2];
if (!CLIENT_ID) {
  console.error('用法: node login-tencent.mjs <clientId>');
  process.exit(1);
}

// 手动指定正确的域名组合
const CRM_HOST = 'crm-tencent.xiaoshouyi.com';
const CONNECTAPPS_HOST = 'connectapps.xiaoshouyi.com';
const BFF_ENDPOINT = 'https://crmclaw.xiaoshouyi.com';

const REDIRECT_URI = `https://${CONNECTAPPS_HOST}/neocrm/claw/refer/auth/callback`;
const AUTH_BASE = `https://${CONNECTAPPS_HOST}/neocrm/claw/refer`;
const CREDENTIALS_PATH = path.join(os.homedir(), '.neocrm', 'credentials.json');

// 生成 clawId
const clawId = `neocrm-${crypto.randomBytes(4).toString('hex')}`;
console.log(`[INFO] clawId: ${clawId}`);

// 构建授权 URL（使用 crm-tencent 的授权页 + 标准 connectapps 回调）
const authorizeUrl = new URL(`https://${CRM_HOST}/oauth/oauth2/authorize.action`);
authorizeUrl.searchParams.set('response_type', 'code');
authorizeUrl.searchParams.set('client_id', CLIENT_ID);
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authorizeUrl.searchParams.set('state', `${clawId},${CLIENT_ID}`);
authorizeUrl.searchParams.set('oauthType', 'standard');

console.log(`\n正在打开浏览器，请在销售易页面用自己的账号登录并授权...`);
console.log(`授权 URL: ${authorizeUrl.toString()}\n`);
await open(authorizeUrl.toString());

// 轮询 connectapps.xiaoshouyi.com 等待 token
console.log('等待授权完成（最多 5 分钟）...');
const startTime = Date.now();
const TIMEOUT = 5 * 60 * 1000;
const POLL_INTERVAL = 2000;

let authResult = null;
while (Date.now() - startTime < TIMEOUT) {
  await new Promise(r => setTimeout(r, POLL_INTERVAL));
  try {
    const resp = await axios.get(`${AUTH_BASE}/token/query`, { params: { clawId } });
    if (resp.data?.accessToken) {
      authResult = resp.data;
      break;
    }
  } catch {
    // 继续轮询
  }
  process.stdout.write('.');
}

if (!authResult) {
  console.error('\n\n超时，未收到授权。请重新运行脚本再试。');
  process.exit(1);
}

console.log('\n\n授权成功！');

// 验证：调用 /user/info 获取 tenantId 等用户信息
let userInfo = {};
try {
  const resp = await axios.get(`${BFF_ENDPOINT}/user/info`, {
    headers: {
      Authorization: `Bearer ${authResult.accessToken}`,
      'X-OpenAPI-BaseUrl': `https://${CRM_HOST}`,
    },
  });
  userInfo = resp.data?.data?.result ?? resp.data?.data ?? {};
} catch (e) {
  console.warn(`验证接口报错: ${e.message}`);
}

// ── 以 neocrm CLI 的 AES-256-GCM 格式加密存储凭证 ──
// 密钥派生与 credential-store.js 完全一致：hostname + username → PBKDF2-SHA512
const ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

function deriveKey(salt) {
  const machineId = `neocrm-cli:${os.hostname()}:${os.userInfo().username}`;
  return crypto.pbkdf2Sync(machineId, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function encryptForCLI(obj) {
  const plaintext = JSON.stringify(obj);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext,
  };
}

const connInfo = {
  accessToken: authResult.accessToken,
  refreshToken: authResult.refreshToken,
  tenantId: String(authResult.tenantId ?? userInfo.tenantId ?? ''),
  clientId: CLIENT_ID,
  baseUrl: `https://${CRM_HOST}`,
  expiresAt: authResult.expiresAt ?? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  status: 'ACTIVE',
  host: CRM_HOST,
  userId: String(userInfo.id ?? ''),
  userName: userInfo.name ?? '',
};

await fs.mkdir(path.join(os.homedir(), '.neocrm'), { recursive: true });
const encrypted = encryptForCLI(connInfo);
await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(encrypted, null, 2), 'utf-8');
console.log(`凭证已保存到 ${CREDENTIALS_PATH}`);

if (userInfo.name) {
  console.log(`\n登录用户: ${userInfo.name}（${userInfo.email}）- ${userInfo.tenantName}`);
} else {
  console.log('\n凭证已保存，可运行 neocrm auth:whoami 验证。');
}
