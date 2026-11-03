type ResponsesApiResponse = {
	output?: Array<{
		type?: string;
		content?: Array<{
			type?: string;
			text?: string;
		}>;
	}>;
	error?: {
		message?: string;
	};
};

async function requestOpenAi(input: string, modelOverride?: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = modelOverride ?? process.env.OPENAI_MODEL;

    if (!apiKey || !model) {
        throw new Error("OPENAI_API_KEY と OPENAI_MODEL を環境変数に設定してください。");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            input,
        }),
    });

    const result = (await response.json()) as ResponsesApiResponse;

    if (!response.ok) {
        throw new Error(result.error?.message ?? `OpenAI APIエラー (${response.status})`);
    }

    return (
        result.output
            ?.filter((item) => item.type === "message")
            .flatMap((item) => item.content ?? [])
            .filter((item) => item.type === "output_text")
            .map((item) => item.text ?? "")
            .join("") ?? ""
    ).trim();
}

async function generateOgiri(): Promise<string> {
    // 1回目：お題だけを生成
    const questionRaw = await requestOpenAi(
        "日本語の大喜利のお題を1つ作ってください。回答は出力せず、端的にお題の本文だけを1行で出力してください。"
    );

    const question = questionRaw.replace(/^お題\s*[:：]\s*/, "").trim();

    if (!question || question.includes("\n")) {
        throw new Error("お題の生成結果が不正です。");
    }

    // 2回目：確定したお題への回答だけを生成
const answerPrompt = `あなたは日本語の大喜利の回答者です。

【お題】
${question}

このお題に対して、面白い回答を1つ考えてください。

1. 意外性はあっても、お題への回答として成立し、一読で意味が理解できる内容にしてください。
2. 説明的になりすぎず、短い一文で回答してください。

【出力】
回答本文のみ、1行で出力してください。`;

    // Lunaで回答を生成
    const answerRaw = await requestOpenAi(answerPrompt);
    const answer = answerRaw.replace(/^回答\s*[:：]\s*/, "").trim();

    if (!answer || answer.includes("\n")) {
        throw new Error("回答の生成結果が不正です。");
    }

    // 比較モードの場合だけ、同じお題・同じ指示を別モデルにも送る
    const compareModel = process.env.OGIRI_COMPARE_MODEL;

    if (compareModel) {
        const comparedRaw = await requestOpenAi(answerPrompt, compareModel);
        const comparedAnswer = comparedRaw.replace(/^回答\s*[:：]\s*/, "").trim();

        console.log(`\n【${process.env.OPENAI_MODEL} の回答】\n${answer}`);
        console.log(`\n【${compareModel} の回答】\n${comparedAnswer}\n`);
    }

    // 既存の投稿処理が要求する形式に結合
    return `お題: ${question}\n回答: ${answer}`;
}

function formatPostText(generatedText: string): string {
	const postText = generatedText.trim().replace(/\r\n?/g, "\n");
	if (!postText) {
		throw new Error("生成結果が空です。投稿用テキストを作成できません。");
	}

	const match = postText.match(/^[ \t]*お題[ \t]*[:：][ \t]*(.*)\n[ \t]*回答[ \t]*[:：][ \t]*(.*)$/);
	if (!match) {
		throw new Error("生成結果は「お題: ...」と「回答: ...」の2行である必要があります。");
	}

	const question = match[1]?.trim();
	const answer = match[2]?.trim();
	if (!question || !answer) {
		throw new Error("お題と回答を空にすることはできません。");
	}

	return `【お題】\n${question}\n\n【回答】\n${answer}`;
}

function normalizePostText(postText: string): string {
	return postText.trim().replace(/\s+/g, " ");
}

function hasDuplicatePost(previousPosts: string[], newPost: string): boolean {
	const normalizedNewPost = normalizePostText(newPost);
	return previousPosts.some((post) => normalizePostText(post) === normalizedNewPost);
}

export = { formatPostText, generateOgiri, hasDuplicatePost };
