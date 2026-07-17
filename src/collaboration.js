import { splitCommandArguments } from "./command-parser.js";

const PROVIDER_ALIASES = new Map([
  ["codex", "codex"],
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
]);

export function otherProvider(provider) {
  return provider === "claude-code" ? "codex" : "claude-code";
}

export function collaborationProviderLabel(provider) {
  return provider === "claude-code" ? "Claude Code" : "Codex";
}

function parseTargetAndInstruction(argument, sourceProvider) {
  const args = splitCommandArguments(argument);
  const explicitTarget = PROVIDER_ALIASES.get(String(args[0] || "").toLowerCase());
  if (explicitTarget) args.shift();
  return {
    targetProvider: explicitTarget || otherProvider(sourceProvider),
    instruction: args.join(" ").trim(),
  };
}

export function buildCollaborationTask(command, runtime) {
  if (!command || !["review", "handoff"].includes(command.name)) return null;
  const sourceProvider = runtime?.provider === "claude-code" ? "claude-code" : "codex";
  const { targetProvider, instruction } = parseTargetAndInstruction(command.argument, sourceProvider);
  const sourceLabel = collaborationProviderLabel(sourceProvider);
  const targetLabel = collaborationProviderLabel(targetProvider);

  if (command.name === "review") {
    const focus = instruction || "correctness, security, regressions, missing tests, and maintainability";
    return {
      targetProvider,
      accessMode: "read-only",
      acknowledgement: `已安排 ${targetLabel} 独立复核当前工作区（只读）。`,
      text: [
        "You are the independent reviewer in a deliberate cross-Agent review requested through WeClaudex.",
        `The active work previously used ${sourceLabel}; you are reviewing it with ${targetLabel}.`,
        "Inspect the current worktree directly, including git status, tracked diffs, relevant untracked files, and nearby tests.",
        "This is a read-only review: do not edit files, create commits, or change repository state.",
        `Review focus: ${focus}`,
        "Report actionable findings first, ordered by severity, with precise file paths and reasoning.",
        "Call out test gaps and residual risks. If there are no findings, say so explicitly and summarize what you checked.",
      ].join("\n"),
    };
  }

  const goal = instruction || "Inspect the current workspace state and continue the most evident unfinished implementation safely.";
  return {
    targetProvider,
    accessMode: runtime?.accessMode || "workspace",
    acknowledgement: `已将当前工作区显式交接给 ${targetLabel}。`,
    text: [
      "This is an explicit cross-Agent handoff requested through WeClaudex.",
      `Source Agent: ${sourceLabel}. Target Agent: ${targetLabel}.`,
      "There is intentionally no copied chat transcript. Treat the filesystem and repository as the source of truth.",
      "First inspect git status, current diffs, project instructions, and relevant tests; preserve unrelated user changes.",
      `Handoff goal: ${goal}`,
      "Continue the work in the current workspace, verify changes in proportion to risk, and clearly report the result and any remaining blockers.",
    ].join("\n"),
  };
}
