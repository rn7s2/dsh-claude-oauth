/**
 * Anthropic Messages wire adapter for the Claude Code OAuth route.
 *
 * The Harness LLM seam (`@deepseek-ai/dsh-llm`) speaks provider-neutral
 * messages and a provider-neutral `StreamChunk` protocol. This module is the
 * single place that translates that vocabulary into Anthropic's `/v1/messages`
 * wire format and back, reproducing the request shape Claude Code's first-party
 * OAuth client sends (Claude Code identity system block, billing-header system
 * line, OAuth betas, adaptive thinking) because that is what the subscription
 * endpoint accepts for these tokens.
 *
 * Two halves are exported for offline testing:
 * - {@link buildMessagesRequest} — pure request construction (async only because
 *   request images are prepared through the durable attachment service).
 * - {@link parseSseStream} — SSE framing for the response body.
 *
 * The adapter itself is a plain object (not an `LlmAdapter` subclass) so this
 * module has no runtime dependency beyond Node builtins and the bundle's own
 * `lib/constants.js` / `lib/errors.js`. The glue code that registers it with
 * the Harness supplies `getModels`, `getAccessToken`,
 * `forceRefreshAccessToken`, and `getAttachments`.
 *
 * Security invariant: the OAuth access token is only ever placed in the
 * `authorization` request header. It is never logged and never included in a
 * thrown `PluginError` message or details; provider response text is redacted
 * against the token before it can reach a failure message.
 */

import { createHash } from 'node:crypto';

import {
	ADAPTIVE_EFFORTS,
	ANTHROPIC_VERSION,
	API_BASE_URL,
	CC_BILLING_POSITIONS,
	CC_BILLING_SALT,
	CC_ENTRYPOINT,
	CC_USER_AGENT,
	CC_VERSION,
	CLAUDE_CODE_IDENTITY,
	CLAUDE_CODE_TOOL_NAMES,
	DEFAULT_EFFORT,
	DEFAULT_OUTPUT_TOKENS,
	CACHE_CONTROL,
	HARNESS_IDENTITY_LINE,
	INFERENCE_BETAS,
	MAX_OUTPUT_TOKENS,
	MESSAGES_PATH,
	MODEL_CAPABILITIES,
	PROVIDER_NAME,
	PROVIDER_ID,
	REQUEST_IMAGE_MAX_BYTES,
	REQUEST_IMAGE_MAX_PIXELS,
} from './constants.js';
import { PluginError } from './errors.js';

/** Context window assumed when neither the live catalog nor the capability table knows a model. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** No bytes for this long aborts the request with `TIMEOUT` (the Harness idle-stream default). */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Modalities assumed for catalog entries that do not declare any. */
const DEFAULT_INPUT_MODALITIES = Object.freeze(['text', 'image']);
/** Marker Claude Code puts in its billing system line; if app text already carries it, do not duplicate. */
const BILLING_HEADER_MARKER = 'x-anthropic-billing-header:';
/** Tool result text when the tool produced no content. */
const EMPTY_TOOL_RESULT_TEXT = '(no output)';
/** Provider-neutral failure codes the Harness retry policy replays. */
const RETRYABLE_FAILURE_CODES = Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
/**
 * Provider-owned retry policy in the *resolved* shape the LLM seam stores
 * (`backoff` flattened, matching `resolveRetryPolicy` output).
 */
const RESOLVED_RETRY_POLICY = Object.freeze({
	mode: 'normal',
	maxRetries: 5,
	retryableCodes: RETRYABLE_FAILURE_CODES,
	initialDelayMs: 500,
	maxDelayMs: 10_000,
	jitterRatio: 0.1,
});

/* -------------------------------------------------------------------------- */
/* Claude Code request shaping                                                */
/* -------------------------------------------------------------------------- */

/** Alphanumeric-only tool key, so snake_case Harness names match CamelCase ones. */
function toolNameKey(name) {
	return name.toLowerCase().replace(/[_-]/g, '');
}

/** Normalized Claude Code tool name to its canonical spelling. */
const CC_TOOL_LOOKUP = new Map(CLAUDE_CODE_TOOL_NAMES.map((name) => [toolNameKey(name), name]));

/**
 * Canonical Claude Code spelling for a matching declared tool name. Matching is
 * case-insensitive and ignores `_`/`-`, so Harness names such as `todo_write`
 * become `TodoWrite`. Non-matching names are returned unchanged.
 * @param {string} name - a declared Harness tool name.
 * @returns {string} the wire name to send.
 */
export function toClaudeToolName(name) {
	if (typeof name !== 'string' || name === '') return name;
	return CC_TOOL_LOOKUP.get(toolNameKey(name)) ?? name;
}

/**
 * Map a streamed Claude Code tool name back to the exact name the current
 * request declared (case-insensitively). An unmatched name passes through, so
 * an invented tool still fails as an unknown tool rather than being rewritten.
 * @param {string} name - the name the model streamed.
 * @param {readonly {name?: string}[] | undefined} tools - the request's declared tools.
 * @returns {string} the name the Harness should see.
 */
export function fromClaudeToolName(name, tools) {
	if (!Array.isArray(tools) || typeof name !== 'string' || name === '') return name;
	const key = toolNameKey(name);
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === 'string' && toolNameKey(tool.name) === key) {
			return tool.name;
		}
	}
	return name;
}

/**
 * Remove the Harness identity opener from an outgoing system prompt.
 *
 * This is deliberately route-scoped: only the Claude request body loses this
 * fixed first-party line, because the Claude OAuth client identity block is
 * prepended in its place. The stored Harness prompt, session log, and every
 * other provider's requests are unchanged. Any other Harness prompt text
 * (persona, instructions, tools, environment sections) is kept.
 * @param {string} text - the assembled Harness system prompt.
 * @returns {string} the same prompt without the identity line.
 */
export function stripHarnessIdentityLine(text) {
	if (typeof text !== 'string' || !text.includes(HARNESS_IDENTITY_LINE)) return text;
	const lines = text.split('\n');
	const kept = lines.filter((line) => line.trim() !== HARNESS_IDENTITY_LINE);
	if (kept.length === lines.length) return text;
	return kept
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '');
}

/* -------------------------------------------------------------------------- */
/* Small guards                                                               */
/* -------------------------------------------------------------------------- */

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Output-capitalized reasoning effort name (`low` -> `Low`). */
function effortName(id) {
	return id.length === 0 ? id : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/**
 * Accept the shapes a token store may resolve: the raw token string, or a
 * record carrying it under one of the conventional field names.
 */
function accessTokenOf(value) {
	const direct = nonEmptyString(value);
	if (direct !== undefined) return direct;
	if (!isPlainObject(value)) return undefined;
	for (const key of ['accessToken', 'access_token', 'token', 'value']) {
		const candidate = nonEmptyString(value[key]);
		if (candidate !== undefined) return candidate;
	}
	return undefined;
}

/**
 * Collapse arbitrary provider text into one bounded, token-redacted line.
 * Nothing this returns may contain the access token.
 */
function safeDetail(raw, token) {
	let text = typeof raw === 'string' ? raw : '';
	if (token !== undefined && token.length > 0) text = text.split(token).join('[redacted]');
	text = text.replace(/\s+/g, ' ').trim();
	return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function abortedError(cause) {
	return new PluginError('ABORTED', 'aborted', {}, cause === undefined ? undefined : { cause });
}

/* -------------------------------------------------------------------------- */
/* Claude Code request identity: billing header + system blocks               */
/* -------------------------------------------------------------------------- */

/** Concatenated text blocks of one message's content. */
function textOf(blocks) {
	if (!Array.isArray(blocks)) return '';
	return blocks
		.filter((block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('');
}

/**
 * The first user-role message's text, which the Claude Code billing fingerprint
 * samples. Returns `''` when there is no user text at all.
 */
function firstUserText(messages) {
	if (!Array.isArray(messages)) return '';
	for (const message of messages) {
		if (!isPlainObject(message) || message.role !== 'user') continue;
		return textOf(message.content);
	}
	return '';
}

/**
 * Claude Code's billing fingerprint: first three hex chars of
 * `sha256(CC_BILLING_SALT + sampled chars + CC_VERSION)`.
 *
 * Characters are sampled with zero-based indices from the *first user text*;
 * a missing index contributes `'0'`.
 * @param {string} firstUserTextText - text of the conversation's first user message.
 * @returns {string} three lowercase hex characters.
 */
export function billingSuffix(firstUserTextText) {
	const text = typeof firstUserTextText === 'string' ? firstUserTextText : '';
	const sampled = CC_BILLING_POSITIONS.map((position) => text.charAt(position) || '0').join('');
	return createHash('sha256').update(`${CC_BILLING_SALT}${sampled}${CC_VERSION}`, 'utf8').digest('hex').slice(0, 3);
}

/**
 * The `x-anthropic-billing-header` system line Claude Code sends.
 * @param {string} firstUserTextText - text of the conversation's first user message.
 * @returns {string} the complete billing line, including its pseudo-header name.
 */
export function billingHeaderLine(firstUserTextText) {
	return `${BILLING_HEADER_MARKER} cc_version=${CC_VERSION}.${billingSuffix(firstUserTextText)}; cc_entrypoint=${CC_ENTRYPOINT}; cch=00000;`;
}

/**
 * Build the Anthropic `system` block list: the Claude Code identity always
 * first, then one block combining the billing line with the app's system text.
 * Leading `role: 'system'` history messages are folded into the app text.
 *
 * The second block carries the cache breakpoint: a breakpoint on the last
 * system block caches the whole system prefix (the identity block included),
 * which is stable across the turns of a session.
 */
function buildSystemBlocks(options) {
	const messages = Array.isArray(options.messages) ? options.messages : [];
	const leading = [];
	let index = 0;
	while (index < messages.length && isPlainObject(messages[index]) && messages[index].role === 'system') {
		const text = textOf(messages[index].content);
		if (text.length > 0) leading.push(text);
		index += 1;
	}
	const requestSystem = typeof options.system === 'string' ? options.system : '';
	// Route-scoped: the Harness identity opener is replaced by the Claude Code
	// identity block above; every other provider keeps the original prompt.
	const appSystem = stripHarnessIdentityLine(
		[requestSystem, ...leading].filter((part) => part.length > 0).join('\n\n'),
	);
	const blocks = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
	if (appSystem.includes(BILLING_HEADER_MARKER)) {
		if (appSystem.length > 0) blocks.push({ type: 'text', text: appSystem, cache_control: CACHE_CONTROL });
	} else {
		const billing = billingHeaderLine(firstUserText(messages));
		blocks.push({
			type: 'text',
			text: appSystem.length > 0 ? `${billing}\n\n${appSystem}` : billing,
			cache_control: CACHE_CONTROL,
		});
	}
	return { blocks, skip: index };
}

/**
 * Put the cache breakpoint on the final eligible block of the last user
 * message, caching the whole conversation prefix. This matches the Anthropic
 * layout: markers only on text/image/tool_result blocks, and the last
 * message's breakpoint is what a continued turn re-reads.
 */
function markHistoryCache(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isPlainObject(message)) continue;
		if (message.role !== 'user') continue;
		const content = message.content;
		if (!Array.isArray(content) || content.length === 0) continue;
		const lastBlock = content[content.length - 1];
		if (!isPlainObject(lastBlock)) continue;
		if (lastBlock.type === 'text' || lastBlock.type === 'image' || lastBlock.type === 'tool_result') {
			lastBlock.cache_control = CACHE_CONTROL;
			return;
		}
		return;
	}
}

/* -------------------------------------------------------------------------- */
/* History conversion                                                         */
/* -------------------------------------------------------------------------- */

/** Parse a DSH raw tool-call argument string; unparsable or non-object input becomes `{}`. */
function parseToolArguments(raw) {
	if (typeof raw !== 'string' || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Read the adapter-owned replay envelope off one assistant message source.
 * Only `version: 1` envelopes with an array of per-block entries are usable;
 * anything else degrades to "no replay metadata" rather than failing a request.
 * @returns {readonly unknown[] | undefined} index-aligned replay block entries.
 */
function readAssistantReplay(message) {
	if (!isPlainObject(message) || !isPlainObject(message.source)) return undefined;
	const envelope = message.source.replayState;
	if (!isPlainObject(envelope)) return undefined;
	if (envelope.version !== 1) return undefined;
	if (!Array.isArray(envelope.blocks)) return undefined;
	return envelope.blocks;
}

/**
 * Convert one assistant history message. Text and tool calls come from durable
 * content; thinking blocks exist only where the replay envelope carries the
 * provider signature (or redacted payload) for that exact content index.
 */
function convertAssistantContent(message) {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const replay = readAssistantReplay(message);
	const converted = [];
	for (const [index, block] of blocks.entries()) {
		if (!isPlainObject(block)) continue;
		switch (block.type) {
			case 'text': {
				const text = typeof block.text === 'string' ? block.text : '';
				if (text.trim().length > 0) converted.push({ type: 'text', text });
				break;
			}
			case 'reasoning': {
				const entry = replay?.[index];
				if (!isPlainObject(entry)) break;
				const signature = nonEmptyString(entry.signature);
				if (signature !== undefined) {
					converted.push({
						type: 'thinking',
						thinking: typeof block.text === 'string' ? block.text : '',
						signature,
					});
					break;
				}
				const redacted = nonEmptyString(entry.redacted);
				if (redacted !== undefined) converted.push({ type: 'redacted_thinking', data: redacted });
				break;
			}
			case 'tool-call': {
				converted.push({
					type: 'tool_use',
					id: typeof block.id === 'string' ? block.id : '',
					name: toClaudeToolName(typeof block.name === 'string' ? block.name : ''),
					input: parseToolArguments(block.arguments),
				});
				break;
			}
			default:
				// Assistant images/files and projected tool-change blocks have no
				// Anthropic history representation here; drop them defensively.
				break;
		}
	}
	return converted;
}

/* -------------------------------------------------------------------------- */
/* Request images and files                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel
 * budget (same geometry the attachment seam uses). Small images are not
 * enlarged; the result is guaranteed to fit `maxPixels`.
 * @param {number} width - positive source width.
 * @param {number} height - positive source height.
 * @param {number} maxPixels - positive width-times-height cap.
 * @returns {{width: number, height: number}} inward-rounded dimensions.
 */
export function requestImageDimensions(width, height, maxPixels) {
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
	if (scale === 1) return { width, height };
	if (width >= height) {
		let projectedWidth = Math.max(1, Math.floor(width * scale));
		let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
		while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
			projectedWidth -= 1;
			projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
		}
		return { width: projectedWidth, height: projectedHeight };
	}
	let projectedHeight = Math.max(1, Math.floor(height * scale));
	let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
	while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
		projectedHeight -= 1;
		projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
	}
	return { width: projectedWidth, height: projectedHeight };
}

/** The request-image target (dimensions + byte budget) for one attachment reference. */
function projectImageRequestTarget(attachment) {
	const ref = isPlainObject(attachment) ? attachment : {};
	const width = positiveInteger(ref.width);
	const height = positiveInteger(ref.height);
	const dimensions = width !== undefined && height !== undefined
		? requestImageDimensions(width, height, REQUEST_IMAGE_MAX_PIXELS)
		: { width: width ?? 1, height: height ?? 1 };
	return { width: dimensions.width, height: dimensions.height, maxBytes: REQUEST_IMAGE_MAX_BYTES };
}

/** Deterministic text placeholder describing one image reference without its bytes. */
function imagePlaceholderText(attachment, reason) {
	const ref = isPlainObject(attachment) ? attachment : {};
	const identity = [];
	const name = nonEmptyString(ref.name);
	if (name !== undefined) identity.push(JSON.stringify(name));
	const mediaType = nonEmptyString(ref.mediaType);
	if (mediaType !== undefined) identity.push(mediaType);
	if (positiveInteger(ref.width) !== undefined && positiveInteger(ref.height) !== undefined) {
		identity.push(`${ref.width}x${ref.height}px`);
	}
	if (Number.isSafeInteger(ref.bytes) && ref.bytes >= 0) identity.push(`${ref.bytes} bytes`);
	const attachmentId = nonEmptyString(ref.attachmentId);
	if (attachmentId !== undefined) identity.push(`attachment ${attachmentId}`);
	return `[image omitted (${reason}): ${identity.length > 0 ? identity.join(', ') : 'unknown image reference'}]`;
}

/** Deterministic text handle for one durable file reference. */
function fileHandleText(attachment) {
	const ref = isPlainObject(attachment) ? attachment : {};
	const name = nonEmptyString(ref.name) ?? 'unnamed file';
	const attachmentId = nonEmptyString(ref.attachmentId) ?? 'unknown attachment';
	const bytes = Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 ? `, ${ref.bytes} bytes` : '';
	return `[file attached: ${JSON.stringify(name)}${bytes}; attachment ${attachmentId}. Its contents are not included in this request; read it with a file tool when needed.]`;
}

/**
 * Convert one DSH image block into an Anthropic base64 image block, or a text
 * placeholder when the image cannot be sent. A missing attachment service and
 * an offloaded image are normal conditions (never failures); an unexpected
 * read error also degrades to a placeholder so one image cannot fail the turn.
 */
async function convertImageBlock(block, context) {
	const attachment = isPlainObject(block.attachment) ? block.attachment : undefined;
	if (attachment === undefined) {
		return { type: 'text', text: '[image omitted (invalid reference): the content block carries no attachment]' };
	}
	if (block.offloaded === true || attachment.offloaded === true) {
		return { type: 'text', text: imagePlaceholderText(attachment, 'offloaded') };
	}
	const service = context.attachments;
	if (service === undefined || service === null || typeof service.readImageRequest !== 'function') {
		return { type: 'text', text: imagePlaceholderText(attachment, 'attachment service unavailable') };
	}
	let prepared;
	try {
		prepared = await service.readImageRequest(attachment, projectImageRequestTarget(attachment), context.signal);
	} catch (error) {
		if (context.signal?.aborted === true) throw abortedError(error);
		return { type: 'text', text: imagePlaceholderText(attachment, 'unreadable attachment') };
	}
	if (context.signal?.aborted === true) throw abortedError();
	const data = isPlainObject(prepared) ? prepared.data : undefined;
	const mediaType = nonEmptyString(isPlainObject(prepared) ? prepared.mediaType : undefined)
		?? nonEmptyString(attachment.mediaType);
	if (data === undefined || data === null || mediaType === undefined) {
		return { type: 'text', text: imagePlaceholderText(attachment, 'unreadable attachment') };
	}
	return {
		type: 'image',
		source: { type: 'base64', media_type: mediaType, data: Buffer.from(data).toString('base64') },
	};
}

/**
 * Convert one user-role content block list. Text, images, and file handles are
 * representable; projected tool-change blocks are dropped.
 */
async function convertUserContent(blocks, context) {
	const converted = [];
	for (const block of Array.isArray(blocks) ? blocks : []) {
		if (!isPlainObject(block)) continue;
		switch (block.type) {
			case 'text': {
				const text = typeof block.text === 'string' ? block.text : '';
				if (text.trim().length > 0) converted.push({ type: 'text', text });
				break;
			}
			case 'image':
				converted.push(await convertImageBlock(block, context));
				break;
			case 'file':
				converted.push({ type: 'text', text: fileHandleText(block.attachment) });
				break;
			default:
				// tool-addition / tool-removal / unexpected block types: dropped defensively.
				break;
		}
	}
	return converted;
}

/**
 * Convert one `role: 'tool'` history message into an Anthropic `tool_result`
 * block. Consecutive tool messages share one user message on the wire, which
 * the caller assembles.
 */
async function convertToolResult(message, context) {
	const converted = await convertUserContent(message.content, context);
	const allText = converted.every((block) => block.type === 'text');
	let content;
	if (converted.length === 0) content = EMPTY_TOOL_RESULT_TEXT;
	else if (allText) content = converted.map((block) => block.text).join('\n');
	else content = converted;
	const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
	return {
		type: 'tool_result',
		tool_use_id: toolCallId,
		content,
		is_error: message.isError === true,
	};
}

/* -------------------------------------------------------------------------- */
/* Tools and thinking                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Map DSH tool declarations to Anthropic `tools` entries. The last entry
 * carries the cache breakpoint: the tool list is a stable prefix every turn,
 * and Anthropic allows cache_control on tool declarations.
 */
function convertTools(tools) {
	if (!Array.isArray(tools)) return undefined;
	const converted = [];
	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;
		const name = nonEmptyString(tool.name);
		if (name === undefined) continue;
		// Deferred declarations only exist for in-history tool updates, which this
		// adapter deliberately does not advertise; never send them as live tools.
		if (tool.deferLoading === true) continue;
		const parameters = isPlainObject(tool.parameters)
			? tool.parameters
			: { type: 'object', properties: {}, required: [] };
		converted.push({
			name: toClaudeToolName(name),
			...(typeof tool.description === 'string' ? { description: tool.description } : {}),
			input_schema: parameters,
		});
	}
	if (converted.length === 0) return undefined;
	converted[converted.length - 1].cache_control = CACHE_CONTROL;
	return converted;
}

function effortIdsOf(reasoning) {
	if (!isPlainObject(reasoning) || !Array.isArray(reasoning.efforts)) return [];
	const ids = [];
	for (const effort of reasoning.efforts) {
		const id = typeof effort === 'string' ? nonEmptyString(effort) : nonEmptyString(effort?.id);
		if (id !== undefined && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** The effort actually sent: requested when supported, otherwise the model default. */
function effectiveEffort(reasoning, requested) {
	const ids = effortIdsOf(reasoning);
	if (ids.length === 0) return undefined;
	if (typeof requested === 'string' && ids.includes(requested)) return requested;
	const preferred = nonEmptyString(reasoning.defaultEffort);
	if (preferred !== undefined && ids.includes(preferred)) return preferred;
	if (ids.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
	return ids[0];
}

/**
 * Adaptive thinking is sent only when the resolved model advertises reasoning
 * metadata *and* the caller chose an effort. Claude Code's OAuth client uses
 * adaptive thinking with a summarized display and an `output_config.effort`.
 */
function resolveThinking(model, options) {
	if (typeof options.reasoningEffort !== 'string' || options.reasoningEffort.length === 0) return undefined;
	const reasoning = isPlainObject(model?.reasoning) ? model.reasoning : undefined;
	if (reasoning === undefined) return undefined;
	const effort = effectiveEffort(reasoning, options.reasoningEffort);
	if (effort === undefined) return undefined;
	return {
		thinking: { type: 'adaptive', display: 'summarized' },
		output_config: { effort },
	};
}

/* -------------------------------------------------------------------------- */
/* Request construction                                                       */
/* -------------------------------------------------------------------------- */

function clampMaxTokens(requested, modelMaxTokens) {
	const ceiling = Math.min(modelMaxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
	const preferred = positiveInteger(requested) ?? Math.min(DEFAULT_OUTPUT_TOKENS, ceiling);
	return Math.max(1, Math.min(preferred, ceiling));
}

function buildHeaders(accessToken, sessionId) {
	const headers = {
		'content-type': 'application/json',
		accept: 'application/json',
		'anthropic-version': ANTHROPIC_VERSION,
		'anthropic-beta': INFERENCE_BETAS,
		'user-agent': CC_USER_AGENT,
		'x-app': 'cli',
	};
	const token = accessTokenOf(accessToken);
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (sessionId !== undefined && sessionId !== null) {
		const session = String(sessionId);
		if (session.length > 0) headers['x-claude-code-session-id'] = session;
	}
	return headers;
}

function normalizeBaseUrl(value) {
	const base = nonEmptyString(value) ?? API_BASE_URL;
	return base.endsWith('/') ? base.slice(0, -1) : base;
}

/** Convert the request's history into Anthropic `messages`. */
async function convertMessages(options, context) {
	const messages = Array.isArray(options.messages) ? options.messages : [];
	const { skip } = buildSystemBlocks(options);
	const converted = [];
	let pendingToolResults = [];

	const flushToolResults = () => {
		if (pendingToolResults.length === 0) return;
		converted.push({ role: 'user', content: pendingToolResults });
		pendingToolResults = [];
	};

	for (let index = skip; index < messages.length; index += 1) {
		const message = messages[index];
		if (!isPlainObject(message)) continue;
		switch (message.role) {
			case 'tool':
				pendingToolResults.push(await convertToolResult(message, context));
				break;
			case 'assistant': {
				flushToolResults();
				const content = convertAssistantContent(message);
				if (content.length > 0) converted.push({ role: 'assistant', content });
				break;
			}
			case 'user': {
				flushToolResults();
				const content = await convertUserContent(message.content, context);
				if (content.length > 0) converted.push({ role: 'user', content });
				break;
			}
			case 'system':
			case 'developer':
			default:
				// Leading system text is already merged into the system blocks; later
				// system/developer messages are runtime projections this adapter does
				// not advertise support for. Drop them defensively.
				break;
		}
	}
	flushToolResults();
	markHistoryCache(converted);
	return converted;
}

/**
 * Build the complete `/v1/messages` request for one turn.
 *
 * The result is the exact URL, headers, and JSON body; the adapter's stream
 * method POSTs it. Exporting it separately keeps request shaping unit-testable
 * without an HTTP server.
 *
 * @param {object} input
 * @param {{id?: string, maxTokens?: number, reasoning?: object}} input.model
 *   resolved model metadata (an entry from the adapter's model catalog is also accepted).
 * @param {object} input.options - Harness `GenerateOptions`.
 * @param {string} [input.accessToken] - OAuth access token for the Bearer header.
 * @param {object} [input.attachments] - durable attachment service (for request images).
 * @param {AbortSignal} [input.signal] - cancellation for attachment preparation.
 * @param {string} [input.apiBaseUrl] - Messages root override (tests use a local server).
 * @returns {Promise<{url: string, headers: Record<string, string>, body: object}>}
 */
export async function buildMessagesRequest(input) {
	const model = isPlainObject(input?.model) ? input.model : {};
	const options = isPlainObject(input?.options) ? input.options : {};
	const modelId = nonEmptyString(model.id) ?? nonEmptyString(options.model) ?? '';
	const modelMaxTokens = positiveInteger(model.maxTokens);
	const { blocks: system } = buildSystemBlocks(options);
	const attachments = input?.attachments === null ? undefined : input?.attachments;
	const messages = await convertMessages(options, { attachments, signal: input?.signal });
	const tools = convertTools(options.tools);
	const thinking = resolveThinking(model, options);
	// `GenerateOptions.stop` maps to the wire's `stop_sequences` when supplied.
	// Temperature is deliberately never sent: Claude Code's OAuth client does not
	// send it, and it is invalid alongside extended thinking.
	const stopSequences = Array.isArray(options.stop)
		? options.stop.filter((value) => typeof value === 'string' && value.length > 0)
		: [];
	const body = {
		model: modelId,
		max_tokens: clampMaxTokens(options.maxTokens, modelMaxTokens),
		stream: true,
		system,
		messages,
		...(tools === undefined ? {} : { tools }),
		...(stopSequences.length === 0 ? {} : { stop_sequences: stopSequences }),
		...(thinking === undefined ? {} : { thinking: thinking.thinking, output_config: thinking.output_config }),
	};
	return {
		url: `${normalizeBaseUrl(input?.apiBaseUrl)}${MESSAGES_PATH}`,
		headers: buildHeaders(input?.accessToken, options.sessionId),
		body,
	};
}

/* -------------------------------------------------------------------------- */
/* SSE parsing                                                                */
/* -------------------------------------------------------------------------- */

/** Yield body chunks from either a web ReadableStream or an async iterable. */
async function* readBodyChunks(body) {
	if (body === undefined || body === null) return;
	if (typeof body.getReader === 'function') {
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				yield value;
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				// The stream may already be errored or closed; nothing to clean up.
			}
			try {
				reader.releaseLock();
			} catch {
				// Releasing a reader that already released itself is not a failure.
			}
		}
	}
	if (typeof body[Symbol.asyncIterator] === 'function') {
		yield* body;
	}
}

/**
 * Decode an SSE byte stream into `{event, data}` frames.
 *
 * Follows the framing rules that matter here: blank line dispatches, `data:`
 * lines concatenate with `\n`, comments (including Anthropic's ping) are
 * activity only, and an unterminated tail at EOF is discarded rather than
 * dispatched. `data` is the parsed JSON payload when possible, else the raw
 * string.
 *
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array|string>} body
 * @param {{signal?: AbortSignal, onActivity?: () => void}} [options]
 * @returns {AsyncGenerator<{event: string | undefined, data: unknown}>}
 */
export async function* parseSseStream(body, options = {}) {
	const decoder = new TextDecoder();
	const onActivity = typeof options.onActivity === 'function' ? options.onActivity : undefined;
	let buffer = '';
	let eventName;
	let dataLines = [];

	const frameOf = () => {
		if (dataLines.length === 0) return undefined;
		const raw = dataLines.join('\n');
		let data = raw;
		try {
			data = JSON.parse(raw);
		} catch {
			// A non-JSON payload is surfaced raw; the translator ignores unknowns.
		}
		const event = eventName ?? (isPlainObject(data) ? nonEmptyString(data.type) : undefined);
		return { event, data };
	};

	for await (const chunk of readBodyChunks(body)) {
		onActivity?.();
		buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const rawLine of lines) {
			const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
			if (line.length === 0) {
				const frame = frameOf();
				eventName = undefined;
				dataLines = [];
				if (frame !== undefined) yield frame;
				continue;
			}
			if (line.startsWith(':')) continue;
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) value = value.slice(1);
			if (field === 'event') eventName = value;
			else if (field === 'data') dataLines.push(value);
			// `id` and `retry` carry nothing this adapter consumes.
		}
	}
	// An unterminated trailing event is not dispatched (matches SSE framing rules).
}

/* -------------------------------------------------------------------------- */
/* Response translation                                                       */
/* -------------------------------------------------------------------------- */

/** Merge one Anthropic `usage` payload into the accumulated wire counts. */
function updateUsage(target, raw) {
	if (!isPlainObject(raw)) return;
	const fields = {
		input_tokens: 'inputTokens',
		output_tokens: 'outputTokens',
		cache_read_input_tokens: 'cacheReadTokens',
		cache_creation_input_tokens: 'cacheWriteTokens',
	};
	for (const [wire, local] of Object.entries(fields)) {
		const value = raw[wire];
		if (Number.isSafeInteger(value) && value >= 0) target[local] = value;
	}
	const thinking = isPlainObject(raw.output_tokens_details) ? raw.output_tokens_details.thinking_tokens : undefined;
	if (Number.isSafeInteger(thinking) && thinking >= 0) target.reasoningTokens = thinking;
}

/** Map accumulated wire counts onto the Harness `TokenUsage` shape. */
function mapUsage(raw) {
	const inputTokens = raw.inputTokens ?? 0;
	const outputTokens = raw.outputTokens ?? 0;
	const cacheReadTokens = raw.cacheReadTokens ?? 0;
	const cacheWriteTokens = raw.cacheWriteTokens ?? 0;
	const usage = {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
	};
	if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens;
	if (cacheWriteTokens > 0) usage.cacheWriteTokens = cacheWriteTokens;
	if ((raw.reasoningTokens ?? 0) > 0) usage.reasoningTokens = raw.reasoningTokens;
	return usage;
}

const CONTEXT_LENGTH_PATTERNS = [
	/context[\s_-]*(?:length|window)/i,
	/\bprompt is too long\b/i,
	/\binput (?:is )?too long\b/i,
	/\btoo many (?:input )?tokens\b/i,
	/\bmaximum (?:allowed |supported )?context\b/i,
	/\brequest too large\b/i,
	/input length and\b.*\bexceed\b/i,
	/\bexceed(?:s|ed)?\b.{0,40}\bcontext\b/i,
];

function isContextLengthError(detail) {
	return CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(detail));
}

/**
 * Classify one Anthropic failure into a Harness failure code.
 * @param {number|undefined} status - HTTP status when the failure preceded streaming.
 * @param {string} type - Anthropic error `type` (e.g. `rate_limit_error`).
 * @param {string} detail - type plus message text, used for wording-based classification.
 */
function providerErrorCode(status, type, detail) {
	const normalizedType = type.toLowerCase();
	if (status === 401 || status === 403 || normalizedType === 'authentication_error' || normalizedType === 'permission_error') return 'AUTH';
	if (status === 429 || normalizedType === 'rate_limit_error') return 'RATE_LIMIT';
	if (isContextLengthError(detail)) return 'CONTEXT_WINDOW_EXCEEDED';
	if (status === 400 || status === 413 || status === 422 || normalizedType === 'invalid_request_error') return 'INVALID_REQUEST';
	if ((typeof status === 'number' && status >= 500) || normalizedType === 'api_error' || normalizedType === 'overloaded_error') return 'SERVER';
	return status === undefined ? 'SERVER' : 'INVALID_REQUEST';
}

/** Turn one in-band Anthropic `error` event payload into a finish failure. */
function streamErrorFailure(rawError, token) {
	const error = isPlainObject(rawError) ? rawError : {};
	const type = nonEmptyString(error.type) ?? '';
	const rawMessage = typeof error.message === 'string' && error.message.length > 0
		? error.message
		: 'Anthropic stream error';
	const code = providerErrorCode(undefined, type, `${type} ${rawMessage}`);
	const label = type.length > 0 ? `Anthropic stream error (${type})` : 'Anthropic stream error';
	return { message: safeDetail(`${label}: ${rawMessage}`, token), code };
}

/** Turn a non-2xx HTTP response into a token-redacted `PluginError`. */
async function providerHttpError(response, token) {
	let text = '';
	try {
		text = await response.text();
	} catch {
		// A body that cannot be read leaves the status as the only diagnosis.
	}
	let parsed;
	try {
		parsed = text.length > 0 ? JSON.parse(text) : undefined;
	} catch {
		parsed = undefined;
	}
	const rawError = isPlainObject(parsed) && isPlainObject(parsed.error)
		? parsed.error
		: isPlainObject(parsed)
			? parsed
			: {};
	const type = nonEmptyString(rawError.type) ?? '';
	const rawMessage = typeof rawError.message === 'string' && rawError.message.length > 0
		? rawError.message
		: `HTTP ${response.status}`;
	const code = providerErrorCode(response.status, type, `${type} ${rawMessage}`);
	const message = safeDetail(`Anthropic Messages request failed (HTTP ${response.status}): ${rawMessage}`, token);
	return new PluginError(code, message, {
		status: response.status,
		...(type.length > 0 ? { type } : {}),
	});
}

function transportFailure(error, token) {
	const detail = error instanceof Error && typeof error.message === 'string' ? error.message : '';
	const message = safeDetail(`Anthropic Messages transport failed${detail.length > 0 ? `: ${detail}` : ''}`, token);
	return new PluginError('TRANSPORT', message);
}

/** Best-effort close of a response body that will not be consumed. */
async function discardResponseBody(response) {
	try {
		await response?.body?.cancel();
	} catch {
		// Already closed or locked; the fetch aborts with its signal regardless.
	}
}

/* -------------------------------------------------------------------------- */
/* Streaming transport                                                        */
/* -------------------------------------------------------------------------- */

/** Arm one immediate-reset idle timer; the callback aborts the request. */
function startIdleWatchdog(timeoutMs, onTimeout) {
	const state = { timedOut: false, disposed: false, pulse() {}, dispose() {} };
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return state;
	let timer;
	const arm = () => {
		if (state.disposed) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			state.timedOut = true;
			try {
				onTimeout();
			} catch {
				// Aborting an already-aborted controller is a no-op.
			}
		}, timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();
	};
	state.pulse = arm;
	state.dispose = () => {
		state.disposed = true;
		clearTimeout(timer);
	};
	arm();
	return state;
}

/** Resolve a fresh token through the injected store, or fail with a safe error. */
async function refreshAccessToken(dependencies, callerSignal) {
	let resolved;
	try {
		resolved = await dependencies.forceRefreshAccessToken();
	} catch (error) {
		if (callerSignal?.aborted === true) throw abortedError(error);
		if (error instanceof PluginError) throw new PluginError(error.code, error.message, error.details);
		throw new PluginError('AUTH', 'Claude OAuth token refresh failed');
	}
	const token = accessTokenOf(resolved);
	if (token === undefined) throw new PluginError('AUTH', 'Claude OAuth token refresh returned no access token');
	return token;
}

/**
 * POST one built request, retrying exactly once through a forced token refresh
 * when the server answers 401 before any stream bytes were consumed.
 * @returns {Promise<Response>} a 2xx response whose body has not been consumed.
 */
async function postWithAuthRefresh({ request, accessToken, signal, callerSignal, dependencies, watchdog }) {
	let current = request;
	let token = accessToken;
	let refreshed = false;
	for (;;) {
		let response;
		try {
			response = await dependencies.fetchImpl(current.url, {
				method: 'POST',
				headers: current.headers,
				body: JSON.stringify(current.body),
				signal,
				redirect: 'error',
			});
		} catch (error) {
			if (callerSignal?.aborted === true) throw abortedError(error);
			if (watchdog.timedOut) throw new PluginError('TIMEOUT', `Anthropic Messages request timed out after ${dependencies.idleTimeoutMs} ms`);
			throw transportFailure(error, token);
		}
		watchdog.pulse();
		if (response.status === 401 && !refreshed && typeof dependencies.forceRefreshAccessToken === 'function') {
			refreshed = true;
			await discardResponseBody(response);
			token = await refreshAccessToken(dependencies, callerSignal);
			current = { ...current, headers: { ...current.headers, authorization: `Bearer ${token}` } };
			continue;
		}
		if (!response.ok) throw await providerHttpError(response, token);
		return response;
	}
}

/** One streamed content block accumulated from Anthropic SSE events. */
function startStreamBlock(nativeType, index, native) {
	switch (nativeType) {
		case 'text':
			return {
				kind: 'text',
				index,
				blockType: 'text',
				text: typeof native.text === 'string' ? native.text : '',
				closed: false,
			};
		case 'thinking':
			return {
				kind: 'thinking',
				index,
				blockType: 'reasoning',
				text: typeof native.thinking === 'string' ? native.thinking : '',
				signature: typeof native.signature === 'string' ? native.signature : '',
				closed: false,
			};
		case 'redacted_thinking':
			return {
				kind: 'redacted',
				index,
				blockType: 'reasoning',
				text: '',
				redacted: typeof native.data === 'string' ? native.data : '',
				closed: false,
			};
		case 'tool_use': {
			const input = isPlainObject(native.input) && Object.keys(native.input).length > 0
				? JSON.stringify(native.input)
				: '';
			return {
				kind: 'tool',
				index,
				blockType: 'tool-call',
				id: typeof native.id === 'string' ? native.id : '',
				name: typeof native.name === 'string' ? native.name : '',
				arguments: input,
				closed: false,
			};
		}
		default:
			return undefined;
	}
}

/** The completed Harness content block for one settled stream block. */
function finalStreamBlock(block) {
	switch (block.kind) {
		case 'text':
			return { type: 'text', text: block.text };
		case 'thinking':
			return { type: 'reasoning', text: block.text };
		case 'redacted':
			return { type: 'reasoning', text: '' };
		case 'tool':
			return {
				type: 'tool-call',
				id: block.id,
				name: block.name,
				arguments: block.arguments.length > 0 ? block.arguments : '{}',
			};
		default:
			return { type: 'text', text: '' };
	}
}

/**
 * Build the adapter-owned replay envelope: index-aligned with the emitted
 * content blocks so a later request can restore native thinking blocks.
 * Text and tool-call entries are empty objects; only thinking blocks carry
 * native signatures or redacted payloads, and signature text is never streamed
 * to the UI.
 */
function replayEnvelope(blocks, responseId, responseModel, requestedModel) {
	return {
		version: 1,
		response: { id: responseId ?? '', model: responseModel ?? requestedModel },
		blocks: blocks.map((block) => {
			if (block.kind === 'thinking') return block.signature.length > 0 ? { signature: block.signature } : {};
			if (block.kind === 'redacted') return { redacted: block.redacted };
			return {};
		}),
	};
}

/** Map an Anthropic `stop_reason` to a Harness finish reason. */
function mapStopFinish(rawReason, stopDetails, modelId, blockCount, token) {
	switch (rawReason) {
		case 'tool_use':
			return { kind: 'tool-calls' };
		case 'max_tokens':
			return { kind: 'max-tokens' };
		case 'refusal':
		case 'sensitive': {
			const explanation = isPlainObject(stopDetails) && typeof stopDetails.explanation === 'string'
				? stopDetails.explanation
				: 'The model refused to complete the request';
			return { kind: 'error', failure: { message: safeDetail(explanation, token), code: 'REFUSAL' } };
		}
		case undefined:
		case null:
		case 'end_turn':
		case 'stop_sequence':
		case 'pause_turn':
			if (blockCount === 0) {
				return {
					kind: 'error',
					failure: {
						message: `model "${modelId}" returned a completed response with no content`,
						code: 'EMPTY_RESPONSE',
					},
				};
			}
			return { kind: 'stop' };
		default:
			return {
				kind: 'error',
				failure: {
					message: `Anthropic stopped with an unsupported stop reason "${String(rawReason)}"`,
					code: 'SERVER',
				},
			};
	}
}

/** The `usage` + one terminal `finish` chunk pair for a settled response. */
function terminalChunks(context, blocks, rawStopReason, stopDetails, responseId, responseModel) {
	const chunks = [];
	if (context.state.usageKnown) chunks.push({ type: 'usage', usage: context.state.usage });
	const reason = mapStopFinish(rawStopReason, stopDetails, context.requestedModel, blocks.length, context.token);
	const replayState = blocks.length > 0
		? replayEnvelope(blocks, responseId, responseModel, context.requestedModel)
		: undefined;
	chunks.push({ type: 'finish', reason, ...(replayState === undefined ? {} : { replayState }) });
	return chunks;
}

/**
 * Translate the Anthropic event stream into Harness chunks, ending with the
 * usage chunk (when known) and exactly one terminal finish.
 */
async function* translateAnthropicStream(body, context) {
	const blocks = new Map();
	const order = [];
	let started = false;
	let responseId;
	let responseModel;
	let stopReason;
	let stopDetails;

	const events = parseSseStream(body, { signal: context.signal, onActivity: () => context.watchdog.pulse() });
	for await (const frame of events) {
		context.watchdog.pulse();
		const event = isPlainObject(frame.data) ? frame.data : {};
		const type = nonEmptyString(frame.event) ?? nonEmptyString(event.type) ?? '';

		if (type === 'message_start') {
			if (started) continue;
			started = true;
			const message = isPlainObject(event.message) ? event.message : {};
			responseId = nonEmptyString(message.id) ?? responseId;
			responseModel = nonEmptyString(message.model) ?? responseModel;
			if (isPlainObject(message.usage)) {
				updateUsage(context.usageRaw, message.usage);
				context.state.usageKnown = true;
				context.state.usage = mapUsage(context.usageRaw);
			}
			continue;
		}

		if (type === 'content_block_start') {
			const wireIndex = Number.isSafeInteger(event.index) ? event.index : order.length;
			if (blocks.has(wireIndex)) continue;
			const native = isPlainObject(event.content_block) ? event.content_block : {};
			const nativeType = nonEmptyString(native.type) ?? '';
			const block = startStreamBlock(nativeType, order.length, native);
			if (block === undefined) continue;
			if (block.kind === 'tool') {
				// Canonical Claude Code name back to the exact declared Harness name.
				block.name = fromClaudeToolName(block.name, context.tools);
			}
			blocks.set(wireIndex, block);
			order.push(block);
			yield { type: 'block-start', index: block.index, blockType: block.blockType };
			if (block.kind === 'text' && block.text.length > 0) {
				yield { type: 'text-delta', index: block.index, text: block.text };
			} else if (block.kind === 'thinking' && block.text.length > 0) {
				yield { type: 'reasoning-delta', index: block.index, text: block.text };
			} else if (block.kind === 'tool') {
				yield {
					type: 'tool-call-delta',
					index: block.index,
					id: block.id,
					...(block.name.length > 0 ? { name: block.name } : {}),
					argumentsDelta: '',
				};
			}
			continue;
		}

		if (type === 'content_block_delta') {
			const wireIndex = Number.isSafeInteger(event.index) ? event.index : -1;
			const block = blocks.get(wireIndex);
			if (block === undefined || block.closed) continue;
			const delta = isPlainObject(event.delta) ? event.delta : {};
			const deltaType = nonEmptyString(delta.type) ?? '';
			if (deltaType === 'text_delta' && block.kind === 'text') {
				const text = typeof delta.text === 'string' ? delta.text : '';
				if (text.length === 0) continue;
				block.text += text;
				yield { type: 'text-delta', index: block.index, text };
			} else if (deltaType === 'thinking_delta' && block.kind === 'thinking') {
				const text = typeof delta.thinking === 'string' ? delta.thinking : '';
				if (text.length === 0) continue;
				block.text += text;
				yield { type: 'reasoning-delta', index: block.index, text };
			} else if (deltaType === 'signature_delta' && block.kind === 'thinking') {
				// Provider-owned replay metadata only: never surfaced as UI text.
				if (typeof delta.signature === 'string') block.signature += delta.signature;
			} else if (deltaType === 'input_json_delta' && block.kind === 'tool') {
				const fragment = typeof delta.partial_json === 'string' ? delta.partial_json : '';
				if (fragment.length === 0) continue;
				block.arguments += fragment;
				yield {
					type: 'tool-call-delta',
					index: block.index,
					id: block.id,
					...(block.name.length > 0 ? { name: block.name } : {}),
					argumentsDelta: fragment,
				};
			}
			continue;
		}

		if (type === 'content_block_stop') {
			const wireIndex = Number.isSafeInteger(event.index) ? event.index : -1;
			const block = blocks.get(wireIndex);
			if (block === undefined || block.closed) continue;
			block.closed = true;
			yield { type: 'block-end', index: block.index, block: finalStreamBlock(block) };
			continue;
		}

		if (type === 'message_delta') {
			if (isPlainObject(event.delta)) {
				if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) stopReason = event.delta.stop_reason;
				if (isPlainObject(event.delta.stop_details)) stopDetails = event.delta.stop_details;
			}
			if (isPlainObject(event.usage)) {
				updateUsage(context.usageRaw, event.usage);
				context.state.usageKnown = true;
				context.state.usage = mapUsage(context.usageRaw);
			}
			continue;
		}

		if (type === 'message_stop') {
			// Defensive: finish any block the provider never closed before settling.
			for (const block of order) {
				if (block.closed) continue;
				block.closed = true;
				yield { type: 'block-end', index: block.index, block: finalStreamBlock(block) };
			}
			for (const chunk of terminalChunks(context, order, stopReason, stopDetails, responseId, responseModel)) yield chunk;
			return;
		}

		if (type === 'error') {
			const failure = streamErrorFailure(event.error, context.token);
			if (context.state.usageKnown) yield { type: 'usage', usage: context.state.usage };
			const replayState = order.length > 0
				? replayEnvelope(order, responseId, responseModel, context.requestedModel)
				: undefined;
			yield {
				type: 'finish',
				reason: { kind: 'error', failure },
				...(replayState === undefined ? {} : { replayState }),
			};
			return;
		}

		// `ping` and unknown event types carry no protocol state.
	}

	// End of body without `message_stop`: accept it only when a stop reason
	// already arrived; otherwise the stream was truncated mid-turn.
	if (stopReason !== undefined) {
		for (const block of order) {
			if (block.closed) continue;
			block.closed = true;
			yield { type: 'block-end', index: block.index, block: finalStreamBlock(block) };
		}
		for (const chunk of terminalChunks(context, order, stopReason, stopDetails, responseId, responseModel)) yield chunk;
		return;
	}
	throw new PluginError('TRANSPORT', 'Anthropic Messages stream ended before completion');
}

/* -------------------------------------------------------------------------- */
/* Model catalog                                                              */
/* -------------------------------------------------------------------------- */

function normalizeInputModalities(value) {
	if (!Array.isArray(value)) return [...DEFAULT_INPUT_MODALITIES];
	const filtered = value.filter((modality) => modality === 'text' || modality === 'image');
	return filtered.length > 0 ? [...new Set(filtered)] : [...DEFAULT_INPUT_MODALITIES];
}

/** Normalize the catalog's reasoning descriptor into `{efforts: string[], defaultEffort?}`. */
function normalizeReasoning(reasoning) {
	if (reasoning === true) return { efforts: [...ADAPTIVE_EFFORTS], defaultEffort: DEFAULT_EFFORT };
	if (!isPlainObject(reasoning)) return undefined;
	const efforts = [];
	for (const effort of Array.isArray(reasoning.efforts) ? reasoning.efforts : []) {
		const id = typeof effort === 'string' ? nonEmptyString(effort) : nonEmptyString(effort?.id);
		if (id !== undefined && !efforts.includes(id)) efforts.push(id);
	}
	if (efforts.length === 0) return undefined;
	const declaredDefault = nonEmptyString(reasoning.defaultEffort);
	const defaultEffort = declaredDefault !== undefined && efforts.includes(declaredDefault)
		? declaredDefault
		: efforts.includes(DEFAULT_EFFORT)
			? DEFAULT_EFFORT
			: efforts[0];
	return { efforts, defaultEffort };
}

function normalizeCatalogEntry(entry) {
	const id = nonEmptyString(entry.id) ?? '';
	return {
		id,
		name: nonEmptyString(entry.name) ?? id,
		contextWindow: positiveInteger(entry.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveInteger(entry.maxTokens),
		input: normalizeInputModalities(entry.input),
		reasoning: normalizeReasoning(entry.reasoning),
	};
}

/** Fallback metadata for a model the live catalog did not list. */
function fallbackCatalogEntry(modelId) {
	const capability = MODEL_CAPABILITIES[modelId];
	if (capability !== undefined) {
		return {
			id: modelId,
			name: nonEmptyString(capability.name) ?? modelId,
			contextWindow: positiveInteger(capability.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: positiveInteger(capability.maxTokens),
			input: normalizeInputModalities(capability.input),
			reasoning: capability.adaptive === true
				? { efforts: [...ADAPTIVE_EFFORTS], defaultEffort: DEFAULT_EFFORT }
				: undefined,
		};
	}
	return {
		id: modelId,
		name: modelId,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: undefined,
		input: [...DEFAULT_INPUT_MODALITIES],
		reasoning: undefined,
	};
}

/**
 * Immutable catalog snapshot for one adapter operation. Every method that
 * resolves models or streams captures one snapshot so a catalog refresh cannot
 * mix two generations inside one call.
 * @returns {Map<string, ReturnType<typeof normalizeCatalogEntry>>}
 */
function catalogSnapshot(dependencies) {
	const snapshot = new Map();
	let listed;
	try {
		listed = dependencies.getModels();
	} catch {
		// A catalog that cannot be read yet (signed out) behaves like an empty
		// catalog; the auth path reports the actionable failure.
		listed = [];
	}
	if (!Array.isArray(listed)) return snapshot;
	for (const entry of listed) {
		if (!isPlainObject(entry)) continue;
		const normalized = normalizeCatalogEntry(entry);
		if (normalized.id.length === 0 || snapshot.has(normalized.id)) continue;
		snapshot.set(normalized.id, normalized);
	}
	return snapshot;
}

function catalogEntryOf(snapshot, modelId) {
	return snapshot.get(modelId) ?? fallbackCatalogEntry(modelId);
}

/**
 * Harness `LlmResolvedModelInfo` for one catalog entry.
 *
 * `defaultMaxTokens` is deliberately conservative: it is the *call default* DSH
 * materializes, not the model's hard ceiling. Using the model maximum there
 * would silently cap every reply at 128K; the adapter's own wire clamp still
 * honors the model's real maximum when a caller asks for more.
 */
function modelInfoOf(provider, entry) {
	const info = {
		provider,
		id: entry.id,
		name: entry.name,
		inputModalities: [...entry.input],
		context: { contextWindow: entry.contextWindow },
	};
	if (entry.maxTokens !== undefined) info.defaultMaxTokens = Math.min(entry.maxTokens, DEFAULT_OUTPUT_TOKENS);
	if (entry.reasoning !== undefined) {
		info.reasoning = {
			efforts: entry.reasoning.efforts.map((id) => ({ id, name: effortName(id) })),
			...(entry.reasoning.defaultEffort === undefined ? {} : { defaultEffort: entry.reasoning.defaultEffort }),
		};
	}
	return info;
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stream one turn through the Anthropic Messages endpoint.
 *
 * Failure delivery follows the Harness protocol: caller cancellation yields a
 * terminal `aborted` finish (closing the HTTP body first), while request-level
 * failures throw a `PluginError` that the LLM seam converts into a terminal
 * `error` finish. Mid-stream provider errors and empty completions are reported
 * in-band as finish chunks, matching other direct-transport adapters.
 */
async function* streamTurn(options, snapshot, dependencies) {
	const requestOptions = isPlainObject(options) ? options : {};
	const callerSignal = requestOptions.signal;
	const provider = nonEmptyString(requestOptions.provider) ?? PROVIDER_ID;
	const requestedModel = typeof requestOptions.model === 'string' ? requestOptions.model : '';
	const entry = catalogEntryOf(snapshot, requestedModel);
	const modelInfo = modelInfoOf(provider, entry);
	const state = { usageKnown: false, usage: undefined };

	if (callerSignal?.aborted === true) {
		yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } };
		return;
	}

	const consumer = new AbortController();
	const signal = callerSignal === undefined ? consumer.signal : AbortSignal.any([callerSignal, consumer.signal]);
	const watchdog = startIdleWatchdog(dependencies.idleTimeoutMs, () => consumer.abort());
	let response;

	try {
		const resolvedToken = await dependencies.getAccessToken();
		const accessToken = accessTokenOf(resolvedToken);
		if (accessToken === undefined) throw new PluginError('NOT_LOGGED_IN', 'Claude OAuth is not signed in');
		const request = await buildMessagesRequest({
			provider,
			// The resolved descriptor keeps the conservative `defaultMaxTokens`,
			// while the wire clamp needs the model's real output ceiling.
			model: { ...modelInfo, maxTokens: entry.maxTokens },
			options: requestOptions,
			accessToken,
			attachments: dependencies.getAttachments(),
			signal,
			apiBaseUrl: dependencies.apiBaseUrl,
		});
		response = await postWithAuthRefresh({
			request,
			accessToken,
			signal,
			callerSignal,
			dependencies,
			watchdog,
		});
		const body = response.body;
		if (body === null || body === undefined) {
			throw new PluginError('SERVER', 'Anthropic Messages returned no response body', { status: response.status });
		}
		yield* translateAnthropicStream(body, {
			state,
			usageRaw: {},
			token: accessToken,
			signal,
			requestedModel,
			watchdog,
			tools: requestOptions.tools,
		});
	} catch (error) {
		if (callerSignal?.aborted === true) {
			await discardResponseBody(response);
			if (state.usageKnown) yield { type: 'usage', usage: state.usage };
			yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } };
			return;
		}
		if (watchdog.timedOut && !(error instanceof PluginError)) {
			throw new PluginError('TIMEOUT', `Anthropic Messages request timed out after ${dependencies.idleTimeoutMs} ms`);
		}
		if (error instanceof PluginError) throw error;
		if (typeof error === 'object' && error !== null && error.name === 'AbortError') throw abortedError(error);
		throw new PluginError('TRANSPORT', 'Anthropic Messages request failed');
	} finally {
		watchdog.dispose();
		try {
			consumer.abort();
		} catch {
			// Aborting an already-aborted controller is a no-op.
		}
		await discardResponseBody(response);
	}
}

/**
 * Create the Claude Code OAuth Messages adapter.
 *
 * @param {object} dependencies
 * @param {() => Array<object>} dependencies.getModels - current catalog entries
 *   `{id, name, contextWindow, maxTokens, input, reasoning?}`.
 * @param {() => Promise<string|object>} dependencies.getAccessToken - fresh OAuth access token.
 * @param {() => Promise<string|object>} dependencies.forceRefreshAccessToken - forced refresh for a 401 retry.
 * @param {() => object|undefined} dependencies.getAttachments - durable attachment service.
 * @param {string} [dependencies.__apiBaseUrl] - test-only Messages root override.
 * @param {number} [dependencies.__idleTimeoutMs] - test-only idle timeout override.
 * @param {typeof fetch} [dependencies.__fetch] - test-only fetch override.
 * @returns {object} plain-object `LlmAdapter` implementation.
 */
export function createClaudeAdapter(dependencies = {}) {
	const resolved = {
		getModels: typeof dependencies.getModels === 'function' ? dependencies.getModels : () => [],
		getAccessToken: typeof dependencies.getAccessToken === 'function'
			? dependencies.getAccessToken
			: () => Promise.reject(new PluginError('NOT_LOGGED_IN', 'Claude OAuth is not signed in')),
		forceRefreshAccessToken: typeof dependencies.forceRefreshAccessToken === 'function'
			? dependencies.forceRefreshAccessToken
			: undefined,
		getAttachments: typeof dependencies.getAttachments === 'function' ? dependencies.getAttachments : () => undefined,
		apiBaseUrl: normalizeBaseUrl(dependencies.__apiBaseUrl ?? API_BASE_URL),
		idleTimeoutMs: positiveInteger(dependencies.__idleTimeoutMs) ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
		fetchImpl: typeof dependencies.__fetch === 'function'
			? dependencies.__fetch
			: (...args) => globalThis.fetch(...args),
	};

	return {
		providerInfo(provider) {
			return { id: provider, name: PROVIDER_NAME };
		},
		providerRetryPolicy() {
			return RESOLVED_RETRY_POLICY;
		},
		imageRequestPricing() {
			// The subscription endpoint bills by token, not by image; there is no
			// route-owned image price to report.
			return undefined;
		},
		imageRequestTarget(_provider, _model, image) {
			return projectImageRequestTarget(image);
		},
		async listModels(provider) {
			const snapshot = catalogSnapshot(resolved);
			return [...snapshot.values()].map((entry) => ({
				provider,
				id: entry.id,
				name: entry.name,
				inputModalities: [...entry.input],
			}));
		},
		async resolveModel(provider, model, signal) {
			signal?.throwIfAborted?.();
			const snapshot = catalogSnapshot(resolved);
			return modelInfoOf(provider, catalogEntryOf(snapshot, model));
		},
		async prepareCall(provider, model, signal) {
			signal?.throwIfAborted?.();
			const snapshot = catalogSnapshot(resolved);
			return {
				model: modelInfoOf(provider, catalogEntryOf(snapshot, model)),
				stream: (options) => streamTurn(options, snapshot, resolved),
			};
		},
		stream(options) {
			return streamTurn(options, catalogSnapshot(resolved), resolved);
		},
	};
}
