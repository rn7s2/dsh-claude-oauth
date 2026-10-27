/**
 * Offline tests for the Claude Code OAuth Anthropic Messages adapter.
 *
 * Everything here is hermetic: request shaping is tested through the exported
 * pure builder, and streaming/error behavior runs against a local `node:http`
 * server used as the fake Anthropic Messages endpoint (via the adapter's
 * test-only `__apiBaseUrl` / `__idleTimeoutMs` overrides). No network, no
 * installed plugin, no Harness runtime.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
	ANTHROPIC_VERSION,
	CC_BILLING_POSITIONS,
	CC_BILLING_SALT,
	CC_ENTRYPOINT,
	CC_USER_AGENT,
	CC_VERSION,
	CLAUDE_CODE_IDENTITY,
	DEFAULT_OUTPUT_TOKENS,
	INFERENCE_BETAS,
	MAX_OUTPUT_TOKENS,
	MODEL_CAPABILITIES,
	PROVIDER_ID,
	PROVIDER_NAME,
	REQUEST_IMAGE_MAX_BYTES,
	REQUEST_IMAGE_MAX_PIXELS,
} from '../lib/constants.js';
import { PluginError, isPluginError } from '../lib/errors.js';
import {
	billingHeaderLine,
	billingSuffix,
	buildMessagesRequest,
	createClaudeAdapter,
	parseSseStream,
	requestImageDimensions,
} from '../lib/adapter.js';

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                       */
/* -------------------------------------------------------------------------- */

const SONNET = {
	id: 'claude-sonnet-5',
	name: 'Claude Sonnet 5',
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	input: ['text', 'image'],
	reasoning: { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
};

const HAIKU = {
	id: 'claude-haiku-4-5',
	name: 'Claude Haiku 4.5',
	contextWindow: 200_000,
	maxTokens: 64_000,
	input: ['text', 'image'],
};

/** One adapter harness with a fake token store whose refresh behavior is observable. */
function createHarness(overrides = {}) {
	const tokens = {
		current: 'sk-ant-oat01-initial',
		getCalls: 0,
		refreshes: 0,
	};
	const adapter = createClaudeAdapter({
		getModels: () => [SONNET, HAIKU],
		getAccessToken: async () => {
			tokens.getCalls += 1;
			return tokens.current;
		},
		forceRefreshAccessToken: async () => {
			tokens.refreshes += 1;
			tokens.current = 'sk-ant-oat01-refreshed';
			return tokens.current;
		},
		getAttachments: () => undefined,
		...overrides,
	});
	return { adapter, tokens };
}

/** Harness `GenerateOptions` with a simple first user prompt. */
function generateOptions(overrides = {}) {
	return {
		provider: PROVIDER_ID,
		model: 'claude-sonnet-5',
		messages: [
			{
				id: 'u1',
				role: 'user',
				content: [{ type: 'text', text: 'Hello world from the test prompt.' }],
			},
		],
		...overrides,
	};
}

/** Fake durable attachment service that records every request-image read. */
function fakeImageService(prepared = () => ({ data: Uint8Array.from([1, 2, 3, 4]), mediaType: 'image/png' })) {
	const calls = [];
	const service = {
		async readImageRequest(attachment, target, signal) {
			calls.push({ attachment, target, signal });
			const result = await prepared(attachment, target);
			if (result instanceof Error) throw result;
			return result;
		},
	};
	return { service, calls };
}

async function collect(iterable) {
	const chunks = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

function sseFrame(event) {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function writeSse(res, events) {
	if (!res.headersSent) {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		});
	}
	for (const event of events) res.write(sseFrame(event));
}

function respondJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body),
	});
	res.end(body);
}

/**
 * Start one fake Anthropic endpoint. Every request is recorded with its raw
 * headers and parsed JSON body; the handler owns the response.
 */
async function startFakeAnthropic(handler) {
	const requests = [];
	const server = createServer((req, res) => {
		void (async () => {
			let raw = '';
			for await (const chunk of req) raw += String(chunk);
			let body;
			try {
				body = raw.length === 0 ? undefined : JSON.parse(raw);
			} catch {
				body = raw;
			}
			const record = { method: req.method, url: req.url, headers: req.headers, body, raw };
			requests.push(record);
			try {
				await handler(record, res, requests.length);
			} catch {
				if (!res.headersSent) res.writeHead(500);
				if (!res.writableEnded) res.end();
			}
		})();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** Run one full stream against a fake endpoint with a fresh adapter harness. */
async function streamChunks(server, optionsOverrides = {}, harnessOverrides = {}) {
	const options = generateOptions(optionsOverrides);
	const { adapter, tokens } = createHarness({ __apiBaseUrl: server.url, ...harnessOverrides });
	const call = await adapter.prepareCall(PROVIDER_ID, options.model);
	const chunks = await collect(call.stream(options));
	return { chunks, adapter, tokens };
}

const messageStart = (id, model, usage) => ({
	type: 'message_start',
	message: { id, type: 'message', role: 'assistant', model, content: [], usage },
});

const messageDelta = (stopReason, usage) => ({
	type: 'message_delta',
	delta: { stop_reason: stopReason, stop_sequence: null },
	...(usage === undefined ? {} : { usage }),
});

const messageStop = () => ({ type: 'message_stop' });

/* -------------------------------------------------------------------------- */
/* Adapter contract                                                           */
/* -------------------------------------------------------------------------- */

test('exposes the plain-object LlmAdapter contract without advertising mid-conversation updates', async () => {
	const { adapter } = createHarness();
	for (const method of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
		assert.equal(typeof adapter[method], 'function', `${method} must be a function`);
	}

	assert.deepEqual(adapter.providerInfo(PROVIDER_ID), { id: PROVIDER_ID, name: PROVIDER_NAME });

	assert.deepEqual(adapter.providerRetryPolicy(PROVIDER_ID), {
		mode: 'normal',
		maxRetries: 5,
		retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
		initialDelayMs: 500,
		maxDelayMs: 10_000,
		jitterRatio: 0.1,
	});

	const models = await adapter.listModels(PROVIDER_ID);
	assert.deepEqual(models, [
		{ provider: PROVIDER_ID, id: 'claude-sonnet-5', name: 'Claude Sonnet 5', inputModalities: ['text', 'image'] },
		{ provider: PROVIDER_ID, id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', inputModalities: ['text', 'image'] },
	]);

	const resolved = await adapter.resolveModel(PROVIDER_ID, 'claude-sonnet-5');
	assert.deepEqual(resolved, {
		provider: PROVIDER_ID,
		id: 'claude-sonnet-5',
		name: 'Claude Sonnet 5',
		inputModalities: ['text', 'image'],
		context: { contextWindow: 1_000_000 },
		defaultMaxTokens: 32_000,
		reasoning: {
			efforts: [
				{ id: 'low', name: 'Low' },
				{ id: 'medium', name: 'Medium' },
				{ id: 'high', name: 'High' },
				{ id: 'max', name: 'Max' },
			],
			defaultEffort: 'high',
		},
	});
	// The adapter must not advertise in-history system/tool updates: DSH starts a
	// new request series when the tool set changes instead.
	assert.equal('systemPromptUpdate' in resolved, false);
	assert.equal('toolUpdate' in resolved, false);

	const haiku = await adapter.resolveModel(PROVIDER_ID, 'claude-haiku-4-5');
	assert.equal(haiku.reasoning, undefined);
	// `defaultMaxTokens` is the conservative call default, not the model ceiling.
	assert.equal(haiku.defaultMaxTokens, 32_000);
	assert.deepEqual(haiku.context, { contextWindow: 200_000 });

	// A model absent from the live catalog falls back to the versioned capability table.
	const opus = await adapter.resolveModel(PROVIDER_ID, 'claude-opus-5');
	assert.equal(opus.name, MODEL_CAPABILITIES['claude-opus-5'].name);
	assert.deepEqual(opus.context, { contextWindow: MODEL_CAPABILITIES['claude-opus-5'].contextWindow });
	assert.deepEqual(
		opus.reasoning.efforts.map((effort) => effort.id),
		['low', 'medium', 'high', 'max'],
	);

	// A model nobody knows still resolves to a usable neutral descriptor.
	const unknown = await adapter.resolveModel(PROVIDER_ID, 'totally-unknown-model');
	assert.deepEqual(unknown, {
		provider: PROVIDER_ID,
		id: 'totally-unknown-model',
		name: 'totally-unknown-model',
		inputModalities: ['text', 'image'],
		context: { contextWindow: 200_000 },
	});

	const call = await adapter.prepareCall(PROVIDER_ID, 'claude-sonnet-5');
	assert.deepEqual(call.model, resolved);
	assert.equal(typeof call.stream, 'function');
	const iterable = call.stream(generateOptions());
	assert.equal(typeof iterable[Symbol.asyncIterator], 'function');
	// `stream` is also callable without `prepareCall`; both are lazy generators.
	const direct = adapter.stream(generateOptions());
	assert.equal(typeof direct[Symbol.asyncIterator], 'function');
	await direct.return();
	await iterable.return();
});

/* -------------------------------------------------------------------------- */
/* Billing header                                                             */
/* -------------------------------------------------------------------------- */

test('billing suffix samples positions 4/7/20 of the first user text and hashes salt+chars+version', () => {
	const expectedSuffix = (sampled) =>
		createHash('sha256').update(`${CC_BILLING_SALT}${sampled}${CC_VERSION}`, 'utf8').digest('hex').slice(0, 3);

	assert.equal(billingSuffix('0123456789012345678901'), expectedSuffix('470'));
	assert.equal(billingSuffix(''), expectedSuffix('000'));
	assert.equal(billingSuffix('abc'), expectedSuffix('000'));
	assert.equal(billingSuffix(undefined), expectedSuffix('000'));
	assert.deepEqual(CC_BILLING_POSITIONS, [4, 7, 20]);

	const line = billingHeaderLine('Hello world from the test prompt.');
	assert.equal(
		line,
		`x-anthropic-billing-header: cc_version=${CC_VERSION}.${billingSuffix('Hello world from the test prompt.')}; cc_entrypoint=${CC_ENTRYPOINT}; cch=00000;`,
	);
});

test('system blocks always lead with the Claude Code identity and carry one billing line', async () => {
	const { body } = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions(),
		accessToken: 'sk-ant-oat01-system-test',
	});
	assert.deepEqual(body.system, [
		{ type: 'text', text: CLAUDE_CODE_IDENTITY },
		{ type: 'text', text: billingHeaderLine('Hello world from the test prompt.') },
	]);

	// App text that already carries the billing pseudo-header is not duplicated.
	const custom = 'x-anthropic-billing-header: cc_version=9.9.9.abc; cc_entrypoint=cli; cch=11111;\n\nCUSTOM';
	const withCustom = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({ system: custom }),
		accessToken: 'sk-ant-oat01-system-test',
	});
	assert.deepEqual(withCustom.body.system[1], { type: 'text', text: custom });
	assert.equal(withCustom.body.system[1].text.split('x-anthropic-billing-header:').length - 1, 1);
});

/* -------------------------------------------------------------------------- */
/* Full request body                                                          */
/* -------------------------------------------------------------------------- */

test('buildMessagesRequest produces the complete Claude Code request body', async () => {
	const { service, calls } = fakeImageService();
	const imageAttachment = {
		attachmentId: 'sha256:111',
		mediaType: 'image/png',
		width: 10,
		height: 10,
		bytes: 3,
		name: 'pixel.png',
	};
	const options = {
		provider: PROVIDER_ID,
		model: 'claude-sonnet-5',
		system: 'APP SYSTEM',
		reasoningEffort: 'low',
		maxTokens: 1234,
		sessionId: 'session-xyz',
		temperature: 0.7,
		stop: ['END'],
		messages: [
			{ id: 's1', role: 'system', content: [{ type: 'text', text: 'LEADING SYSTEM' }] },
			{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hello world from the test prompt.' }] },
			{
				id: 'a1',
				role: 'assistant',
				source: {
					kind: 'model',
					provider: PROVIDER_ID,
					model: 'claude-sonnet-5',
					replayState: {
						version: 1,
						response: { id: 'msg_prev', model: 'claude-sonnet-5' },
						blocks: [{}, { signature: 'sig-abc' }, {}, {}],
					},
				},
				content: [
					{ type: 'text', text: 'Sure.' },
					{ type: 'reasoning', text: 'internal reasoning' },
					{ type: 'tool-call', id: 'toolu_1', name: 'Read', arguments: '{"file_path":"/tmp/x.txt"}' },
					{ type: 'tool-call', id: 'toolu_2', name: 'Read', arguments: 'not json at all' },
				],
			},
			{ id: 't1', role: 'tool', toolCallId: 'toolu_1', isError: false, content: [{ type: 'text', text: 'line1\nline2' }] },
			{ id: 't2', role: 'tool', toolCallId: 'toolu_2', isError: true, content: [] },
			{ id: 'd1', role: 'developer', content: [{ type: 'text', text: 'developer only' }] },
			{ id: 's2', role: 'system', content: [{ type: 'text', text: 'later system' }] },
			{
				id: 'u2',
				role: 'user',
				content: [
					{ type: 'text', text: 'And this image' },
					{ type: 'image', attachment: imageAttachment },
					{ type: 'file', attachment: { attachmentId: 'sha256:222', name: 'notes.txt', bytes: 42 } },
					{ type: 'tool-addition', toolName: 'LateTool' },
					{ type: 'tool-removal', toolName: 'GoneTool' },
				],
			},
		],
		tools: [
			{
				name: 'Read',
				description: 'Read a file',
				parameters: {
					type: 'object',
					properties: { file_path: { type: 'string' } },
					required: ['file_path'],
				},
			},
			{ name: 'Deferred', description: 'never sent', parameters: { type: 'object' }, deferLoading: true },
		],
	};

	const accessToken = 'sk-ant-oat01-body-test';
	const { url, headers, body } = await buildMessagesRequest({
		model: SONNET,
		options,
		accessToken,
		attachments: service,
		apiBaseUrl: 'http://127.0.0.1:9876',
	});

	assert.equal(url, 'http://127.0.0.1:9876/v1/messages');
	assert.deepEqual(headers, {
		'content-type': 'application/json',
		accept: 'application/json',
		'anthropic-version': ANTHROPIC_VERSION,
		'anthropic-beta': INFERENCE_BETAS,
		'user-agent': CC_USER_AGENT,
		'x-app': 'cli',
		authorization: `Bearer ${accessToken}`,
		'x-claude-code-session-id': 'session-xyz',
	});

	assert.deepEqual(body, {
		model: 'claude-sonnet-5',
		max_tokens: 1234,
		stream: true,
		system: [
			{ type: 'text', text: CLAUDE_CODE_IDENTITY },
			{
				type: 'text',
				text: `${billingHeaderLine('Hello world from the test prompt.')}\n\nAPP SYSTEM\n\nLEADING SYSTEM`,
			},
		],
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'Hello world from the test prompt.' }] },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Sure.' },
					{ type: 'thinking', thinking: 'internal reasoning', signature: 'sig-abc' },
					{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x.txt' } },
					{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'line1\nline2', is_error: false },
					{ type: 'tool_result', tool_use_id: 'toolu_2', content: '(no output)', is_error: true },
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'And this image' },
					{
						type: 'image',
						source: {
							type: 'base64',
							media_type: 'image/png',
							data: Buffer.from([1, 2, 3, 4]).toString('base64'),
						},
					},
					{
						type: 'text',
						text: '[file attached: "notes.txt", 42 bytes; attachment sha256:222. Its contents are not included in this request; read it with a file tool when needed.]',
					},
				],
			},
		],
		tools: [
			{
				name: 'Read',
				description: 'Read a file',
				input_schema: {
					type: 'object',
					properties: { file_path: { type: 'string' } },
					required: ['file_path'],
				},
			},
		],
		stop_sequences: ['END'],
		thinking: { type: 'adaptive', display: 'summarized' },
		output_config: { effort: 'low' },
	});
	// Claude Code never sends temperature; the option is ignored rather than forwarded.
	assert.equal('temperature' in body, false);
	assert.deepEqual(calls[0].target, { width: 10, height: 10, maxBytes: REQUEST_IMAGE_MAX_BYTES });
});

test('tool mapping filters deferred declarations and supplies a neutral schema', async () => {
	const options = generateOptions({
		tools: [
			{ name: 'NoSchema', description: 'no parameters' },
			{ name: 'DeferredOnly', description: 'x', parameters: { type: 'object' }, deferLoading: true },
		],
	});
	const { body } = await buildMessagesRequest({ model: SONNET, options, accessToken: 't' });
	assert.deepEqual(body.tools, [
		{
			name: 'NoSchema',
			description: 'no parameters',
			input_schema: { type: 'object', properties: {}, required: [] },
		},
	]);

	const withoutTools = await buildMessagesRequest({ model: SONNET, options: generateOptions(), accessToken: 't' });
	assert.equal('tools' in withoutTools.body, false);

	const onlyDeferred = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			tools: [{ name: 'D', description: 'x', parameters: { type: 'object' }, deferLoading: true }],
		}),
		accessToken: 't',
	});
	assert.equal('tools' in onlyDeferred.body, false);
});

/* -------------------------------------------------------------------------- */
/* Thinking, max tokens, stop                                                 */
/* -------------------------------------------------------------------------- */

test('adaptive thinking is sent only for reasoning models with a chosen effort', async () => {
	const withEffort = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({ reasoningEffort: 'medium' }),
		accessToken: 't',
	});
	assert.deepEqual(withEffort.body.thinking, { type: 'adaptive', display: 'summarized' });
	assert.deepEqual(withEffort.body.output_config, { effort: 'medium' });

	// Unknown effort levels fall back to the model's advertised default.
	const fallback = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({ reasoningEffort: 'xhigh' }),
		accessToken: 't',
	});
	assert.deepEqual(fallback.body.output_config, { effort: 'high' });

	const noEffort = await buildMessagesRequest({ model: SONNET, options: generateOptions(), accessToken: 't' });
	assert.equal('thinking' in noEffort.body, false);
	assert.equal('output_config' in noEffort.body, false);

	const nonReasoning = await buildMessagesRequest({
		model: HAIKU,
		options: generateOptions({ model: 'claude-haiku-4-5', reasoningEffort: 'high' }),
		accessToken: 't',
	});
	assert.equal('thinking' in nonReasoning.body, false);
	assert.equal('output_config' in nonReasoning.body, false);

	// Fallback capability metadata advertises reasoning for adaptive models.
	const opus = await buildMessagesRequest({
		model: undefined,
		options: generateOptions({ model: 'claude-opus-5', reasoningEffort: 'max' }),
		accessToken: 't',
	});
	assert.equal('thinking' in opus.body, false, 'without resolved model metadata no thinking is sent');
});

test('max_tokens defaults, respects the model ceiling, and never exceeds the adapter maximum', async () => {
	const defaults = await buildMessagesRequest({ model: SONNET, options: generateOptions(), accessToken: 't' });
	assert.equal(defaults.body.max_tokens, DEFAULT_OUTPUT_TOKENS);

	const explicit = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({ maxTokens: 4096 }),
		accessToken: 't',
	});
	assert.equal(explicit.body.max_tokens, 4096);

	const clampedToModel = await buildMessagesRequest({
		model: HAIKU,
		options: generateOptions({ model: 'claude-haiku-4-5', maxTokens: 999_999 }),
		accessToken: 't',
	});
	assert.equal(clampedToModel.body.max_tokens, 64_000);

	const capped = await buildMessagesRequest({
		model: { id: 'huge-output', maxTokens: 999_999 },
		options: generateOptions({ model: 'huge-output', maxTokens: 999_999 }),
		accessToken: 't',
	});
	assert.equal(capped.body.max_tokens, MAX_OUTPUT_TOKENS);

	const invalid = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({ maxTokens: -5 }),
		accessToken: 't',
	});
	assert.equal(invalid.body.max_tokens, DEFAULT_OUTPUT_TOKENS);
});

/* -------------------------------------------------------------------------- */
/* Images and files                                                           */
/* -------------------------------------------------------------------------- */

test('request image dimensions preserve aspect ratio within the pixel budget', () => {
	assert.deepEqual(requestImageDimensions(3000, 3000, REQUEST_IMAGE_MAX_PIXELS), { width: 2048, height: 2048 });
	assert.deepEqual(requestImageDimensions(4000, 2000, REQUEST_IMAGE_MAX_PIXELS), { width: 2896, height: 1448 });
	assert.deepEqual(requestImageDimensions(800, 600, REQUEST_IMAGE_MAX_PIXELS), { width: 800, height: 600 });
	const tall = requestImageDimensions(2000, 4000, REQUEST_IMAGE_MAX_PIXELS);
	assert.ok(tall.width * tall.height <= REQUEST_IMAGE_MAX_PIXELS);
	assert.ok(Math.abs(tall.width / tall.height - 0.5) < 0.01);
});

test('user images are prepared through the attachment service and sent as base64', async () => {
	const signal = new AbortController().signal;
	const { service, calls } = fakeImageService();
	const attachment = {
		attachmentId: 'sha256:image',
		mediaType: 'image/jpeg',
		width: 3000,
		height: 3000,
		bytes: 12_345,
		name: 'photo.jpg',
	};
	const { body } = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [
				{
					id: 'u1',
					role: 'user',
					content: [{ type: 'text', text: 'look' }, { type: 'image', attachment }],
				},
			],
		}),
		accessToken: 't',
		attachments: service,
		signal,
	});
	assert.deepEqual(body.messages[0].content[1], {
		type: 'image',
		source: {
			type: 'base64',
			media_type: 'image/png',
			data: Buffer.from([1, 2, 3, 4]).toString('base64'),
		},
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].attachment, attachment);
	assert.deepEqual(calls[0].target, { width: 2048, height: 2048, maxBytes: REQUEST_IMAGE_MAX_BYTES });
	assert.equal(calls[0].signal, signal);
});

test('offloaded or unreadable images degrade to a text placeholder instead of failing', async () => {
	const attachment = {
		attachmentId: 'sha256:offloaded',
		mediaType: 'image/png',
		width: 12,
		height: 8,
		bytes: 99,
		name: 'gone.png',
	};
	const offloaded = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [{ id: 'u1', role: 'user', content: [{ type: 'image', offloaded: true, attachment }] }],
		}),
		accessToken: 't',
		attachments: fakeImageService().service,
	});
	assert.equal(offloaded.body.messages[0].content[0].type, 'text');
	assert.match(offloaded.body.messages[0].content[0].text, /offloaded/);
	assert.match(offloaded.body.messages[0].content[0].text, /sha256:offloaded/);
	assert.doesNotMatch(offloaded.body.messages[0].content[0].text, /base64/);

	const noService = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [{ id: 'u1', role: 'user', content: [{ type: 'image', attachment }] }],
		}),
		accessToken: 't',
	});
	assert.match(noService.body.messages[0].content[0].text, /attachment service unavailable/);

	const failing = fakeImageService(() => new Error('disk on fire'));
	const unreadable = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [{ id: 'u1', role: 'user', content: [{ type: 'image', attachment }] }],
		}),
		accessToken: 't',
		attachments: failing.service,
	});
	assert.match(unreadable.body.messages[0].content[0].text, /unreadable attachment/);
});

test('assistant images and projected tool updates in user content are dropped defensively', async () => {
	const { body } = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [
				{
					id: 'a1',
					role: 'assistant',
					content: [
						{ type: 'text', text: 'hi' },
						{ type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', width: 1, height: 1, bytes: 1 } },
					],
				},
				{
					id: 'u1',
					role: 'user',
					content: [
						{ type: 'text', text: 'go' },
						{ type: 'tool-addition', toolName: 'A' },
						{ type: 'tool-removal', toolName: 'B' },
					],
				},
			],
		}),
		accessToken: 't',
	});
	assert.deepEqual(body.messages, [
		{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
		{ role: 'user', content: [{ type: 'text', text: 'go' }] },
	]);
});

/* -------------------------------------------------------------------------- */
/* Tool results                                                               */
/* -------------------------------------------------------------------------- */

test('consecutive tool results merge into one user message with is_error', async () => {
	const { service } = fakeImageService();
	const { body } = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [
				{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'run tools' }] },
				{
					id: 'a1',
					role: 'assistant',
					source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-sonnet-5' },
					content: [
						{ type: 'tool-call', id: 'call-a', name: 'A', arguments: '{}' },
						{ type: 'tool-call', id: 'call-b', name: 'B', arguments: '{}' },
						{ type: 'tool-call', id: 'call-c', name: 'C', arguments: '{}' },
					],
				},
				{ id: 't1', role: 'tool', toolCallId: 'call-a', content: [{ type: 'text', text: 'A says hi' }] },
				{ id: 't2', role: 'tool', toolCallId: 'call-b', content: [], isError: true },
				{
					id: 't3',
					role: 'tool',
					toolCallId: 'call-c',
					content: [
						{ type: 'text', text: 'C screenshot' },
						{ type: 'image', attachment: { attachmentId: 'sha256:shot', mediaType: 'image/png', width: 4, height: 4, bytes: 4 } },
					],
				},
			],
		}),
		accessToken: 't',
		attachments: service,
	});
	const userMessage = body.messages[2];
	assert.equal(body.messages.length, 3);
	assert.equal(userMessage.role, 'user');
	assert.deepEqual(userMessage.content[0], {
		type: 'tool_result',
		tool_use_id: 'call-a',
		content: 'A says hi',
		is_error: false,
	});
	assert.deepEqual(userMessage.content[1], {
		type: 'tool_result',
		tool_use_id: 'call-b',
		content: '(no output)',
		is_error: true,
	});
	assert.deepEqual(userMessage.content[2].content[0], { type: 'text', text: 'C screenshot' });
	assert.equal(userMessage.content[2].content[1].type, 'image');
});

/* -------------------------------------------------------------------------- */
/* Replay reconstruction                                                      */
/* -------------------------------------------------------------------------- */

test('assistant reasoning replays only from matching replay signatures', async () => {
	const replayState = {
		version: 1,
		response: { id: 'msg_prev', model: 'claude-sonnet-5' },
		blocks: [{}, { signature: 'sig-one' }, { redacted: 'opaque-redacted' }, {}, {}],
	};
	const { body } = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [
				{
					id: 'a1',
					role: 'assistant',
					source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-sonnet-5', replayState },
					content: [
						{ type: 'text', text: 'visible text' },
						{ type: 'reasoning', text: 'signed reasoning' },
						{ type: 'reasoning', text: 'redacted reasoning text' },
						{ type: 'reasoning', text: 'unsigned reasoning' },
						{ type: 'tool-call', id: 'toolu_9', name: 'Read', arguments: '{"a":1}' },
					],
				},
			],
		}),
		accessToken: 't',
	});
	assert.deepEqual(body.messages[0].content, [
		{ type: 'text', text: 'visible text' },
		{ type: 'thinking', thinking: 'signed reasoning', signature: 'sig-one' },
		{ type: 'redacted_thinking', data: 'opaque-redacted' },
		{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { a: 1 } },
	]);

	// Reasoning without any replay metadata never becomes wire thinking (and is
	// not smuggled back in as text).
	const noReplay = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [
				{
					id: 'a2',
					role: 'assistant',
					source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-sonnet-5' },
					content: [
						{ type: 'reasoning', text: 'plain reasoning' },
						{ type: 'text', text: 'answer' },
					],
				},
			],
		}),
		accessToken: 't',
	});
	assert.deepEqual(noReplay.body.messages[0].content, [{ type: 'text', text: 'answer' }]);

	// A foreign/unknown replay version is ignored.
	const wrongVersion = await buildMessagesRequest({
		model: SONNET,
		options: generateOptions({
			messages: [
				{
					id: 'a3',
					role: 'assistant',
					source: {
						kind: 'model',
						provider: PROVIDER_ID,
						model: 'claude-sonnet-5',
						replayState: { version: 2, blocks: [{ signature: 'nope' }] },
					},
					content: [{ type: 'reasoning', text: 'drop me' }],
				},
			],
		}),
		accessToken: 't',
	});
	assert.deepEqual(wrongVersion.body.messages, []);
});

/* -------------------------------------------------------------------------- */
/* SSE parser                                                                 */
/* -------------------------------------------------------------------------- */

test('parseSseStream frames split SSE bytes, comments, and CRLF line endings', async () => {
	async function* chunks() {
		yield Buffer.from('event: message_start\r\ndata: {"type":"message_start",');
		yield Buffer.from('"value":1}\r\n\r\n: heartbeat\n\n');
		yield Buffer.from('event: ping\ndata: {"type":"ping"}\n\n');
		yield Buffer.from('data: {"type":"delta"}\n\n');
		// Unterminated tail at EOF is not a frame.
		yield Buffer.from('event: tail\ndata: {"type":"cut-off"}');
	}
	const frames = await collect(parseSseStream(chunks()));
	assert.deepEqual(frames, [
		{ event: 'message_start', data: { type: 'message_start', value: 1 } },
		{ event: 'ping', data: { type: 'ping' } },
		{ event: 'delta', data: { type: 'delta' } },
	]);
});

test('parseSseStream accepts a web ReadableStream and concatenates multi-line data', async () => {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('event: multi\ndata: {"type":"multi",\ndata: "ok":true}\n\n'));
			controller.close();
		},
	});
	const frames = await collect(parseSseStream(stream));
	assert.equal(frames.length, 1);
	assert.equal(frames[0].event, 'multi');
	assert.deepEqual(frames[0].data, { type: 'multi', ok: true });

	// A node:stream Readable works through its async iterator as well.
	const nodeStream = Readable.from([Buffer.from('data: {"plain":true}\n\n')]);
	const nodeFrames = await collect(parseSseStream(nodeStream));
	assert.deepEqual(nodeFrames[0].data, { plain: true });
	assert.equal(nodeFrames[0].event, undefined);
});

/* -------------------------------------------------------------------------- */
/* Streaming over the fake endpoint                                           */
/* -------------------------------------------------------------------------- */

test('streams a text turn into the DSH chunk protocol and sends Claude Code headers', async () => {
	const events = [
		messageStart('msg_text_1', 'claude-sonnet-5', {
			input_tokens: 11,
			cache_read_input_tokens: 4,
			output_tokens: 1,
		}),
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'ping' },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
		{ type: 'content_block_stop', index: 0 },
		messageDelta('end_turn', { output_tokens: 9 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks, tokens } = await streamChunks(server, {
			sessionId: 'sess-text',
			reasoningEffort: 'medium',
		});
		assert.deepEqual(chunks, [
			{ type: 'block-start', index: 0, blockType: 'text' },
			{ type: 'text-delta', index: 0, text: 'Hello' },
			{ type: 'text-delta', index: 0, text: ' world' },
			{ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
			{
				type: 'usage',
				usage: { inputTokens: 11, outputTokens: 9, totalTokens: 24, cacheReadTokens: 4 },
			},
			{
				type: 'finish',
				reason: { kind: 'stop' },
				replayState: {
					version: 1,
					response: { id: 'msg_text_1', model: 'claude-sonnet-5' },
					blocks: [{}],
				},
			},
		]);
		assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
		assert.equal(chunks.at(-1).type, 'finish');
		assert.equal(tokens.getCalls, 1);

		assert.equal(server.requests.length, 1);
		const request = server.requests[0];
		assert.equal(request.method, 'POST');
		assert.equal(request.url, '/v1/messages');
		assert.equal(request.headers.authorization, 'Bearer sk-ant-oat01-initial');
		assert.equal(request.headers['anthropic-version'], ANTHROPIC_VERSION);
		assert.equal(request.headers['anthropic-beta'], INFERENCE_BETAS);
		assert.equal(request.headers['user-agent'], CC_USER_AGENT);
		assert.equal(request.headers['x-app'], 'cli');
		assert.equal(request.headers['x-claude-code-session-id'], 'sess-text');
		assert.equal(request.headers['content-type'], 'application/json');
		assert.equal(request.headers.accept, 'application/json');
		assert.equal(request.body.model, 'claude-sonnet-5');
		assert.equal(request.body.max_tokens, DEFAULT_OUTPUT_TOKENS);
		assert.equal(request.body.stream, true);
		assert.deepEqual(request.body.thinking, { type: 'adaptive', display: 'summarized' });
		assert.deepEqual(request.body.output_config, { effort: 'medium' });
		assert.deepEqual(request.body.system, [
			{ type: 'text', text: CLAUDE_CODE_IDENTITY },
			{ type: 'text', text: billingHeaderLine('Hello world from the test prompt.') },
		]);
	} finally {
		await server.close();
	}
});

test('captures thinking signatures into replayState without emitting signature text', async () => {
	const events = [
		messageStart('msg_think', 'claude-sonnet-5', { input_tokens: 20, output_tokens: 1 }),
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weigh options' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' carefully.' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'two==' } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } },
		{ type: 'content_block_stop', index: 1 },
		messageDelta('end_turn', { output_tokens: 12 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks } = await streamChunks(server);
		assert.deepEqual(chunks, [
			{ type: 'block-start', index: 0, blockType: 'reasoning' },
			{ type: 'reasoning-delta', index: 0, text: 'Weigh options' },
			{ type: 'reasoning-delta', index: 0, text: ' carefully.' },
			{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Weigh options carefully.' } },
			{ type: 'block-start', index: 1, blockType: 'text' },
			{ type: 'text-delta', index: 1, text: 'Answer.' },
			{ type: 'block-end', index: 1, block: { type: 'text', text: 'Answer.' } },
			{ type: 'usage', usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 } },
			{
				type: 'finish',
				reason: { kind: 'stop' },
				replayState: {
					version: 1,
					response: { id: 'msg_think', model: 'claude-sonnet-5' },
					blocks: [{ signature: 'sig-part-two==' }, {}],
				},
			},
		]);
		// Signature text is provider replay metadata only; no UI-facing text carries it.
		for (const chunk of chunks) {
			if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
				assert.doesNotMatch(chunk.text, /sig-part/);
			}
			if (chunk.type === 'block-end' && chunk.block.type !== 'tool-call') {
				assert.doesNotMatch(chunk.block.text, /sig-part/);
			}
		}

		// Round-trip: the durable replay envelope restores the native thinking block.
		const finish = chunks.at(-1);
		const { body } = await buildMessagesRequest({
			model: SONNET,
			options: generateOptions({
				messages: [
					{ id: 'u', role: 'user', content: [{ type: 'text', text: 'question' }] },
					{
						id: 'a',
						role: 'assistant',
						source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-sonnet-5', replayState: finish.replayState },
						content: [
							{ type: 'reasoning', text: 'Weigh options carefully.' },
							{ type: 'text', text: 'Answer.' },
						],
					},
				],
			}),
			accessToken: 't',
		});
		assert.deepEqual(body.messages[1], {
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'Weigh options carefully.', signature: 'sig-part-two==' },
				{ type: 'text', text: 'Answer.' },
			],
		});
	} finally {
		await server.close();
	}
});

test('streams redacted thinking as empty reasoning plus redacted replay payload', async () => {
	const events = [
		messageStart('msg_redacted', 'claude-sonnet-5', { input_tokens: 7, output_tokens: 1 }),
		{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-redacted-payload' } },
		{ type: 'content_block_stop', index: 0 },
		{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Visible' } },
		{ type: 'content_block_stop', index: 1 },
		messageDelta('end_turn', { output_tokens: 3 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks } = await streamChunks(server);
		const finish = chunks.at(-1);
		assert.deepEqual(finish.replayState.blocks, [{ redacted: 'opaque-redacted-payload' }, {}]);
		assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' });
		assert.deepEqual(chunks[1], { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } });
		for (const chunk of chunks) {
			if (chunk.type === 'block-end' || chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
				const text = chunk.type === 'block-end' ? chunk.block.text ?? '' : chunk.text;
				assert.doesNotMatch(String(text), /opaque-redacted-payload/);
			}
		}

		const { body } = await buildMessagesRequest({
			model: SONNET,
			options: generateOptions({
				messages: [
					{
						id: 'a',
						role: 'assistant',
						source: { kind: 'model', provider: PROVIDER_ID, model: 'claude-sonnet-5', replayState: finish.replayState },
						content: [
							{ type: 'reasoning', text: '' },
							{ type: 'text', text: 'Visible' },
						],
					},
				],
			}),
			accessToken: 't',
		});
		assert.deepEqual(body.messages[0].content[0], { type: 'redacted_thinking', data: 'opaque-redacted-payload' });
	} finally {
		await server.close();
	}
});

test('streams tool_use with partial JSON into one block-end tool-call block', async () => {
	const events = [
		messageStart('msg_tool', 'claude-sonnet-5', { input_tokens: 30, output_tokens: 1 }),
		{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'a.txt"}' } },
		{ type: 'content_block_stop', index: 0 },
		messageDelta('tool_use', { output_tokens: 8 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks } = await streamChunks(server);
		assert.deepEqual(chunks, [
			{ type: 'block-start', index: 0, blockType: 'tool-call' },
			{ type: 'tool-call-delta', index: 0, id: 'toolu_01', name: 'Read', argumentsDelta: '' },
			{ type: 'tool-call-delta', index: 0, id: 'toolu_01', name: 'Read', argumentsDelta: '{"file_path":"/tmp/' },
			{ type: 'tool-call-delta', index: 0, id: 'toolu_01', name: 'Read', argumentsDelta: 'a.txt"}' },
			{
				type: 'block-end',
				index: 0,
				block: { type: 'tool-call', id: 'toolu_01', name: 'Read', arguments: '{"file_path":"/tmp/a.txt"}' },
			},
			{ type: 'usage', usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } },
			{
				type: 'finish',
				reason: { kind: 'tool-calls' },
				replayState: { version: 1, response: { id: 'msg_tool', model: 'claude-sonnet-5' }, blocks: [{}] },
			},
		]);
	} finally {
		await server.close();
	}
});

test('max_tokens maps to the max-tokens finish with usage first', async () => {
	const events = [
		messageStart('msg_max', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 1 }),
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Trunc' } },
		{ type: 'content_block_stop', index: 0 },
		messageDelta('max_tokens', { output_tokens: 5 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks } = await streamChunks(server);
		assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } });
		assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' });
		assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
	} finally {
		await server.close();
	}
});

test('a completed response with no content becomes an EMPTY_RESPONSE failure', async () => {
	const events = [
		messageStart('msg_empty', 'claude-sonnet-5', { input_tokens: 2, output_tokens: 1 }),
		messageDelta('end_turn', { output_tokens: 1 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks } = await streamChunks(server);
		assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
		assert.equal(chunks.length, 2);
		assert.deepEqual(chunks[1].reason, {
			kind: 'error',
			failure: { message: 'model "claude-sonnet-5" returned a completed response with no content', code: 'EMPTY_RESPONSE' },
		});
	} finally {
		await server.close();
	}
});

test('an in-band stream error event becomes a terminal error finish', async () => {
	const events = [
		messageStart('msg_err', 'claude-sonnet-5', { input_tokens: 2, output_tokens: 1 }),
		{ type: 'error', error: { type: 'overloaded_error', message: 'try later' } },
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks } = await streamChunks(server);
		const finish = chunks.at(-1);
		assert.equal(finish.type, 'finish');
		assert.equal(finish.reason.kind, 'error');
		assert.equal(finish.reason.failure.code, 'SERVER');
		assert.match(finish.reason.failure.message, /overloaded_error/);
		assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
		assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1);
	} finally {
		await server.close();
	}
});

/* -------------------------------------------------------------------------- */
/* HTTP failures                                                              */
/* -------------------------------------------------------------------------- */

test('maps HTTP failures to the documented failure codes', async (t) => {
	const cases = [
		{
			status: 429,
			payload: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
			code: 'RATE_LIMIT',
		},
		{
			status: 400,
			payload: {
				type: 'error',
				error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' },
			},
			code: 'CONTEXT_WINDOW_EXCEEDED',
		},
		{
			status: 400,
			payload: {
				type: 'error',
				error: { type: 'invalid_request_error', message: 'max_tokens: 200000 > 128000' },
			},
			code: 'INVALID_REQUEST',
		},
		{
			status: 500,
			payload: { type: 'error', error: { type: 'api_error', message: 'internal' } },
			code: 'SERVER',
		},
		{
			status: 403,
			payload: { type: 'error', error: { type: 'permission_error', message: 'forbidden' } },
			code: 'AUTH',
		},
	];
	for (const testCase of cases) {
		const server = await startFakeAnthropic((record, res) => respondJson(res, testCase.status, testCase.payload));
		t.after(() => server.close());
		const { adapter } = createHarness({ __apiBaseUrl: server.url });
		const call = await adapter.prepareCall(PROVIDER_ID, 'claude-sonnet-5');
		await assert.rejects(
			() => collect(call.stream(generateOptions())),
			(error) => isPluginError(error, testCase.code),
			`expected ${testCase.code} for HTTP ${testCase.status}`,
		);
	}
});

test('provider error text never leaks the OAuth token', async () => {
	let leakedToken = '';
	const server = await startFakeAnthropic((record, res) => {
		leakedToken = String(record.headers.authorization ?? '').replace(/^Bearer /, '');
		respondJson(res, 500, {
			type: 'error',
			error: { type: 'api_error', message: `upstream rejected ${record.headers.authorization}` },
		});
	});
	try {
		const { adapter } = createHarness({ __apiBaseUrl: server.url });
		const call = await adapter.prepareCall(PROVIDER_ID, 'claude-sonnet-5');
		let thrown;
		await assert.rejects(
			() => collect(call.stream(generateOptions())),
			(error) => {
				thrown = error;
				return isPluginError(error, 'SERVER');
			},
		);
		assert.ok(leakedToken.length > 0);
		assert.equal(thrown.message.includes(leakedToken), false);
		assert.match(thrown.message, /\[redacted\]/);
		assert.equal(JSON.stringify(thrown.details ?? {}).includes(leakedToken), false);
	} finally {
		await server.close();
	}
});

/* -------------------------------------------------------------------------- */
/* 401 refresh retry                                                          */
/* -------------------------------------------------------------------------- */

test('a 401 before any stream bytes triggers exactly one forced refresh and one retry', async () => {
	const events = [
		messageStart('msg_retry', 'claude-sonnet-5', { input_tokens: 3, output_tokens: 1 }),
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
		{ type: 'content_block_stop', index: 0 },
		messageDelta('end_turn', { output_tokens: 1 }),
		messageStop(),
	];
	const server = await startFakeAnthropic((record, res, attempt) => {
		if (attempt === 1) {
			respondJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'token expired' } });
			return;
		}
		writeSse(res, events);
		res.end();
	});
	try {
		const { chunks, tokens } = await streamChunks(server);
		assert.equal(tokens.refreshes, 1);
		assert.equal(tokens.getCalls, 1);
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[0].headers.authorization, 'Bearer sk-ant-oat01-initial');
		assert.equal(server.requests[1].headers.authorization, 'Bearer sk-ant-oat01-refreshed');
		assert.equal(chunks.at(-1).reason.kind, 'stop');
	} finally {
		await server.close();
	}
});

test('a repeated 401 fails with AUTH after one refresh attempt', async () => {
	const server = await startFakeAnthropic((record, res) => {
		respondJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'still expired' } });
	});
	try {
		const { adapter, tokens } = createHarness({ __apiBaseUrl: server.url });
		const call = await adapter.prepareCall(PROVIDER_ID, 'claude-sonnet-5');
		await assert.rejects(
			() => collect(call.stream(generateOptions())),
			(error) => isPluginError(error, 'AUTH'),
		);
		assert.equal(tokens.refreshes, 1);
		assert.equal(server.requests.length, 2);
	} finally {
		await server.close();
	}
});

/* -------------------------------------------------------------------------- */
/* Abort and timeout                                                          */
/* -------------------------------------------------------------------------- */

test('caller abort closes the body and yields one terminal aborted finish', async () => {
	let markClosed;
	let closedResolved = false;
	const closed = new Promise((resolve) => {
		markClosed = () => {
			closedResolved = true;
			resolve();
		};
	});
	const partial = [
		messageStart('msg_abort', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 1 }),
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
	];
	const server = await startFakeAnthropic((record, res) => {
		writeSse(res, partial);
		res.on('close', () => markClosed());
		// Keep the response open: the client cancels it.
	});
	try {
		const { adapter } = createHarness({ __apiBaseUrl: server.url });
		const controller = new AbortController();
		const call = await adapter.prepareCall(PROVIDER_ID, 'claude-sonnet-5');
		const iterator = call
			.stream(generateOptions({ signal: controller.signal, sessionId: 'sess-abort' }))
			[Symbol.asyncIterator]();

		const seen = [];
		for (;;) {
			const { done, value } = await iterator.next();
			if (done) break;
			seen.push(value);
			if (value.type === 'text-delta') break;
		}
		controller.abort();
		for (;;) {
			const { done, value } = await iterator.next();
			if (done) break;
			seen.push(value);
		}

		assert.equal(seen.filter((chunk) => chunk.type === 'finish').length, 1);
		const finish = seen.at(-1);
		assert.deepEqual(finish.reason, { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } });
		// Usage known from message_start is delivered before the terminal finish.
		const usageIndex = seen.findIndex((chunk) => chunk.type === 'usage');
		assert.ok(usageIndex >= 0 && usageIndex < seen.length - 1);
		assert.deepEqual(seen[usageIndex].usage, { inputTokens: 5, outputTokens: 1, totalTokens: 6 });

		await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
		assert.equal(closedResolved, true, 'the HTTP response body must be closed after a caller abort');
	} finally {
		await server.close();
	}
});

test('an already-aborted signal settles immediately without a request', async () => {
	const { adapter } = createHarness({ __apiBaseUrl: 'http://127.0.0.1:1' });
	const controller = new AbortController();
	controller.abort();
	const chunks = await collect(adapter.stream(generateOptions({ signal: controller.signal })));
	assert.deepEqual(chunks, [
		{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } },
	]);
});

test('an idle stream times out with a TIMEOUT failure', async () => {
	const server = await startFakeAnthropic(() => {
		// Never respond: the adapter's idle watchdog must fire.
	});
	try {
		const { adapter } = createHarness({ __apiBaseUrl: server.url, __idleTimeoutMs: 120 });
		const call = await adapter.prepareCall(PROVIDER_ID, 'claude-sonnet-5');
		await assert.rejects(
			() => collect(call.stream(generateOptions())),
			(error) => isPluginError(error, 'TIMEOUT'),
		);
	} finally {
		await server.close();
	}
});

test('stream wire requests clamp max_tokens to the model output ceiling', async () => {
	const server = await startFakeAnthropic((record, res) =>
		respondJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'rejected for test' } }),
	);
	try {
		const { adapter } = createHarness({ __apiBaseUrl: server.url });
		const call = await adapter.prepareCall(PROVIDER_ID, 'claude-haiku-4-5');
		await assert.rejects(
			() => collect(call.stream(generateOptions({ model: 'claude-haiku-4-5', maxTokens: 999_999 }))),
			(error) => isPluginError(error, 'INVALID_REQUEST'),
		);
		assert.equal(server.requests[0].body.max_tokens, 64_000);
	} finally {
		await server.close();
	}
});
