import historicalEventVerification = require("./historical-event-verification");

const candidates = [
	{
		event: "ハリー・フーディーニの死去",
		date: "1926-10-31",
		sourceUrl: "https://www.britannica.com/biography/Harry-Houdini",
		verified: false as const,
	},
	{
		event: "ムッソリーニ銃撃未遂事件とアンテオ・ザンボーニの死亡",
		date: "1926-10-31",
		sourceUrl: "https://www.britannica.com/biography/Benito-Mussolini",
		verified: false as const,
	},
	{
		event: "スタディオ・リットリオーレの開場",
		date: "1926-10-31",
		sourceUrl: "https://www.bolognafc.it/",
		verified: false as const,
	},
	{
		event: "キリスト王の祭の初回執行",
		date: "1926-10-31",
		sourceUrl: "https://www.vatican.va/content/pius-xi/en/encyclicals/documents/hf_p-xi_enc_11121925_quas-primas.html",
		verified: false as const,
	},
];

const timeoutMilliseconds = 15_000;
let apiCallCount = 0;

const timedFetch: typeof fetch = (input, init) => fetch(input, {
	...init,
	signal: init?.signal ?? AbortSignal.timeout(timeoutMilliseconds),
});

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeSourceUrl(value: string): string {
	try {
		const url = new URL(value);
		for (const key of url.searchParams.keys()) {
			if (/(?:key|token|secret|auth|signature|credential|password)/i.test(key)) {
				url.searchParams.set(key, "[REDACTED]");
			}
		}
		const apiKey = process.env.OPENAI_API_KEY;
		return apiKey ? url.toString().replaceAll(apiKey, "[REDACTED]") : url.toString();
	} catch {
		return "[invalid URL]";
	}
}

async function main(): Promise<void> {
	const startedAt = new Date();
	console.log(`検証開始: ${startedAt.toISOString()}`);
	try {
		if (!process.env.OPENAI_API_KEY || !(process.env.HISTORICAL_EVENT_VERIFICATION_MODEL ?? process.env.OPENAI_MODEL)) {
			throw new Error("OPENAI_API_KEY と検証用モデルをVS Codeターミナルの環境変数に設定してください。");
		}

		const results = await historicalEventVerification.verifyHistoricalEventCandidates(candidates, {
			fetchImplementation: timedFetch,
			onApiCall: (kind) => {
				if (apiCallCount >= 2) throw new Error("API呼び出し上限（2回）に達しました。");
				apiCallCount += 1;
				console.log(`API呼び出し ${apiCallCount}/2: ${kind}`);
			},
		});

		for (const result of results) {
			console.log(`\n出来事: ${result.event}`);
			console.log(`発生日: ${result.date}`);
			console.log(`検証状態: ${result.status}`);
			console.log(`検証結果: ${result.status === "verified" ? "採用" : result.status === "rejected" ? "不採用" : "検証エラー"}`);
			console.log(`出典URL: ${result.sourceUrls.length ? result.sourceUrls.map(safeSourceUrl).join("\n          ") : "なし"}`);
			console.log(`検証理由: ${result.verificationReason}`);
			if (result.error) console.error(`障害情報: ${JSON.stringify(result.error)}`);
		}
		if (results.some((result) => result.status === "error")) process.exitCode = 1;
	} catch (error) {
		console.error(`実行エラー: ${errorMessage(error)}`);
		process.exitCode = 1;
	} finally {
		console.log(`\nAPI呼び出し回数: ${apiCallCount}`);
		console.log(`検証終了: ${new Date().toISOString()}`);
	}
}

void main();