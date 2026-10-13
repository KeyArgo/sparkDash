/**
 * sparkdeck fleet features mounted onto sparkDash:
 * inventory, sparkrun, model control, LiteLLM profile export, serving switches.
 */
import * as control from "./control.js";
import * as sparkrun from "./sparkrun.js";
import * as recipeSources from "./recipeSources.js";
import * as profiles from "./profiles.js";
import * as servingConfig from "./servingConfig.js";
import { collectInventory } from "./collectors/InventoryCollector.js";
import { guardSpark, isAdmin, filterVisibleSparks } from "./admin.js";

const isPort = (n) => Number.isInteger(n) && n >= 1024 && n <= 65535;
const RECIPE_NAME_RE = /^[@A-Za-z0-9_.\-/]+$/;

export function mountFleetRoutes(app, { registry, orderedSnapshots }) {
  app.get("/api/sparks/:id/inventory", async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      const inventory = await collectInventory(spark);
      try {
        inventory.sparkrunMatchesByDir = Object.fromEntries(
          (inventory.modelDirs || []).map((dir) => [dir.name, sparkrun.matchRecipesForModel(dir.name)])
        );
        inventory.sparkrunMatchesByTag = Object.fromEntries(
          (inventory.ollamaTags || []).map((tag) => [tag, sparkrun.matchRecipesForModel(tag, { isOllamaTag: true })])
        );
      } catch {
        /* recipe matching is optional */
      }
      res.json(inventory);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/sparkrun/recipes", (_req, res) => {
    try {
      res.json({ recipes: [...sparkrun.listCustomRecipes(), ...sparkrun.getRecipes()] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/sparkrun/recipes", (req, res) => {
    try {
      const r = sparkrun.addCustomRecipe(req.body || {});
      res.json({ ok: true, name: r.name, localPath: r.localPath });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.get("/api/recipes", async (_req, res) => {
    try {
      res.json(await recipeSources.listAllRecipes());
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/recipes/import", async (req, res) => {
    try {
      const recipe = await recipeSources.importRecipe(req.body || {});
      res.json({ ok: true, recipe });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });

  function recipeTarget(body) {
    const source = String(body?.source || "sparkrun");
    const name = String(body?.name || "");
    const url = body?.url ? String(body.url) : "";
    const localPath = body?.localPath ? String(body.localPath) : "";
    const port = body?.port != null ? Number(body.port) : undefined;
    return { source, name, url, localPath, port };
  }

  app.post("/api/sparks/:id/recipes/load", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const blocked = guardSpark(spark.id, req);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const t = recipeTarget(req.body || {});
    if (t.port != null && !isPort(t.port)) return res.status(400).json({ error: "invalid port" });
    if (t.source === "git" || t.source === "mia") {
      const gh = recipeSources.parseGithubRepo(t.url);
      if (!gh) return res.status(400).json({ error: "invalid recipe url" });
      void control.doGitRecipe(spark, { url: gh.url, action: "start" });
      return res.json({ ok: true, url: gh.url });
    }
    const recipeName = t.localPath || t.name;
    if (!recipeName || recipeName.length > 300 || !RECIPE_NAME_RE.test(recipeName) || recipeName.includes(".."))
      return res.status(400).json({ error: "invalid recipeName" });
    const host = spark.ssh?.host || spark.lanIp;
    const logPath = sparkrun.recipeRunLogPath(recipeName, host);
    void control.doSparkrunRun(spark, { recipeName, port: t.port });
    res.json({ ok: true, logPath });
  });

  app.post("/api/sparks/:id/recipes/unload", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const blocked = guardSpark(spark.id, req);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const t = recipeTarget(req.body || {});
    const model = req.body?.model ? String(req.body.model) : "";
    if (t.source === "ollama" || (model && t.source !== "git" && t.source !== "mia" && !t.name)) {
      if (!model || !control.PULL_TAG_RE.test(model)) return res.status(400).json({ error: "invalid model" });
      void control.doOllamaStop(spark, { model });
      return res.json({ ok: true });
    }
    if (t.source === "git" || t.source === "mia") {
      const gh = recipeSources.parseGithubRepo(t.url);
      if (!gh) return res.status(400).json({ error: "invalid recipe url" });
      void control.doGitRecipe(spark, { url: gh.url, action: "stop" });
      return res.json({ ok: true, url: gh.url });
    }
    const recipeName = t.localPath || t.name;
    if (!recipeName || recipeName.length > 300 || !RECIPE_NAME_RE.test(recipeName) || recipeName.includes(".."))
      return res.status(400).json({ error: "invalid recipeName" });
    if (t.port != null && !isPort(t.port)) return res.status(400).json({ error: "invalid port" });
    void control.doSparkrunStop(spark, { recipeName, port: t.port });
    res.json({ ok: true });
  });

  app.get("/api/sparks/:id/recipes/log", async (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const source = String(req.query.source || "");
    if (source === "git" || source === "mia") {
      const gh = recipeSources.parseGithubRepo(String(req.query.url || ""));
      if (!gh) return res.json({ log: "" });
      const log = await control.readGitRecipeLog(spark, gh.url);
      return res.json({ log });
    }
    const host = spark.ssh?.host || spark.lanIp;
    const recipeName = String(req.query.recipe || "");
    if (!host || !recipeName) return res.json({ log: "" });
    res.json({ log: sparkrun.readRecipeRunLog(sparkrun.recipeRunLogPath(recipeName, host)) });
  });

  app.post("/api/sparks/:id/control/ollama-stop", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const blocked = guardSpark(spark.id, req);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const model = String(req.body?.model || "").trim();
    if (!model || model.length > 200 || !control.PULL_TAG_RE.test(model))
      return res.status(400).json({ error: "invalid model" });
    void control.doOllamaStop(spark, { model });
    res.json({ ok: true });
  });

  app.get("/api/control/status", (_req, res) => {
    res.json(control.getControlStatus());
  });

  app.get("/api/fleet/coverage", async (req, res) => {
    const sparks = filterVisibleSparks(registry.sparks, isAdmin(req));
    const invs = await Promise.all(
      sparks.map(async (s) => {
        try {
          return { id: s.id, inv: await collectInventory(s) };
        } catch {
          return { id: s.id, inv: null };
        }
      })
    );
    const reachable = invs.filter((x) => x.inv).map((x) => x.id);
    const map = new Map();
    const add = (kind, name, id) => {
      const key = `${kind}:${name}`;
      if (!map.has(key)) map.set(key, { kind, name, present: new Set() });
      map.get(key).present.add(id);
    };
    for (const { id, inv } of invs) {
      if (!inv) continue;
      for (const d of inv.modelDirs || []) add("vllm", d.name, id);
      for (const t of inv.ollamaTags || []) add("ollama", t, id);
    }
    const models = [...map.values()]
      .map((m) => ({
        kind: m.kind,
        name: m.name,
        present: [...m.present],
        missing: reachable.filter((id) => !m.present.has(id)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ sparks: sparks.map((s) => ({ id: s.id, name: s.name })), reachable, models });
  });

  app.get("/api/profiles/litellm", (req, res) => {
    const admin = isAdmin(req);
    const visibleSparks = filterVisibleSparks(registry.sparks, admin);
    const snapById = {};
    for (const s of filterVisibleSparks(orderedSnapshots(), admin)) snapById[s.id] = s;
    res.type("text/yaml").send(profiles.toLiteLLMConfig(visibleSparks, snapById));
  });

  app.post("/api/sparks/:id/control/switch", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const b = req.body || {};
    const port = Number(b.port);
    const prefs = profiles.resolvePrefs(spark.id);
    const ctxPref = b.maxLen != null ? b.maxLen : profiles.resolveContext(spark.id, b.modelDir);
    const gpuUtil = b.gpuUtil != null ? Number(b.gpuUtil) : Number(prefs.gpuUtil);
    const servedName = (b.servedName && String(b.servedName).trim()) || profiles.aliasFor(spark);
    if (!control.MODEL_DIR_RE.test(b.modelDir || "") || (b.modelDir || "").split("/").includes(".."))
      return res.status(400).json({ error: "invalid modelDir" });
    if (!control.NAME_RE.test(servedName)) return res.status(400).json({ error: "invalid servedName" });
    if (!isPort(port)) return res.status(400).json({ error: "invalid port" });
    let maxLen;
    if (ctxPref === "max" || ctxPref === "auto") maxLen = "max";
    else {
      maxLen = Number(ctxPref);
      if (!(maxLen >= 512 && maxLen <= 1048576)) return res.status(400).json({ error: "invalid context" });
    }
    if (!(gpuUtil >= 0.1 && gpuUtil <= 0.98)) return res.status(400).json({ error: "invalid gpuUtil" });
    const enforceEager = b.enforceEager != null ? b.enforceEager === true : !!prefs.enforceEager;
    const kvCacheDtype = b.kvCacheDtype !== undefined ? b.kvCacheDtype : prefs.kvCacheDtype;
    const reasoningParser = b.reasoningParser !== undefined ? b.reasoningParser : prefs.reasoningParser;
    if (kvCacheDtype != null && !control.NAME_RE.test(kvCacheDtype))
      return res.status(400).json({ error: "invalid kvCacheDtype" });
    if (reasoningParser != null && !control.NAME_RE.test(reasoningParser))
      return res.status(400).json({ error: "invalid reasoningParser" });
    void control.doSwitch(spark, {
      modelDir: b.modelDir,
      servedName,
      port,
      maxLen,
      gpuUtil,
      arch: b.arch,
      enforceEager,
      kvCacheDtype,
      reasoningParser,
    });
    res.json({ ok: true, servedName, context: maxLen, gpuUtil, enforceEager, kvCacheDtype, reasoningParser });
  });

  app.post("/api/sparks/:id/control/switch-sglang", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const b = req.body || {};
    const port = Number(b.port);
    const prefs = profiles.resolvePrefs(spark.id);
    const ctxPref = b.maxLen != null ? b.maxLen : profiles.resolveContext(spark.id, b.modelDir);
    const gpuUtil = b.gpuUtil != null ? Number(b.gpuUtil) : Number(prefs.gpuUtil);
    const servedName = (b.servedName && String(b.servedName).trim()) || profiles.aliasFor(spark);
    if (!control.MODEL_DIR_RE.test(b.modelDir || "") || (b.modelDir || "").split("/").includes(".."))
      return res.status(400).json({ error: "invalid modelDir" });
    if (!control.NAME_RE.test(servedName)) return res.status(400).json({ error: "invalid servedName" });
    if (!isPort(port)) return res.status(400).json({ error: "invalid port" });
    let maxLen;
    if (ctxPref === "max" || ctxPref === "auto") maxLen = "max";
    else {
      maxLen = Number(ctxPref);
      if (!(maxLen >= 512 && maxLen <= 1048576)) return res.status(400).json({ error: "invalid context" });
    }
    if (!(gpuUtil >= 0.1 && gpuUtil <= 0.98)) return res.status(400).json({ error: "invalid gpuUtil" });
    const toolParser = b.toolParser !== undefined ? b.toolParser : null;
    const reasoningParser = b.reasoningParser !== undefined ? b.reasoningParser : prefs.reasoningParser;
    const attentionBackend = b.attentionBackend !== undefined ? b.attentionBackend : null;
    if (toolParser != null && !control.NAME_RE.test(toolParser))
      return res.status(400).json({ error: "invalid toolParser" });
    if (reasoningParser != null && !control.NAME_RE.test(reasoningParser))
      return res.status(400).json({ error: "invalid reasoningParser" });
    if (attentionBackend != null && !control.NAME_RE.test(attentionBackend))
      return res.status(400).json({ error: "invalid attentionBackend" });
    void control.doSwitchSglang(spark, {
      modelDir: b.modelDir,
      servedName,
      port,
      maxLen,
      gpuUtil,
      toolParser,
      reasoningParser,
      attentionBackend,
    });
    res.json({
      ok: true,
      servedName,
      context: maxLen,
      gpuUtil,
      reasoningParser,
      attentionBackend: attentionBackend || "triton",
    });
  });

  app.post("/api/sparks/:id/control/kill", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const port = Number(req.body?.port);
    if (!isPort(port)) return res.status(400).json({ error: "invalid port" });
    void control.doKill(spark, { port });
    res.json({ ok: true });
  });

  app.post("/api/sparks/:id/control/warm", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const model = req.body?.model;
    if (!model || String(model).length > 200) return res.status(400).json({ error: "invalid model" });
    void control.doWarm(spark, { model });
    res.json({ ok: true });
  });

  app.post("/api/sparks/:id/control/restart-vllm", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const port = Number(req.body?.port);
    if (!isPort(port)) return res.status(400).json({ error: "invalid port" });
    void control.doRestartVllm(spark, { port });
    res.json({ ok: true });
  });

  app.post("/api/sparks/:id/control/restart-ollama", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    void control.doRestartOllama(spark);
    res.json({ ok: true });
  });

  app.post("/api/sparks/:id/control/gguf-import", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const b = req.body || {};
    if ((b.ggufPath || "").includes("..") || !String(b.ggufPath || "").toLowerCase().endsWith(".gguf"))
      return res.status(400).json({ error: "invalid ggufPath" });
    if (!control.NAME_RE.test(b.modelName || "")) return res.status(400).json({ error: "invalid modelName" });
    void control.doGgufImport(spark, { ggufPath: b.ggufPath, modelName: b.modelName });
    res.json({ ok: true });
  });

  app.post("/api/sparks/:id/control/sparkrun-run", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const blocked = guardSpark(spark.id, req);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const b = req.body || {};
    const recipeName = String(b.recipeName || "");
    if (!recipeName || recipeName.length > 300 || !RECIPE_NAME_RE.test(recipeName) || recipeName.includes(".."))
      return res.status(400).json({ error: "invalid recipeName" });
    const port = b.port != null ? Number(b.port) : undefined;
    if (port != null && !isPort(port)) return res.status(400).json({ error: "invalid port" });
    const servedName = b.servedName != null ? String(b.servedName) : undefined;
    if (servedName != null && !control.NAME_RE.test(servedName))
      return res.status(400).json({ error: "invalid servedName" });
    const gpuMem = b.gpuMem != null ? Number(b.gpuMem) : undefined;
    if (gpuMem != null && !(gpuMem >= 0.1 && gpuMem <= 0.98))
      return res.status(400).json({ error: "invalid gpuMem" });
    const maxModelLen = b.maxModelLen != null ? Number(b.maxModelLen) : undefined;
    if (maxModelLen != null && !(maxModelLen >= 512 && maxModelLen <= 1048576))
      return res.status(400).json({ error: "invalid maxModelLen" });
    const host = spark.ssh?.host || spark.lanIp;
    const logPath = sparkrun.recipeRunLogPath(recipeName, host);
    void control.doSparkrunRun(spark, { recipeName, port, servedName, gpuMem, maxModelLen });
    res.json({ ok: true, logPath });
  });

  app.get("/api/sparks/:id/control/sparkrun-log", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const host = spark.ssh?.host || spark.lanIp;
    const recipeName = String(req.query.recipe || "");
    if (!host || !recipeName) return res.json({ log: "" });
    res.json({ log: sparkrun.readRecipeRunLog(sparkrun.recipeRunLogPath(recipeName, host)) });
  });

  app.post("/api/sparks/:id/control/pull", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const modelTag = (req.body?.modelTag || "").trim();
    if (!modelTag || modelTag.length > 200 || !control.PULL_TAG_RE.test(modelTag))
      return res.status(400).json({ error: "invalid modelTag" });
    void control.doPullModel(spark, { modelTag });
    res.json({ ok: true });
  });

  app.post("/api/sparks/:id/control/copy", (req, res) => {
    const src = registry.getSpark(req.params.id);
    if (!src) return res.status(404).json({ error: "source Spark not found" });
    const b = req.body || {};
    const dst = registry.getSpark(b.dst);
    if (!dst) return res.status(404).json({ error: "destination Spark not found" });
    if (src.id === dst.id) return res.status(400).json({ error: "source and destination must differ" });
    const blockedDst = guardSpark(dst.id, req);
    if (blockedDst) return res.status(blockedDst.status).json(blockedDst.body);
    if (!["ollama", "vllm"].includes(b.kind)) return res.status(400).json({ error: "invalid kind" });
    const name = (b.name || "").trim();
    if (!name || name.length > 200 || !control.PULL_TAG_RE.test(name))
      return res.status(400).json({ error: "invalid name" });
    void control.doCopyModel(src, dst, { kind: b.kind, name });
    res.json({ ok: true });
  });

  app.get("/api/sparks/:id/serving-config", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const config = servingConfig.getServingConfig(spark.id);
    res.json({ config, translated: servingConfig.translateConfigToFlags(config) });
  });

  app.put("/api/sparks/:id/serving-config", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    try {
      const config = servingConfig.saveServingConfig(spark.id, req.body || {});
      const translated = servingConfig.translateConfigToFlags(config);
      res.json({
        config,
        translated,
        applied: false,
        note: "Saved toggle state. Live apply requires applyServingConfigToSpark (not wired).",
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/sparks/:id/serving-config/ab-bench", (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const config = servingConfig.getServingConfig(spark.id);
    res.json(servingConfig.stubRunCtxBenchAB(spark.id, config));
  });
}
