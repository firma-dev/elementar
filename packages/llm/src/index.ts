/**
 * @elementar/llm — слот под модель (§10).
 * Ленивый чанк: не грузится, пока человек не открыл слот или не нажал кнопку агента.
 */

export type {
  FetchLike,
  JsonSchema,
  LlmCapabilities,
  LlmErrorCode,
  LlmEvent,
  LlmMessage,
  LlmPart,
  LlmProvider,
  LlmRegistry,
  LlmRequest,
  LlmStopReason,
  LlmToolSpec,
  LlmTransportConfig,
  ModelInfo,
  ProbeResult,
  ProviderConfig,
} from './types.js'
export { isLlmErrorCode, lastUserText, textOfParts } from './types.js'

export { LlmError, codeForStatus, describeLlmError, errorEvent, errorOf, isAbort, messageOfBody, refineCode, retryAfterMsOf } from './errors.js'

export { SseParser, readSse, jsonOf } from './sse.js'
export type { SseEvent } from './sse.js'

export {
  OWN_RELAY_TEMPLATE,
  RELAY_ALLOW,
  RELAY_MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  llmFetch,
  relayAllows,
  resolveEndpoint,
} from './transport.js'
export type { Endpoint, EndpointArgs, LlmFetchArgs } from './transport.js'

export { parseProviderConfig, parseTransport, isLlmTransportMode } from './parse.js'

export {
  EXPORT_EXCLUDED_SETTINGS,
  LLM_SETTING_KEY,
  createKeyStore,
  emptySlotSettings,
  hasKey,
  memoryKeyStore,
  parseSlotSettings,
  redactConfig,
  redactSlotSettings,
} from './keystore.js'
export type { LlmKeyStore, LlmSettingsStore, LlmSlotSettings } from './keystore.js'

export { createLlmRegistry } from './registry.js'
export type { LlmSlot, RegistryEnv } from './registry.js'

export {
  createAnthropicProvider,
  createEchoProvider,
  createGoogleProvider,
  createOpenAiProvider,
  createProvider,
} from './providers/index.js'
export type { OpenAiOptions, ProviderDeps } from './providers/index.js'
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_CAPABILITIES,
  ANTHROPIC_PATH,
  ANTHROPIC_VERSION,
  createAnthropicDecoder,
  toAnthropicBody,
} from './providers/anthropic.js'
export type { AnthropicBody } from './providers/anthropic.js'
export {
  OPENAI_BASE_URL,
  OPENAI_CAPABILITIES,
  OPENAI_CHAT_PATH,
  createOpenAiDecoder,
  toOpenAiBody,
} from './providers/openai-compatible.js'
export type { OpenAiBody, OpenAiDecoder } from './providers/openai-compatible.js'
export { GOOGLE_BASE_URL, GOOGLE_CAPABILITIES, toGoogleBody } from './providers/google.js'
export type { GoogleBody } from './providers/google.js'
export { ECHO_CAPABILITIES, ECHO_MODEL, ECHO_PROVIDER_ID, echoChunks, echoToolInput } from './providers/echo.js'
export {
  PROVIDER_PRESETS,
  configFromPreset,
  defaultTransport,
  presetOf,
  relayable,
} from './providers/presets.js'
export type { ProviderKind, ProviderPreset } from './providers/presets.js'

export {
  SLICE_LIMIT_DEFAULT,
  SLICE_TITLE_LIMIT_DEFAULT,
  createDocReadonly,
  sliceSize,
} from './slice.js'
export type { DocReadonly, ReadonlyCollection, Redacted, SliceOptions, TitleRef } from './slice.js'

export {
  changeCount,
  createChange,
  draft,
  findTool,
  isProposeTool,
  isReadTool,
  parseToolInput,
  proposeTool,
  readTool,
  toolSpecs,
} from './tools.js'
export type { AgentTool, CreateChangeArgs, ProposeTool, ReadTool, ToolBase, ToolContext } from './tools.js'

export { AGENT_MAX_TURNS, AGENT_SYSTEM_PROMPT, TOOL_RESULT_MAX_CHARS, collectDrafts, runAgent } from './agent.js'
export type { AgentDoneReason, AgentEvent, AgentRunOptions, AgentRunResult } from './agent.js'
