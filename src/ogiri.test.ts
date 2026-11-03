import assert = require("node:assert/strict");
import test = require("node:test");
import ogiri = require("./ogiri");

test("投稿用テキストの前後の空白を除去する", () => {
	assert.equal(
		ogiri.formatPostText("  お題: テスト\n回答: テスト  \n"),
		"【お題】\nテスト\n\n【回答】\nテスト",
	);
});

test("全角コロンとWindows形式の改行にも対応する", () => {
	assert.equal(
		ogiri.formatPostText("お題： 未来の校則とは？\r\n 回答： 先生の頭上だけ飛行禁止。"),
		"【お題】\n未来の校則とは？\n\n【回答】\n先生の頭上だけ飛行禁止。",
	);
});

test("文章の途中には余計な改行や絵文字を挿入しない", () => {
	const question = "未来の教科書に載った、今では信じられない校則とは？";
	const answer = "校内でのドローン飛行は、先生の頭上を除いて禁止。";
	assert.equal(
		ogiri.formatPostText(`お題: ${question}\n回答: ${answer}`),
		`【お題】\n${question}\n\n【回答】\n${answer}`,
	);
});

test("空文字はエラーにする", () => {
	assert.throws(() => ogiri.formatPostText(""), /生成結果が空です/);
});

test("空白だけの出力はエラーにする", () => {
	assert.throws(() => ogiri.formatPostText(" \t\n "), /生成結果が空です/);
});

test("お題と回答の2行形式でない出力はエラーにする", () => {
	assert.throws(() => ogiri.formatPostText("任意の文章"), /2行である必要があります/);
	assert.throws(() => ogiri.formatPostText("お題: 途中で\n改行した\n回答: テスト"), /2行である必要があります/);
});

test("お題または回答が空ならエラーにする", () => {
	assert.throws(() => ogiri.formatPostText("お題: \n回答: テスト"), /空にすることはできません/);
	assert.throws(() => ogiri.formatPostText("お題: テスト\n回答: "), /空にすることはできません/);
});

test("過去の投稿と同じ文章は重複と判定する", () => {
	assert.equal(ogiri.hasDuplicatePost(["お題: テスト\n回答: テスト"], "お題: テスト\n回答: テスト"), true);
});

test("前後の空白や改行の違いを無視して重複と判定する", () => {
	assert.equal(
		ogiri.hasDuplicatePost(["  お題: テスト\n回答: テスト  "], "お題: テスト   回答: テスト\n"),
		true,
	);
});

test("異なる文章は重複と判定しない", () => {
	assert.equal(ogiri.hasDuplicatePost(["お題: 別のお題\n回答: 別の回答"], "お題: テスト\n回答: テスト"), false);
});

test("お題と回答を別々のAPI呼び出しで生成する", async (t) => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalModel = process.env.OPENAI_MODEL;

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "test-model";

    t.after(() => {
        if (originalKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = originalKey;
        }

        if (originalModel === undefined) {
            delete process.env.OPENAI_MODEL;
        } else {
            process.env.OPENAI_MODEL = originalModel;
        }
    });

    const prompts: string[] = [];

    const outputs = [
        "お題: テスト用のお題は？",
        "回答: テスト用の回答。",
    ];

    t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
        const body = JSON.parse(String(options?.body)) as {
            input: string;
        };

        prompts.push(body.input);

        const text = outputs[prompts.length - 1] ?? "";

        return new Response(
            JSON.stringify({
                output: [{
                    type: "message",
                    content: [{
                        type: "output_text",
                        text,
                    }],
                }],
            }),
            { status: 200 },
        );
    });

    const result = await ogiri.generateOgiri();

    assert.equal(
        result,
        "お題: テスト用のお題は？\n回答: テスト用の回答。",
    );

    assert.equal(prompts.length, 2);

    assert.match(prompts[1] ?? "", /テスト用のお題は？/);
});