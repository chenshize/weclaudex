import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollaborationTask,
  collaborationProviderLabel,
  otherProvider,
} from "../src/collaboration.js";

test("cross-Agent helpers choose the other native provider", () => {
  assert.equal(otherProvider("codex"), "claude-code");
  assert.equal(otherProvider("claude-code"), "codex");
  assert.equal(collaborationProviderLabel("claude-code"), "Claude Code");
});

test("review is read-only, independently focused, and does not request edits", () => {
  const task = buildCollaborationTask(
    { name: "review", argument: "claude-code security and regressions" },
    { provider: "codex", accessMode: "full" },
  );
  assert.equal(task.targetProvider, "claude-code");
  assert.equal(task.accessMode, "read-only");
  assert.match(task.text, /read-only review: do not edit files/i);
  assert.match(task.text, /security and regressions/);
  assert.doesNotMatch(task.text, /chat transcript.*source of truth/i);
});

test("handoff defaults to the other provider and preserves the chosen access boundary", () => {
  const task = buildCollaborationTask(
    { name: "handoff", argument: "finish the failing tests" },
    { provider: "claude-code", accessMode: "workspace" },
  );
  assert.equal(task.targetProvider, "codex");
  assert.equal(task.accessMode, "workspace");
  assert.match(task.text, /filesystem and repository as the source of truth/i);
  assert.match(task.text, /finish the failing tests/);
});
