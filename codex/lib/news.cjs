"use strict";

const { promises: fsp, existsSync } = require("fs");
const path = require("path");
const { CFG, log } = require("./config.cjs");
const { cap } = require("./text.cjs");

const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "and", "or", "on", "at", "is", "was",
  "are", "were", "did", "does", "do", "what", "which", "when", "how", "that", "this",
  "it", "its", "by", "with", "from", "about", "tell", "me", "report", "search",
]);

function searchTerms(query) {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9$.]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SEARCH_STOPWORDS.has(t));
}

function newsDir() {
  if (CFG.newsDir) return existsSync(CFG.newsDir) ? CFG.newsDir : null;
  for (const cand of ["news", path.join("pi", "bench", "fixtures", "news"), path.join("bench", "fixtures", "news")]) {
    const p = path.resolve(process.cwd(), cand);
    if (existsSync(p)) return p;
  }
  return null;
}

async function searchLocalCorpus(query, limit) {
  const dir = newsDir();
  if (!dir) throw new Error("no local news corpus found (set DH_NEWS_DIR)");
  const terms = searchTerms(query);
  const scored = [];
  for (const f of (await fsp.readdir(dir)).filter((x) => x.endsWith(".txt"))) {
    const full = await fsp.readFile(path.join(dir, f), "utf8");
    const lines = full.split(/\r?\n/);
    const title = (lines[0] || "").trim();
    const body = lines.slice(1).join("\n").trim();
    const lowerTitle = title.toLowerCase();
    const lowerBody = body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      score += 3 * (lowerTitle.split(t).length - 1);
      score += lowerBody.split(t).length - 1;
    }
    if (score > 0) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
      scored.push({
        hit: { source: f.replace(/\.txt$/, ""), date: m ? m[1] : "", title, text: body },
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.hit);
}

async function searchLiveHN(query, limit, hours) {
  const base = hours
    ? `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${Math.floor(
        Date.now() / 1000 - hours * 3600,
      )}`
    : "https://hn.algolia.com/api/v1/search?tags=story";
  const url = `${base}&hitsPerPage=${limit}&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HN search -> HTTP ${res.status}`);
  const j = await res.json();
  return (j.hits || []).map((h) => ({
    source: h.objectID,
    date: String(h.created_at || "").slice(0, 10),
    title: String(h.title || h.story_title || ""),
    text: `${h.points ?? "?"} points, ${h.num_comments ?? "?"} comments\n${
      h.url || `https://news.ycombinator.com/item?id=${h.objectID}`
    }`,
  }));
}

async function searchNews(query, limit, hours) {
  let hits;
  let degraded = "";
  try {
    hits = CFG.newsLive
      ? await searchLiveHN(query, limit, hours)
      : await searchLocalCorpus(query, limit);
  } catch (e) {
    log("news_search primary source failed:", String(e).slice(0, 120));
    try {
      hits = CFG.newsLive ? await searchLocalCorpus(query, limit) : [];
      if (hits.length) degraded = " (live search unavailable — showing local corpus)";
    } catch {
      hits = [];
    }
    if (!hits.length) return { hits: [], degraded, error: String(e) };
  }
  return { hits, degraded, error: "" };
}

function newsBase(query) {
  let h = 2166136261;
  const s = String(query || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `news${(h >>> 0) % 1000000}`;
}

function formatNewsResult(query, hits, base, includeVars = true) {
  const names = [`${base}_query`];
  const vars = { [`${base}_query`]: query };
  const blocks = hits.map((h, i) => {
    const k = i + 1;
    vars[`${base}_r${k}_title`] = cap(h.title);
    vars[`${base}_r${k}_date`] = h.date;
    vars[`${base}_r${k}_text`] = cap(h.text);
    names.push(`${base}_r${k}_title`, `${base}_r${k}_date`, `${base}_r${k}_text`);
    return `#${k} [${h.source}] ${h.date}\n${h.title}\n${h.text.slice(0, 700)}`;
  });
  const marker = includeVars ? `\n\nDEHALL_VARS ${JSON.stringify(vars)}` : "";
  return { text: `${blocks.join("\n\n")}${marker}`, vars, names };
}

function parseNewsVars(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DEHALL_VARS "));
  if (!line) return null;
  try {
    const vars = JSON.parse(line.slice("DEHALL_VARS ".length));
    if (!vars || typeof vars !== "object") return null;
    const m = Object.keys(vars)[0] && Object.keys(vars)[0].match(/^(news\d+)_/);
    return { vars, base: m ? m[1] : "" };
  } catch {
    return null;
  }
}

module.exports = {
  searchTerms,
  newsDir,
  searchLocalCorpus,
  searchLiveHN,
  searchNews,
  newsBase,
  formatNewsResult,
  parseNewsVars,
};
