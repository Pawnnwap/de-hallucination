#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const userScope = args.includes("--user");
const withMcp = args.includes("--mcp");
const targetArg = args.find((a) => !a.startsWith("--"));
const repoRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");
const hookCommand = `node "${repoRoot}/codex/hooks.cjs"`;
const mcpScript = `${repoRoot}/codex/mcp-server.cjs`;

const hookEvents = {
  SessionStart: [{ hooks: [{ type: "command", command: hookCommand, timeout: 20 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand, timeout: 30 }] }],
  PreToolUse: [{ hooks: [{ type: "command", command: hookCommand, timeout: 15 }] }],
  PostToolUse: [{ hooks: [{ type: "command", command: hookCommand, timeout: 15 }] }],
  Stop: [{ hooks: [{ type: "command", command: hookCommand, timeout: 120 }] }],
};

const mcpBlock = `
[mcp_servers.dehall]
command = "node"
args = ["${mcpScript}"]
startup_timeout_sec = 20
tool_timeout_sec = 120
`;

function readJson(file) {
  if (!fs.existsSync(file)) return { description: "de-hallucination", hooks: {} };
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

function mergeHooks(existing) {
  const merged = { ...existing, hooks: { ...(existing.hooks || {}) } };
  for (const [event, groups] of Object.entries(hookEvents)) {
    const current = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const already = current.some(
      (g) =>
        g &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h) => h && h.type === "command" && h.command === hookCommand),
    );
    merged.hooks[event] = already ? current : [...current, ...groups];
  }
  if (!merged.description) merged.description = "de-hallucination";
  return merged;
}

function ensureMcp(configFile) {
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  if (/^\s*\[mcp_servers\.dehall\]/m.test(existing)) return { changed: false, text: existing };
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  return { changed: true, text: existing + sep + mcpBlock };
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const bak = `${file}.bak-dehall`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function install(scopeDir, label) {
  const codexDir = userScope ? scopeDir : path.join(scopeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const hooksFile = path.join(codexDir, "hooks.json");
  const configFile = path.join(codexDir, "config.toml");

  const hooks = mergeHooks(readJson(hooksFile));
  backup(hooksFile);
  fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2) + "\n");

  if (withMcp) {
    const mcp = ensureMcp(configFile);
    if (mcp.changed) {
      backup(configFile);
      fs.writeFileSync(configFile, mcp.text);
    }
  }

  console.log(`de-hallucination (Codex) installed for ${label}`);
  console.log(`  hooks:  ${hooksFile}`);
  console.log(`  tools:  CLI transport (codex/cli.cjs)${withMcp ? " + MCP server" : ""}`);
  if (withMcp) console.log(`  MCP:    ${configFile} [mcp_servers.dehall]`);
  console.log(`  engine: ${hookCommand}`);
  console.log("");
  console.log("Next steps:");
  console.log(
    userScope
      ? "  1. Codex may ask you to review/trust the new hooks once."
      : "  1. Codex must trust this project and its hooks once (review the prompt).",
  );
  console.log("  2. For non-interactive runs, add --dangerously-bypass-hook-trust.");
  console.log("  3. Check wiring with: codex doctor");
  if (withMcp) {
    console.log("  4. MCP tools are sent as namespace tools; some third-party providers hide them.");
    console.log("     Set DH_CODEX_TOOLS=mcp (or both) if your provider supports them.");
  }
}

if (userScope) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  install(codexHome, `user scope (${codexHome})`);
} else {
  install(path.resolve(targetArg || process.cwd()), path.resolve(targetArg || process.cwd()));
}
