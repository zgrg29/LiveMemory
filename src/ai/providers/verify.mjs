import {callProvider, listProviderModels, ProviderHttpError, PROVIDER_ERROR} from './adapters.mjs';
import {PRICING_STATUS} from './catalog.mjs';
import {estimateTokensFromText} from './pricing.mjs';
import {assertSafeResolvedUrl} from './url-safety.mjs';

/**
 * Capability verification.
 *
 * HTTP 200 is not "the model works". Each stage is separate:
 *   network -> auth -> text -> json -> session -> memory
 *
 * The memory probe is a synthetic LiveMemory-style task: three viewers, mixed
 * languages, one viewer with no semantic evidence, explicit evidence seqs. A
 * model only gets `capabilities.memory=true` if it returns all three refs and
 * legal evidence. The result is tied to provider + region + model + time and is
 * invalidated when any of those change.
 */

const SYSTEM = 'You are a JSON-only test responder for LiveMemory. Follow the requested JSON shape exactly. Do not add prose.';

function extractJson(text) {
  const source = String(text ?? '').trim().replace(/^```[A-Za-z0-9_-]*\s*/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function stageError(error) {
  if (error instanceof ProviderHttpError) {
    return {code: error.code, status: error.status, detail: error.detail};
  }
  return {code: 'PROVIDER_TEST_FAILED', detail: String(error?.message ?? error?.name ?? 'unknown').slice(0, 200)};
}

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {ok: {type: 'boolean'}}
};

const SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'topics'],
  properties: {
    summary: {type: 'string'},
    topics: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary'],
        properties: {
          title: {type: 'string'},
          summary: {type: 'string'}
        }
      }
    }
  }
};

const MEMORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['viewers'],
  properties: {
    viewers: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'no_new_information', 'operations'],
        properties: {
          ref: {type: 'integer', minimum: 1, maximum: 3},
          no_new_information: {type: 'boolean'},
          operations: {
            type: 'array',
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['op', 'kind', 'topic', 'statement', 'certainty', 'evidence'],
              properties: {
                op: {enum: ['add', 'confirm']},
                kind: {enum: ['interest', 'topic']},
                topic: {type: 'string'},
                statement: {type: 'string'},
                certainty: {enum: ['stated']},
                evidence: {type: 'array', items: {type: 'integer'}, minItems: 1, maxItems: 2}
              }
            }
          }
        }
      }
    }
  }
};

function memoryProbeMessages() {
  return [
    {role: 'system', content: SYSTEM},
    {
      role: 'user',
      content: [
        'Synthetic LiveMemory memory test. Three viewers, each assigned a ref:',
        'ref 1: viewer "A" / seq 1: "I started learning guitar last month."',
        'ref 2: viewer "B" / seq 2: "最近は絵を描くのが楽しいです。"',
        'ref 3: viewer "C" has no chat excerpt (gift only).',
        'Return exactly one JSON object:',
        '{"viewers":[{"ref":1,"no_new_information":false,"operations":[{"op":"add","kind":"interest","topic":"guitar","statement":"started learning guitar","certainty":"stated","evidence":[1]}]},{"ref":2,"no_new_information":false,"operations":[{"op":"add","kind":"interest","topic":"drawing","statement":"enjoys drawing","certainty":"stated","evidence":[2]}]},{"ref":3,"no_new_information":true,"operations":[]}]}',
        'Rules: cover refs 1, 2 and 3 exactly once. Never invent a ref. Only use evidence seq 1 for ref 1 and seq 2 for ref 2; ref 3 has no evidence and must be no_new_information. Reply in the viewer language. JSON only.'
      ].join('\n')
    }
  ];
}

function validateMemoryProbe(object) {
  const viewers = Array.isArray(object?.viewers) ? object.viewers : null;
  if (!viewers || viewers.length !== 3) return {ok: false, code: 'MEMORY_COVERAGE'};
  const byRef = new Map();
  for (const viewer of viewers) {
    const ref = Number(viewer?.ref);
    if (![1, 2, 3].includes(ref) || byRef.has(ref)) return {ok: false, code: 'MEMORY_REF'};
    byRef.set(ref, viewer);
  }
  if (byRef.size !== 3) return {ok: false, code: 'MEMORY_COVERAGE'};
  for (const ref of [1, 2]) {
    const viewer = byRef.get(ref);
    if (viewer.no_new_information === true || !Array.isArray(viewer.operations) || viewer.operations.length === 0) {
      return {ok: false, code: 'MEMORY_SEMANTIC_MISSING'};
    }
    for (const operation of viewer.operations) {
      if (!Array.isArray(operation.evidence) || operation.evidence.length === 0) {
        return {ok: false, code: 'MEMORY_EVIDENCE_MISSING'};
      }
      if (!operation.evidence.every((seq) => Number(seq) === ref)) {
        return {ok: false, code: 'MEMORY_EVIDENCE_OTHER_VIEWER'};
      }
    }
  }
  const noSemantic = byRef.get(3);
  if (noSemantic.no_new_information !== true || (Array.isArray(noSemantic.operations) && noSemantic.operations.length > 0)) {
    return {ok: false, code: 'MEMORY_ZERO_EXCERPT'};
  }
  return {ok: true, code: null};
}

function wasStructured(result) {
  return result?.responseFormat === 'json_schema';
}

/**
 * Run all capability stages. The caller must have already obtained explicit
 * spend confirmation for paid/unknown models.
 */
export async function verifyProviderConfig({
  config,
  apiKey = null,
  fetchImpl = globalThis.fetch,
  signal = null,
  now = Date.now,
  timeoutMs = 120000,
  stages: requestedStages = null,
  multiline = false
} = {}) {
  const startedAt = now();
  const stages = {};
  try {
    await assertSafeResolvedUrl(config.baseUrl, {
      allowLocalNetwork: config.allowLocalNetwork === true
    });
  } catch (error) {
    stages.network = {status: 'failed', code: error?.code ?? 'URL_BLOCKED', detail: 'base-url-rejected'};
    return {
      status: 'failed',
      startedAt,
      at: new Date(now()).toISOString(),
      durationMs: now() - startedAt,
      providerId: config.providerId,
      regionId: config.regionId,
      modelId: config.modelId,
      capabilities: {
        network: false, auth: false, text: false, json: false, structuredOutputs: false,
        session: false, memory: false, multilingual: false,
        testedAt: new Date(now()).toISOString(), model: config.modelId,
        providerId: config.providerId, regionId: config.regionId
      },
      stages,
      error: error?.code ?? 'URL_BLOCKED'
    };
  }
  const capabilities = {
    network: false,
    auth: false,
    text: false,
    json: false,
    structuredOutputs: false,
    session: false,
    memory: false,
    multilingual: false,
    testedAt: null,
    model: config.modelId,
    providerId: config.providerId,
    regionId: config.regionId
  };
  const want = (stage) => !requestedStages || requestedStages.includes(stage);
  let fatal = null;

  const setStage = (name, status, extra = {}) => {
    stages[name] = {status, ...extra};
  };

  // 1. Network / authentication via the model catalogue where available.
  if (want('network') || want('auth')) {
    const started = now();
    try {
      if (config.supportsModelList && apiKey) {
        await listProviderModels({config, apiKey, fetchImpl, signal, timeoutMs});
        capabilities.network = true;
        capabilities.auth = true;
        setStage('network', 'passed', {durationMs: now() - started});
        setStage('auth', 'passed', {durationMs: now() - started});
      } else {
        // No catalogue endpoint (or no key for a custom local server): the text
        // probe is the first real network/auth test.
        setStage('network', 'skipped', {reason: 'no-model-list-endpoint'});
        setStage('auth', 'skipped', {reason: 'deferred-to-text'});
      }
    } catch (error) {
      const info = stageError(error);
      if (info.code === PROVIDER_ERROR.AUTH) {
        capabilities.network = true;
        setStage('network', 'passed', {durationMs: now() - started});
        setStage('auth', 'failed', {durationMs: now() - started, ...info});
        fatal = info;
      } else {
        setStage('network', 'failed', {durationMs: now() - started, ...info});
        setStage('auth', 'skipped', {reason: 'network-failed'});
        fatal = info;
      }
    }
  }

  const call = async (stage, messages, maxTokens, schema = null) => {
    if (fatal) return null;
    const started = now();
    try {
      const result = await callProvider(config, {
        apiKey,
        messages,
        maxTokens,
        responseSchema: schema,
        responseFormat: schema ? (config.supportsStructuredOutputs ? 'json_schema' : 'json_object') : 'none',
        fetchImpl,
        signal,
        timeoutMs
      });
      capabilities.network = true;
      capabilities.auth = true;
      setStage(stage, 'passed', {
        durationMs: now() - started,
        finishReason: result.finishReason,
        format: result.responseFormat,
        usage: result.usage ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens
        } : null
      });
      return result;
    } catch (error) {
      const info = stageError(error);
      setStage(stage, 'failed', {durationMs: now() - started, ...info});
      if (info.code === PROVIDER_ERROR.AUTH) capabilities.auth = false;
      fatal = info;
      return null;
    }
  };

  // 2. Text.
  if (want('text') && !fatal) {
    const result = await call('text', [
      {role: 'system', content: SYSTEM},
      {role: 'user', content: 'Reply with exactly: OK'}
    ], 32);
    if (result && result.text.trim().toUpperCase().includes('OK')) capabilities.text = true;
  }

  // 3. JSON.
  if (want('json') && !fatal) {
    const result = await call('json', [
      {role: 'system', content: SYSTEM},
      {role: 'user', content: 'Return only {"ok":true}.'}
    ], 64, JSON_SCHEMA);
    if (result) {
      const object = extractJson(result.text);
      capabilities.json = object?.ok === true;
      capabilities.structuredOutputs = wasStructured(result);
    }
  }

  // 4. Session analysis shape.
  if (want('session') && !fatal) {
    const result = await call('session', [
      {role: 'system', content: SYSTEM},
      {
        role: 'user',
        content: 'Synthetic livestream chat: A says "hello"; B says "the guitar part was great". Return only {"summary":"short summary","topics":[{"title":"music","summary":"chat discussed the guitar"}]}.'
      }
    ], 300, SESSION_SCHEMA);
    if (result) {
      const object = extractJson(result.text);
      capabilities.session = Boolean(
        object
        && typeof object.summary === 'string'
        && Array.isArray(object.topics)
        && object.topics.length >= 1
        && typeof object.topics[0]?.title === 'string'
      );
    }
  }

  // 5. Memory shape: coverage, identity refs, evidence ownership, zero excerpt.
  if (want('memory') && !fatal) {
    const result = await call('memory', memoryProbeMessages(), 900, MEMORY_SCHEMA);
    if (result) {
      const object = extractJson(result.text);
      const checked = validateMemoryProbe(object);
      capabilities.memory = checked.ok;
      capabilities.multilingual = checked.ok;
      if (!checked.ok) {
        stages.memory = {
          ...(stages.memory ?? {}),
          status: 'failed',
          code: checked.code,
          detail: 'memory probe did not satisfy identity/evidence coverage'
        };
      }
    }
  }

  capabilities.testedAt = new Date(now()).toISOString();
  const relevant = requestedStages ?? ['network', 'auth', 'text', 'json', 'session', 'memory'];
  const failed = relevant.filter((stage) => stages[stage]?.status === 'failed');
  const status = failed.length === 0
    ? (capabilities.memory ? 'passed' : 'partial')
    : (capabilities.text || capabilities.session ? 'partial' : 'failed');
  return {
    status,
    startedAt,
    at: new Date(now()).toISOString(),
    durationMs: now() - startedAt,
    providerId: config.providerId,
    regionId: config.regionId,
    modelId: config.modelId,
    capabilities,
    stages,
    error: failed.length > 0 ? stages[failed[0]]?.code ?? 'PROVIDER_TEST_FAILED' : null,
    estimate: {
      inputTokens: estimateTokensFromText(memoryProbeMessages().map((message) => message.content).join('\n')),
      requests: Object.keys(stages).filter((key) => stages[key].status !== 'skipped').length
    }
  };
}

export const __internal = {extractJson, validateMemoryProbe, memoryProbeMessages, SESSION_SCHEMA, MEMORY_SCHEMA};
