import { spawn } from "node:child_process";

import { loadClaudeModel, loadClaudeReasoningEffort, loadHistory } from "./state.js";

function splitArgs(value) {
  return String(value || "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^(["'])(.*)\1$/, "$2")
  ) || [];
}

function claudeArgs() {
  const extra = process.env.WECHAT_BRIDGE_CLAUDE_CODE_ARGS?.trim();
  if (extra) return splitArgs(extra);
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--model",
    loadClaudeModel(),
    "--effort",
    loadClaudeReasoningEffort(),
  ];
}

function buildPrompt({ peerId, text }) {
  const history = loadHistory(peerId).slice(-12);
  const historyText = history
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
  return [
    "你是通过个人微信接入的本地 Claude Code 助手。用中文简洁回答，除非用户要求其它语言。",
    "不要提及内部桥接实现，除非用户询问。",
    "如果用户要求执行本机操作，先判断风险；默认只做必要、可解释的操作。",
    "",
    historyText ? `最近对话:\n${historyText}\n` : "",
    `当前用户消息:\n${text}`,
  ].join("\n");
}

function finalResult(stdout) {
  let result = "";
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") result = event.result.trim();
    } catch {
      // Claude emits NDJSON in the default configuration; ignore non-JSON diagnostics.
    }
  }
  return result;
}

export function startClaudeCode({ peerId, text, onOutput } = {}) {
  const provider = "claude-code";
  const timeoutMs = Number.parseInt(
    process.env.WECHAT_BRIDGE_TIMEOUT_MS || process.env.WEIXIN_CODEX_TIMEOUT_MS || "600000",
    10,
  );
  const child = spawn("claude", claudeArgs(), {
    cwd: process.env.WECHAT_BRIDGE_CWD || process.env.WEIXIN_CODEX_CWD || process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  let stopped = false;
  let killTimer;

  const promise = new Promise((resolve, reject) => {
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      stopped = true;
      child.kill("SIGTERM");
      reject(new Error(`${provider} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const textChunk = chunk.toString();
      stdout += textChunk;
      onOutput?.({ stream: "stdout", text: textChunk });
    });
    child.stderr.on("data", (chunk) => {
      const textChunk = chunk.toString();
      stderr += textChunk;
      onOutput?.({ stream: "stderr", text: textChunk });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (stopped) {
        const err = new Error(`${provider} stopped`);
        err.code = "AGENT_STOPPED";
        reject(err);
        return;
      }
      if (code !== 0) {
        reject(new Error(`${provider} exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(finalResult(stdout) || "我这边没有生成可发送的回复。");
    });

    child.stdin.end(buildPrompt({ peerId, text }));
  });

  return {
    provider,
    promise,
    cancel() {
      stopped = true;
      if (!child.killed) child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000);
    },
  };
}
