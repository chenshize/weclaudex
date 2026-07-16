#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "weclaudex-package-"));
const commandEnvironment = { ...process.env };
delete commandEnvironment.npm_config_dry_run;
delete commandEnvironment.NPM_CONFIG_DRY_RUN;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: commandEnvironment,
    timeout: 120_000,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  return result;
}

try {
  const packResult = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporaryRoot,
  ]);
  const [packed] = JSON.parse(packResult.stdout);
  assert.equal(packed.name, "weclaudex");
  assert.equal(packed.version, manifest.version);

  const paths = packed.files.map((file) => file.path);
  assert(paths.includes("src/cli.js"));
  assert(paths.includes("README.md"));
  assert(paths.includes("LICENSE"));
  assert(!paths.some((file) => file.startsWith("test/") || file.startsWith("tests/")));
  assert(!paths.some((file) => file.startsWith("docs/images/") || file.startsWith(".github/")));

  const tarball = path.join(temporaryRoot, packed.filename);
  const installRoot = path.join(temporaryRoot, "install");
  fs.mkdirSync(installRoot);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installRoot,
    tarball,
  ]);

  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installRoot, "node_modules", "weclaudex", "package.json"), "utf8"),
  );
  assert.deepEqual(installedManifest.bin, { weclaudex: "src/cli.js" });

  const executable = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "weclaudex.cmd" : "weclaudex",
  );
  const cliResult = run(executable, [], {
    cwd: installRoot,
    env: {
      ...process.env,
      HOME: path.join(temporaryRoot, "home"),
    },
  });
  assert.match(cliResult.stdout, new RegExp(`^WeClaudex ${manifest.version.replaceAll(".", "\\.")}`, "m"));

  console.log(
    `package smoke test passed: ${packed.filename}, ${packed.size} bytes, ${paths.length} files`,
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
