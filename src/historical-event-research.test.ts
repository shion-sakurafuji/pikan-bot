import assert = require("node:assert/strict");
import test = require("node:test");
import historicalEventResearch = require("./historical-event-research");

test("Web検索で指定日の複数候補を未検証として返す", async (t) => {
	const originalKey = process.env.OPENAI_API_KEY;
	const originalModel = process.env.OPENAI_MODEL;
	const originalResearchModel = process.env.HISTORICAL_EVENTS_MODEL;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_MODEL = "test-model";
	delete process.env.HISTORICAL_EVENTS_MODEL;
	t.after(() => {
		if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalKey;
		if (originalModel === undefined) delete process.env.OPENAI_MODEL;
		else process.env.OPENAI_MODEL = originalModel;
		if (originalResearchModel === undefined) delete process.env.HISTORICAL_EVENTS_MODEL;
		else process.env.HISTORICAL_EVENTS_MODEL = originalResearchModel;
	});

	let requestedUrl = "";
	let requestOptions: RequestInit | undefined;
	const fetchMock: typeof fetch = async (input, init) => {
		requestedUrl = String(input);
		requestOptions = init;
		return new Response(JSON.stringify({
			output: [{
				type: "message",
				content: [{
					type: "output_text",
					text: JSON.stringify({ events: [
						{ event: "出来事A", eventKey: "event-a", date: "1929-10-31", sourceUrl: "https://example.com/a" },
						{ event: "出来事B", eventKey: "event-b", date: "1929-10-31", sourceUrl: "https://example.org/b" },
					] }),
				}],
			}],
		}), { status: 200 });
	};

	const candidates = await historicalEventResearch.getHistoricalEventCandidates(1929, 10, 31, fetchMock);
	const requestBody = JSON.parse(String(requestOptions?.body)) as {
		model: string;
		tools: { type: string }[];
		input: string;
	};

	assert.equal(requestedUrl, "https://api.openai.com/v1/responses");
	assert.equal(requestBody.model, "test-model");
	assert.deepEqual(requestBody.tools, [{ type: "web_search" }]);
	assert.match(requestBody.input, /1929-10-31/);
	assert.match(requestBody.input, /ちょうど8件/);
	assert.match(requestBody.input, /Wikipediaに限定せず/);
	assert.deepEqual(candidates, [
		{ event: "出来事A", eventKey: "event-a", date: "1929-10-31", sourceUrl: "https://example.com/a", verified: false },
		{ event: "出来事B", eventKey: "event-b", date: "1929-10-31", sourceUrl: "https://example.org/b", verified: false },
	]);
});

test("調査専用モデル環境変数を優先する", async (t) => {
	const originalKey = process.env.OPENAI_API_KEY;
	const originalModel = process.env.OPENAI_MODEL;
	const originalResearchModel = process.env.HISTORICAL_EVENTS_MODEL;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_MODEL = "default-model";
	process.env.HISTORICAL_EVENTS_MODEL = "research-model";
	t.after(() => {
		if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalKey;
		if (originalModel === undefined) delete process.env.OPENAI_MODEL;
		else process.env.OPENAI_MODEL = originalModel;
		if (originalResearchModel === undefined) delete process.env.HISTORICAL_EVENTS_MODEL;
		else process.env.HISTORICAL_EVENTS_MODEL = originalResearchModel;
	});

	let requestedModel = "";
	const fetchMock: typeof fetch = async (_input, init) => {
		requestedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
		return new Response(JSON.stringify({
			output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ events: [] }) }] }],
		}), { status: 200 });
	};

	await historicalEventResearch.getHistoricalEventCandidates(1929, 10, 31, fetchMock);
	assert.equal(requestedModel, "research-model");
});

test("無効な日付は通信前に拒否する", async () => {
	let wasCalled = false;
	const fetchMock: typeof fetch = async () => {
		wasCalled = true;
		return new Response();
	};

	await assert.rejects(
		historicalEventResearch.getHistoricalEventCandidates(1929, 2, 29, fetchMock),
		/有効な年月日/,
	);
	assert.equal(wasCalled, false);
});

test("一度の調査件数は最大8件に制限する", async () => {
	let wasCalled = false;
	const fetchMock: typeof fetch = async () => {
		wasCalled = true;
		return new Response();
	};
	await assert.rejects(
		historicalEventResearch.getHistoricalEventCandidates(1929, 10, 31, fetchMock, 9),
		/1件から8件/,
	);
	assert.equal(wasCalled, false);
});

test("指定日と異なる日付の候補は返さない", async (t) => {
	const originalKey = process.env.OPENAI_API_KEY;
	const originalModel = process.env.OPENAI_MODEL;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_MODEL = "test-model";
	t.after(() => {
		if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalKey;
		if (originalModel === undefined) delete process.env.OPENAI_MODEL;
		else process.env.OPENAI_MODEL = originalModel;
	});

	const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
		output: [{
			type: "message",
			content: [{
				type: "output_text",
				text: JSON.stringify({ events: [
					{ event: "別の日の出来事", eventKey: "other-event", date: "1929-11-01", sourceUrl: "https://example.com/event" },
				] }),
			}],
		}],
	}), { status: 200 });

	await assert.rejects(
		historicalEventResearch.getHistoricalEventCandidates(1929, 10, 31, fetchMock),
		/指定日と一致する/,
	);
});