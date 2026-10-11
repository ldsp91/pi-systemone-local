# pi-systemone-local

Registers **System One "decider" models** for pi — classifier models
(`type: "classifier"`) with the `typesafe-system-one` API, i.e. TypeSafe's
d1 decision models. Deciders are visible from codemode scripts via
`models.getAvailableOfType("classifier")` and callable with
`models.classify()`. They never appear in `/model`.

The extension implements the System One wire protocol itself: a JSON POST
of `{ model, state, questions }` to `{baseUrl}/systemone` — the decision
endpoint served by TypeSafe's API and by llama.cpp / llama-swap routers
for decision models. (pi's built-in implementation of that API cannot be
imported from extensions, because pi aliases `@earendil-works/pi-ai/*`
specifiers away from extension loads — hence the small local
implementation.)

Models can be declared in two places:

| Source | What it does |
|---|---|
| `systemone-models.json` | Standalone file; **every** model in it is a decider |
| `models.json` (pi's model file) | Any model with `"type": "systemone"` becomes a decider instead of a chat model |

## 1. `systemone-models.json`

Config file locations (checked in order):

1. **`<agentDir>/systemone-models.json`** — alongside `models.json`
   (e.g. `~/.pi/agent/systemone-models.json`). **If it exists, it is the
   only file used** — it fully overrides location 2.
2. **`<extensionDir>/systemone-models.json`** — alongside this extension
   (the checked-in seed file).

If neither exists, no providers are registered from this source (the
extension stays loaded; `/systemone` reports the situation).

`<agentDir>` is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.

### Format

```json
{
  "providers": {
    "<provider-id>": {
      "name": "Display Name",            // optional; defaults to provider-id
      "baseUrl": "http://127.0.0.1:8081/v1",   // required; ends in the API root
      "apiKey": "ignored",               // optional; sent as Bearer key; default "ignored"
      "api": "typesafe-system-one",       // optional default api for the models below
      "models": [
        {
          "id": "d1-3B",                  // required
          "name": "d1 3B",                // optional; defaults to id
          "api": "typesafe-system-one",   // optional; only this api is implemented
          "baseUrl": "http://.../v1",     // optional; overrides the provider baseUrl
          "contextWindow": 32768,         // optional; default 128000
          "cost": {                       // optional; USD per million tokens; default all zeros
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0,
            "tiers": [                    // optional
              { "inputTokensAbove": 128000, "input": 0.08, "output": 0.08, "cacheRead": 0, "cacheWrite": 0 }
            ]
          },
          "input": ["text"]               // optional; default ["text"] (System One is text-only)
        }
      ]
    }
  }
}
```

Notes:

- **Only `typesafe-system-one` is supported.** The request goes to
  `{baseUrl}/systemone`; `bool` questions are sent as `noul` and answered
  as `{ type: "noul", noul: <probability of true> }`. `choice` questions
  come back with per-option `probabilities` and a `confidence`; `score`
  questions with an expected `score` and `confidence`.
- For local servers the `apiKey` is only there to satisfy pi's provider
  authentication requirement; use a real value if the server runs with
  `--api-key`.

## 2. `models.json`: `"type": "systemone"` deciders

pi's own model file (`<agentDir>/models.json`) has no model `type` field —
pi validates the extra field and then ignores it, registering the model as
a chat model. This extension intercepts that: for every `models.json`
provider that contains at least one model with `"type": "systemone"`, the
extension **takes over the provider** by re-registering it under the same
ID (pi replaces a provider's model list when an extension registers
`models` for it):

- models with `"type": "systemone"` are declared as **deciders** —
  classifier models with `api: "typesafe-system-one"`, text-only. They are
  **not** re-declared as chat models, so they never appear in `/model`.
- every other model in the provider is re-declared as a **chat model**
  with its fields preserved and the same defaults pi applies to
  `models.json` entries (`contextWindow` 128000, `maxTokens` 16384, zero
  cost, text input). Duplicate model IDs follow pi's upsert rule (last
  entry wins).

```json
{
  "providers": {
    "mac-llamacpp": {
      "baseUrl": "http://127.0.0.1:8081/v1",
      "api": "openai-completions",
      "apiKey": "ignored",
      "models": [
        { "id": "Qwen3.8-27B", "reasoning": true },
        { "id": "d1-3B", "type": "systemone", "contextWindow": 32768 }
      ]
    },
    "decider-only": {
      "baseUrl": "http://127.0.0.1:8082/v1",
      "api": "typesafe-system-one",
      "apiKey": "ignored",
      "models": [
        { "id": "d1-3B", "type": "systemone" }
      ]
    }
  }
}
```

Rules and caveats:

- **The provider must be fully usable as models.json defines it**: a
  resolvable `api` (model or provider level) and `baseUrl` for every
  model, and an `apiKey` (a dummy like `"ignored"` is the standard models.json
  practice for local servers). The extension reuses the file's
  authentication instead of fabricating one. For a provider that holds
  only deciders, set `"api": "typesafe-system-one"` at the provider level.
- A decider's `baseUrl` defaults to the provider `baseUrl` (a model-level
  `baseUrl` overrides it). Its `contextWindow` (default 128000) and
  `cost` (default all zeros) are honored.
- A decider must not set a model-level `api` other than
  `typesafe-system-one` (the extension rejects that as a misconfiguration;
  a provider-level `api` is fine — it only defaults the chat models).
- **The takeover owns the provider's whole model list.** The list becomes
  exactly the `models.json` entries (chat re-declared + deciders as
  classifiers). If the provider ID is also a built-in pi provider, that
  provider's catalog models are replaced — so use a dedicated provider ID
  for local servers, which is the common case anyway. The extension logs
  every takeover at startup.
- **Don't mix the same provider ID in `systemone-models.json` and
  `models.json`.** If it happens, the `models.json` takeover wins (it is
  registered after the file providers).
- pi reloads `models.json` itself for the chat side (e.g. when `/model`
  opens), but the decider side is applied by this extension at startup and
  by `/systemone`. Edit `models.json`, then run **`/systemone`** to pick
  up decider changes without restarting.

## Usage

1. Declare your deciders in `systemone-models.json` and/or mark them with
   `"type": "systemone"` in `models.json`.
2. Restart pi, or run **`/systemone`** in a session to reload both files
   and re-register the providers without restarting. `/systemone` reports
   which files were used, which providers were registered or taken over,
   and which models are deciders vs. kept as chat models.
3. Use the models from codemode:

```js
const result = await models.classify(
  { provider: "mac-llamacpp", id: "d1-3B" },
  {
    state: { userMessage: 'The user says: "That looks great. Let\'s ship it!"' },
    questions: {
      approval: {
        type: "bool",
        instructions: "Determine whether the user explicitly approves shipping the proposed change.",
        criteria: {
          true: "The user clearly approves shipping the change.",
          false: "The user does not approve shipping the change, or approval is ambiguous.",
        },
      },
    },
  },
);
// result.answers.approval => { type: "bool", probability: 0.96 }
```

## Requirements

- The server must be reachable at `baseUrl` and serve the System One
  endpoint (`/v1/systemone` for a `/v1` root). For llama.cpp/llama-swap,
  this means the decision model is loaded in a router-mode server built
  with System One support.
- A `models.classify()` call against an unreachable server fails
  gracefully: it returns `stopReason: "error"` with a network error in
  `errorMessage` (after up to 2 retries of transient failures), not a
  thrown exception.

## Development

```bash
# load just this extension in a dev session
pi --extension /Users/levent/agents/pi/extensions/pi-systemone-local

# reload the configs at runtime
/systemone
```
