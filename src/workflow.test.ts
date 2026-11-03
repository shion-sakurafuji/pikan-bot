import assert = require("node:assert/strict");
import test = require("node:test");
import workflow = require("./workflow");

async function withPostSetting(setting: string | undefined, run: () => Promise<void>): Promise<void> {
	const originalValue = process.env.X_POST_ENABLED;
	if (setting === undefined) {
		delete process.env.X_POST_ENABLED;
	} else {
		process.env.X_POST_ENABLED = setting;
	}

	try {
		await run();
	} finally {
		if (originalValue === undefined) {
			delete process.env.X_POST_ENABLED;
		} else {
			process.env.X_POST_ENABLED = originalValue;
		}
	}
}

test("デフォルトでは生成文を返すだけで投稿しない", async () => {
	await withPostSetting(undefined, async () => {
		let postCalled = false;
		const result = await workflow.runOgiriWorkflow(
			async () => " お題: テスト\n回答: テスト ",
			async () => {
				postCalled = true;
			},
		);

		assert.equal(result.postText, "【お題】\nテスト\n\n【回答】\nテスト");
		assert.equal(result.posted, false);
		assert.equal(postCalled, false);
	});
});

test("X_POST_ENABLED=true の場合だけ投稿関数を呼ぶ", async () => {
	await withPostSetting("true", async () => {
		let postedText = "";
		const result = await workflow.runOgiriWorkflow(
			async () => "お題: テスト\n回答: テスト",
			async (text) => {
				postedText = text;
			},
		);

		assert.equal(result.posted, true);
		assert.equal(postedText, "【お題】\nテスト\n\n【回答】\nテスト");
	});
});

test("280文字を超える文章は投稿関数を呼ばずエラーにする", async () => {
	await withPostSetting("true", async () => {
		let postCalled = false;
		await assert.rejects(
			workflow.runOgiriWorkflow(
				async () => `お題: あ\n回答: ${"い".repeat(268)}`,
				async () => {
					postCalled = true;
				},
			),
			/280文字以内/,
		);
		assert.equal(postCalled, false);
	});
});

test("280文字ちょうどなら投稿できる", async () => {
	await withPostSetting("true", async () => {
		const result = await workflow.runOgiriWorkflow(
			async () => `お題: あ\n回答: ${"い".repeat(267)}`,
			async () => undefined,
		);

		assert.equal(result.posted, true);
		assert.equal(Array.from(result.postText).length, 280);
	});
});
