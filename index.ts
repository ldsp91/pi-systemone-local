/**
 * pi-systemone-local
 *
 * Registers System One "decider" models for pi — classifier models with the
 * `typesafe-system-one` API (TypeSafe's d1 decision models). This extension
 * supplies the implementation: a JSON POST of `{ model, state, questions }`
 * to `{baseUrl}/systemone` — the System One decision endpoint served by
 * TypeSafe's API and by llama.cpp / llama-swap routers for decision models.
 *
 * Two config sources are supported:
 *
 *   1. `systemone-models.json` — a standalone file that mirrors the
 *      provider/model structure of models.json. Every model in the file is
 *      registered as a classifier (`type: "classifier"`) with the
 *      `typesafe-system-one` API.
 *      Config file locations (checked in order):
 *        a. <agentDir>/systemone-models.json  (alongside models.json,
 *           e.g. ~/.pi/agent/systemone-models.json). If it exists, it is the
 *           only file used.
 *        b. <extensionDir>/systemone-models.json  (alongside this extension).
 *           Used when location a does not exist.
 *
 *   2. `models.json` — pi's own model file (<agentDir>/models.json). Any
 *      model that carries `"type": "systemone"` is registered as a decider
 *      (classifier) instead of a chat model. pi ignores the `type` field
 *      itself (models.json has no model `type`), so this extension "takes
 *      over" the provider: it re-registers the provider under the same ID,
 *      re-declaring the provider's ordinary models as chat models (fields
 *      preserved, pi's defaults applied) and declaring the
 *      `"type": "systemone"` models as classifiers. Taken-over deciders
 *      never appear in `/model`.
 *
 * Usage:
 *   1. Fill in a systemone-models.json and/or mark deciders in models.json
 *      (see README.md).
 *   2. Restart pi, or run `/systemone` in a session to reload both files
 *      and re-register the providers.
 *   3. Do not define the same model in both places. A models.json entry
 *      cannot be prevented from being re-declared by this extension, and a
 *      provider ID used in both files is fully owned by the models.json
 *      takeover.
 *
 * Notes:
 * - Only the `typesafe-system-one` API is implemented here. pi's built-in
 *   implementation of that API is not importable from extensions (pi
 *   aliases `@earendil-works/pi-ai/*` specifiers away from extension
 *   loads), so the small protocol is implemented locally below.
 * - `bool` questions are sent as `noul` and answered as
 *   `{ type: "noul", noul: <probability of true> }`.
 * - A dummy `apiKey` (default "ignored") satisfies pi's provider
 *   authentication requirement; local servers ignore it or require a
 *   real key via their own `--api-key` (set `apiKey` to the real value).
 *   models.json providers that contain deciders need an `apiKey` of their
 *   own (the standard models.json practice for local servers), since this
 *   extension reuses the file's authentication instead of fabricating one.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config file format (systemone-models.json)
// ---------------------------------------------------------------------------

export interface CostDef {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: {
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[];
}

export interface ModelDef {
  id: string;
  name?: string;
  /** Classifier API. Only `typesafe-system-one` is implemented here. */
  api?: string;
  /** Overrides the provider-level baseUrl. */
  baseUrl?: string;
  contextWindow?: number;
  cost?: Partial<CostDef>;
  input?: ("text" | "image")[];
}

export interface ProviderDef {
  /** Display name for the provider. Defaults to the provider ID. */
  name?: string;
  /** e.g. "http://127.0.0.1:8081/v1" — must end in the API root. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`. Default: "ignored". */
  apiKey?: string;
  /** Default api for models without their own `api`. */
  api?: string;
  models: ModelDef[];
}

export interface ConfigFile {
  providers: Record<string, ProviderDef>;
}

const CONFIG_FILE_NAME = "systemone-models.json";
/** Name of pi's model file, read for `"type": "systemone"` decider models. */
const MODELS_JSON_NAME = "models.json";
/** The models.json model field that marks a model as a System One decider. */
export const SYSTEMONE_TYPE = "systemone";
export const SUPPORTED_API = "typesafe-system-one";

/** pi's default context window (modelFromJson). */
const DEFAULT_CONTEXT_WINDOW = 128000;
/** pi's default max output tokens (modelFromJson). */
const DEFAULT_MAX_TOKENS = 16384;

const ZERO_COST: CostDef = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Directory of this extension. pi loads extensions through jiti (CJS), where __dirname exists. */
export function getExtensionDir(): string {
  if (typeof __dirname !== "undefined" && __dirname) return __dirname;
  return fileURLToPath(new URL(".", import.meta.url));
}

/** The pi agent directory (where models.json lives). Mirrors pi's getAgentDir(). */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return envDir === "~" ? homedir() : envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
  }
  return join(homedir(), ".pi", "agent");
}

/** The path of pi's models.json file (<agentDir>/models.json). */
export function getModelsJsonPath(): string {
  return join(getAgentDir(), MODELS_JSON_NAME);
}

/**
 * Resolves which systemone-models.json to use:
 *   1. <agentDir>/systemone-models.json — alongside models.json; wins if present.
 *   2. <extensionDir>/systemone-models.json — alongside this extension.
 * Returns null when neither exists.
 */
export function resolveConfigPath(): string | null {
  const alongsideModelsJson = join(getAgentDir(), CONFIG_FILE_NAME);
  if (existsSync(alongsideModelsJson)) return alongsideModelsJson;
  const alongsideExtension = join(getExtensionDir(), CONFIG_FILE_NAME);
  if (existsSync(alongsideExtension)) return alongsideExtension;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`systemone-models.json: ${path}: ${message}`);
}

function failModelsJson(path: string, message: string): never {
  throw new Error(`models.json (pi-systemone-local): ${path}: ${message}`);
}

function asString(where: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail(where, "must be a non-empty string");
  return value;
}

/** Mirror of pi's stripBom. */
function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/** Mirror of pi's stripJsonComments: `//` line comments and trailing commas, strings untouched. */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

export function parseConfig(raw: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("<root>", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail("<root>", "top level must be an object");
  if (!isRecord(parsed.providers)) fail("providers", "must map provider IDs to provider definitions");

  const config: ConfigFile = { providers: {} };

  for (const [providerId, providerRaw] of Object.entries(parsed.providers)) {
    const where = `providers.${providerId}`;
    if (!isRecord(providerRaw)) fail(where, "must be an object");

    const baseUrl = asString(`${where}.baseUrl`, providerRaw.baseUrl);
    if (!/^(https?):\/\//i.test(baseUrl)) {
      fail(`${where}.baseUrl`, `must be an http(s) URL, got "${baseUrl}"`);
    }

    const provider: ProviderDef = { baseUrl };
    if (providerRaw.name !== undefined) provider.name = asString(`${where}.name`, providerRaw.name);
    if (providerRaw.apiKey !== undefined) provider.apiKey = asString(`${where}.apiKey`, providerRaw.apiKey);
    if (providerRaw.api !== undefined) provider.api = asString(`${where}.api`, providerRaw.api);

    if (!Array.isArray(providerRaw.models) || providerRaw.models.length === 0) {
      fail(`${where}.models`, "must be a non-empty array of model definitions");
    }

    const models: ModelDef[] = [];
    providerRaw.models.forEach((modelRaw: unknown, index: number) => {
      const mWhere = `${where}.models[${index}]`;
      if (!isRecord(modelRaw)) fail(mWhere, "must be an object");

      const id = asString(`${mWhere}.id`, modelRaw.id);
      if (models.some((m) => m.id === id)) fail(`${mWhere}.id`, `duplicate model id "${id}"`);

      const model: ModelDef = { id };
      if (modelRaw.name !== undefined) model.name = asString(`${mWhere}.name`, modelRaw.name);
      if (modelRaw.api !== undefined) model.api = asString(`${mWhere}.api`, modelRaw.api);
      if (modelRaw.baseUrl !== undefined) model.baseUrl = asString(`${mWhere}.baseUrl`, modelRaw.baseUrl);
      if (modelRaw.contextWindow !== undefined) {
        if (typeof modelRaw.contextWindow !== "number" || modelRaw.contextWindow <= 0) {
          fail(`${mWhere}.contextWindow`, "must be a positive number");
        }
        model.contextWindow = modelRaw.contextWindow;
      }
      if (modelRaw.cost !== undefined) {
        if (!isRecord(modelRaw.cost)) fail(`${mWhere}.cost`, "must be an object");
        const cost: CostDef = { ...ZERO_COST };
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = modelRaw.cost[key];
          if (value === undefined) continue;
          if (typeof value !== "number" || value < 0) {
            fail(`${mWhere}.cost.${key}`, "must be a non-negative number (USD per million tokens)");
          }
          cost[key] = value;
        }
        if (modelRaw.cost.tiers !== undefined) {
          if (!Array.isArray(modelRaw.cost.tiers)) fail(`${mWhere}.cost.tiers`, "must be an array");
          const tiers = [] as NonNullable<CostDef["tiers"]>;
          modelRaw.cost.tiers.forEach((tier: unknown, tierIndex: number) => {
            const tWhere = `${mWhere}.cost.tiers[${tierIndex}]`;
            if (!isRecord(tier)) fail(tWhere, "must be an object");
            if (typeof tier.inputTokensAbove !== "number") {
              fail(`${tWhere}.inputTokensAbove`, "must be a number");
            }
            const rates = {
              inputTokensAbove: tier.inputTokensAbove,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            };
            for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
              if (typeof tier[key] !== "number" || tier[key] < 0) {
                fail(`${tWhere}.${key}`, "must be a non-negative number");
              }
              rates[key] = tier[key];
            }
            tiers.push(rates);
          });
          cost.tiers = tiers;
        }
        model.cost = cost;
      }
      if (modelRaw.input !== undefined) {
        if (
          !Array.isArray(modelRaw.input) ||
          modelRaw.input.length === 0 ||
          modelRaw.input.some((v) => v !== "text" && v !== "image")
        ) {
          fail(`${mWhere}.input`, 'must be a non-empty array of "text" and/or "image"');
        }
        model.input = modelRaw.input as ("text" | "image")[];
      }

      models.push(model);
    });

    provider.models = models;
    config.providers[providerId] = provider;
  }

  return config;
}

// ---------------------------------------------------------------------------
// models.json integration ("type": "systemone")
// ---------------------------------------------------------------------------

/** A model entry in models.json, as far as this extension reads it. */
export interface ModelsJsonModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  /** `systemone` marks a decider; every other value (or absence) stays a chat model. */
  type?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  inputLimits?: Record<string, unknown>;
  cost?: CostDef;
  promptCache?: { short?: number; long?: number };
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

/** A provider entry in models.json, as far as this extension reads it. */
export interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models: ModelsJsonModel[];
}

export interface ModelsJsonFile {
  providers: Record<string, ModelsJsonProvider>;
}

function parseCostDef(where: string, raw: unknown): CostDef {
  if (!isRecord(raw)) failModelsJson(where, "must be an object");
  const cost: CostDef = { ...ZERO_COST };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      failModelsJson(`${where}.${key}`, "must be a non-negative number (USD per million tokens)");
    }
    cost[key] = value;
  }
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) failModelsJson(`${where}.tiers`, "must be an array");
    const tiers = [] as NonNullable<CostDef["tiers"]>;
    raw.tiers.forEach((tier: unknown, tierIndex: number) => {
      const tWhere = `${where}.tiers[${tierIndex}]`;
      if (!isRecord(tier)) failModelsJson(tWhere, "must be an object");
      if (typeof tier.inputTokensAbove !== "number") {
        failModelsJson(`${tWhere}.inputTokensAbove`, "must be a number");
      }
      const rates = {
        inputTokensAbove: tier.inputTokensAbove,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        if (typeof tier[key] !== "number" || tier[key] < 0) {
          failModelsJson(`${tWhere}.${key}`, "must be a non-negative number");
        }
        rates[key] = tier[key];
      }
      tiers.push(rates);
    });
    cost.tiers = tiers;
  }
  return cost;
}

/**
 * Lenient parse of pi's models.json. pi validates the file strictly first
 * (TypeBox schema) and applies its own defaults, so this parser only checks
 * what the takeover needs and passes everything else through verbatim.
 */
export function parseModelsJson(raw: string): ModelsJsonFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(stripBom(raw)));
  } catch (error) {
    failModelsJson("<root>", `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) failModelsJson("<root>", "top level must be an object");
  if (!isRecord(parsed.providers)) failModelsJson("providers", "must map provider IDs to provider definitions");

  const file: ModelsJsonFile = { providers: {} };

  for (const [providerId, providerRaw] of Object.entries(parsed.providers)) {
    const where = `providers.${providerId}`;
    if (!isRecord(providerRaw)) failModelsJson(where, "must be an object");

    const provider: ModelsJsonProvider = { models: [] };
    if (providerRaw.name !== undefined) {
      if (typeof providerRaw.name !== "string") failModelsJson(`${where}.name`, "must be a string");
      provider.name = providerRaw.name;
    }
    if (providerRaw.baseUrl !== undefined) {
      if (typeof providerRaw.baseUrl !== "string") failModelsJson(`${where}.baseUrl`, "must be a string");
      provider.baseUrl = providerRaw.baseUrl;
    }
    if (providerRaw.apiKey !== undefined) {
      if (typeof providerRaw.apiKey !== "string") failModelsJson(`${where}.apiKey`, "must be a string");
      provider.apiKey = providerRaw.apiKey;
    }
    if (providerRaw.api !== undefined) {
      if (typeof providerRaw.api !== "string") failModelsJson(`${where}.api`, "must be a string");
      provider.api = providerRaw.api;
    }
    if (providerRaw.headers !== undefined) {
      if (!isRecord(providerRaw.headers)) failModelsJson(`${where}.headers`, "must be an object");
      provider.headers = providerRaw.headers as Record<string, string>;
    }
    if (providerRaw.authHeader !== undefined) {
      if (typeof providerRaw.authHeader !== "boolean") failModelsJson(`${where}.authHeader`, "must be a boolean");
      provider.authHeader = providerRaw.authHeader;
    }
    if (providerRaw.compat !== undefined) {
      if (!isRecord(providerRaw.compat)) failModelsJson(`${where}.compat`, "must be an object");
      provider.compat = providerRaw.compat;
    }

    if (providerRaw.models !== undefined) {
      if (!Array.isArray(providerRaw.models)) failModelsJson(`${where}.models`, "must be an array");
      providerRaw.models.forEach((modelRaw: unknown, index: number) => {
        const mWhere = `${where}.models[${index}]`;
        if (!isRecord(modelRaw)) failModelsJson(mWhere, "must be an object");

        const id = modelRaw.id;
        if (typeof id !== "string" || id.length === 0) failModelsJson(`${mWhere}.id`, "must be a non-empty string");

        const model: ModelsJsonModel = { id };
        if (modelRaw.name !== undefined) {
          if (typeof modelRaw.name !== "string") failModelsJson(`${mWhere}.name`, "must be a string");
          model.name = modelRaw.name;
        }
        if (modelRaw.api !== undefined) {
          if (typeof modelRaw.api !== "string") failModelsJson(`${mWhere}.api`, "must be a string");
          model.api = modelRaw.api;
        }
        if (modelRaw.baseUrl !== undefined) {
          if (typeof modelRaw.baseUrl !== "string") failModelsJson(`${mWhere}.baseUrl`, "must be a string");
          model.baseUrl = modelRaw.baseUrl;
        }
        if (modelRaw.type !== undefined) {
          if (typeof modelRaw.type !== "string") failModelsJson(`${mWhere}.type`, "must be a string");
          model.type = modelRaw.type;
        }
        if (modelRaw.reasoning !== undefined) {
          if (typeof modelRaw.reasoning !== "boolean") failModelsJson(`${mWhere}.reasoning`, "must be a boolean");
          model.reasoning = modelRaw.reasoning;
        }
        if (modelRaw.thinkingLevelMap !== undefined) {
          if (!isRecord(modelRaw.thinkingLevelMap)) failModelsJson(`${mWhere}.thinkingLevelMap`, "must be an object");
          model.thinkingLevelMap = modelRaw.thinkingLevelMap as Record<string, string | null>;
        }
        if (modelRaw.input !== undefined) {
          if (
            !Array.isArray(modelRaw.input) ||
            modelRaw.input.length === 0 ||
            modelRaw.input.some((v) => v !== "text" && v !== "image")
          ) {
            failModelsJson(`${mWhere}.input`, 'must be a non-empty array of "text" and/or "image"');
          }
          model.input = modelRaw.input as ("text" | "image")[];
        }
        if (modelRaw.inputLimits !== undefined) {
          if (!isRecord(modelRaw.inputLimits)) failModelsJson(`${mWhere}.inputLimits`, "must be an object");
          model.inputLimits = modelRaw.inputLimits;
        }
        if (modelRaw.cost !== undefined) model.cost = parseCostDef(`${mWhere}.cost`, modelRaw.cost);
        if (modelRaw.promptCache !== undefined) {
          if (!isRecord(modelRaw.promptCache)) failModelsJson(`${mWhere}.promptCache`, "must be an object");
          model.promptCache = modelRaw.promptCache as { short?: number; long?: number };
        }
        if (modelRaw.contextWindow !== undefined) {
          if (typeof modelRaw.contextWindow !== "number" || modelRaw.contextWindow <= 0) {
            failModelsJson(`${mWhere}.contextWindow`, "must be a positive number");
          }
          model.contextWindow = modelRaw.contextWindow;
        }
        if (modelRaw.maxTokens !== undefined) {
          if (typeof modelRaw.maxTokens !== "number" || modelRaw.maxTokens <= 0) {
            failModelsJson(`${mWhere}.maxTokens`, "must be a positive number");
          }
          model.maxTokens = modelRaw.maxTokens;
        }
        if (modelRaw.samplingParams !== undefined) {
          if (!isRecord(modelRaw.samplingParams)) failModelsJson(`${mWhere}.samplingParams`, "must be an object");
          model.samplingParams = modelRaw.samplingParams;
        }
        if (modelRaw.samplingParamsByThinkingLevel !== undefined) {
          if (!isRecord(modelRaw.samplingParamsByThinkingLevel)) {
            failModelsJson(`${mWhere}.samplingParamsByThinkingLevel`, "must be an object");
          }
          model.samplingParamsByThinkingLevel = modelRaw.samplingParamsByThinkingLevel as Record<string, Record<string, unknown>>;
        }
        if (modelRaw.headers !== undefined) {
          if (!isRecord(modelRaw.headers)) failModelsJson(`${mWhere}.headers`, "must be an object");
          model.headers = modelRaw.headers as Record<string, string>;
        }
        if (modelRaw.compat !== undefined) {
          if (!isRecord(modelRaw.compat)) failModelsJson(`${mWhere}.compat`, "must be an object");
          model.compat = modelRaw.compat;
        }

        provider.models.push(model);
      });
    }

    file.providers[providerId] = provider;
  }

  return file;
}

/**
 * Mirror of pi's mergeCompat: deep-merges the provider-level and model-level
 * `compat` objects (models.json composition applies the same merge).
 */
export function mergeCompat(base: unknown, override: unknown): unknown {
  if (!override) return base;
  const merged: Record<string, unknown> = { ...((base && typeof base === "object") ? base : {}), ...(override as object) };
  const baseNested = (base && typeof base === "object" ? base : undefined) as Record<string, unknown> | undefined;
  const overrideNested = override as Record<string, unknown>;
  for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"]) {
    const baseValue = baseNested?.[key];
    const overrideValue = overrideNested[key];
    if ((typeof baseValue === "object" && baseValue !== null) || (typeof overrideValue === "object" && overrideValue !== null)) {
      merged[key] = { ...((baseValue && typeof baseValue === "object") ? baseValue : {}), ...((overrideValue && typeof overrideValue === "object") ? overrideValue : {}) };
    }
  }
  return merged;
}

/**
 * A provider from models.json that contains at least one decider. The
 * extension re-registers it under the same ID; pi's composition then uses
 * this model list instead of the models.json entries (registerProvider with
 * `models` replaces all of a provider's models).
 */
export interface Takeover {
  providerId: string;
  /** The pi.registerProvider config for the takeover. */
  config: {
    name?: string;
    baseUrl?: string;
    models: ProviderModelConfig[];
    classifiers: { [SUPPORTED_API]: { classify: typeof systemOneClassify } };
  };
  /** Model IDs declared as System One deciders (classifiers). */
  deciders: string[];
  /** Model IDs re-declared as chat models. */
  chat: string[];
}

/**
 * Computes the takeovers for a parsed models.json: one per provider that
 * has at least one `type: "systemone"` model.
 *
 * - `type: "systemone"` models become classifier models
 *   (`type: "classifier"`, `api: "typesafe-system-one"`, text-only) and are
 *   not re-declared as chat models.
 * - Every other model in the provider is re-declared as a chat model with
 *   the same fields and the same defaults pi applies to models.json entries
 *   (pi's modelFromJson: contextWindow 128000, maxTokens 16384, zero cost,
 *   text input, no reasoning, provider+model compat merge).
 * - Duplicate model IDs follow pi's upsert semantics: last entry wins, in
 *   first-seen order.
 */
export function computeTakeovers(file: ModelsJsonFile): Takeover[] {
  const takeovers: Takeover[] = [];

  for (const [providerId, provider] of Object.entries(file.providers)) {
    if (!provider.models.some((m) => m.type === SYSTEMONE_TYPE)) continue;
    const where = `providers.${providerId}`;

    // pi's applyModelsJson upserts duplicate IDs in place (last wins).
    const models = [] as ModelsJsonModel[];
    const indexById = new Map<string, number>();
    for (const model of provider.models) {
      const existing = indexById.get(model.id);
      if (existing === undefined) {
        indexById.set(model.id, models.length);
        models.push(model);
      } else {
        models[existing] = model;
      }
    }

    const providerModels: ProviderModelConfig[] = [];
    const deciders: string[] = [];
    const chat: string[] = [];

    for (const model of models) {
      const mWhere = `${where}.models["${model.id}"]`;

      if (model.type === SYSTEMONE_TYPE) {
        if (model.api !== undefined && model.api !== SUPPORTED_API) {
          failModelsJson(mWhere, `a ${SYSTEMONE_TYPE} model has api "${model.api}", but System One deciders use api "${SUPPORTED_API}" (drop the api field or set it to "${SUPPORTED_API}")`);
        }
        const baseUrl = model.baseUrl ?? provider.baseUrl;
        if (!baseUrl) {
          failModelsJson(mWhere, `a ${SYSTEMONE_TYPE} model needs a baseUrl (set it on the model or the provider)`);
        }
        providerModels.push({
          type: "classifier",
          id: model.id,
          name: model.name ?? model.id,
          api: SUPPORTED_API,
          baseUrl,
          contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          cost: model.cost ?? { ...ZERO_COST },
          input: ["text"],
        } as ProviderModelConfig);
        deciders.push(model.id);
        continue;
      }

      const api = model.api ?? provider.api;
      if (!api) {
        failModelsJson(mWhere, 'no "api" at model or provider level — pi requires one for every models.json model');
      }
      const baseUrl = model.baseUrl ?? provider.baseUrl;
      if (!baseUrl) {
        failModelsJson(mWhere, 'no "baseUrl" at model or provider level — pi requires one for every models.json model');
      }
      providerModels.push({
        type: "chat",
        id: model.id,
        name: model.name ?? model.id,
        api,
        baseUrl,
        reasoning: model.reasoning ?? false,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input ?? ["text"],
        inputLimits: model.inputLimits,
        cost: model.cost ?? { ...ZERO_COST },
        promptCache: model.promptCache,
        contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
        samplingParams: model.samplingParams,
        samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel,
        headers: model.headers,
        compat: mergeCompat(provider.compat, model.compat),
      } as ProviderModelConfig);
      chat.push(model.id);
    }

    takeovers.push({
      providerId,
      config: {
        name: provider.name,
        baseUrl: provider.baseUrl,
        models: providerModels,
        classifiers: { [SUPPORTED_API]: { classify: systemOneClassify } },
      },
      deciders,
      chat,
    });
  }

  return takeovers;
}

// ---------------------------------------------------------------------------
// System One classification (typesafe-system-one API)
//
// Mirrors pi's built-in classifier implementation: POST { model, state,
// questions } to {baseUrl}/systemone; `bool` questions go out as `noul`.
// ---------------------------------------------------------------------------

export interface ClassifierModel {
  id: string;
  provider: string;
  baseUrl: string;
  api: string;
  cost: CostDef;
}

interface ClassifierQuestion {
  type: "choice" | "score" | "bool";
  instructions: string;
  criteria: unknown;
}

export interface ClassifierContext {
  state: Record<string, unknown>;
  images?: { type: "image"; data: string; mimeType: string }[];
  questions: Record<string, ClassifierQuestion>;
}

export interface ClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, unknown>;
  stopReason: "stop" | "error" | "aborted";
  timestamp: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  errorMessage?: string;
}

export interface ClassifierOptions {
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onPayload?: (
    payload: Record<string, unknown>,
    model: ClassifierModel,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  onResponse?: (
    response: { status: number; headers: Record<string, string> },
    model: ClassifierModel,
  ) => void | Promise<void>;
}

function wireRequest(context: ClassifierContext): Record<string, unknown> {
  return {
    state: context.state,
    questions: Object.fromEntries(
      Object.entries(context.questions).map(([id, question]) => [
        id,
        question.type === "bool" ? { ...question, type: "noul" } : question,
      ]),
    ),
  };
}

function requiredNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`System One API returned an invalid ${what}`);
  }
  return value;
}

function parseProbabilities(value: unknown, id: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`System One API returned invalid probabilities for ${id}`);
  return Object.fromEntries(
    Object.entries(value).map(([key, probability]) => [
      key,
      requiredNumber(probability, `probability for ${id}.${key}`),
    ]),
  );
}

function parseAnswers(value: unknown, context: ClassifierContext): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("System One API returned an unexpected response");
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = value[id];
    if (!isRecord(answer)) throw new Error(`System One API did not return an answer for ${id}`);
    if (question.type === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new Error(`System One API did not return a choice answer for ${id}`);
      }
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: parseProbabilities(answer.probabilities, id),
        confidence: requiredNumber(answer.confidence, `confidence for ${id}`),
      };
    } else if (question.type === "score") {
      if (answer.type !== "score") throw new Error(`System One API did not return a score answer for ${id}`);
      answers[id] = {
        type: "score",
        score: requiredNumber(answer.score, `score for ${id}`),
        confidence: requiredNumber(answer.confidence, `confidence for ${id}`),
      };
    } else {
      if (answer.type !== "noul") throw new Error(`System One API did not return a bool answer for ${id}`);
      answers[id] = { type: "bool", probability: requiredNumber(answer.noul, `probability for ${id}`) };
    }
  }
  return answers;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function calculateCost(model: ClassifierModel, usage: NonNullable<ClassifierResult["usage"]>): void {
  let rates = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (usage.input > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = { input: tier.input, output: tier.output, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite };
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  usage.cost.input = (rates.input / 1e6) * usage.input;
  usage.cost.output = (rates.output / 1e6) * usage.output;
  usage.cost.cacheRead = (rates.cacheRead / 1e6) * usage.cacheRead;
  usage.cost.cacheWrite = (rates.cacheWrite / 1e6) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function parseUsage(value: unknown, model: ClassifierModel): ClassifierResult["usage"] | undefined {
  if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) {
    return undefined;
  }
  const input = tokenCount(value.input_tokens);
  const output = tokenCount(value.output_tokens);
  const usage = {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postSystemOneRequest(
  url: string,
  model: ClassifierModel,
  payload: Record<string, unknown>,
  options: ClassifierOptions,
): Promise<unknown> {
  if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);

  let body = payload;
  const transformed = await options.onPayload?.(payload, model);
  if (transformed !== undefined) body = transformed;

  const requestFetch = options.fetch ?? globalThis.fetch;
  const maxRetries = options.maxRetries ?? 2;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 2000;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
  if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");

    const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal =
      options.signal && timeoutSignal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : options.signal ?? timeoutSignal;

    try {
      const response = await requestFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(
          `System One API error: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`,
        );
        // Retry 429/5xx; anything else fails immediately.
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          await sleep(Math.min(500 * 2 ** attempt, maxRetryDelayMs), options.signal);
          continue;
        }
        throw error;
      }

      await options.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        model,
      );
      return await response.json();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const isTimeout =
        timeoutSignal !== undefined &&
        timeoutSignal.aborted &&
        (error as Error | undefined)?.name === "TimeoutError";
      if (isTimeout) {
        throw new Error(`System One API request timed out after ${options.timeoutMs}ms`);
      }
      // Network failure (connection refused, reset, ...): retry, then rethrow.
      if (attempt < maxRetries) {
        await sleep(Math.min(500 * 2 ** attempt, maxRetryDelayMs), options.signal);
        continue;
      }
      throw error;
    }
  }
}

export async function systemOneClassify(
  model: ClassifierModel,
  context: ClassifierContext,
  options: ClassifierOptions,
): Promise<ClassifierResult> {
  const output: ClassifierResult = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    if (model.api !== SUPPORTED_API) throw new Error(`Unsupported classifier API: ${model.api}`);
    if (context.images?.length) throw new Error("System One API does not support image input");
    const url = new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`).toString();
    const payload = { model: model.id, ...wireRequest(context) };
    const result = await postSystemOneRequest(url, model, payload, options);
    if (!isRecord(result)) throw new Error("System One API returned an unexpected response");
    const usage = parseUsage(result.usage, model);
    if (usage) output.usage = usage;
    output.answers = parseAnswers(result.answers, context);
    return output;
  } catch (error) {
    output.stopReason = options.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    return output;
  }
}

// ---------------------------------------------------------------------------
// Provider registration (both config sources)
// ---------------------------------------------------------------------------

interface RegisteredModel {
  type: "classifier";
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  input: ("text" | "image")[];
  contextWindow: number;
  cost: CostDef;
}

function buildModels(providerId: string, def: ProviderDef): RegisteredModel[] {
  const providerApi = def.api ?? SUPPORTED_API;
  return def.models.map((model) => {
    const api = model.api ?? providerApi;
    if (api !== SUPPORTED_API) {
      throw new Error(
        `systemone-models.json: providers.${providerId} (model ${model.id}): ` +
          `only api "${SUPPORTED_API}" is implemented by this extension (got "${api}")`,
      );
    }
    return {
      type: "classifier" as const,
      id: model.id,
      name: model.name ?? model.id,
      api,
      baseUrl: model.baseUrl ?? def.baseUrl,
      input: model.input ?? ["text"],
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      cost: model.cost ?? { ...ZERO_COST },
    };
  });
}

interface FileSummary {
  path: string;
  providers: { id: string; models: string[] }[];
}

interface TakeoverSummary {
  providerId: string;
  deciders: string[];
  chat: string[];
}

interface ApplyResult {
  /** systemone-models.json providers (null when the file is missing/errored). */
  file: FileSummary | null;
  /** Why the file was skipped, e.g. "config file not found (...)". */
  fileError?: string;
  /** Path of the models.json that was inspected (null when absent). */
  modelsJsonPath: string | null;
  /** models.json providers that were taken over for their deciders. */
  takeovers: TakeoverSummary[];
}

/** Providers this extension currently has registered, and from which source. */
const managedProviders = new Map<string, "file" | "modelsJson">();

function loadFileConfig(): { path: string; config: ConfigFile } {
  const filePath = resolveConfigPath();
  if (filePath === null) {
    throw new Error(
      `config file not found (looked in ${join(getAgentDir(), CONFIG_FILE_NAME)} and ` +
        `${join(getExtensionDir(), CONFIG_FILE_NAME)})`,
    );
  }
  return { path: filePath, config: parseConfig(readFileSync(filePath, "utf-8")) };
}

/** Reads pi's models.json for decider models; null when the file is absent. */
function loadModelsJsonFile(): { path: string; file: ModelsJsonFile } | null {
  const path = getModelsJsonPath();
  if (!existsSync(path)) return null;
  return { path, file: parseModelsJson(readFileSync(path, "utf-8")) };
}

/**
 * Applies both config sources:
 *   - systemone-models.json providers (all models are deciders), and
 *   - models.json takeovers for providers with `"type": "systemone"` models.
 * A provider ID present in both sources is owned by the models.json takeover
 * (takeovers are registered after the file providers). Stale registrations
 * (providers no longer present) are unregistered.
 */
function applyAll(pi: ExtensionAPI): ApplyResult {
  // 1. Read the sources.
  let filePart: FileSummary | null = null;
  let fileError: string | undefined;
  let fileConfig: ConfigFile | null = null;
  try {
    const loaded = loadFileConfig();
    fileConfig = loaded.config;
    filePart = {
      path: loaded.path,
      providers: Object.entries(loaded.config.providers).map(([id, def]) => ({
        id,
        models: def.models.map((m) => m.id),
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("config file not found")) throw new Error(message);
    fileError = message;
  }

  // A missing models.json is not an error; an unreadable/unparsable one is
  // (pi itself reports the same file as broken).
  const modelsJsonFile = loadModelsJsonFile();
  const takeovers = modelsJsonFile ? computeTakeovers(modelsJsonFile.file) : [];

  // 2. Determine the desired provider set; models.json wins on ID collisions.
  const desired = new Map<string, "file" | "modelsJson">();
  if (fileConfig) {
    for (const id of Object.keys(fileConfig.providers)) desired.set(id, "file");
  }
  for (const takeover of takeovers) desired.set(takeover.providerId, "modelsJson");

  // 3. Drop providers that are no longer managed.
  for (const id of [...managedProviders.keys()]) {
    if (!desired.has(id)) {
      try {
        pi.unregisterProvider(id);
      } catch {
        // best effort
      }
    }
  }

  // 4. (Re)register the file providers. Re-registering an existing provider
  //    ID replaces its models, so this doubles as a hot reload.
  if (fileConfig) {
    for (const [providerId, def] of Object.entries(fileConfig.providers)) {
      pi.registerProvider(providerId, {
        name: def.name ?? providerId,
        baseUrl: def.baseUrl,
        apiKey: def.apiKey ?? "ignored",
        models: buildModels(providerId, def),
        classifiers: {
          [SUPPORTED_API]: { classify: systemOneClassify },
        },
      });
    }
  }

  // 5. (Re)register the models.json takeovers. With `models` set, pi uses
  //    this list instead of the provider's models.json entries, so the
  //    deciders are classifiers (not chat) and the ordinary models stay
  //    chat models with their original fields.
  for (const takeover of takeovers) {
    pi.registerProvider(takeover.providerId, takeover.config);
  }

  managedProviders.clear();
  for (const [id, source] of desired) managedProviders.set(id, source);

  return {
    file: filePart,
    fileError,
    modelsJsonPath: modelsJsonFile?.path ?? null,
    takeovers: takeovers.map(({ providerId, deciders, chat }) => ({ providerId, deciders, chat })),
  };
}

function formatApplyResult(result: ApplyResult): string {
  const lines: string[] = ["System One reloaded"];
  if (result.file) {
    lines.push(`systemone-models.json: ${result.file.path}`);
    for (const p of result.file.providers) {
      lines.push(`  ${p.id}: ${p.models.join(", ")} (all deciders)`);
    }
  } else {
    lines.push(`systemone-models.json: ${result.fileError ?? "not found"}`);
  }
  if (result.modelsJsonPath) {
    lines.push(`models.json: ${result.modelsJsonPath}`);
    if (result.takeovers.length === 0) {
      lines.push('  no "type": "systemone" models');
    }
    for (const t of result.takeovers) {
      lines.push(`  ${t.providerId}: decider(s) ${t.deciders.join(", ")}` +
        (t.chat.length > 0 ? `; chat kept: ${t.chat.join(", ")}` : ""));
    }
  } else {
    lines.push("models.json: not found");
  }
  return lines.join("\n");
}

export default function systemOneLocalExtension(pi: ExtensionAPI): void {
  try {
    const result = applyAll(pi);
    if (result.file === null && result.fileError) {
      // Stay loaded (and keep /systemone available) so the file can be
      // created and loaded without a restart.
      console.warn(`[pi-systemone-local] ${result.fileError}`);
    }
    for (const t of result.takeovers) {
      console.log(
        `[pi-systemone-local] models.json provider "${t.providerId}" taken over: ` +
          `decider(s) ${t.deciders.join(", ")}` +
          (t.chat.length > 0 ? `; chat model(s) kept: ${t.chat.join(", ")}` : "; no chat models"),
      );
    }
  } catch (error) {
    // Invalid config: surface it as an extension load error.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith("pi-systemone-local:") ? message : `pi-systemone-local: ${message}`);
  }

  pi.registerCommand("systemone", {
    description:
      'Reload systemone-models.json and models.json ("type": "systemone" deciders) and re-register the providers',
    handler: async (_name, ctx) => {
      try {
        const result = applyAll(pi);
        ctx.ui.notify(formatApplyResult(result), "info");
      } catch (error) {
        ctx.ui.notify(
          `System One reload failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
