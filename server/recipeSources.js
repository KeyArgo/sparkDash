/**
 * Recipe catalog across sparkrun, Mia's published GitHub recipes, and
 * anything the user pastes (a GitHub repo or a raw sparkrun YAML).
 */
import fs from "fs";
import os from "os";
import path from "path";
import * as sparkrun from "./sparkrun.js";

const MIA_ORG = "MiaAI-Lab";
const MIA_TTL_MS = 15 * 60 * 1000;
const EXTERNAL_FILE = path.join(os.homedir(), ".cache", "sparkdeck", "external-recipes.json");

let miaCache = { at: 0, recipes: [], error: null };

function guessRuntime(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("exl3") || s.includes("exllama")) return "exl3";
  if (s.includes("sglang")) return "sglang";
  if (s.includes("llama.cpp") || s.includes("llama-cpp")) return "llama.cpp";
  if (s.includes("ollama")) return "ollama";
  if (s.includes("vllm")) return "vllm";
  return "";
}

function guessNodes(text) {
  const s = String(text || "");
  const nx = s.match(/(\d)\s*[x×][\s_-]*(?:dgx|spark)/i);
  if (nx) return Math.max(1, Number(nx[1]) || 1);
  if (/triple[\s_-]*(?:dgx|spark)/i.test(s)) return 3;
  if (/dual[\s_-]*(?:dgx|spark)|two sparks/i.test(s)) return 2;
  if (/single[\s_-]*(?:dgx|spark)/i.test(s)) return 1;
  return 1;
}

function looksLikeServingRecipe(repo) {
  const blob = `${repo?.name || ""} ${repo?.description || ""}`;
  const name = String(repo?.name || "");
  if (/sparkdash|html-files/i.test(name)) return false;
  if (/benchmark|html-files|(^|[-_])bench($|[-_])/i.test(name) && !/spark|dgx|recipe/i.test(name)) return false;
  return /spark|dgx|vllm|sglang|exl3|exllama/i.test(blob);
}

async function githubJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "sparkdash",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

function miaFromRepo(repo) {
  const name = String(repo?.name || "");
  if (!name || name.toLowerCase() === "sparkdash") return null;
  const blob = `${name} ${repo.description || ""}`;
  return {
    name,
    model: repo.description || name,
    runtime: guessRuntime(blob),
    min_nodes: guessNodes(blob),
    source: "mia",
    url: repo.html_url,
    stars: repo.stargazers_count || 0,
    updated: repo.updated_at || null,
  };
}

export async function listMiaRecipes({ force = false } = {}) {
  if (!force && miaCache.recipes.length && Date.now() - miaCache.at < MIA_TTL_MS) {
    return { recipes: miaCache.recipes, error: miaCache.error };
  }
  const urls = [
    `https://api.github.com/orgs/${MIA_ORG}/repos?per_page=100&sort=updated&type=public`,
    `https://api.github.com/users/${MIA_ORG}/repos?per_page=100&sort=updated&type=public`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await githubJson(url);
      if (!Array.isArray(data)) continue;
      const recipes = data.filter(looksLikeServingRecipe).map(miaFromRepo).filter(Boolean);
      miaCache = { at: Date.now(), recipes, error: null };
      return { recipes, error: null };
    } catch (err) {
      lastErr = err;
    }
  }
  const error = lastErr ? String(lastErr.message || lastErr) : "Mia catalog unavailable";
  if (miaCache.recipes.length) {
    miaCache = { ...miaCache, error };
    return { recipes: miaCache.recipes, error };
  }
  miaCache = { at: Date.now(), recipes: [], error };
  return { recipes: [], error };
}

function readExternal() {
  try {
    const data = JSON.parse(fs.readFileSync(EXTERNAL_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeExternal(list) {
  fs.mkdirSync(path.dirname(EXTERNAL_FILE), { recursive: true });
  fs.writeFileSync(EXTERNAL_FILE, JSON.stringify(list, null, 2));
}

/** github.com/owner/repo, with an optional /tree or /blob suffix stripped. */
export function parseGithubRepo(input) {
  const raw = String(input || "").trim();
  const m = raw.match(
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i
  );
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  return {
    owner,
    repo,
    name: repo,
    url: `https://github.com/${owner}/${repo}`,
  };
}

export function listExternalRecipes() {
  return readExternal().map((r) => ({
    name: r.name,
    model: r.model || r.url,
    runtime: r.runtime || guessRuntime(r.name),
    min_nodes: r.min_nodes || 1,
    source: r.source || "git",
    url: r.url,
    localPath: r.localPath,
  }));
}

export async function listAllRecipes() {
  const custom = sparkrun.listCustomRecipes().map((r) => ({ ...r, source: r.source || "custom" }));
  let sparkrunRecipes = [];
  try {
    sparkrunRecipes = sparkrun.getRecipes().map((r) => ({ ...r, source: "sparkrun" }));
  } catch {
    sparkrunRecipes = [];
  }
  const mia = await listMiaRecipes();
  const external = listExternalRecipes();
  return {
    recipes: [...external, ...custom, ...sparkrunRecipes, ...mia.recipes],
    miaError: mia.error,
  };
}

export async function importRecipe(input) {
  const raw = String(input?.url || input?.name || "").trim();
  if (!raw) throw new Error("paste a GitHub URL, a raw recipe YAML URL, or a sparkrun name");
  const gh = parseGithubRepo(raw);
  if (gh) {
    const list = readExternal().filter((r) => r.url !== gh.url);
    const entry = {
      name: gh.name,
      url: gh.url,
      source: "git",
      model: gh.repo,
      runtime: guessRuntime(gh.repo),
      min_nodes: guessNodes(gh.repo),
    };
    list.unshift(entry);
    writeExternal(list.slice(0, 200));
    return entry;
  }
  if (/^https?:\/\//i.test(raw) && /\.ya?ml(\?|$)/i.test(raw)) {
    const res = await fetch(raw, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const text = await res.text();
    const base = decodeURIComponent(raw.split("/").pop() || "imported").replace(/\.ya?ml.*$/, "");
    const saved = sparkrun.saveRecipeFile(base, text);
    return { ...saved, model: base, source: "yaml" };
  }
  if (!/^[@A-Za-z0-9_.\-/]+$/.test(raw) || raw.includes("..")) throw new Error("unrecognized recipe");
  const known = sparkrun.getRecipes().some((r) => r.name === raw);
  if (!known) throw new Error("not a sparkrun recipe, GitHub repo, or raw YAML url");
  return { name: raw, source: "sparkrun", model: raw };
}
