import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadCodexModel, loadCodexReasoningEffort, loadHistory } from "./state.js";

function codexArgs(outputFile) {
  const extra = process.env.WEIXIN_CODEX_ARGS?.trim();
  if (extra) return extra.split(/\s+/);
  const model = loadCodexModel();
  const reasoningEffort = loadCodexReasoningEffort();
  return [
    "exec",
    "--model",
    model,
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-C",
    process.env.WEIXIN_CODEX_CWD || process.cwd(),
    "--output-last-message",
    outputFile,
    "-",
  ];
}

function buildPrompt({ peerId, text }) {
  const history = loadHistory(peerId).slice(-12);
  const historyText = history
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
  const identity = "你是通过个人微信接入的本地 Codex 助手。用中文简洁回答，除非用户要求其它语言。";

  return [
    identity,
    "不要提及内部桥接实现，除非用户询问。",
    "如果用户要求执行本机操作，先判断风险；默认只做必要、可解释的操作。",
    "",
    historyText ? `最近对话:\n${historyText}\n` : "",
    `当前用户消息:\n${text}`,
  ].join("\n");
}

function codexCommand(outputFile) {
  return { bin: "codex", args: codexArgs(outputFile), stdin: true, outputFile };
}

export function isAgentStoppedError(err) {
  return err?.code === "AGENT_STOPPED";
}

export function startAgent({ peerId, text, onOutput } = {}) {
  const provider = "codex";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-"));
  const outputFile = path.join(tmpDir, "last-message.txt");
  const command = codexCommand(outputFile);
  const prompt = buildPrompt({ peerId, text });
  const timeoutMs = Number.parseInt(process.env.WEIXIN_CODEX_TIMEOUT_MS || "600000", 10);

  const child = spawn(command.bin, command.args, {
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
      const finalText = command.outputFile && fs.existsSync(command.outputFile)
        ? fs.readFileSync(outputFile, "utf8").trim()
        : stdout.trim();
      resolve(finalText || "我这边没有生成可发送的回复。");
    });

    child.stdin.end(prompt);
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

export async function askAgent(args) {
  const task = startAgent(args);
  return await task.promise;
}

export const askCodex = askAgent;
