#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const userScope = args.includes("--user");
const withMcp = args.includes("--mcp");
const legacyJson = args.includes("--legacy-json");
const targetArg = args.find((a) => !a.startsWith("--"));
const repoRoot = path.resolve(__dirname, "..").replace(/\\/g, "/");
const hookCommand = `node "${repoRoot}/codex/hooks.cjs"`;
const mcpScript = `${repoRoot}/codex/mcp-server.cjs`;

// Codex >= 0.163 reads hooks from config.toml ([[hooks.<Event>]] tables), not from a
// separate hooks.json. Installing into the wrong file means the hooks either never run
// or — worse — run twice (once per file), which duplicates the policy and the per-tool
// trailers inside the prompt the remote model caches.
const HOOK_EVENTS = {
  SessionStart: 20,
  // The router runs here: one generous jev attempt (DH_JEV_TIMEOUT_MS, 20 s by
  // default). The hook's own ceiling must sit well above that so the hook can never be
  // killed mid-call — a killed UserPromptSubmit stalls the turn's first model request
  // and drops the prefix the remote model has cached.
  UserPromptSubmit: 120,
  PreToolUse: 15,
  PostToolUse: 15,
  // Stop runs the checker plus the closing round at 3x the jev timeout, and the
  // ablation twin after it, so this ceiling has to absorb several sequential calls.
  Stop: 180,
};
const hookEvents = Object.fromEntries(
  Object.entries(HOOK_EVENTS).map(([event, timeout]) => [
    event,
    [{ hooks: [{ type: "command", command: hookCommand, timeout }] }],
  ]),
);

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
        g.hooks &&
        g.hooks.some((h) => h && h.type === "command" && h.command === hookCommand),
    );
    merged.hooks[event] = already ? current : [...current, ...groups];
  }
  if (!merged.description) merged.description = "de-hallucination";
  return merged;
}

/**
 * Write the hook entries into config.toml (Codex >= 0.163), replacing any previous
 * de-hallucination entries so a re-install never leaves two copies behind: duplicate
 * hook groups mean the policy and the per-tool trailers land in the prompt twice.
 */
function renderHookTables() {
  const lines = ["", "# de-hallucination (managed by codex/install.cjs)"];
  for (const [event, timeout] of Object.entries(HOOK_EVENTS)) {
    lines.push(`[[hooks.${event}]]`);
    lines.push("hooks = [");
    lines.push(`  { type = "command", command = '${hookCommand.replace(/'/g, "''")}', timeout = ${timeout} },`);
    lines.push("]");
  }
  return lines.join("\n");
}

function installConfigToml(configFile) {
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : "";
  // Split the file into TOML blocks (a block starts at a `[` header) and drop the hook
  // tables that carry our command. Filtering line by line is not enough: the table
  // header does not contain the command, so a re-install would stack a second copy of
  // every hook table.
  const lines = existing.split(/\r?\n/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line) && current.length) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  const kept = blocks
    .filter((block) => !(block[0] || "").includes("hooks.") || !block.join("\n").includes(hookCommand))
    .map((block) => block.join("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
  const block = renderHookTables();
  return { changed: existing !== kept + block + "\n", text: `${kept}\n${block}\n` };
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

  // Codex >= 0.163: hooks live in config.toml. hooks.json is the legacy location and is
  // only written on request, so a 0.163 install never ends up with the hooks in both
  // places — which would run every hook twice and put the policy and the per-tool
  // trailers into the prompt twice.
  let hooksTarget = "config.toml";
  if (legacyJson) {
    const hooks = mergeHooks(readJson(hooksFile));
    backup(hooksFile);
    fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2) + "\n");
    hooksTarget = "hooks.json (legacy)";
  }
  const { changed, text } = installConfigToml(configFile);
  if (changed) {
    backup(configFile);
    fs.writeFileSync(configFile, text);
  }

  if (withMcp) {
    const mcp = ensureMcp(configFile);
    if (mcp.changed) {
      backup(configFile);
      fs.writeFileSync(configFile, mcp.text);
    }
  }

  console.log(`de-hallucination (Codex) installed for ${label}`);
  console.log(`  hooks:  ${configFile} [hooks.*]  (${hooksTarget})`);
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
