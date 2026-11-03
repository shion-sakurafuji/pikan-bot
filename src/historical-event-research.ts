import openAiClient = require("./openai-client");

type HistoricalEventCandidate = {
	event: string;
	eventKey: string;
	date: string;
	sourceUrl: string;
	verified: false;
};

type SearchResult = {
	events?: Array<{
		event?: string;
		eventKey?: string;
		date?: string;
		sourceUrl?: string;
	}>;
};

const candidateSchema = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: {
				type: "object",
				properties: {
					event: { type: "string" },
					eventKey: { type: "string" },
					date: { type: "string" },
					sourceUrl: { type: "string" },
				},
				required: ["event", "eventKey", "date", "sourceUrl"],
				additionalProperties: false,
			},
		},
	},
	required: ["events"],
	additionalProperties: false,
} as const;

function isValidDate(year: number, month: number, day: number): boolean {
	if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
	if (!Number.isInteger(month) || month < 1 || month > 12) return false;
	if (!Number.isInteger(day) || day < 1) return false;

	const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= (daysInMonth[month - 1] ?? 0);
}

async function getHistoricalEventCandidates(
	year: number,
	month: number,
	day: number,
	fetchImplementation: typeof fetch = fetch,
	candidateCount = 8,
	excludedEventKeys: string[] = [],
): Promise<HistoricalEventCandidate[]> {
	if (!isValidDate(year, month, day)) {
		throw new Error("有効な年月日を指定してください。");
	}
	if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 8) {
		throw new Error("一度の調査件数は1件から8件で指定してください。");
	}

	const model = process.env.HISTORICAL_EVENTS_MODEL ?? process.env.OPENAI_MODEL;
	if (!model) {
		throw new Error("OPENAI_API_KEY と OPENAI_MODEL（または HISTORICAL_EVENTS_MODEL）を環境変数に設定してください。");
	}

	const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	const outputText = await openAiClient.requestOpenAi(
		`Web検索を使い、歴史上の${date}に起きた異なる出来事をちょうど${candidateCount}件調査してください。Wikipediaに限定せず、信頼できる公開情報源を参照してください。発生日が指定日と一致する出来事だけを選び、短い説明、同じ出来事なら文章表現や出典が違っても同一になる短いeventKey、発生日（YYYY-MM-DD）、根拠にした出典ページのURLを含めてください。次のeventKeyは既に調査済みなので除外してください: ${JSON.stringify(excludedEventKeys)}。確認できる出典がない候補は含めないでください。不足する場合に架空の候補で埋めてはいけません。これらはファクトチェック前の未検証候補です。`,
		{
			model,
			tools: [{ type: "web_search" }],
			jsonSchema: {
				name: "historical_event_candidates",
				schema: candidateSchema,
			},
			fetchImplementation,
		},
	);

	let searchResult: SearchResult;
	try {
		searchResult = JSON.parse(outputText) as SearchResult;
	} catch {
		throw new Error("歴史候補の検索結果をJSONとして読み取れません。");
	}

	if (!Array.isArray(searchResult.events)) {
		throw new Error("歴史候補の検索結果にevents配列がありません。");
	}

	return searchResult.events.map((candidate) => {
		if (
			typeof candidate.event !== "string" || !candidate.event.trim() ||
			typeof candidate.eventKey !== "string" || !candidate.eventKey.trim() ||
			typeof candidate.date !== "string" || candidate.date !== date ||
			typeof candidate.sourceUrl !== "string"
		) {
			throw new Error("歴史候補に指定日と一致する出来事・発生日・出典URLが必要です。");
		}

		let sourceUrl: URL;
		try {
			sourceUrl = new URL(candidate.sourceUrl);
		} catch {
			throw new Error("歴史候補の出典URLが不正です。");
		}
		if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "http:") {
			throw new Error("歴史候補の出典URLはHTTPまたはHTTPSである必要があります。");
		}

		return {
			event: candidate.event.trim(),
			eventKey: candidate.eventKey.trim(),
			date: candidate.date,
			sourceUrl: sourceUrl.toString(),
			verified: false as const,
		};
	}).slice(0, candidateCount);
}

export = { getHistoricalEventCandidates };