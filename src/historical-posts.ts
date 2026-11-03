import fs = require("node:fs");
import path = require("node:path");

type HistoricalCandidate = {
	event: string;
	eventKey: string;
	date: string;
	sourceUrl: string;
	verified: false;
};

type VerificationResult = {
	event: string;
	date: string;
	status: "verified" | "rejected" | "error";
	verified: boolean;
	sourceUrls: string[];
	verifiedSourceUrls: string[];
};

type PostStatus = "pending" | "sending" | "posted" | "unknown";
type DayStatus = "ready" | "insufficient" | "error";
type HistoricalPost = {
	slot: string;
	targetDate: string;
	event: string;
	eventKey: string;
	sourceUrls: string[];
	postText: string;
	scheduledAt: string;
	status: PostStatus;
	createdAt: string;
	attemptId?: string;
	xPostId?: string;
	postedAt?: string;
};

type HistoricalDay = {
	postingDate: string;
	targetDate: string;
	status: DayStatus;
	createdAt: string;
	failureReason?: string;
	posts: HistoricalPost[];
};

type HistoricalStore = { days: HistoricalDay[] };
type Pipeline = {
	research: (targetDate: string, excludedEventKeys: string[]) => Promise<HistoricalCandidate[]>;
	verify: (candidates: HistoricalCandidate[]) => Promise<VerificationResult[]>;
};

const MAX_RESEARCH_ROUNDS = 3;
const CANDIDATES_PER_ROUND = 8;
const MAX_POST_CHARACTERS = 280;
const slots = ["0730", "1205", "1815"] as const;

function getStorePath(): string {
	return process.env.HISTORICAL_POSTS_FILE ?? path.join(process.cwd(), "data", "historical-posts.json");
}

function isValidPost(value: unknown): value is HistoricalPost {
	if (!value || typeof value !== "object") return false;
	const post = value as HistoricalPost;
	return typeof post.slot === "string" && typeof post.targetDate === "string" &&
		typeof post.event === "string" && typeof post.eventKey === "string" &&
		Array.isArray(post.sourceUrls) && post.sourceUrls.every((url) => typeof url === "string") &&
		typeof post.postText === "string" && typeof post.scheduledAt === "string" &&
		["pending", "sending", "posted", "unknown"].includes(post.status) &&
		typeof post.createdAt === "string";
}

function loadHistoricalStore(filePath = getStorePath()): HistoricalStore {
	let contents: string;
	try {
		contents = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { days: [] };
		throw error;
	}

	const parsed: unknown = JSON.parse(contents);
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as HistoricalStore).days)) {
		throw new Error("歴史投稿データの形式が不正です。安全のため処理を中止します。");
	}
	const days = (parsed as HistoricalStore).days;
	if (!days.every((value) => {
		if (!value || typeof value !== "object") return false;
		const day = value as HistoricalDay;
		return typeof day.postingDate === "string" && typeof day.targetDate === "string" &&
			["ready", "insufficient", "error"].includes(day.status) &&
			typeof day.createdAt === "string" && Array.isArray(day.posts) && day.posts.every(isValidPost);
	})) {
		throw new Error("歴史投稿データの形式が不正です。安全のため処理を中止します。");
	}
	return parsed as HistoricalStore;
}

function saveHistoricalStore(store: HistoricalStore, filePath = getStorePath()): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	fs.renameSync(temporaryPath, filePath);
}

function japanDate(now = new Date()): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
	}).formatToParts(now);
	const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return `${value("year")}-${value("month")}-${value("day")}`;
}

function getTargetHistoricalDateForPostingDate(postingDate: string): string {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) throw new Error("投稿日はYYYY-MM-DD形式で指定してください。");
 const [postingYear, month, day] = postingDate.split("-").map(Number);
 const parsedDate = new Date(Date.UTC(postingYear!, month! - 1, day!));
 if (parsedDate.getUTCFullYear() !== postingYear || parsedDate.getUTCMonth() !== month! - 1 || parsedDate.getUTCDate() !== day) {
  throw new Error("投稿日が実在する日付ではありません。");
 }
 const year = postingYear! - 100;
 const monthNumber = month!;
 const dayNumber = day!;
	const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
	if (dayNumber > lastDay) throw new Error("100年前に同じ暦日が存在しないため対象日を決定できません。");
	return `${String(year).padStart(4, "0")}-${month}-${day}`;
}

function getTargetHistoricalDate(now = new Date()): string {
 return getTargetHistoricalDateForPostingDate(japanDate(now));
}

function normalizeEventKey(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\b(?:19|20)\d{2}\b/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function isKnownEvent(eventKey: string, known: Set<string>): boolean {
	const key = normalizeEventKey(eventKey);
	if (!key) return true;
	for (const existing of known) {
		if (existing === key || (Math.min(existing.length, key.length) >= 8 && (existing.includes(key) || key.includes(existing)))) return true;
	}
	return false;
}

function formatPostText(date: string, event: string, sourceUrl: string): string {
	return `【${date}】${event}\n出典: ${sourceUrl}`;
}

function scheduledAt(postingDate: string, slot: string): string {
	return new Date(`${postingDate}T${slot.slice(0, 2)}:${slot.slice(2)}:00+09:00`).toISOString();
}

async function prepareHistoricalDay(
	filePath: string,
	postingDate: string,
	targetDate: string,
	pipeline: Pipeline,
	previousPostTexts: string[] = [],
	now = new Date(),
): Promise<HistoricalDay> {
	const store = loadHistoricalStore(filePath);
	const existing = store.days.find((day) => day.postingDate === postingDate);
	if (existing) return existing;

	const knownEventKeys = new Set<string>();
	const eventKeysThisDay = new Set<string>();
	for (const day of store.days) {
		for (const post of day.posts) {
			knownEventKeys.add(normalizeEventKey(post.eventKey));
			knownEventKeys.add(normalizeEventKey(post.event));
		}
	}
	for (const postText of previousPostTexts) knownEventKeys.add(normalizeEventKey(postText));

	const selected: HistoricalPost[] = [];
	let failureReason: string | undefined;
	let status: DayStatus = "insufficient";
	for (let round = 0; round < MAX_RESEARCH_ROUNDS && selected.length < slots.length; round++) {
		let candidates: HistoricalCandidate[];
		try {
			candidates = await pipeline.research(targetDate, [...eventKeysThisDay]).then((items) => items.slice(0, CANDIDATES_PER_ROUND));
		} catch (error) {
			status = "error";
			failureReason = error instanceof Error ? error.message : String(error);
			break;
		}

		const uniqueCandidates: HistoricalCandidate[] = [];
		const batchKeys = new Set<string>();
		for (const candidate of candidates) {
			if (candidate.date !== targetDate) continue;
			const eventKey = candidate.eventKey?.trim() || candidate.event;
			const normalizedKey = normalizeEventKey(eventKey);
			if (isKnownEvent(eventKey, knownEventKeys) || isKnownEvent(candidate.event, knownEventKeys) || batchKeys.has(normalizedKey)) continue;
			batchKeys.add(normalizedKey);
			uniqueCandidates.push(candidate);
			knownEventKeys.add(normalizedKey);
			eventKeysThisDay.add(normalizedKey);
		}
		if (uniqueCandidates.length === 0) continue;

		let results: VerificationResult[];
		try {
			results = await pipeline.verify(uniqueCandidates);
		} catch (error) {
			status = "error";
			failureReason = error instanceof Error ? error.message : String(error);
			break;
		}
		if (results.some((result) => result.status === "error")) {
			status = "error";
			failureReason = "史実検証APIでエラーが発生したため、追加調査を中止しました。";
		}

		for (let index = 0; index < uniqueCandidates.length && selected.length < slots.length; index++) {
			const candidate = uniqueCandidates[index]!;
			const result = results[index];
			if (result?.status !== "verified" || !result.verified || result.date !== targetDate || result.verifiedSourceUrls.length === 0) continue;
			const eventKey = candidate.eventKey?.trim() || candidate.event;
			const verifiedSourceUrls = [...new Set(result.verifiedSourceUrls)];
			if (verifiedSourceUrls.length === 0) continue;
			const postText = formatPostText(targetDate, candidate.event, verifiedSourceUrls[0]!);
			if (Array.from(postText).length > MAX_POST_CHARACTERS) continue;
			const slot = slots[selected.length]!;
			selected.push({
				slot: `${postingDate}-${slot}`,
				targetDate,
				event: candidate.event,
				eventKey,
				sourceUrls: verifiedSourceUrls,
				postText,
				scheduledAt: scheduledAt(postingDate, slot),
				status: "pending",
				createdAt: now.toISOString(),
			});
		}
		if (status === "error") break;
	}

	if (status !== "error" && selected.length === slots.length) status = "ready";
	const day: HistoricalDay = {
		postingDate,
		targetDate,
		status,
		createdAt: now.toISOString(),
		...(failureReason ? { failureReason } : {}),
		posts: selected,
	};
	store.days.push(day);
	saveHistoricalStore(store, filePath);
	return day;
}

async function publishHistoricalPost(
	filePath: string,
	slot: string,
	postTweet: (text: string) => Promise<{ id?: string } | undefined>,
	now = new Date(),
): Promise<{ posted: boolean; status: PostStatus | "missing" }> {
	const store = loadHistoricalStore(filePath);
	const post = store.days.flatMap((day) => day.posts).find((entry) => entry.slot === slot);
	if (!post) return { posted: false, status: "missing" };
	if (post.status !== "pending") return { posted: false, status: post.status };

	post.status = "sending";
	saveHistoricalStore(store, filePath);
	try {
		const response = await postTweet(post.postText);
		if (!response?.id) throw new Error("Xの投稿IDが返されませんでした。送信状態を確認してください。");
		post.status = "posted";
		post.xPostId = response.id;
		post.postedAt = now.toISOString();
		saveHistoricalStore(store, filePath);
		return { posted: true, status: "posted" };
	} catch (error) {
		post.status = "unknown";
		saveHistoricalStore(store, filePath);
		throw error;
	}
}

function reserveHistoricalPost(filePath: string, slot: string, attemptId: string): boolean {
	if (!attemptId) throw new Error("投稿試行IDがありません。");
	const store = loadHistoricalStore(filePath);
	const post = store.days.flatMap((day) => day.posts).find((entry) => entry.slot === slot);
	if (!post || post.status !== "pending") return false;
	post.status = "sending";
	post.attemptId = attemptId;
	saveHistoricalStore(store, filePath);
	return true;
}

async function publishReservedHistoricalPost(
	filePath: string,
	slot: string,
	attemptId: string,
	postTweet: (text: string) => Promise<{ id?: string } | undefined>,
	now = new Date(),
): Promise<{ posted: boolean; status: PostStatus | "missing" }> {
	const store = loadHistoricalStore(filePath);
	const post = store.days.flatMap((day) => day.posts).find((entry) => entry.slot === slot);
	if (!post) return { posted: false, status: "missing" };
	if (post.status !== "sending" || post.attemptId !== attemptId) return { posted: false, status: post.status };

	post.status = "unknown";
	saveHistoricalStore(store, filePath);
	try {
		const response = await postTweet(post.postText);
		if (!response?.id) throw new Error("Xの投稿IDが返されませんでした。送信状態を確認してください。");
		post.status = "posted";
		post.xPostId = response.id;
		post.postedAt = now.toISOString();
		saveHistoricalStore(store, filePath);
		return { posted: true, status: "posted" };
	} catch (error) {
		saveHistoricalStore(store, filePath);
		throw error;
	}
}

export = {
	loadHistoricalStore,
	saveHistoricalStore,
	japanDate,
	getTargetHistoricalDate,
	 getTargetHistoricalDateForPostingDate,
	normalizeEventKey,
	prepareHistoricalDay,
	reserveHistoricalPost,
	publishHistoricalPost,
	publishReservedHistoricalPost,
};