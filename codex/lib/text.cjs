"use strict";

const { CFG } = require("./config.cjs");

const asRecord = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
const str = (x) => (typeof x === "string" ? x : "");

const cap = (s) =>
  s.length <= CFG.maxVarChars
    ? s
    : s.slice(0, CFG.maxVarChars) + `\n…[truncated, ${s.length - CFG.maxVarChars} chars omitted]`;

function resultText(toolResponse) {
  if (typeof toolResponse === "string") return toolResponse;
  const rec = asRecord(toolResponse);
  if (typeof rec.output === "string") return rec.output;
  if (Array.isArray(rec.content)) {
    const text = rec.content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (text) return text;
  }
  if (typeof rec.text === "string") return rec.text;
  try {
    return JSON.stringify(toolResponse);
  } catch {
    return String(toolResponse);
  }
}

const VAR_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const KNOWN_PREFIX_RE = /^(read|bash|powershell|edit|write|grep|find|ls|news)\d+_/;

function renderTemplates(text, vars) {
  const get = (name) => (vars instanceof Map ? vars.get(name) : vars[name]);
  const cleaned = text
    .replace(/(^|\n)\[vars: [^\]]*\]( — [^\n]*)?(?=\n|$)/g, "")
    .replace(/(^|\n)DEHALL_VARS \{[^\n]*\}(?=\n|$)/g, "")
    .replace(/^\n+/, "");
  const replaced = [];
  const rendered = cleaned.replace(VAR_RE, (whole, name) => {
    const value = get(name);
    if (value === undefined) return whole;
    if (!replaced.includes(name)) replaced.push(name);
    return value;
  });
  return { text: rendered, replaced };
}

function extractPayload(text, lang) {
  const fences = [...text.matchAll(/```([a-zA-Z0-9_+#.-]*)\r?\n([\s\S]*?)```/g)].map((m) => ({
    tag: m[1].toLowerCase(),
    body: m[2],
  }));
  if (lang) {
    const tagged = fences.find((f) => f.tag === lang || (lang === "yaml" && f.tag === "yml"));
    if (tagged) return tagged.body.trim();
  }
  return fences.length ? fences[fences.length - 1].body.trim() : text.trim();
}

function extractJsonCandidate(text) {
  const fenced = extractPayload(text, "json");
  if (fenced.startsWith("{") || fenced.startsWith("[")) return fenced;
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return fenced;
}

function formatIssue(text, fmt) {
  if (fmt === "json") {
    const payload = extractJsonCandidate(text);
    if (!payload) return "no JSON payload found";
    try {
      JSON.parse(payload);
      return null;
    } catch (e) {
      return `JSON.parse failed: ${String(e.message || e).slice(0, 160)}`;
    }
  }
  if (fmt === "yaml") {
    const payload = extractPayload(text);
    if (!payload) return "empty payload";
    if (payload.startsWith("{") || payload.startsWith("[")) return "payload looks like JSON, not YAML";
    const lines = payload.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (!lines.length) return "empty payload";
    const kv = lines.filter((l) => /^[\s]*[-a-zA-Z0-9_."'\\/]+\s*:(\s|$)/.test(l));
    return kv.length >= Math.ceil(lines.length / 2) ? null : "not a YAML mapping/list";
  }
  if (fmt === "csv") {
    const payload = extractPayload(text);
    if (!payload) return "empty payload";
    return payload.includes(",") || payload.includes("\n") ? null : "no comma or newline";
  }
  if (fmt === "code") {
    const fences = (text.match(/```/g) || []).length;
    return fences % 2 === 0 ? null : `unbalanced code fences (${fences} markers)`;
  }
  return null;
}

const validateFormat = (text, fmt) => formatIssue(text, fmt) === null;

const FAMILIES = new Map([
  ["bash", "bash"],
  ["shell", "bash"],
  ["exec_command", "bash"],
  ["powershell", "bash"],
  ["apply_patch", "edit"],
  ["edit", "edit"],
  ["write", "edit"],
  ["write_file", "edit"],
  ["read", "read"],
  ["read_file", "read"],
  ["view_file", "read"],
  ["grep", "grep"],
  ["grep_files", "grep"],
  ["search_files", "grep"],
  ["find", "find"],
  ["glob", "find"],
  ["ls", "ls"],
  ["list_dir", "ls"],
]);

function toolFamily(toolName) {
  return FAMILIES.get(String(toolName || "").toLowerCase()) || null;
}

function varsForTool(toolName, prefix, input, result, toolResponse) {
  const family = toolFamily(toolName);
  if (!family) return [];
  const rec = asRecord(input);
  const resp = asRecord(toolResponse);
  const out = [];
  const add = (name, value) => {
    if (typeof value === "string" && value !== "") out.push([name, cap(value)]);
  };
  if (family === "bash") {
    const cmd = str(rec.command) || str(rec.cmd) || str(rec.script) || (typeof input === "string" ? input : "");
    add(`${prefix}_cmd`, cmd);
    add(`${prefix}_out`, result);
    const exit = rec.exit_code ?? rec.exitCode ?? resp.exit_code ?? resp.exitCode;
    if (Number.isFinite(Number(exit))) add(`${prefix}_exit`, String(exit));
  } else if (family === "edit") {
    const patch = str(rec.patch) || str(rec.diff) || (typeof input === "string" ? input : "");
    const fromPatch = (patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m) || [])[1] || "";
    add(`${prefix}_path`, str(rec.path) || str(rec.file) || fromPatch.trim());
    add(`${prefix}_patch`, patch);
    add(`${prefix}_diff`, result);
  } else if (family === "read") {
    add(`${prefix}_path`, str(rec.path) || str(rec.file));
    add(`${prefix}_content`, result);
  } else if (family === "grep" || family === "find") {
    add(`${prefix}_pattern`, str(rec.pattern) || str(rec.query) || str(rec.regex));
    add(`${prefix}_path`, str(rec.path));
    add(`${prefix}_out`, result);
  } else if (family === "ls") {
    add(`${prefix}_path`, str(rec.path) || str(rec.dir));
    add(`${prefix}_out`, result);
  }
  return out;
}

const ERROR_RE =
  /(Traceback \(most recent call last\)|SyntaxError|NameError|TypeError|ValueError|IndentationError|ImportError|ModuleNotFoundError|Invalid patch|is not recognized as|CommandNotFoundException|ParserError|RuntimeException|Unhandled exception|error:)/i;
const NONZERO_EXIT_RE = /(exited with code [1-9]\d*|exit code:? [1-9]\d*)/i;
const SUCCESS_CLAIM_RE =
  /(verified|confirmed|now prints|now outputs|correctly prints|correctly outputs|prints `|outputs `|successfull|works as expected|fix(ed)? and)/i;
const SEARCH_CLASS_CMD_RE = /^\s*(grep|rg|ag|find|fd|locate|test|\[|diff|comm|which|where|command -v)\b/;

function verificationGuard(finalText, vars, bashMax) {
  if (!bashMax) return null;
  const get = (name) => (vars instanceof Map ? vars.get(name) : vars[name]);
  const out = get(`bash${bashMax}_out`);
  const cmd = get(`bash${bashMax}_cmd`) || "";
  if (!out) return null;
  const exit = Number(get(`bash${bashMax}_exit`));
  const exitError = Number.isFinite(exit) && exit > 0 && !SEARCH_CLASS_CMD_RE.test(cmd);
  const isError = ERROR_RE.test(out) || exitError || (NONZERO_EXIT_RE.test(out) && !SEARCH_CLASS_CMD_RE.test(cmd));
  if (!isError) return null;
  if (!SUCCESS_CLAIM_RE.test(finalText)) return null;
  const tail = out.slice(-400).trim();
  return `---\n**de-hallucination check**: this reply claims success, but the last recorded command output (\`bash${bashMax}_out\`) is an error:\n\n\`\`\`\n${tail}\n\`\`\`\nRe-run the command and confirm before trusting the claim.`;
}

const hintFor = (names) =>
  `[vars: ${names.join(" ")}] — quote these as {name} placeholders in your final reply; the de-hallucination Stop hook renders the exact recorded values.`;

function truncateNotice(text) {
  return text.length <= CFG.maxNoticeChars
    ? text
    : text.slice(0, CFG.maxNoticeChars) + `\n…[notice truncated, ${text.length - CFG.maxNoticeChars} chars omitted]`;
}

module.exports = {
  asRecord,
  str,
  cap,
  resultText,
  renderTemplates,
  extractPayload,
  extractJsonCandidate,
  formatIssue,
  validateFormat,
  toolFamily,
  varsForTool,
  verificationGuard,
  hintFor,
  truncateNotice,
  KNOWN_PREFIX_RE,
};
