import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import test = require("node:test");
import historicalEventResearch = require("./historical-event-research");
import historicalEventVerification = require("./historical-event-verification");
import historicalPosts = require("./historical-posts");

const postingDate = "2026-10-25";
const targetDate = "1926-10-25";

function candidate(index: number, overrides: Partial<{ event: string; eventKey: string }> = {}) {
	return {
		event: overrides.event ?? `歴史的出来事${index}が起きた`,
		eventKey: overrides.eventKey ?? `event-${index}`,
		date: targetDate,
		sourceUrl: `https://history${index}.example.test/event`,
		verified: false as const,
	};
}

function verified(candidates: ReturnType<typeof candidate>[]) {
	return candidates.map((item) => ({
		event: item.event,
		date: item.date,
		status: "verified" as const,
		verified: true,
		sourceUrls: [item.sourceUrl],
		verifiedSourceUrls: [item.sourceUrl],
	}));
}

function withStore(run: (filePath: string) => Promise<void>): Promise<void> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pikan-historical-posts-"));
	return run(path.join(directory, "historical-posts.json")).finally(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});
}

type IntegrationCandidate = {
	event: string;
	eventKey: string;
	date: string;
	sourceUrl: string;
};

function mockResearchAndVerification(
	candidates: IntegrationCandidate[],
	verifiedEventKeys: Set<string>,
) {
	const calls = { research: 0, sourceSearch: 0, evidenceReview: 0, sourceFetch: 0 };
	const fetchMock: typeof fetch = async (input, init) => {
		if (String(input) !== "https://api.openai.com/v1/responses") {
			calls.sourceFetch++;
			const requestedUrl = new URL(String(input)).toString();
			const candidate = candidates.find((item) => new URL(item.sourceUrl).toString() === requestedUrl);
			if (!candidate) return new Response("Not found", { status: 404 });
			return new Response(`<html><body>${candidate.event}. October 25, 1926.</body></html>`, {
				headers: { "content-type": "text/html" },
			});
		}

		const request = JSON.parse(String(init?.body)) as {
			text?: { format?: { name?: string } };
			input?: string;
		};
		const schemaName = request.text?.format?.name;
		let output: unknown;
		if (schemaName === "historical_event_candidates") {
			calls.research++;
			output = { events: candidates };
		} else if (schemaName === "historical_event_sources") {
			calls.sourceSearch++;
			const candidateMarker = "候補: ";
			const candidateStart = (request.input ?? "").indexOf(candidateMarker) + candidateMarker.length;
			const verificationCandidates = JSON.parse((request.input ?? "").slice(candidateStart)) as IntegrationCandidate[];
			output = { events: verificationCandidates.map((candidate, index) => ({
				candidateIndex: index,
				sources: [{ url: candidate.sourceUrl }],
			})) };
		} else if (schemaName === "historical_event_evidence_review") {
			calls.evidenceReview++;
			const input = request.input ?? "";
			const evidenceCandidates = JSON.parse(input.slice(input.lastIndexOf("\n") + 1)) as Array<{
				candidateIndex: number;
				event: string;
				date: string;
				sources: Array<{ url: string }>;
			}>;
			output = { events: evidenceCandidates.map((candidate) => {
				const fixture = candidates.find((item) => item.event === candidate.event);
				return {
				candidateIndex: candidate.candidateIndex,
				sources: candidate.sources.map((source) => ({
					url: source.url,
					claimQuote: candidate.event,
					dateQuote: "October 25, 1926",
					extractedDate: candidate.date,
					supportsEvent: fixture !== undefined && verifiedEventKeys.has(fixture.eventKey),
					supportsDate: true,
					reliable: true,
					primarySource: true,
					independenceGroup: fixture?.eventKey ?? "unknown",
					contradicts: false,
				})),
				};
			}) };
		} else {
			throw new Error(`Unexpected mocked OpenAI request schema: ${schemaName}`);
		}

		return new Response(JSON.stringify({
			output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
		}), { status: 200 });
	};

	return {
		calls,
		pipeline: {
			research: async (date: string, excludedEventKeys: string[]) => {
				const [year, month, day] = date.split("-").map(Number);
				return historicalEventResearch.getHistoricalEventCandidates(
					year!, month!, day!, fetchMock, 8, excludedEventKeys,
				);
			},
			verify: (items: Awaited<ReturnType<typeof historicalEventResearch.getHistoricalEventCandidates>>) =>
				historicalEventVerification.verifyHistoricalEventCandidates(items, { fetchImplementation: fetchMock }),
		},
	};
}

function setMockOpenAiEnvironment(t: test.TestContext): void {
	const originalKey = process.env.OPENAI_API_KEY;
	const originalModel = process.env.OPENAI_MODEL;
	process.env.OPENAI_API_KEY = "integration-test-key";
	process.env.OPENAI_MODEL = "integration-test-model";
	t.after(() => {
		if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = originalKey;
		if (originalModel === undefined) delete process.env.OPENAI_MODEL;
		else process.env.OPENAI_MODEL = originalModel;
	});
}

test("候補検索から保存・予約・一度限りの送信までをモックで結合確認する", async (t) => {
	setMockOpenAiEnvironment(t);
	await withStore(async (filePath) => {
		const candidates: IntegrationCandidate[] = [
			{ event: "Example event Alpha occurred", eventKey: "alpha-event", date: targetDate, sourceUrl: "https://alpha.example.test/source" },
			{ event: "A different description of Alpha", eventKey: "alpha-event", date: targetDate, sourceUrl: "https://alpha-alt.example.test/source" },
			{ event: "Example event Beta occurred", eventKey: "beta-event", date: targetDate, sourceUrl: "https://beta.example.test/source" },
			{ event: "Example event Gamma occurred", eventKey: "gamma-event", date: targetDate, sourceUrl: "https://gamma.example.test/source" },
			{ event: "Unverified event Delta", eventKey: "delta-event", date: targetDate, sourceUrl: "https://delta.example.test/source" },
		];
		const integration = mockResearchAndVerification(candidates, new Set(["alpha-event", "beta-event", "gamma-event"]));
		const now = new Date("2026-10-24T22:30:00Z");
		const prepared = await historicalPosts.prepareHistoricalDay(
			filePath, postingDate, targetDate, integration.pipeline, [], now,
		);

		assert.equal(prepared.status, "ready");
		assert.deepEqual(prepared.posts.map((post) => post.eventKey), ["alpha-event", "beta-event", "gamma-event"]);
		assert.equal(new Set(prepared.posts.map((post) => post.eventKey)).size, 3);
		assert.deepEqual(prepared.posts.map((post) => post.slot), [
			"2026-10-25-0730", "2026-10-25-1205", "2026-10-25-1815",
		]);
		assert.deepEqual(prepared.posts.map((post) => post.scheduledAt), [
			"2026-10-24T22:30:00.000Z", "2026-10-25T03:05:00.000Z", "2026-10-25T09:15:00.000Z",
		]);
		assert.ok(prepared.posts.every((post) => post.sourceUrls.length === 1 && post.postText.includes(post.sourceUrls[0]!)));
		assert.ok(prepared.posts.every((post) => !post.eventKey.startsWith("delta")));
		assert.equal(integration.calls.sourceFetch, 4);

		const persisted = historicalPosts.loadHistoricalStore(filePath).days[0]!;
		assert.deepEqual(persisted.posts.map(({ event, postText, sourceUrls, scheduledAt }) => ({ event, postText, sourceUrls, scheduledAt })),
			prepared.posts.map(({ event, postText, sourceUrls, scheduledAt }) => ({ event, postText, sourceUrls, scheduledAt })));

		const reused = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, integration.pipeline, [], now);
		assert.deepEqual(reused, prepared);
		assert.deepEqual(integration.calls, { research: 1, sourceSearch: 1, evidenceReview: 1, sourceFetch: 4 });

		const slot = "2026-10-25-0730";
		assert.equal(historicalPosts.reserveHistoricalPost(filePath, slot, "run-1-attempt-1"), true);
		assert.equal(historicalPosts.loadHistoricalStore(filePath).days[0]?.posts[0]?.status, "sending");
		let postCalls = 0;
		const firstSend = await historicalPosts.publishReservedHistoricalPost(filePath, slot, "run-1-attempt-1", async () => {
			postCalls++;
			return { id: "mock-post-id" };
		}, new Date("2026-10-25T00:00:00Z"));
		const secondReservation = historicalPosts.reserveHistoricalPost(filePath, slot, "run-2-attempt-1");
		const secondSend = await historicalPosts.publishReservedHistoricalPost(filePath, slot, "run-1-attempt-1", async () => {
			postCalls++;
			return { id: "duplicate-mock-post-id" };
		});
		assert.deepEqual(firstSend, { posted: true, status: "posted" });
		assert.equal(secondReservation, false);
		assert.deepEqual(secondSend, { posted: false, status: "posted" });
		assert.equal(postCalls, 1);
		assert.equal(historicalPosts.loadHistoricalStore(filePath).days[0]?.posts[0]?.xPostId, "mock-post-id");
	});
});

test("検証済み候補が3件未満なら未検証候補で補わず不足を保存する", async (t) => {
	setMockOpenAiEnvironment(t);
	await withStore(async (filePath) => {
		const candidates: IntegrationCandidate[] = [
			{ event: "Example event Alpha occurred", eventKey: "alpha-event", date: targetDate, sourceUrl: "https://alpha.example.test/source" },
			{ event: "Example event Beta occurred", eventKey: "beta-event", date: targetDate, sourceUrl: "https://beta.example.test/source" },
			{ event: "Unverified event Delta", eventKey: "delta-event", date: targetDate, sourceUrl: "https://delta.example.test/source" },
		];
		const integration = mockResearchAndVerification(candidates, new Set(["alpha-event", "beta-event"]));
		const prepared = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, integration.pipeline);

		assert.equal(prepared.status, "insufficient");
		assert.equal(prepared.posts.length, 2);
		assert.ok(prepared.posts.every((post) => post.eventKey !== "delta-event"));
		assert.deepEqual(historicalPosts.loadHistoricalStore(filePath).days, [prepared]);
		assert.equal(integration.calls.research, 3);
		assert.equal(integration.calls.sourceSearch, 1);
		assert.equal(integration.calls.evidenceReview, 1);
	});
});

test("日本時間の日付から100年前の日付を求める", () => {
	assert.equal(historicalPosts.japanDate(new Date("2026-10-24T22:30:00Z")), postingDate);
	assert.equal(historicalPosts.getTargetHistoricalDate(new Date("2026-10-24T22:30:00Z")), targetDate);
	assert.equal(historicalPosts.getTargetHistoricalDateForPostingDate("2026-10-25"), targetDate);
	assert.throws(() => historicalPosts.getTargetHistoricalDate(new Date("2000-02-28T15:00:00Z")), /同じ暦日が存在しない/);
	assert.throws(() => historicalPosts.getTargetHistoricalDateForPostingDate("2026-02-29"), /実在する日付/);
});

test("投稿枠の予約状態を保存できない場合は投稿しない", async () => {
	await withStore(async (filePath) => {
		const pipeline = {
			research: async () => [candidate(1), candidate(2), candidate(3)],
			verify: async (items: ReturnType<typeof candidate>[]) => verified(items),
		};
		await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, pipeline);
		fs.mkdirSync(`${filePath}.${process.pid}.tmp`);

		assert.throws(
			() => historicalPosts.reserveHistoricalPost(filePath, `${postingDate}-0730`, "run-1-attempt-1"),
		);
		let postCalls = 0;
		const result = await historicalPosts.publishReservedHistoricalPost(
			filePath,
			`${postingDate}-0730`,
			"run-1-attempt-1",
			async () => { postCalls++; return { id: "must-not-post" }; },
		);

		assert.deepEqual(result, { posted: false, status: "pending" });
		assert.equal(postCalls, 0);
	});
});

test("重複候補を除いて3投稿を保存し、再実行では調査しない", async () => {
	await withStore(async (filePath) => {
		let researchCalls = 0;
		let verifyCalls = 0;
		const pipeline = {
			research: async (_date: string, excluded: string[]) => {
				researchCalls++;
				assert.deepEqual(excluded, []);
				return [candidate(1), candidate(1, { event: "出来事1の別表現", eventKey: "event-1" }), candidate(2), candidate(3)];
			},
			verify: async (items: ReturnType<typeof candidate>[]) => {
				verifyCalls++;
				return verified(items);
			},
		};
		const now = new Date("2026-10-24T22:30:00Z");
		const prepared = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, pipeline, [], now);

		assert.equal(prepared.status, "ready");
		assert.deepEqual(prepared.posts.map((post) => post.eventKey), ["event-1", "event-2", "event-3"]);
		assert.deepEqual(prepared.posts.map((post) => post.slot), [
			"2026-10-25-0730", "2026-10-25-1205", "2026-10-25-1815",
		]);
		assert.deepEqual(prepared.posts.map((post) => post.scheduledAt), [
			"2026-10-24T22:30:00.000Z", "2026-10-25T03:05:00.000Z", "2026-10-25T09:15:00.000Z",
		]);
		assert.ok(prepared.posts.every((post) => post.status === "pending" && post.sourceUrls.length === 1));
		assert.deepEqual(historicalPosts.loadHistoricalStore(filePath).days, [prepared]);

		const again = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, pipeline, [], now);
		assert.deepEqual(again, prepared);
		assert.equal(researchCalls, 1);
		assert.equal(verifyCalls, 1);
	});
});

test("最大3ラウンドで3件を確保できない場合は未検証で埋めず不足を保存する", async () => {
	await withStore(async (filePath) => {
		let researchCalls = 0;
		const prepared = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, {
			research: async () => {
				researchCalls++;
				return [candidate(researchCalls)];
			},
			verify: async (items) => items.map((item) => ({
				event: item.event, date: item.date, status: "rejected" as const, verified: false, sourceUrls: [], verifiedSourceUrls: [],
			})),
		});
		assert.equal(researchCalls, 3);
		assert.equal(prepared.status, "insufficient");
		assert.equal(prepared.posts.length, 0);
	});
});

test("投稿URLは検証済みURLから選び、検証済み出典がない候補は除外する", async () => {
	await withStore(async (filePath) => {
		const first = candidate(1);
		const second = candidate(2);
		const prepared = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, {
			research: async () => [first, second],
			verify: async (items) => items.map((item, index) => ({
				event: item.event,
				date: item.date,
				status: "verified" as const,
				verified: true,
				sourceUrls: index === 0
					? ["https://unverified.example.test/source", "https://verified.example.test/source"]
					: ["https://unverified-only.example.test/source"],
				verifiedSourceUrls: index === 0
					? ["https://verified.example.test/source"]
					: [],
			})),
		});

		assert.equal(prepared.posts.length, 1);
		assert.deepEqual(prepared.posts[0]?.sourceUrls, ["https://verified.example.test/source"]);
		assert.match(prepared.posts[0]?.postText ?? "", /https:\/\/verified\.example\.test\/source/);
		assert.doesNotMatch(prepared.posts[0]?.postText ?? "", /unverified/);
	});
});

test("過去の履歴にあるイベントは再採用しない", async () => {
	await withStore(async (filePath) => {
		const previous = candidate(1);
		const prepared = await historicalPosts.prepareHistoricalDay(filePath, "2026-10-26", targetDate, {
			research: async (_date, excluded) => {
				assert.deepEqual(excluded, []);
				return [previous];
			},
			verify: async () => { throw new Error("重複候補は検証しない"); },
		}, [`【${targetDate}】${previous.event}\n出典: ${previous.sourceUrl}`]);
		assert.equal(prepared.status, "insufficient");
		assert.equal(prepared.posts.length, 0);
	});
});

test("送信成功後は同じ投稿枠を二重送信しない", async () => {
	await withStore(async (filePath) => {
		const pipeline = {
			research: async () => [candidate(1), candidate(2), candidate(3)],
			verify: async (items: ReturnType<typeof candidate>[]) => verified(items),
		};
		await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, pipeline);
		let calls = 0;
		const first = await historicalPosts.publishHistoricalPost(filePath, "2026-10-25-0730", async () => {
			calls++;
			return { id: "x-post-1" };
		});
		const second = await historicalPosts.publishHistoricalPost(filePath, "2026-10-25-0730", async () => {
			calls++;
			return { id: "x-post-duplicate" };
		});
		assert.deepEqual(first, { posted: true, status: "posted" });
		assert.deepEqual(second, { posted: false, status: "posted" });
		assert.equal(calls, 1);
	});
});

test("永続化済みの予約は同じ試行IDからだけ一度送信できる", async () => {
	await withStore(async (filePath) => {
		await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, {
			research: async () => [candidate(1), candidate(2), candidate(3)],
			verify: async (items) => verified(items),
		});
		assert.equal(historicalPosts.reserveHistoricalPost(filePath, "2026-10-25-0730", "run-1"), true);
		assert.equal(historicalPosts.reserveHistoricalPost(filePath, "2026-10-25-0730", "run-2"), false);
		let calls = 0;
		const wrongAttempt = await historicalPosts.publishReservedHistoricalPost(filePath, "2026-10-25-0730", "run-2", async () => {
			calls++;
			return { id: "wrong-attempt" };
		});
		assert.deepEqual(wrongAttempt, { posted: false, status: "sending" });
		const sent = await historicalPosts.publishReservedHistoricalPost(filePath, "2026-10-25-0730", "run-1", async () => {
			calls++;
			return { id: "x-post-1" };
		});
		assert.deepEqual(sent, { posted: true, status: "posted" });
		assert.equal(calls, 1);
	});
});

test("送信タイムアウト後は状態をunknownにして再送しない", async () => {
	await withStore(async (filePath) => {
		await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, {
			research: async () => [candidate(1), candidate(2), candidate(3)],
			verify: async (items) => verified(items),
		});
		let calls = 0;
		await assert.rejects(historicalPosts.publishHistoricalPost(filePath, "2026-10-25-0730", async () => {
			calls++;
			throw new Error("timeout");
		}), /timeout/);
		const retry = await historicalPosts.publishHistoricalPost(filePath, "2026-10-25-0730", async () => {
			calls++;
			return { id: "should-not-send" };
		});
		assert.deepEqual(retry, { posted: false, status: "unknown" });
		assert.equal(calls, 1);
	});
});

test("調査API障害はerrorとして保存し、再実行でAPIを呼ばない", async () => {
	await withStore(async (filePath) => {
		let calls = 0;
		const pipeline = {
			research: async () => {
				calls++;
				throw new Error("OpenAI timeout");
			},
			verify: async () => [],
		};
		const first = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, pipeline);
		const second = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, pipeline);
		assert.equal(first.status, "error");
		assert.equal(first.failureReason, "OpenAI timeout");
		assert.deepEqual(second, first);
		assert.equal(calls, 1);
	});
});