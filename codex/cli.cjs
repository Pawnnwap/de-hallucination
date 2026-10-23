#!/usr/bin/env node
"use strict";

const { CFG } = require("./lib/config.cjs");
const { jevDecide, JevUnavailable } = require("./lib/jev.cjs");
const { searchNews, newsBase, formatNewsResult } = require("./lib/news.cjs");
const { stateDir, withState } = require("./lib/state.cjs");
const fs = require("fs");
const path = require("path");

function usage() {
  console.log(`de-hallucination CLI (Codex)

Usage:
  node codex/cli.cjs news-search <query> [--limit N] [--hours N]
  node codex/cli.cjs jev-decide --context <text> --choice <key>=<description> --choice <key>=<description> [...]
  node codex/cli.cjs vars-list [--last | --session <id>]

news-search and jev-decide print the same records as the MCP tools; news-search ends with a
DEHALL_VARS line so the Codex hooks can turn the returned facts into {placeholders}.
vars-list prints the recorded template variable names of the latest (or the given)
session, so the reply can reference {name} placeholders without guessing.
`);
}

function takeFlag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value === undefined ? fallback : value;
}

async function newsSearch(args) {
  const limitRaw = takeFlag(args, "--limit", "3");
  const hoursRaw = takeFlag(args, "--hours", "");
  const query = args.join(" ").trim();
  if (!query) throw new Error("news-search needs a query");
  const limit = Math.min(10, Math.max(1, Number(limitRaw) || 3));
  const hoursNum = Number(hoursRaw);
  const hours = Number.isFinite(hoursNum) && hoursNum > 0 ? Math.min(24 * 30, hoursNum) : null;
  const { hits, degraded, error } = await searchNews(query, limit, hours);
  if (!hits.length) {
    if (error) {
      console.error(`News search unavailable (${error.slice(0, 160)}).`);
      process.exitCode = 1;
      return;
    }
    console.log(`No news matches for "${query}". Try different terms.`);
    return;
  }
  const formatted = formatNewsResult(query, hits, newsBase(query), CFG.templates);
  console.log(formatted.text + degraded);
}

async function jevDecideCli(args) {
  const context = takeFlag(args, "--context", "");
  const choices = [];
  for (;;) {
    const i = args.indexOf("--choice");
    if (i === -1) break;
    const raw = args[i + 1];
    args.splice(i, 2);
    if (!raw) throw new Error("--choice needs key=description");
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error(`invalid --choice "${raw}" (expected key=description)`);
    choices.push({ key: raw.slice(0, eq).trim(), description: raw.slice(eq + 1).trim() });
  }
  if (!context) throw new Error("jev-decide needs --context");
  try {
    const d = await jevDecide(context, choices);
    const dist = Object.entries(d.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => `- ${k}: ${(p * 100).toFixed(1)}%`)
      .join("\n");
    console.log(`Decision: ${d.choice} (confidence ${d.confidence.toFixed(2)})\n${dist}`);
  } catch (e) {
    const msg = e instanceof JevUnavailable ? e.message : String(e);
    console.error(`jev decision service unavailable (${msg}). Make the decision yourself and say so.`);
    process.exitCode = 1;
  }
}

function varsList(args) {
  const session = takeFlag(args, "--session", "");
  const last = args.includes("--last");
  let sessionId = session;
  if (!sessionId && last) {
    const dir = stateDir();
    let best = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        const st = fs.statSync(path.join(dir, f));
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
      }
    } catch (e) {
      console.error(`vars-list: cannot read state dir (${String(e.message || e)}).`);
      process.exitCode = 1;
      return;
    }
    if (!best) {
      console.error("vars-list: no recorded sessions found.");
      process.exitCode = 1;
      return;
    }
    sessionId = best.file.slice(0, -".json".length);
  }
  if (!sessionId) {
    console.error("vars-list: pass --last or --session <id>.");
    process.exitCode = 2;
    return;
  }
  if (sessionId === "unknown") {
    console.error("vars-list: only anonymous default state exists (no vars).");
    return;
  }
  const state = withState(sessionId, (st) => ({
    vars: { ...st.vars },
    count: Object.keys(st.vars).length,
  }));
  const names = Object.keys(state.vars);
  if (!names.length) {
    console.log("No template variables recorded for this session yet.");
    return;
  }
  console.log(`Recorded template variables (${names.length}):`);
  for (const n of names) {
    const v = String(state.vars[n] || "");
    const preview = v.length > 60 ? v.slice(0, 57).replace(/\s+/g, " ") + "…" : v.replace(/\s+/g, " ");
    console.log(`- {${n}} chars=${v.length} preview="${preview}"`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }
  if (command === "news-search") {
    await newsSearch(args);
    return;
  }
  if (command === "jev-decide") {
    await jevDecideCli(args);
    return;
  }
  if (command === "vars-list") {
    varsList(args);
    return;
  }
  console.error(`unknown command: ${command}`);
  usage();
  process.exitCode = 2;
})().catch((e) => {
  console.error(String(e.message || e));
  process.exitCode = 1;
});
