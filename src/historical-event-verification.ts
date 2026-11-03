import openAiClient = require("./openai-client");

type HistoricalEventCandidate = {
	event: string;
	date: string;
	sourceUrl: string;
	verified: false;
};

type VerificationResult = {
	event: string;
	date: string;
	status: "verified" | "rejected" | "error";
	sourceUrls: string[];
	verifiedSourceUrls: string[];
	sourceUrlLimit: number;
	sourceUrlsRetrieved: number;
	sourceRetrievalStatus?: "no-urls" | "fetch-failed" | "insufficient-content" | "retrieved";
	sourceEvidence: SourceEvidenceRecord[];
	verified: boolean;
	verificationReason: string;
	error?: VerificationFailure;
};

type VerificationFailure = {
	stage: "configuration" | "input-validation" | "source-search" | "source-fetch" | "evidence-review";
	httpStatus?: number;
	apiCode?: string;
	message: string;
};

type SourceEvidenceRecord = {
	url: string;
	claim: string;
	claimQuote: string;
	dateQuote: string;
	claimQuoteMatched: boolean;
	dateQuoteMatched: boolean;
	dateMatchesCandidate: boolean;
	supportsEvent: boolean;
	supportsDate: boolean;
	reliable: boolean;
	primarySource: boolean;
	independenceGroup: string;
	contradicts: boolean;
};

type VerificationOptions = {
	fetchImplementation?: typeof fetch;
	onApiCall?: (kind: "source-search" | "evidence-review") => void;
};

type DiscoveredSources = {
	events?: Array<{
		candidateIndex?: number;
		sources?: Array<{ url?: string }>;
	}>;
};

type EvidenceReview = {
	events?: Array<{
		candidateIndex?: number;
		sources?: Array<{
			url?: string;
			claimQuote?: string;
			dateQuote?: string;
            extractedDate?: string;
			supportsEvent?: boolean;
			supportsDate?: boolean;
			reliable?: boolean;
			primarySource?: boolean;
			independenceGroup?: string;
			contradicts?: boolean;
		}>;
	}>;
};

type RetrievedSource = {
	url: string;
	text: string;
};

const MAX_CANDIDATES = 8;
const MAX_SOURCE_URLS_PER_CANDIDATE = 4;
const MAX_SOURCE_URLS = MAX_CANDIDATES * MAX_SOURCE_URLS_PER_CANDIDATE;
const MAX_SOURCE_TEXT_LENGTH = 4000;
const MAX_CANDIDATE_SOURCE_TEXT_LENGTH = 12000;

const sourceSearchSchema = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: {
				type: "object",
				properties: {
					candidateIndex: { type: "integer" },
					sources: {
						type: "array",
						maxItems: 4,
						items: {
							type: "object",
							properties: { url: { type: "string" } },
							required: ["url"],
							additionalProperties: false,
						},
					},
				},
				required: ["candidateIndex", "sources"],
				additionalProperties: false,
			},
		},
	},
	required: ["events"],
	additionalProperties: false,
} as const;

const evidenceReviewSchema = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: {
				type: "object",
				properties: {
					candidateIndex: { type: "integer" },
					sources: {
						type: "array",
						items: {
							type: "object",
							properties: {
								url: { type: "string" },
								claimQuote: { type: "string" },
								dateQuote: { type: "string" },
                                extractedDate: { type: "string" },
                                supportsEvent: { type: "boolean" },
								supportsDate: { type: "boolean" },
								reliable: { type: "boolean" },
								primarySource: { type: "boolean" },
								independenceGroup: { type: "string" },
								contradicts: { type: "boolean" },
							},
							required: ["url", "claimQuote", "dateQuote", "extractedDate", "supportsEvent", "supportsDate", "reliable", "primarySource", "independenceGroup", "contradicts"],
							additionalProperties: false,
						},
					},
				},
				required: ["candidateIndex", "sources"],
				additionalProperties: false,
			},
		},
	},
	required: ["events"],
	additionalProperties: false,
} as const;

function makeResult(
	candidate: HistoricalEventCandidate,
	reason: string,
	sourceUrls: string[] = [],
	sourceEvidence: SourceEvidenceRecord[] = [],
	status: "rejected" | "error" = "rejected",
	error?: VerificationFailure,
	sourceRetrievalStatus?: VerificationResult["sourceRetrievalStatus"],
): VerificationResult {
	return {
		event: candidate.event,
		date: candidate.date,
		status,
		sourceUrls,
		verifiedSourceUrls: [],
		sourceUrlLimit: MAX_SOURCE_URLS_PER_CANDIDATE,
		sourceUrlsRetrieved: sourceUrls.length,
		...(sourceRetrievalStatus ? { sourceRetrievalStatus } : {}),
		sourceEvidence,
		verified: false,
		verificationReason: reason,
		...(error ? { error } : {}),
	};
}

function failureDetails(error: unknown, stage: VerificationFailure["stage"]): VerificationFailure {
	if (error instanceof openAiClient.OpenAiRequestError) {
		return {
			stage,
			...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
			...(error.apiCode === undefined ? {} : { apiCode: error.apiCode }),
			message: error.message,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	const apiKey = process.env.OPENAI_API_KEY;
	return {
		stage,
		message: (apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message)
			.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
			.replace(/\b(?:sk|rk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
			.replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)["']?[^\s,"']+/gi, "$1[REDACTED]")
			.slice(0, 500),
	};
}

function normalizeText(text: string): string {
	return text
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeQuote(text: string): string {
	return normalizeText(text).toLocaleLowerCase();
}

function limitCharacters(text: string, limit: number): string {
	return Array.from(text).slice(0, limit).join("");
}

function isValidExternalUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase();
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username || url.password ||
			hostname === "localhost" || hostname.endsWith(".localhost") ||
            !hostname.includes(".") ||/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||hostname.includes(":") 
		) return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function isWikipediaUrl(value: string): boolean {
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        return hostname === "wikipedia.org" || hostname.endsWith(".wikipedia.org");
    } catch {
        return false;
    }
}

function dateVariants(isoDate: string): string[] {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return [];
	const [yearText, monthText, dayText] = isoDate.split("-");
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const monthName = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1];
	if (!monthName || !Number.isInteger(day) || day < 1 || day > 31) return [];
	return [
		isoDate,
		`${monthName} ${day}, ${year}`,
		`${day} ${monthName} ${year}`,
		`${year}年${month}月${day}日`,
	];
}

function dateAppears(text: string, isoDate: string): boolean {
	const normalized = normalizeQuote(text);
	return dateVariants(isoDate).some((variant) => normalized.includes(variant.toLocaleLowerCase()));
}

async function retrieveSource(url: string, fetchImplementation: typeof fetch): Promise<RetrievedSource | undefined> {
	try {
		const response = await fetchImplementation(url, { method: "GET", redirect: "error" });
		if (!response.ok) return undefined;
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain")) return undefined;
		const text = limitCharacters(normalizeText(await response.text()), MAX_SOURCE_TEXT_LENGTH);
		return text ? { url, text } : undefined;
	} catch {
		return undefined;
	}
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function sourceSupports(
    candidate: HistoricalEventCandidate,
    evidence: NonNullable<NonNullable<EvidenceReview["events"]>[number]["sources"]>[number],
    source: RetrievedSource
): boolean {
    if (!source.text.trim()) return false;

    const dateQuote = normalizeQuote(evidence.dateQuote ?? "");
	const claimQuote = normalizeQuote(evidence.claimQuote ?? "");
    const actualText = normalizeQuote(source.text);
    const extractedDate = evidence.extractedDate ?? "";

    return (
        evidence.supportsEvent === true &&
        evidence.supportsDate === true &&
        evidence.reliable === true &&
        evidence.contradicts === false &&
		claimQuote.length > 0 &&
		actualText.includes(claimQuote) &&
        dateQuote.length > 0 &&
        actualText.includes(dateQuote) &&
        /^\d{4}-\d{2}-\d{2}$/.test(extractedDate) &&
        extractedDate === candidate.date
    );
}

async function verifyHistoricalEventCandidates(
	candidates: HistoricalEventCandidate[],
	options: VerificationOptions = {},
): Promise<VerificationResult[]> {
	if (candidates.length === 0) return [];
	const model = process.env.HISTORICAL_EVENT_VERIFICATION_MODEL ?? process.env.OPENAI_MODEL;
	if (!model) {
		const failure: VerificationFailure = { stage: "configuration", message: "検証用モデルが設定されていません。" };
		return candidates.map((candidate) => makeResult(candidate, failure.message, [], [], "error", failure));
	}
	if (candidates.length > MAX_CANDIDATES) {
		const failure: VerificationFailure = { stage: "input-validation", message: `一度に検証できる候補数の上限（${MAX_CANDIDATES}件）を超えています。` };
		return candidates.map((candidate) => makeResult(candidate, failure.message, [], [], "error", failure));
	}
	if (candidates.some((candidate) => candidate.verified !== false)) {
		const failure: VerificationFailure = { stage: "input-validation", message: "未検証候補のみを受け付けます。" };
		return candidates.map((candidate) => makeResult(candidate, failure.message, [], [], "error", failure));
	}

	const fetchImplementation = options.fetchImplementation ?? fetch;
	const apiCall = (kind: "source-search" | "evidence-review") => options.onApiCall?.(kind);
	
let discovery: DiscoveredSources | undefined;

try {
    apiCall("source-search");

    const output = await openAiClient.requestOpenAi(
		`次の歴史的出来事候補について、発生日と主要な主張を確認できる資料URLをWeb検索で集めてください。Wikipediaも利用できます。候補ごとに最大4件までとし、候補のsourceUrlを最優先で含めてください。候補: ${JSON.stringify(candidates.map(({ event, date, sourceUrl }, candidateIndex) => ({ candidateIndex, event, date, sourceUrl })))}`,
        {
            model,
            tools: [{ type: "web_search" }],
            jsonSchema: {
                name: "historical_event_sources",
                schema: sourceSearchSchema,
            },
            fetchImplementation,
        },
    );

    discovery = parseJson<DiscoveredSources>(output);
} catch (error) {
    const failure = failureDetails(error, "source-search");
    return candidates.map((candidate) =>
        makeResult(
            candidate,
            "資料検索に失敗したため検証を完了できませんでした。",
            [],
            [],
            "error",
            failure,
        )
    );
}

if (!Array.isArray(discovery?.events)) {
    const failure: VerificationFailure = {
        stage: "source-search",
        message: "資料検索結果を解釈できませんでした。",
    };
    return candidates.map((candidate) =>
        makeResult(candidate, failure.message, [], [], "error", failure)
    );
}

	const candidateUrls = candidates.map(() => new Set<string>());
	candidates.forEach((candidate, candidateIndex) => {
		const originalUrl = isValidExternalUrl(candidate.sourceUrl);
		if (originalUrl) candidateUrls[candidateIndex]?.add(originalUrl);
	});

for (const entry of discovery.events) {
    if (
        !Number.isInteger(entry.candidateIndex) ||
        entry.candidateIndex! < 0 ||
        entry.candidateIndex! >= candidates.length
    ) continue;

    const urls = candidateUrls[entry.candidateIndex!];

    for (const rawUrl of entry.sources ?? []) {
        const url = typeof rawUrl.url === "string"
            ? isValidExternalUrl(rawUrl.url)
            : undefined;

        if (url) urls?.add(url);
    }
}

const allocatedByCandidate = candidates.map(() => [] as string[]);
const allUrls: string[] = [];
const uniqueUrls = new Set<string>();
for (let round = 0; round < MAX_SOURCE_URLS_PER_CANDIDATE && allUrls.length < MAX_SOURCE_URLS; round++) {
	for (let candidateIndex = 0; candidateIndex < candidateUrls.length && allUrls.length < MAX_SOURCE_URLS; candidateIndex++) {
		const url = [...(candidateUrls[candidateIndex] ?? [])][round];
		if (!url) continue;
		allocatedByCandidate[candidateIndex]?.push(url);
		if (!uniqueUrls.has(url)) {
			uniqueUrls.add(url);
			allUrls.push(url);
		}
	}
}

const retrievedSources = new Map<string, RetrievedSource>();
for (const url of allUrls) {
    const source = await retrieveSource(url, fetchImplementation);
	if (source) retrievedSources.set(url, source);
}

const retrievedByCandidate = candidates.map(
    () => [] as RetrievedSource[]
);

allocatedByCandidate.forEach((urls, candidateIndex) => {
	let remainingTextLength = MAX_CANDIDATE_SOURCE_TEXT_LENGTH;
	for (const url of urls) {
		const source = retrievedSources.get(url);
		if (!source || remainingTextLength <= 0) continue;
		const limitedSource = { ...source, text: limitCharacters(source.text, remainingTextLength) };
		retrievedByCandidate[candidateIndex]?.push(limitedSource);
		remainingTextLength -= Array.from(limitedSource.text).length;
	}
});

if (!retrievedByCandidate.some((sources) => sources.length > 0)) {
    return candidates.map((candidate) =>
        makeResult(
            candidate,
			allUrls.length > 0
				? "検索で得た出典URLの取得に失敗したため採用を見送りました。"
				: "出典URLが見つからなかったため採用を見送りました。",
			[],
			[],
			"rejected",
			undefined,
			allUrls.length > 0 ? "fetch-failed" : "no-urls",
        )
    );
}

	let review: EvidenceReview | undefined;
	try {
		apiCall("evidence-review");

const output = await openAiClient.requestOpenAi(
    `以下はWebから取得した歴史資料の本文です。

各候補について、次の条件で判定してください。

1. 出来事の発生日を示す原文をdateQuoteに引用する。
2. 日付を言語に関係なくYYYY-MM-DD形式に変換し、extractedDateに返す。
3. extractedDateが候補dateと一致する場合だけsupportsDateをtrueにする。
4. 出来事の内容が本文で確認できる場合だけsupportsEventをtrueにする。
5. 日付が不明ならextractedDateは空文字列、supportsDateはfalseにする。
6. 矛盾があればcontradictsをtrueにする。
7. 信頼性、一次資料かどうか、独立性グループも判定する。

例：
31 ottobre 1926 → 1926-10-31
October 31, 1926 → 1926-10-31
1926年10月31日 → 1926-10-31
30 ottobre 1926 → 1926-10-30

引用は資料の原文から取得してください。
本文にない情報を補わず、URLを変更しないでください。

候補と取得本文：
${JSON.stringify(candidates.map(({ event, date }, candidateIndex) => ({
    candidateIndex,
    event,
    date,
    sources: retrievedByCandidate[candidateIndex]?.map(
        ({ url, text }) => ({ url, text })
    ) ?? []
})))}`,
    {
        model,
        jsonSchema: {
            name: "historical_event_evidence_review",
            schema: evidenceReviewSchema
        },
        fetchImplementation,
    },
);

		review = parseJson<EvidenceReview>(output);
	} catch (error) {
		const failure = failureDetails(error, "evidence-review");
		return candidates.map((candidate, index) => makeResult(
			candidate,
			"出典本文の照合に失敗したため検証を完了できませんでした。",
			retrievedByCandidate[index]?.map((source) => source.url) ?? [],
			[],
			"error",
			failure,
		));
	}
	if (!Array.isArray(review?.events)) {
		const failure: VerificationFailure = { stage: "evidence-review", message: "出典本文の照合結果を解釈できませんでした。" };
		return candidates.map((candidate, index) => makeResult(
			candidate,
			failure.message,
			retrievedByCandidate[index]?.map((source) => source.url) ?? [],
			[],
			"error",
			failure,
		));
	}

	return candidates.map((candidate, candidateIndex) => {
		const evidence = review.events?.find((entry) => entry.candidateIndex === candidateIndex)?.sources ?? [];
		const retrieved = new Map((retrievedByCandidate[candidateIndex] ?? []).map((source) => [source.url, source]));
		const sourceEvidence: SourceEvidenceRecord[] = evidence.flatMap((item) => {
			const url = typeof item.url === "string" ? isValidExternalUrl(item.url) : undefined;
			const source = url ? retrieved.get(url) : undefined;
			if (!source || !url) return [];
			const actualText = normalizeQuote(source.text);
			const claimQuote = typeof item.claimQuote === "string" ? item.claimQuote.trim() : "";
			const dateQuote = typeof item.dateQuote === "string" ? item.dateQuote.trim() : "";
            const claimQuoteMatched =
                claimQuote.length > 0 &&
                actualText.includes(normalizeQuote(claimQuote));

            const dateQuoteMatched =
                dateQuote.length > 0 &&
                actualText.includes(normalizeQuote(dateQuote));

            const dateMatchesCandidate =
                item.extractedDate === candidate.date;
    		return [{
				url,
				claim: candidate.event,
				claimQuote,
				dateQuote,
				claimQuoteMatched,
				dateQuoteMatched,
				dateMatchesCandidate,
                supportsEvent: item.supportsEvent === true,
                supportsDate: item.supportsDate === true && dateQuoteMatched && dateMatchesCandidate,
				reliable: item.reliable === true,
				primarySource: item.primarySource === true,
				independenceGroup: item.independenceGroup ?? "",
				contradicts: item.contradicts === true,
			}];
		});
		const confirmed = evidence.flatMap((item) => {
			const url = typeof item.url === "string" ? isValidExternalUrl(item.url) : undefined;
			const source = url ? retrieved.get(url) : undefined;
			return source && sourceSupports(candidate, item, source) ? [{ item, source }] : [];
		});

        const hasContradiction = evidence.some(
            (item) => item.contradicts === true
        );

        const supported = confirmed.length >= 1;
		const verifiedSourceUrls = hasContradiction
			? []
			: [...new Set(confirmed.map(({ source }) => source.url))];

		const sourceUrls = [
			...new Set(
				(allocatedByCandidate[candidateIndex] ?? [])
					.filter((url) => retrievedSources.has(url))
			)
		];

        if (hasContradiction) {
            return makeResult(
                candidate,
                "確認した資料間に矛盾があるため不採用です。",
                sourceUrls,
                sourceEvidence
            );
        }

        if (!supported) {
            return makeResult(
                candidate,
                "出来事と発生日を裏付ける資料を確認できませんでした。",
                sourceUrls,
				sourceEvidence,
				"rejected",
				undefined,
				sourceUrls.length > 0 ? "insufficient-content" : allocatedByCandidate[candidateIndex]?.length ? "fetch-failed" : "no-urls",
            );
        }

        return {
            event: candidate.event,
            date: candidate.date,
            status: "verified" as const,
            sourceUrls,
			verifiedSourceUrls,
			sourceUrlLimit: MAX_SOURCE_URLS_PER_CANDIDATE,
			sourceUrlsRetrieved: sourceUrls.length,
			sourceRetrievalStatus: "retrieved" as const,
            sourceEvidence,
            verified: true,
            verificationReason:
                "取得した資料で出来事と発生日を確認しました。",
        };

	});
}

export = { verifyHistoricalEventCandidates };