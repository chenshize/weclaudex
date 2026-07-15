import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir() {
  return process.env.WEIXIN_CODEX_STATE_DIR?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".weixin-codex-bridge");
}

export function accountsDir() {
  return path.join(stateDir(), "accounts");
}

export function accountIndexPath() {
  return path.join(stateDir(), "accounts.json");
}

export function accountPath(accountId) {
  return path.join(accountsDir(), `${accountId}.json`);
}

export function syncPath(accountId) {
  return path.join(accountsDir(), `${accountId}.sync.json`);
}

export function historyPath(peerId) {
  const safe = peerId.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  return path.join(stateDir(), "history", `${safe}.json`);
}

export function settingsPath() {
  return path.join(stateDir(), "settings.json");
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort; chmod is not critical on all filesystems.
  }
}

export function listAccountIds() {
  const parsed = readJson(accountIndexPath(), []);
  return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id.trim()) : [];
}

export function saveAccount(account) {
  if (!account?.accountId) throw new Error("accountId is required");
  const existing = readJson(accountPath(account.accountId), {});
  const saved = {
    ...existing,
    ...account,
    savedAt: new Date().toISOString(),
  };
  writeJson(accountPath(account.accountId), saved);

  const ids = listAccountIds();
  if (!ids.includes(account.accountId)) {
    writeJson(accountIndexPath(), [...ids, account.accountId]);
  }
  return saved;
}

export function loadAccount(accountId) {
  const ids = listAccountIds();
  const selected = accountId || ids.at(-1);
  if (!selected) return null;
  const account = readJson(accountPath(selected), null);
  return account ? { ...account, accountId: selected } : null;
}

export function loadSyncBuf(accountId) {
  const data = readJson(syncPath(accountId), {});
  return typeof data?.get_updates_buf === "string" ? data.get_updates_buf : "";
}

export function saveSyncBuf(accountId, getUpdatesBuf) {
  writeJson(syncPath(accountId), { get_updates_buf: getUpdatesBuf ?? "" });
}

export function loadHistory(peerId) {
  const data = readJson(historyPath(peerId), []);
  return Array.isArray(data) ? data : [];
}

export function appendHistory(peerId, userText, assistantText, maxTurns = 12) {
  const history = loadHistory(peerId);
  history.push({ role: "user", content: userText, at: new Date().toISOString() });
  history.push({ role: "assistant", content: assistantText, at: new Date().toISOString() });
  writeJson(historyPath(peerId), history.slice(-maxTurns * 2));
}

export function clearHistory(peerId) {
  const filePath = historyPath(peerId);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best effort; a missing or locked history file should not break chat commands.
  }
}

export function loadSettings() {
  return readJson(settingsPath(), {});
}

export function saveSettings(update) {
  const next = { ...loadSettings(), ...update, updatedAt: new Date().toISOString() };
  writeJson(settingsPath(), next);
  return next;
}

export function listCodexModels() {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  const data = readJson(cachePath, {});
  const slugs = Array.isArray(data?.models)
    ? data.models
        .map((model) => model?.slug)
        .filter((slug) => typeof slug === "string" && slug.trim() && !slug.includes("auto-review"))
    : [];
  return slugs.length ? slugs : ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
}

function loadCodexModelCatalog() {
  const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
  const data = readJson(cachePath, {});
  return Array.isArray(data?.models) ? data.models : [];
}

export function defaultCodexModel() {
  return process.env.WEIXIN_CODEX_DEFAULT_MODEL?.trim() || listCodexModels()[0] || "gpt-5.5";
}

export function loadCodexModel() {
  const configured = loadSettings().codexModel;
  return typeof configured === "string" && configured.trim() ? configured.trim() : defaultCodexModel();
}

export function saveCodexModel(model) {
  const normalized = String(model || "").trim();
  const available = listCodexModels();
  if (!available.includes(normalized)) {
    throw new Error(`unsupported Codex model: ${normalized || "<empty>"}`);
  }
  return saveSettings({ codexModel: normalized });
}

export function listCodexReasoningEfforts(model = loadCodexModel()) {
  const found = loadCodexModelCatalog().find((item) => item?.slug === model);
  const efforts = Array.isArray(found?.supported_reasoning_levels)
    ? found.supported_reasoning_levels
        .map((level) => level?.effort)
        .filter((effort) => typeof effort === "string" && effort.trim())
    : [];
  return efforts.length ? efforts : ["low", "medium", "high", "xhigh"];
}

export function defaultCodexReasoningEffort(model = loadCodexModel()) {
  const found = loadCodexModelCatalog().find((item) => item?.slug === model);
  return typeof found?.default_reasoning_level === "string" && found.default_reasoning_level.trim()
    ? found.default_reasoning_level.trim()
    : "medium";
}

export function loadCodexReasoningEffort() {
  const model = loadCodexModel();
  const configured = loadSettings().codexReasoningEffort;
  const available = listCodexReasoningEfforts(model);
  if (typeof configured === "string" && available.includes(configured.trim())) {
    return configured.trim();
  }
  return defaultCodexReasoningEffort(model);
}

export function saveCodexReasoningEffort(effort) {
  const normalized = String(effort || "").trim().toLowerCase();
  const available = listCodexReasoningEfforts();
  if (!available.includes(normalized)) {
    throw new Error(`unsupported Codex reasoning effort: ${normalized || "<empty>"}`);
  }
  return saveSettings({ codexReasoningEffort: normalized });
}
