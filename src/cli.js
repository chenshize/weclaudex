#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline/promises";

import qrcode from "qrcode-terminal";

import { isAgentStoppedError, startAgent } from "./codex.js";
import { startClaudeCode } from "./claude-code.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  MESSAGE_TYPE,
  extractTextItems,
  fetchQrCode,
  getConfig,
  getUpdates,
  notifyStart,
  pollQrStatus,
  sendImage,
  sendText,
  sendTyping,
} from "./wechat-api.js";
import {
  appendHistory,
  clearHistory,
  listAccountIds,
  listClaudeModels,
  listClaudeReasoningEfforts,
  listCodexModels,
  listCodexReasoningEfforts,
  loadAccount,
  loadAgentProvider,
  loadClaudeModel,
  loadClaudeReasoningEffort,
  loadCodexModel,
  loadCodexReasoningEffort,
  loadSyncBuf,
  saveAccount,
  saveAgentProvider,
  saveClaudeModel,
  saveClaudeReasoningEffort,
  saveCodexModel,
  saveCodexReasoningEffort,
  saveSyncBuf,
  stateDir,
} from "./state.js";

function usage() {
  console.log(`Usage:
  npm run login
  npm run run
  node src/cli.js doctor
  node src/cli.js send-image /absolute/path/to/image.png

Environment:
  WECHAT_BRIDGE_STATE_DIR      State directory, default ~/.wechat-agent-bridge
  WECHAT_BRIDGE_ACCOUNT_ID     Account id to run, default latest login
  WECHAT_BRIDGE_ALLOW_FROM     Comma-separated allowed WeChat user ids
  WECHAT_BRIDGE_ALLOW_ALL      Set 1 to process messages from any user
  WECHAT_BRIDGE_CWD            Agent working directory, default current directory
  WECHAT_BRIDGE_DEFAULT_AGENT  Initial backend: codex or claude-code
  WECHAT_BRIDGE_CODEX_ARGS     Full custom Codex args
  WECHAT_BRIDGE_CLAUDE_CODE_ARGS Full custom Claude Code args

WeChat commands:
  /codex                  Switch to Codex
  /claude-code            Switch to Claude Code
  /model                  Show current and available Codex models
  /model <name>           Switch Codex model, e.g. /model gpt-5.6-sol
  /think                  Show current and available reasoning levels
  /think <level>          Switch reasoning level: low, medium, high, xhigh
  /help                   Show Weixin bridge commands
  /new                    Start a new topic and clear local chat context
  /reset                  Alias for /new
  /stop                   Stop the current running task
  /status                 Show current backend
`);
}

function localTokenList() {
  return listAccountIds()
    .map((id) => loadAccount(id)?.token)
    .filter((token) => typeof token === "string" && token.trim())
    .slice(-10)
    .reverse();
}

async function promptLine(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function login() {
  console.log(`[wechat-bridge] state dir: ${stateDir()}`);
  console.log("[wechat-bridge] requesting QR code...");
  const qr = await fetchQrCode({
    botType: process.env.WECHAT_BRIDGE_BOT_TYPE || process.env.WEIXIN_CODEX_BOT_TYPE || DEFAULT_BOT_TYPE,
    localTokenList: localTokenList(),
  });
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error(`QR response missing fields: ${JSON.stringify(qr)}`);
  }

  console.log("\nUse Weixin to scan this QR code:\n");
  qrcode.generate(qr.qrcode_img_content, { small: true });
  console.log(`\nFallback URL:\n${qr.qrcode_img_content}\n`);

  let currentBaseUrl = DEFAULT_BASE_URL;
  let pendingVerifyCode = "";
  const deadline = Date.now() + Number.parseInt(
    process.env.WECHAT_BRIDGE_LOGIN_TIMEOUT_MS || process.env.WEIXIN_CODEX_LOGIN_TIMEOUT_MS || "480000",
    10,
  );

  while (Date.now() < deadline) {
    const status = await pollQrStatus({
      qrcode: qr.qrcode,
      verifyCode: pendingVerifyCode,
      baseUrl: currentBaseUrl,
    });

    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (pendingVerifyCode) pendingVerifyCode = "";
        process.stdout.write("\nScanned. Waiting for confirmation...\n");
        break;
      case "need_verifycode":
        pendingVerifyCode = await promptLine("\nEnter the number shown in Weixin: ");
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          currentBaseUrl = `https://${status.redirect_host}`;
          process.stdout.write(`\nRedirected to ${currentBaseUrl}\n`);
        }
        break;
      case "binded_redirect":
        console.log("\nAlready connected. Existing local credentials should still work.");
        return;
      case "expired":
        throw new Error("QR code expired. Re-run login.");
      case "verify_code_blocked":
        throw new Error("Verify code blocked after repeated failures. Try again later.");
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error(`confirmed response missing account/token: ${JSON.stringify(status)}`);
        }
        const account = saveAccount({
          accountId: status.ilink_bot_id,
          token: status.bot_token,
          baseUrl: status.baseurl || currentBaseUrl || DEFAULT_BASE_URL,
          userId: status.ilink_user_id || "",
        });
        console.log(`\nConnected. Account saved: ${account.accountId}`);
        if (account.userId) console.log(`Allowed user id: ${account.userId}`);
        return;
      }
      default:
        process.stdout.write(`\nUnhandled status: ${JSON.stringify(status)}\n`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Login timed out.");
}

function allowedSender(account, fromUserId) {
  if ((process.env.WECHAT_BRIDGE_ALLOW_ALL || process.env.WEIXIN_CODEX_ALLOW_ALL) === "1") return true;
  const configured = (process.env.WECHAT_BRIDGE_ALLOW_FROM || process.env.WEIXIN_CODEX_ALLOW_FROM || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = new Set(configured);
  if (account.userId) allow.add(account.userId);
  return allow.has(fromUserId);
}

function normalizeReplyText(text) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s+/gm, "- ")
    .trim();
}

function splitReplyText(text, maxLen = 1200) {
  const normalized = normalizeReplyText(text);
  if (normalized.length <= maxLen) return [normalized || "我这边没有生成可发送的回复。"];

  const chunks = [];
  let current = "";
  for (const para of normalized.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= maxLen) {
      current = para;
      continue;
    }
    for (let i = 0; i < para.length; i += maxLen) {
      chunks.push(para.slice(i, i + maxLen));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

function compactProgressText(text, maxLen = 360) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function progressIcon(name) {
  const normalized = String(name || "").toLowerCase();
  if (normalized.includes("web_search") || normalized.includes("websearch") || normalized.includes("search")) return "🔎";
  if (normalized.includes("webfetch") || normalized.includes("curl") || normalized.includes("http")) return "🌐";
  if (
    normalized.includes("read") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("ls") ||
    normalized.includes("cat") ||
    normalized.includes("sed") ||
    normalized.includes("find")
  ) return "📖";
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) return "🛠️";
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("shell")) return "💻";
  return "⚙️";
}

function formatProgress(name) {
  const label = compactProgressText(name || "tool");
  return `${progressIcon(label)} 正在执行：${label}\n请稍等…`;
}

function codexProgressFromEvent(event) {
  const item = event.item;
  if (!item || typeof item !== "object") return "";
  const itemType = item.type || "";
  if (event.type === "item.started") {
    if (itemType === "command_execution") {
      return formatProgress(item.command || item.cmd || "command");
    }
    if (itemType === "tool_call") {
      return formatProgress(item.name || item.tool_name || "tool");
    }
    if (itemType && itemType !== "agent_message") {
      return formatProgress(itemType);
    }
  }
  return "";
}

function claudeProgressFromEvent(event) {
  if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
    const tool = event.message.content.find((item) => item?.type === "tool_use");
    if (tool) return formatProgress(tool.name || "tool");
  }
  if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
    return formatProgress(event.content_block.name || "tool");
  }
  return "";
}

function createProgressRelay({ baseUrl, token, to, contextToken, runId, markOutput }) {
  let stdoutBuffer = "";
  let pending = [];
  let flushTimer;
  let lastSentAt = 0;
  const minIntervalMs = Number.parseInt(
    process.env.WECHAT_BRIDGE_STREAM_PROGRESS_MIN_INTERVAL_MS || process.env.WEIXIN_CODEX_STREAM_PROGRESS_MIN_INTERVAL_MS || "5000",
    10,
  );
  const maxItems = Number.parseInt(
    process.env.WECHAT_BRIDGE_STREAM_PROGRESS_MAX_ITEMS || process.env.WEIXIN_CODEX_STREAM_PROGRESS_MAX_ITEMS || "3",
    10,
  );

  function progressFromLine(line) {
    try {
      const event = JSON.parse(line);
      return codexProgressFromEvent(event) || claudeProgressFromEvent(event);
    } catch {
      return "";
    }
  }

  function flush() {
    flushTimer = undefined;
    if (!pending.length) return;
    const now = Date.now();
    if (now - lastSentAt < minIntervalMs) {
      flushTimer = setTimeout(flush, minIntervalMs - (now - lastSentAt));
      return;
    }
    const unique = [];
    for (const item of pending) {
      if (item && !unique.includes(item)) unique.push(item);
    }
    pending = [];
    if (!unique.length) return;
    lastSentAt = now;
    const selected = unique.slice(-maxItems);
    sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: selected.join("\n"),
    }).catch((err) => console.warn(`[wechat-bridge] stream progress send failed: ${String(err)}`));
  }

  return function onOutput({ stream, text }) {
    markOutput?.();
    if (stream !== "stdout" || !text) return;
    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const message = progressFromLine(line.trim());
      if (message) pending.push(message);
    }
    if (pending.length && !flushTimer) flushTimer = setTimeout(flush, 0);
  };
}

async function sendReplyChunks({ baseUrl, token, to, contextToken, runId, text }) {
  const chunks = splitReplyText(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : "";
    const result = await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: `${prefix}${chunks[i]}`,
    });
    console.log(`[wechat-bridge] sent reply chunk ${i + 1}/${chunks.length} to=${to} messageId=${result.clientId}`);
  }
}

function isStopCommand(text) {
  return text.trim().toLowerCase() === "/stop";
}

function isNewTopicCommand(text) {
  const command = text.trim().toLowerCase();
  return command === "/new" || command === "/reset";
}

function parseModelCommand(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/models?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] || "").trim();
}

function parseReasoningCommand(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:think|reasoning)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return (match[1] || "").trim().toLowerCase();
}

function formatElapsed(ms) {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

async function handleSlashCommand({ baseUrl, token, to, contextToken, runId, text }) {
  const command = text.trim().toLowerCase();
  if (command === "/help") {
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: [
        "微信桥指令：",
        "/codex 切换到 Codex",
        "/claude-code 切换到 Claude Code",
        "/status 查看后端、模型、思考级别和权限",
        "/model 查看可选模型",
        "/model gpt-5.6-sol 切换模型",
        "/think 查看可选思考级别",
        "/think high 切换思考级别",
        "/new 开启新话题并清空上下文",
        "/reset 等同于 /new",
        "/stop 停止当前任务",
      ].join("\n"),
    });
    return true;
  }
  if (command === "/status") {
    const provider = loadAgentProvider();
    const model = provider === "codex" ? loadCodexModel() : loadClaudeModel();
    const reasoningEffort = provider === "codex" ? loadCodexReasoningEffort() : loadClaudeReasoningEffort();
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: `当前后端：${provider === "codex" ? "Codex" : "Claude Code"}\n当前模型：${model}\n思考级别：${reasoningEffort}\n当前权限：完全权限`,
    });
    return true;
  }
  if (command === "/codex" || command === "/claude-code") {
    const provider = command.slice(1);
    saveAgentProvider(provider);
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: provider === "codex" ? "已切换到 Codex。" : "已切换到 Claude Code。",
    });
    console.log(`[wechat-bridge] agent switched to ${provider} by ${to}`);
    return true;
  }
  const modelCommand = parseModelCommand(text);
  if (modelCommand !== null) {
    const provider = loadAgentProvider();
    const isCodex = provider === "codex";
    const current = isCodex ? loadCodexModel() : loadClaudeModel();
    const available = isCodex ? listCodexModels() : listClaudeModels();
    if (!modelCommand) {
      await sendText({
        baseUrl,
        token,
        to,
        contextToken,
        runId,
        text: `当前模型：${current}\n可选模型：${available.join("、")}\n切换示例：/model ${available[0] || current}`,
      });
      return true;
    }
    if (isCodex && !available.includes(modelCommand)) {
      await sendText({
        baseUrl,
        token,
        to,
        contextToken,
        runId,
        text: `不支持的模型：${modelCommand}\n可选模型：${available.join("、")}`,
      });
      return true;
    }
    if (isCodex) saveCodexModel(modelCommand);
    else saveClaudeModel(modelCommand);
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: `已切换${isCodex ? " Codex" : " Claude Code"} 模型：${modelCommand}`,
    });
    console.log(`[wechat-bridge] ${provider} model switched to ${modelCommand} by ${to}`);
    return true;
  }
  const reasoningCommand = parseReasoningCommand(text);
  if (reasoningCommand !== null) {
    const provider = loadAgentProvider();
    const isCodex = provider === "codex";
    const current = isCodex ? loadCodexReasoningEffort() : loadClaudeReasoningEffort();
    const available = isCodex ? listCodexReasoningEfforts() : listClaudeReasoningEfforts();
    if (!reasoningCommand) {
      await sendText({
        baseUrl,
        token,
        to,
        contextToken,
        runId,
        text: `当前思考级别：${current}\n可选级别：${available.join("、")}\n切换示例：/think high`,
      });
      return true;
    }
    if (!available.includes(reasoningCommand)) {
      await sendText({
        baseUrl,
        token,
        to,
        contextToken,
        runId,
        text: `不支持的思考级别：${reasoningCommand}\n可选级别：${available.join("、")}`,
      });
      return true;
    }
    if (isCodex) saveCodexReasoningEffort(reasoningCommand);
    else saveClaudeReasoningEffort(reasoningCommand);
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: `已切换${isCodex ? " Codex" : " Claude Code"} 思考级别：${reasoningCommand}`,
    });
    console.log(`[wechat-bridge] ${provider} reasoning effort switched to ${reasoningCommand} by ${to}`);
    return true;
  }
  if (command === "/new" || command === "/reset") {
    clearHistory(to);
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: "已开启新话题。",
    });
    console.log(`[wechat-bridge] cleared history for ${to}`);
    return true;
  }
  if (command === "/stop") {
    await sendText({
      baseUrl,
      token,
      to,
      contextToken,
      runId,
      text: "当前没有正在进行中的任务。",
    });
    return true;
  }
  return false;
}

async function startUserFeedback({ baseUrl, token, to, contextToken }) {
  let typingTicket = "";
  try {
    const cfg = await getConfig({ baseUrl, token, to, contextToken });
    typingTicket = cfg.typing_ticket || "";
    await sendTyping({ baseUrl, token, to, typingTicket, status: 1 });
    if (typingTicket) console.log(`[wechat-bridge] typing started to=${to}`);
  } catch (err) {
    console.warn(`[wechat-bridge] typing start failed: ${String(err)}`);
  }

  let progressSent = false;
  const progressText = (process.env.WECHAT_BRIDGE_PROGRESS_TEXT || process.env.WEIXIN_CODEX_PROGRESS_TEXT || "").trim();
  const delayMs = Number.parseInt(
    process.env.WECHAT_BRIDGE_PROGRESS_DELAY_MS || process.env.WEIXIN_CODEX_PROGRESS_DELAY_MS || "2500",
    10,
  );
  const typingHeartbeatMs = Number.parseInt(
    process.env.WECHAT_BRIDGE_TYPING_HEARTBEAT_MS || process.env.WEIXIN_CODEX_TYPING_HEARTBEAT_MS || "15000",
    10,
  );
  const timer = progressText
    ? setTimeout(() => {
        sendText({ baseUrl, token, to, contextToken, text: progressText })
          .then((result) => {
            progressSent = true;
            console.log(`[wechat-bridge] sent progress to=${to} messageId=${result.clientId}`);
          })
          .catch((err) => console.warn(`[wechat-bridge] progress send failed: ${String(err)}`));
      }, delayMs)
    : undefined;
  const heartbeat = typingTicket && typingHeartbeatMs > 0
    ? setInterval(() => {
        sendTyping({ baseUrl, token, to, typingTicket, status: 1 })
          .then(() => console.log(`[wechat-bridge] typing heartbeat to=${to}`))
          .catch((err) => console.warn(`[wechat-bridge] typing heartbeat failed: ${String(err)}`));
      }, typingHeartbeatMs)
    : undefined;

  return async function stopUserFeedback() {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    try {
      await sendTyping({ baseUrl, token, to, typingTicket, status: 2 });
      if (typingTicket) console.log(`[wechat-bridge] typing stopped to=${to}`);
    } catch (err) {
      console.warn(`[wechat-bridge] typing stop failed: ${String(err)}`);
    }
    return { progressSent };
  };
}

async function run() {
  const account = loadAccount(process.env.WECHAT_BRIDGE_ACCOUNT_ID || process.env.WEIXIN_CODEX_ACCOUNT_ID);
  if (!account?.token) {
    throw new Error("No Weixin account found. Run `npm run login` first.");
  }
  const baseUrl = account.baseUrl || DEFAULT_BASE_URL;
  let syncBuf = loadSyncBuf(account.accountId);
  console.log(`[wechat-bridge] running account=${account.accountId} baseUrl=${baseUrl}`);
  console.log(`[wechat-bridge] state dir: ${stateDir()}`);
  const activeTasks = new Map();

  try {
    await notifyStart({ baseUrl, token: account.token });
  } catch (err) {
    console.warn(`[wechat-bridge] notifystart failed, continuing: ${String(err)}`);
  }

  while (true) {
    const resp = await getUpdates({ baseUrl, token: account.token, getUpdatesBuf: syncBuf });
    if (resp.ret && resp.ret !== 0) {
      console.error(`[wechat-bridge] getUpdates ret=${resp.ret} errcode=${resp.errcode || ""} errmsg=${resp.errmsg || ""}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (resp.get_updates_buf) {
      syncBuf = resp.get_updates_buf;
      saveSyncBuf(account.accountId, syncBuf);
    }

    for (const msg of resp.msgs || []) {
      if (msg.message_type !== MESSAGE_TYPE.USER) continue;
      const from = msg.from_user_id || "";
      if (!from || !allowedSender(account, from)) {
        console.log(`[wechat-bridge] ignored unauthorized sender=${from}`);
        continue;
      }
      const text = extractTextItems(msg).join("\n").trim();
      if (!text) {
        await sendText({
          baseUrl,
          token: account.token,
          to: from,
          contextToken: msg.context_token,
          runId: msg.run_id,
          text: "我现在第一版只支持文本消息。图片、文件和语音后续再接。",
        });
        continue;
      }

      const activeTask = activeTasks.get(from);
      if (activeTask) {
        if (isStopCommand(text)) {
          activeTask.stopRequested = true;
          activeTask.cancel();
          await sendText({
            baseUrl,
            token: account.token,
            to: from,
            contextToken: msg.context_token,
            runId: msg.run_id,
            text: "已停止当前任务。",
          });
          console.log(`[wechat-bridge] stop requested for ${from}`);
        } else if (isNewTopicCommand(text)) {
          activeTask.stopRequested = true;
          activeTask.cancel();
          clearHistory(from);
          await sendText({
            baseUrl,
            token: account.token,
            to: from,
            contextToken: msg.context_token,
            runId: msg.run_id,
            text: "已中止当前任务并开启新话题。",
          });
          console.log(`[wechat-bridge] new topic requested during active task for ${from}`);
        } else {
          await sendText({
            baseUrl,
            token: account.token,
            to: from,
            contextToken: msg.context_token,
            runId: msg.run_id,
            text: "当前有任务正在进行中，请稍后再发送新消息，或发送 /stop 或 /new 中止当前任务",
          });
          console.log(`[wechat-bridge] busy reply to=${from}`);
        }
        continue;
      }

      if (await handleSlashCommand({
        baseUrl,
        token: account.token,
        to: from,
        contextToken: msg.context_token,
        runId: msg.run_id,
        text,
      })) {
        continue;
      }

      const effectiveText = text;
      console.log(`[wechat-bridge] inbound from=${from}: ${effectiveText.slice(0, 120)}`);
      const provider = loadAgentProvider();
      console.log(`[wechat-bridge] using provider=${provider} permissions=full`);
      const stopFeedback = await startUserFeedback({
        baseUrl,
        token: account.token,
        to: from,
        contextToken: msg.context_token,
      });

      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      const progressMs = Number.parseInt(
        process.env.WECHAT_BRIDGE_PROGRESS_INTERVAL_MS || process.env.WEIXIN_CODEX_PROGRESS_INTERVAL_MS || "45000",
        10,
      );
      const progressTimer = progressMs > 0
        ? setInterval(() => {
            const elapsed = formatElapsed(Date.now() - startedAt);
            const idle = formatElapsed(Date.now() - lastOutputAt);
            sendText({
              baseUrl,
              token: account.token,
              to: from,
              contextToken: msg.context_token,
              runId: msg.run_id,
              text: `任务进行中，已运行 ${elapsed}。最近 ${idle} 内有执行活动。发送 /stop 可以结束当前任务。`,
            }).catch((err) => console.warn(`[wechat-bridge] progress send failed: ${String(err)}`));
          }, progressMs)
        : undefined;
      const onOutput = createProgressRelay({
        baseUrl,
        token: account.token,
        to: from,
        contextToken: msg.context_token,
        runId: msg.run_id,
        markOutput: () => {
          lastOutputAt = Date.now();
        },
      });
      const agentTask = (provider === "claude-code" ? startClaudeCode : startAgent)({
        peerId: from,
        text: effectiveText,
        onOutput,
      });
      const taskState = {
        cancel: agentTask.cancel,
        stopRequested: false,
      };
      activeTasks.set(from, taskState);
      agentTask.promise
        .then(async (reply) => {
          await sendReplyChunks({
            baseUrl,
            token: account.token,
            to: from,
            contextToken: msg.context_token,
            runId: msg.run_id,
            text: reply,
          });
          appendHistory(from, effectiveText, reply);
        })
        .catch(async (err) => {
          if (isAgentStoppedError(err) || taskState.stopRequested) {
            console.log(`[wechat-bridge] task stopped for ${from}`);
            return;
          }
          console.error(`[wechat-bridge] agent failed: ${String(err)}`);
          await sendReplyChunks({
            baseUrl,
            token: account.token,
            to: from,
            contextToken: msg.context_token,
            runId: msg.run_id,
            text: `agent 调用失败：${String(err).slice(0, 800)}`,
          });
        })
        .finally(async () => {
          if (progressTimer) clearInterval(progressTimer);
          activeTasks.delete(from);
          await stopFeedback();
        });
    }
  }
}

async function doctor() {
  console.log(`stateDir=${stateDir()}`);
  console.log(`accounts=${JSON.stringify(listAccountIds())}`);
  const account = loadAccount(process.env.WECHAT_BRIDGE_ACCOUNT_ID || process.env.WEIXIN_CODEX_ACCOUNT_ID);
  if (account) {
    console.log(`selectedAccount=${account.accountId}`);
    console.log(`baseUrl=${account.baseUrl || DEFAULT_BASE_URL}`);
    console.log(`hasToken=${Boolean(account.token)}`);
    console.log(`loginUserId=${account.userId || ""}`);
  } else {
    console.log("selectedAccount=<none>");
  }
}

async function sendImageCommand(filePath) {
  if (!filePath) throw new Error("send-image requires an image path");
  const account = loadAccount(process.env.WECHAT_BRIDGE_ACCOUNT_ID || process.env.WEIXIN_CODEX_ACCOUNT_ID);
  if (!account?.token) throw new Error("No Weixin account found. Run `npm run login` first.");
  const to = process.env.WECHAT_BRIDGE_TO || process.env.WEIXIN_CODEX_TO || account.userId;
  if (!to) throw new Error("No recipient. Set WECHAT_BRIDGE_TO or login again to capture userId.");
  const baseUrl = account.baseUrl || DEFAULT_BASE_URL;
  const result = await sendImage({
    baseUrl,
    token: account.token,
    to,
    filePath,
    text: process.env.WECHAT_BRIDGE_IMAGE_TEXT || process.env.WEIXIN_CODEX_IMAGE_TEXT || "",
  });
  console.log(`sent image to=${to} messageId=${result.clientId}`);
}

const command = process.argv[2];
try {
  if (command === "login") await login();
  else if (command === "run") await run();
  else if (command === "doctor") await doctor();
  else if (command === "send-image") await sendImageCommand(process.argv[3]);
  else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`[wechat-bridge] ${err?.stack || err}`);
  process.exit(1);
}
