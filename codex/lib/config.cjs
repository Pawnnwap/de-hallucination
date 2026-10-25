"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const env = (name, fallback) => process.env[name] || fallback;
const flag = (name) => process.env[name] === "1";

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    if (process.env.DH_DEBUG === "1") {
      console.error(`[dehall] ${name}="${raw}" is not a valid integer — using ${fallback}`);
    }
    return fallback;
  }
  return n;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    if (process.env.DH_DEBUG === "1") {
      console.error(`[dehall] ${name}="${raw}" is not a valid number - using ${fallback}`);
    }
    return fallback;
  }
  return n;
}

const renderModeRaw = env("DH_CODEX_RENDER", "notice").toLowerCase();
const renderMode = ["notice", "block", "off"].includes(renderModeRaw) ? renderModeRaw : "notice";
const toolsModeRaw = env("DH_CODEX_TOOLS", "cli").toLowerCase();
const toolsMode = ["cli", "mcp", "both"].includes(toolsModeRaw) ? toolsModeRaw : "cli";

/**
 * Optional jev endpoint file (~/.dehall/jev.json, {"url","key","model"}). It keeps
 * service endpoints and bearer tokens out of the repo, so codex and pi read the same
 * service without any per-tool wiring. Environment variables always win over the file.
 */
function jevService() {
  try {
    const file = path.join(os.homedir(), ".dehall", "jev.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
const JEVSVC = jevService();

const CFG = {
  jevUrl: env("DH_JEV_URL", String(JEVSVC.url || "http://127.0.0.1:8090")).replace(/\/+$/, ""),
  jevKey: env("DH_JEV_KEY", String(JEVSVC.key || "")),
  jevModel: env("DH_JEV_MODEL", String(JEVSVC.model || "")),
  // Generous on purpose: the closing round runs at 3x this and the judge may be a
  // remote service. Never shrink it to fit a hook — raise the hook's own timeout.
  jevTimeoutMs: int("DH_JEV_TIMEOUT_MS", 20000),
  maxVarChars: int("DH_MAX_VAR_CHARS", 8192),
  maxNoticeChars: int("DH_MAX_NOTICE_CHARS", 12000),
  stateDir: env("DH_CODEX_STATE_DIR", path.join(os.tmpdir(), "dehall-codex")),
  newsLive: flag("DH_NEWS_LIVE"),
  newsDir: env("DH_NEWS_DIR", ""),
  router: !flag("DH_DISABLE_ROUTER"),
  templates: !flag("DH_DISABLE_TEMPLATES"),
  closer: !flag("DH_DISABLE_CLOSER"),
  checker: !flag("DH_DISABLE_CHECKER"),
  decide: !flag("DH_DISABLE_DECIDE"),
  renderMode,
  toolsMode,
  // The per-turn reminder is redundant with the session policy (which stays in the prompt
  // for the whole session). Off by default: every turn's reminder is extra bytes inside
  // the prefix the remote model caches, plus a prompt mutation per turn.
  turnReminder: flag("DH_CODEX_TURN_REMINDER"),
  // How much of the expanded final reply may be inlined into a block reason. A block
  // reason goes into the model's input and stays there, so the payload is capped hard.
  renderPayloadChars: int("DH_CODEX_RENDER_PAYLOAD", 2000),
  checkRetries: Math.max(0, Math.min(2, int("DH_CODEX_CHECK_RETRIES", 1))),
  abstainMargin: num("DH_ABSTAIN_MARGIN", 0.10),
  abstainTopP: num("DH_ABSTAIN_TOPP", 0.45),
  ablationDelta: num("DH_ABLATION_DELTA", 0.15),
  abstainConf: num("DH_ABSTAIN_CONF", 0.15),
  ablation: !flag("DH_DISABLE_ABLATION"),
  twinChars: Math.max(200, int("DH_TWIN_STATE_CHARS", 4000)),
  debug: flag("DH_DEBUG"),
};

const log = (...args) => {
  if (CFG.debug) console.error("[dehall]", ...args);
};

module.exports = { CFG, log };
