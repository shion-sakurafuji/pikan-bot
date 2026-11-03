import assert = require("node:assert/strict");
import test = require("node:test");
import openAiClient = require("./openai-client");

function setEnvironment(t: test.TestContext, values: Record<string, string | undefined>): void {
	const originalValues = Object.keys(values).map((name) => process.env[name]);
	Object.entries(values).forEach(([name, value]) => {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	});
	t.after(() => {
		Object.keys(values).forEach((name, index) => {
			const originalValue = originalValues[index];
			if (originalValue === undefined) delete process.env[name];
			else process.env[name] = originalValue;
		});
	});
}

test("Responses APIリクエストでモデル・ツール・JSON Schemaを指定しテキストを結合する", async (t) => {
	setEnvironment(t, { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "default-model" });
	let requestedUrl = "";
	let requestOptions: RequestInit | undefined;
	const fetchMock: typeof fetch = async (input, init) => {
		requestedUrl = String(input);
		requestOptions = init;
		return new Response(JSON.stringify({
			output: [
				{ type: "reasoning", content: [] },
				{ type: "message", content: [
					{ type: "output_text", text: " first " },
					{ type: "output_text", text: "second " },
				] },
			],
		}), { status: 200 });
	};

	const result = await openAiClient.requestOpenAi("調査してください", {
		model: "research-model",
		tools: [{ type: "web_search" }],
		jsonSchema: {
			name: "events",
			schema: { type: "object", properties: { events: { type: "array" } } },
		},
		fetchImplementation: fetchMock,
	});
	const body = JSON.parse(String(requestOptions?.body)) as {
		model: string;
		input: string;
		tools: { type: string }[];
		text: { format: { type: string; name: string; strict: boolean; schema: unknown } };
	};

	assert.equal(requestedUrl, "https://api.openai.com/v1/responses");
	assert.equal(new Headers(requestOptions?.headers).get("Authorization"), "Bearer test-key");
	assert.equal(body.model, "research-model");
	assert.equal(body.input, "調査してください");
	assert.deepEqual(body.tools, [{ type: "web_search" }]);
	assert.equal(body.text.format.type, "json_schema");
	assert.equal(body.text.format.name, "events");
	assert.equal(body.text.format.strict, true);
	assert.deepEqual(body.text.format.schema, { type: "object", properties: { events: { type: "array" } } });
	assert.equal(result, "first second");
});

test("HTTPエラーを空の成功結果にせず例外にする", async (t) => {
	setEnvironment(t, { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "test-model" });
	const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
		error: { message: "invalid request" },
	}), { status: 400 });

	await assert.rejects(openAiClient.requestOpenAi("prompt", { fetchImplementation: fetchMock }), /invalid request/);
});

test("出力テキストがない成功応答は例外にする", async (t) => {
	setEnvironment(t, { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "test-model" });
	const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ output: [] }), { status: 200 });

	await assert.rejects(openAiClient.requestOpenAi("prompt", { fetchImplementation: fetchMock }), /出力テキストが空/);
});

test("APIキーまたはモデルがない場合は通信前に例外にする", async (t) => {
	setEnvironment(t, { OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined });
	let wasCalled = false;
	const fetchMock: typeof fetch = async () => {
		wasCalled = true;
		return new Response();
	};

	await assert.rejects(openAiClient.requestOpenAi("prompt", { fetchImplementation: fetchMock }), /OPENAI_API_KEY/);
	assert.equal(wasCalled, false);
});

test("通常APIとWeb検索は別々の既定タイムアウトを使う", (t) => {
	setEnvironment(t, {
		OPENAI_REQUEST_TIMEOUT_MS: undefined,
		OPENAI_WEB_SEARCH_TIMEOUT_MS: undefined,
	});
	assert.equal(openAiClient.getRequestTimeoutMs(), 30_000);
	assert.equal(openAiClient.getRequestTimeoutMs([{ type: "web_search" }]), 120_000);
});

test("環境変数で通常APIとWeb検索のタイムアウトを個別に上書きできる", (t) => {
	setEnvironment(t, {
		OPENAI_REQUEST_TIMEOUT_MS: "45000",
		OPENAI_WEB_SEARCH_TIMEOUT_MS: "180000",
	});
	assert.equal(openAiClient.getRequestTimeoutMs(), 45_000);
	assert.equal(openAiClient.getRequestTimeoutMs([{ type: "web_search" }]), 180_000);
});

test("Web検索タイムアウト時は1回の呼び出しで例外終了する", async (t) => {
	setEnvironment(t, {
		OPENAI_API_KEY: "test-key",
		OPENAI_MODEL: "test-model",
		OPENAI_WEB_SEARCH_TIMEOUT_MS: "5",
	});
	let apiRequests = 0;
	const fetchMock: typeof fetch = async (_input, init) => {
		apiRequests += 1;
		const signal = init?.signal;
		assert.ok(signal);
		return new Promise<Response>((_resolve, reject) => {
			if (signal.aborted) reject(signal.reason);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	};

	await assert.rejects(
		openAiClient.requestOpenAi("search", {
			tools: [{ type: "web_search" }],
			fetchImplementation: fetchMock,
		}),
		(error: unknown) => {
			assert.ok(error instanceof openAiClient.OpenAiRequestError);
			assert.match(error.message, /timeout/i);
			return true;
		},
	);
	assert.equal(apiRequests, 1);
});