import crypto from "node:crypto";
import fs from "node:fs/promises";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_BOT_TYPE = "3";
export const MESSAGE_TYPE = { USER: 1, BOT: 2 };
export const MESSAGE_ITEM_TYPE = { TEXT: 1, IMAGE: 2 };
export const UPLOAD_MEDIA_TYPE = { IMAGE: 1 };

const CLIENT_VERSION = buildClientVersion("2.4.6");
const BOT_AGENT = process.env.WEIXIN_CODEX_BOT_AGENT || "CodexWeixinBridge/0.1.0";

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => Number.parseInt(p, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function baseInfo() {
  return {
    channel_version: "2.4.6",
    bot_agent: BOT_AGENT,
  };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function commonHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function apiGet({ baseUrl = DEFAULT_BASE_URL, endpoint, timeoutMs = 15_000 }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  return fetchWithTimeout(url.toString(), { method: "GET", headers: commonHeaders() }, timeoutMs);
}

export async function apiPost({
  baseUrl = DEFAULT_BASE_URL,
  endpoint,
  token,
  body = {},
  timeoutMs = 15_000,
}) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  return fetchWithTimeout(
    url.toString(),
    {
      method: "POST",
      headers: commonHeaders(token),
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

export async function fetchQrCode({ botType = DEFAULT_BOT_TYPE, localTokenList = [] } = {}) {
  return apiPost({
    baseUrl: DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList },
  });
}

export async function pollQrStatus({ qrcode, verifyCode, baseUrl = DEFAULT_BASE_URL }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  return apiGet({ baseUrl, endpoint, timeoutMs: 35_000 });
}

export async function getUpdates({ baseUrl, token, getUpdatesBuf, timeoutMs = 35_000 }) {
  try {
    return await apiPost({
      baseUrl,
      token,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf ?? "", base_info: baseInfo() },
      timeoutMs,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf ?? "" };
    }
    throw err;
  }
}

export async function sendText({ baseUrl, token, to, text, contextToken, runId }) {
  const clientId = `weixin-codex-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE.BOT,
      message_state: 2,
      item_list: text ? [{ type: MESSAGE_ITEM_TYPE.TEXT, text_item: { text } }] : undefined,
      context_token: contextToken || undefined,
      run_id: runId || undefined,
    },
    base_info: baseInfo(),
  };
  const resp = await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendmessage",
    body,
    timeoutMs: 15_000,
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg || ""}`);
  }
  return { clientId };
}

export async function getConfig({ baseUrl, token, to, contextToken }) {
  return apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: to,
      context_token: contextToken || undefined,
      base_info: baseInfo(),
    },
    timeoutMs: 10_000,
  });
}

export async function sendTyping({ baseUrl, token, to, typingTicket, status = 1 }) {
  if (!typingTicket) return;
  await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: to,
      typing_ticket: typingTicket,
      status,
      base_info: baseInfo(),
    },
    timeoutMs: 10_000,
  });
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadBufferToCdn({ buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = uploadFullUrl?.trim() || buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status !== 200) {
        throw new Error(`CDN upload failed ${res.status}: ${res.headers.get("x-error-message") || await res.text()}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param");
      return { downloadParam };
    } catch (err) {
      lastError = err;
      if (attempt === 3) break;
    }
  }
  throw lastError;
}

export async function getUploadUrl({ baseUrl, token, to, filekey, rawsize, rawfilemd5, filesize, aeskey }) {
  return apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/getuploadurl",
    body: {
      filekey,
      media_type: UPLOAD_MEDIA_TYPE.IMAGE,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey,
      base_info: baseInfo(),
    },
    timeoutMs: 15_000,
  });
}

export async function uploadImage({ baseUrl, token, to, filePath, cdnBaseUrl = CDN_BASE_URL }) {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrl = await getUploadUrl({
    baseUrl,
    token,
    to,
    filekey,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });
  const uploadFullUrl = uploadUrl.upload_full_url?.trim();
  const uploadParam = uploadUrl.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getuploadurl returned no upload URL: ${JSON.stringify(uploadUrl)}`);
  }

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl,
    uploadParam,
    filekey,
    cdnBaseUrl,
    aeskey,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

export async function sendImage({ baseUrl, token, to, filePath, text = "", contextToken, runId }) {
  const uploaded = await uploadImage({ baseUrl, token, to, filePath });
  if (text) {
    await sendText({ baseUrl, token, to, text, contextToken, runId });
  }

  const item = {
    type: MESSAGE_ITEM_TYPE.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  const clientId = `weixin-codex-img-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const resp = await apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/sendmessage",
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MESSAGE_TYPE.BOT,
        message_state: 2,
        item_list: [item],
        context_token: contextToken || undefined,
        run_id: runId || undefined,
      },
      base_info: baseInfo(),
    },
    timeoutMs: 15_000,
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`send image ret=${resp.ret} errmsg=${resp.errmsg || ""}`);
  }
  return { clientId };
}

export async function notifyStart({ baseUrl, token }) {
  return apiPost({
    baseUrl,
    token,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: baseInfo() },
    timeoutMs: 10_000,
  });
}

export function extractTextItems(message) {
  return (message?.item_list || [])
    .filter((item) => item?.type === MESSAGE_ITEM_TYPE.TEXT && item?.text_item?.text)
    .map((item) => item.text_item.text);
}
