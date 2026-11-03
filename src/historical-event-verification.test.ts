import assert = require("node:assert/strict");
import test = require("node:test");
import historicalEventVerification = require("./historical-event-verification");

const eventText = "The Example Treaty was signed on October 31, 1926.";
const date = "1926-10-31";

type SourceEvidence = {
	url: string;
	claimQuote?: string;
	dateQuote?: string;
    extractedDate?: string;
	supportsEvent?: boolean;
	supportsDate?: boolean;
	reliable?: boolean;
	primarySource?: boolean;
	independenceGroup?: string;
	contradicts?: boolean;
};

function setEnvironment(t: test.TestContext): void {
	const originalKey = process.env.OPENAI_API_KEY;
	const originalModel = process.env.OPENAI_MODEL;
	const originalVerificationModel = process.env.HISTORICAL_EVENT_VERIFICATION_MODEL;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_MODEL = "test-model";
	delete process.env.HISTORICAL_EVENT_VERIFICATION_MODEL;
	t.after(() => {
		if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalKey;
		if (originalModel === undefined) delete process.env.OPENAI_MODEL;
		else process.env.OPENAI_MODEL = originalModel;
		if (originalVerificationModel === undefined) delete process.env.HISTORICAL_EVENT_VERIFICATION_MODEL;
		else process.env.HISTORICAL_EVENT_VERIFICATION_MODEL = originalVerificationModel;
	});
}

function apiResponse(outputText: string, status = 200): Response {
	return new Response(JSON.stringify({
		output: [{ type: "message", content: [{ type: "output_text", text: outputText }] }],
	}), { status });
}

function apiErrorResponse(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), { status });
}

function candidate(sourceUrl = "https://primary.example.test/history"): {
	event: string;
	date: string;
	sourceUrl: string;
	verified: false;
} {
	return { event: "The Example Treaty was signed", date, sourceUrl, verified: false };
}

function evidence(url: string, overrides: Partial<SourceEvidence> = {}): SourceEvidence {
	return {
		url,
		claimQuote: eventText,
		dateQuote: eventText,
        extractedDate: date,
		supportsEvent: true,
		supportsDate: true,
		reliable: true,
		primarySource: false,
		independenceGroup: "example-group",
		contradicts: false,
		...overrides,
	};
}

async function verify(
	t: test.TestContext,
	options: {
		candidate?: ReturnType<typeof candidate>;
		sourceUrls?: string[];
		pageTexts?: Record<string, string>;
		evidence?: SourceEvidence[];
		searchStatus?: number;
		searchApiError?: { status: number; code: string; message: string };
		searchTimeout?: boolean;
		reviewStatus?: number;
		candidates?: ReturnType<typeof candidate>[];
		discoveredCandidates?: Array<{ candidateIndex: number; sourceUrls: string[] }>;
	},
) {
	setEnvironment(t);
	const item = options.candidate ?? candidate();
	const items = options.candidates ?? [item];
	const sourceUrls = options.sourceUrls ?? [item.sourceUrl];
	const pageTexts = options.pageTexts ?? Object.fromEntries(sourceUrls.map((url) => [url, eventText]));
	let apiRequests = 0;
	let sourceRequests = 0;
	const requestedSourceUrls: string[] = [];
	let reviewInput = "";
	const fetchMock: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url === "https://api.openai.com/v1/responses") {
			apiRequests += 1;
			if (apiRequests === 1) {
				if (options.searchTimeout) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
				if (options.searchApiError) {
					return apiErrorResponse(options.searchApiError.status, options.searchApiError.code, options.searchApiError.message);
				}
				const discoveredCandidates = options.discoveredCandidates ?? [{ candidateIndex: 0, sourceUrls }];
				return apiResponse(JSON.stringify({ events: discoveredCandidates.map(({ candidateIndex, sourceUrls: urls }) => ({ candidateIndex, sources: urls.map((url) => ({ url })) })) }), options.searchStatus ?? 200);
			}
			reviewInput = (JSON.parse(String(init?.body)) as { input: string }).input;
			const reviewedSources = options.evidence ?? sourceUrls.map((sourceUrl) => evidence(sourceUrl));
			return apiResponse(JSON.stringify({ events: [{ candidateIndex: 0, sources: reviewedSources }] }), options.reviewStatus ?? 200);
		}
		sourceRequests += 1;
		requestedSourceUrls.push(url);
		assert.equal(init?.method, "GET");
		const text = pageTexts[url];
		return text === undefined
			? new Response("Not found", { status: 404 })
			: new Response(`<html><body><p>${text}</p></body></html>`, { headers: { "content-type": "text/html" } });
	};
	const apiCallKinds: string[] = [];
	const results = await historicalEventVerification.verifyHistoricalEventCandidates(items, {
		fetchImplementation: fetchMock,
		onApiCall: (kind) => apiCallKinds.push(kind),
	});
	return { result: results[0]!, results, apiRequests, sourceRequests, requestedSourceUrls, reviewInput, apiCallKinds };
}

test("本文中の日付が一致し、独立した2資料が裏付ける場合に採用する", async (t) => {
	const urls = ["https://archive.example.test/treaty", "https://university.example.test/treaty"];
	const result = await verify(t, {
		sourceUrls: urls,
		evidence: [evidence(urls[0]!, { independenceGroup: "archive" }), evidence(urls[1]!, { independenceGroup: "university" })],
	});
	assert.equal(result.result.verified, true);
	assert.deepEqual(result.result.sourceUrls, urls);
	assert.deepEqual(result.result.verifiedSourceUrls, urls);
	assert.equal(result.result.sourceEvidence.length, 2);
	assert.equal(result.result.sourceEvidence[0]?.claimQuoteMatched, true);
	assert.equal(result.result.sourceEvidence[0]?.dateMatchesCandidate, true);
	assert.equal(result.result.sourceEvidence[0]?.supportsEvent, true);
	assert.match(result.result.verificationReason, /取得した資料/);
});


test("出典本文の日付が候補日と一致しない場合は不採用にする", async (t) => {
    const url = "https://history.example.test/treaty";

    const result = await verify(t, {
        sourceUrls: [url],
        pageTexts: {
            [url]: "The Example Treaty was signed on October 30, 1926."
        },
        evidence: [
            evidence(url, {
                primarySource: true,
                claimQuote: "The Example Treaty was signed on October 30, 1926.",
                dateQuote: "The Example Treaty was signed on October 30, 1926.",
                extractedDate: "1926-10-30",
            })
        ],
    });

    assert.equal(result.result.verified, false);
    assert.deepEqual(result.result.sourceUrls, [url]);
	assert.deepEqual(result.result.verifiedSourceUrls, []);
    assert.equal(result.result.sourceEvidence[0]?.dateQuoteMatched, true);
    assert.equal(result.result.sourceEvidence[0]?.dateMatchesCandidate, false);
    assert.equal(result.result.sourceEvidence[0]?.supportsDate, false);
});


test("取得本文で出来事と発生日を確認できる一次資料を採用する", async (t) => {
	const url = "https://national-archive.example.test/treaty";
	const result = await verify(t, { sourceUrls: [url], evidence: [evidence(url, { primarySource: true })] });
	assert.equal(result.result.verified, true);
	assert.deepEqual(result.result.sourceUrls, [url]);
	assert.match(result.result.verificationReason, /取得した資料/);
});

test("独立性の異なる信頼できる2資料を採用する", async (t) => {
	const urls = ["https://museum.example.test/treaty", "https://university.example.test/treaty"];
	const result = await verify(t, {
		sourceUrls: urls,
		evidence: [evidence(urls[0]!, { independenceGroup: "museum" }), evidence(urls[1]!, { independenceGroup: "university" })],
	});
	assert.equal(result.result.verified, true);
});

test("取得URLと検証済みURLを分けて返す", async (t) => {
	const urls = ["https://history.example.test/unverified", "https://archive.example.test/verified"];
	const result = await verify(t, {
		sourceUrls: urls,
		evidence: [
			evidence(urls[0]!, { supportsEvent: false }),
			evidence(urls[1]!, { primarySource: true, independenceGroup: "archive" }),
		],
	});

	assert.equal(result.result.verified, true);
	assert.deepEqual(result.result.sourceUrls, urls);
	assert.deepEqual(result.result.verifiedSourceUrls, [urls[1]]);
});

test("二次資料1件で主要事実と日付を確認できれば採用する", async (t) => {
	const url = "https://history.example.test/treaty";
	const result = await verify(t, { sourceUrls: [url], evidence: [evidence(url)] });
    assert.equal(result.result.verified, true);
    assert.equal(result.result.status, "verified");
});

test("資料間に矛盾が報告された場合は不採用にする", async (t) => {
	const urls = ["https://archive.example.test/treaty", "https://university.example.test/treaty"];
	const result = await verify(t, {
		sourceUrls: urls,
		evidence: [evidence(urls[0]!), evidence(urls[1]!, { contradicts: true })],
	});
	assert.equal(result.result.verified, false);
	assert.match(result.result.verificationReason, /矛盾/);
});

test("Wikipediaのみでも主要事実と日付を確認できれば採用する", async (t) => {
	const wikiUrl = "https://en.wikipedia.org/wiki/Example_Treaty";
	const result = await verify(t, { candidate: candidate(wikiUrl), sourceUrls: [wikiUrl] });
    assert.equal(result.result.verified, true);
    assert.equal(result.result.status, "verified");
    assert.equal(result.sourceRequests, 1);
});

test("検索APIエラー時はerrorにし、再試行しない", async (t) => {
	const result = await verify(t, { searchStatus: 500 });
	assert.equal(result.result.verified, false);
	assert.equal(result.result.status, "error");
	assert.equal(result.apiRequests, 1);
	assert.deepEqual(result.apiCallKinds, ["source-search"]);
});

test("検索API障害は一括候補すべてをerrorにし、安全な診断情報を保持する", async (t) => {
	const candidates = Array.from({ length: 4 }, (_, index) => ({
		...candidate(),
		event: `Example event ${index + 1}`,
	}));
	const result = await verify(t, {
		candidates,
		searchApiError: {
			status: 401,
			code: "invalid_api_key",
			message: "Invalid API key: test-key; Authorization: Bearer test-secret",
		},
	});

	assert.deepEqual(result.results.map((item) => item.status), ["error", "error", "error", "error"]);
	assert.equal(result.result.error?.stage, "source-search");
	assert.equal(result.result.error?.httpStatus, 401);
	assert.equal(result.result.error?.apiCode, "invalid_api_key");
	assert.match(result.result.error?.message ?? "", /\[REDACTED\]/);
	assert.doesNotMatch(JSON.stringify(result.results), /test-key|test-secret/);
	assert.equal(result.apiRequests, 1);
	assert.deepEqual(result.apiCallKinds, ["source-search"]);
});

test("source-searchのタイムアウトはerrorで返り、再試行しない", async (t) => {
	const result = await verify(t, { searchTimeout: true });
	assert.equal(result.result.status, "error");
	assert.equal(result.result.error?.stage, "source-search");
	assert.match(result.result.error?.message ?? "", /timeout/i);
	assert.equal(result.apiRequests, 1);
	assert.deepEqual(result.apiCallKinds, ["source-search"]);
});

test("出典照合APIエラー時も未検証のまま不採用にする", async (t) => {
	const result = await verify(t, { reviewStatus: 500 });
	assert.equal(result.result.verified, false);
	assert.equal(result.result.status, "error");
	assert.equal(result.result.error?.stage, "evidence-review");
	assert.equal(result.apiRequests, 2);
	assert.deepEqual(result.apiCallKinds, ["source-search", "evidence-review"]);
});

test("不正な出典URLは取得せず不採用にする", async (t) => {
	const result = await verify(t, {
		candidate: candidate("javascript:alert(1)"),
		sourceUrls: ["javascript:alert(1)"],
	});
	assert.equal(result.result.verified, false);
	assert.equal(result.sourceRequests, 0);
	assert.deepEqual(result.result.sourceUrls, []);
});

test("1回の一括検索と1回の一括評価だけを行う", async (t) => {
	const result = await verify(t, {
		sourceUrls: ["https://archive.example.test/treaty", "https://university.example.test/treaty"],
		evidence: [
			evidence("https://archive.example.test/treaty", { independenceGroup: "archive" }),
			evidence("https://university.example.test/treaty", { independenceGroup: "university" }),
		],
	});
	assert.equal(result.apiRequests, 2);
	assert.deepEqual(result.apiCallKinds, ["source-search", "evidence-review"]);
});

test("イタリア語の日付を正しく判定する", async (t) => {
    const url = "https://history.example.test/italian";

    const result = await verify(t, {
        sourceUrls: [url],
        pageTexts: {
            [url]: "Il trattato fu firmato il 31 ottobre 1926."
        },
        evidence: [
            evidence(url, {
                claimQuote: "Il trattato fu firmato",
                dateQuote: "31 ottobre 1926",
                extractedDate: "1926-10-31",
                supportsEvent: true,
                supportsDate: true,
                reliable: true,
            })
        ],
    });

    assert.equal(result.result.verified, true);
    assert.equal(result.result.status, "verified");
    assert.equal(result.result.sourceEvidence[0]?.dateMatchesCandidate, true);
});

test("8候補へ最大32 URLを公平に配分し、各候補の元URLを優先する", async (t) => {
	const candidates = Array.from({ length: 8 }, (_, index) => candidate(`https://original${index}.example.test/event`));
	const discoveredCandidates = candidates.map((_, candidateIndex) => ({
		candidateIndex,
		sourceUrls: Array.from({ length: 6 }, (_value, sourceIndex) => `https://source${sourceIndex}-${candidateIndex}.example.test/page`),
	}));
	const result = await verify(t, { candidates, discoveredCandidates });

	assert.equal(result.sourceRequests, 32);
	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const originalUrl = candidates[candidateIndex]!.sourceUrl;
		assert.ok(result.requestedSourceUrls.includes(originalUrl));
		assert.equal(result.requestedSourceUrls.filter((url) => url.endsWith(`-${candidateIndex}.example.test/page`) || url === originalUrl).length, 4);
		assert.ok(result.requestedSourceUrls.indexOf(originalUrl) < result.requestedSourceUrls.indexOf(`https://source0-${candidateIndex}.example.test/page`));
	}
});

test("複数候補で共有するURLは実際の取得を1回にする", async (t) => {
	const candidates = Array.from({ length: 2 }, (_, index) => candidate(`https://shared.example.test/original`));
	const discoveredCandidates = candidates.map((_, candidateIndex) => ({
		candidateIndex,
		sourceUrls: Array.from({ length: 3 }, (_value, sourceIndex) => `https://source${sourceIndex}-${candidateIndex}.example.test/page`),
	}));
	const result = await verify(t, { candidates, discoveredCandidates });
	assert.equal(result.sourceRequests, 7);
	assert.equal(new Set(result.requestedSourceUrls).size, 7);
});

test("1資料4,000文字・1候補12,000文字の本文上限を守る", async (t) => {
	const item = candidate("https://original.example.test/0");
	const sourceUrls = Array.from({ length: 4 }, (_, index) => `https://source${index}.example.test/page`);
	const result = await verify(t, {
		candidate: item,
		sourceUrls,
		pageTexts: Object.fromEntries([item.sourceUrl, ...sourceUrls].map((url) => [url, "😀".repeat(5000)])),
	});
	const payloadStart = result.reviewInput.indexOf("[{\"candidateIndex\"");
	assert.notEqual(payloadStart, -1);
	const review = JSON.parse(result.reviewInput.slice(payloadStart)) as Array<{ sources: Array<{ text: string }> }>;
	assert.equal(review[0]?.sources.length, 3);
	assert.deepEqual(review[0]?.sources.map((source) => Array.from(source.text).length), [4000, 4000, 4000]);
	assert.equal(review[0]?.sources.reduce((total, source) => total + Array.from(source.text).length, 0), 12000);
	assert.equal(result.result.sourceUrlsRetrieved, 4);
});

test("取得本文に存在しない主要事実の引用では採用しない", async (t) => {
	const url = "https://history.example.test/unmatched-claim";
	const result = await verify(t, {
		sourceUrls: [url],
		pageTexts: { [url]: "The Example Treaty was signed on October 31, 1926." },
		evidence: [evidence(url, { claimQuote: "A different treaty ended the war", dateQuote: "October 31, 1926" })],
	});
	assert.equal(result.result.status, "rejected");
	assert.equal(result.result.verified, false);
	assert.equal(result.result.sourceEvidence[0]?.claimQuoteMatched, false);
	assert.equal(result.result.sourceRetrievalStatus, "insufficient-content");
});

test("出典URL未発見とページ取得失敗を区別する", async (t) => {
	const missingUrl = await verify(t, {
		candidate: candidate("ftp://invalid.example.test/page"),
		sourceUrls: [],
	});
	assert.equal(missingUrl.result.sourceRetrievalStatus, "no-urls");
	assert.equal(missingUrl.result.sourceUrlsRetrieved, 0);
	assert.equal(missingUrl.result.status, "rejected");

	const failedFetch = await verify(t, {
		sourceUrls: ["https://unavailable.example.test/page"],
		pageTexts: {},
	});
	assert.equal(failedFetch.result.sourceRetrievalStatus, "fetch-failed");
	assert.equal(failedFetch.result.sourceUrlsRetrieved, 0);
	assert.equal(failedFetch.result.status, "rejected");
});