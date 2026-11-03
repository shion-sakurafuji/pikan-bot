import assert = require("node:assert/strict");
import test = require("node:test");
import xPost = require("./x-post");
import historicalPublisher = require("./publish-historical-post");

const credentialNames = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] as const;

function withTestCredentials(run: () => Promise<void>): Promise<void> {
	const originalValues = credentialNames.map((name) => process.env[name]);
	credentialNames.forEach((name, index) => {
		process.env[name] = `test-credential-${index}`;
	});

	return run().finally(() => {
		credentialNames.forEach((name, index) => {
			const originalValue = originalValues[index];
			if (originalValue === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = originalValue;
			}
		});
	});
}

test("OAuth認証でPOST /2/tweetsを呼び出し、投稿結果を返す", async () => {
	await withTestCredentials(async () => {
		let requestedUrl = "";
		let requestOptions: RequestInit | undefined;
		const fetchMock: typeof fetch = async (input, init) => {
			requestedUrl = String(input);
			requestOptions = init;
			return new Response(JSON.stringify({ data: { id: "123", text: "投稿文" } }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		};

		const result = await xPost.postTweet("投稿文", fetchMock);

		assert.equal(requestedUrl, "https://api.x.com/2/tweets");
		assert.equal(requestOptions?.method, "POST");
		assert.equal(requestOptions?.body, JSON.stringify({ text: "投稿文" }));
		assert.match(new Headers(requestOptions?.headers).get("Authorization") ?? "", /^OAuth /);
		assert.deepEqual(result, { id: "123", text: "投稿文" });
	});
});

test("空の投稿文は通信前にエラーにする", async () => {
	await withTestCredentials(async () => {
		let wasCalled = false;
		const fetchMock: typeof fetch = async () => {
			wasCalled = true;
			return new Response();
		};

		await assert.rejects(xPost.postTweet(" \n ", fetchMock), /投稿文が空です/);
		assert.equal(wasCalled, false);
	});
});

test("API認証情報が不足している場合は通信せずエラーにする", async () => {
	const originalValues = credentialNames.map((name) => process.env[name]);
	credentialNames.forEach((name) => delete process.env[name]);
	let wasCalled = false;
	const fetchMock: typeof fetch = async () => {
		wasCalled = true;
		return new Response();
	};

	try {
		await assert.rejects(xPost.postTweet("投稿文", fetchMock), /X_API_KEY/);
		assert.equal(wasCalled, false);
	} finally {
		credentialNames.forEach((name, index) => {
			const originalValue = originalValues[index];
			if (originalValue !== undefined) {
				process.env[name] = originalValue;
			}
		});
	}
});

test("post_to_x=falseでは投稿処理を呼び出さない", async () => {
	const baseEnv = {
		GITHUB_EVENT_NAME: "workflow_dispatch",
		PIKAN_AUTOPUBLISH_ENABLED: "true",
		X_POST_ENABLED: "true",
	};
	for (const env of [
		{ ...baseEnv, POST_TO_X: "false" },
		{ ...baseEnv, PIKAN_AUTOPUBLISH_ENABLED: "false", POST_TO_X: "true" },
		{ ...baseEnv, X_POST_ENABLED: "false", POST_TO_X: "true" },
		{ ...baseEnv, GITHUB_EVENT_NAME: "push", POST_TO_X: "true" },
	]) {
		let publishCalls = 0;
		const ran = await historicalPublisher.runIfPostingEnabled(env, async () => { publishCalls++; });

		assert.equal(ran, false);
		assert.equal(publishCalls, 0);
	}
});

test("投稿タイムアウトでHTTP要求を中断する", async () => {
	await withTestCredentials(async () => {
		const previousTimeout = process.env.X_POST_TIMEOUT_MS;
		process.env.X_POST_TIMEOUT_MS = "5";
		let observedSignal: AbortSignal | undefined;
		const fetchMock: typeof fetch = async (_input, init) => {
			const signal = init?.signal;
			assert.ok(signal);
			observedSignal = signal;
			return new Promise<Response>((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};
		try {
			await assert.rejects(xPost.postTweet("投稿文", fetchMock), /timeout/i);
			assert.ok(observedSignal?.aborted);
		} finally {
			if (previousTimeout === undefined) delete process.env.X_POST_TIMEOUT_MS;
			else process.env.X_POST_TIMEOUT_MS = previousTimeout;
		}
	});
});