import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function stateDir() {
  const legacyDir = path.join(os.homedir(), ".weixin-codex-bridge");
  return process.env.WECHAT_BRIDGE_STATE_DIR?.trim() ||
    process.env.WEIXIN_CODEX_STATE_DIR?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    (fs.existsSync(legacyDir) ? legacyDir : path.join(os.homedir(), ".wechat-agent-bridge"));
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

export const AGENT_PROVIDERS = ["codex", "claude-code"];

export function loadAgentProvider() {
  const configured = loadSettings().agentProvider;
  const fallback = process.env.WECHAT_BRIDGE_DEFAULT_AGENT?.trim().toLowerCase() || "codex";
  return AGENT_PROVIDERS.includes(configured) ? configured :
    AGENT_PROVIDERS.includes(fallback) ? fallback : "codex";
}

export function saveAgentProvider(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (!AGENT_PROVIDERS.includes(normalized)) {
    throw new Error(`unsupported agent provider: ${normalized || "<empty>"}`);
  }
  return saveSettings({ agentProvider: normalized });
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
  return process.env.WECHAT_BRIDGE_CODEX_DEFAULT_MODEL?.trim() ||
    process.env.WEIXIN_CODEX_DEFAULT_MODEL?.trim() ||
    listCodexModels()[0] ||
    "gpt-5.5";
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

function loadClaudeSettings() {
  const userSettings = readJson(path.join(os.homedir(), ".claude", "settings.json"), {});
  const localSettings = readJson(path.join(os.homedir(), ".claude", "settings.local.json"), {});
  return { ...userSettings, ...localSettings };
}

export function listClaudeModels() {
  const models = new Set(["sonnet", "opus", "haiku"]);
  const configured = loadClaudeSettings().model;
  if (typeof configured === "string" && configured.trim()) models.add(configured.trim());
  try {
    const help = execFileSync("claude", ["--help"], { encoding: "utf8", timeout: 5000 });
    const modelHelp = help.match(/--model <model>[\s\S]*?(?=\n\s{2}--|\nCommands:|$)/)?.[0] || "";
    for (const match of modelHelp.matchAll(/'([^']+)'/g)) {
      if (/^[a-z0-9._:[\]-]+$/i.test(match[1])) models.add(match[1]);
    }
  } catch {
    // Fall back to stable aliases when Claude is unavailable or help changes.
  }
  return [...models];
}

export function loadClaudeModel() {
  const configured = loadSettings().claudeModel;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const environmentModel = process.env.WECHAT_BRIDGE_CLAUDE_CODE_MODEL?.trim();
  if (environmentModel) return environmentModel;
  const settingsModel = loadClaudeSettings().model;
  return typeof settingsModel === "string" && settingsModel.trim() ? settingsModel.trim() : "sonnet";
}

export function saveClaudeModel(model) {
  const normalized = String(model || "").trim();
  if (!normalized) throw new Error("Claude Code model cannot be empty");
  return saveSettings({ claudeModel: normalized });
}

export function listClaudeReasoningEfforts() {
  return ["low", "medium", "high", "xhigh", "max"];
}

export function loadClaudeReasoningEffort() {
  const configured = loadSettings().claudeReasoningEffort;
  const available = listClaudeReasoningEfforts();
  if (typeof configured === "string" && available.includes(configured.trim())) return configured.trim();
  const environmentEffort = process.env.WECHAT_BRIDGE_CLAUDE_CODE_EFFORT?.trim().toLowerCase();
  return available.includes(environmentEffort) ? environmentEffort : "high";
}

export function saveClaudeReasoningEffort(effort) {
  const normalized = String(effort || "").trim().toLowerCase();
  const available = listClaudeReasoningEfforts();
  if (!available.includes(normalized)) {
    throw new Error(`unsupported Claude Code effort: ${normalized || "<empty>"}`);
  }
  return saveSettings({ claudeReasoningEffort: normalized });
}
