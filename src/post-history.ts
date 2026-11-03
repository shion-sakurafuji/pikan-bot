import fs = require("node:fs");
import path = require("node:path");
import ogiri = require("./ogiri");

type PostStatus = "reserved" | "posted";

type HistoryEntry = {
    slot: string;
    runId: string;
    postText: string;
    status: PostStatus;
    createdAt: string;
    xPostId?: string;
    postedAt?: string;
};

const maxPostCharacters = 280;
const maxGenerationAttempts = 5;

const scheduleSlots: Record<string, string> = {
    "30 22 * * *": "0730",
    "5 3 * * *": "1205",
    "15 9 * * *": "1815",
};

function getHistoryPath(): string {
    return process.env.POST_HISTORY_FILE
        ?? path.join(process.cwd(), "data", "post-history.json");
}

function loadHistory(filePath = getHistoryPath()): HistoryEntry[] {
    let contents: string;

    try {
        contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }

    const parsed: unknown = JSON.parse(contents);

    if (
        !Array.isArray(parsed) ||
        !parsed.every(
            (entry) =>
                entry !== null &&
                typeof entry === "object" &&
                typeof entry.slot === "string" &&
                typeof entry.runId === "string" &&
                typeof entry.postText === "string" &&
                (entry.status === "reserved" || entry.status === "posted") &&
                typeof entry.createdAt === "string",
        )
    ) {
        throw new Error(
            "投稿履歴ファイルの形式が不正です。安全のため投稿を中止します。"
        );
    }

    return parsed as HistoryEntry[];
}

function saveHistory(
    history: HistoryEntry[],
    filePath = getHistoryPath()
): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const temporaryPath = `${filePath}.${process.pid}.tmp`;

    fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify(history, null, 2)}\n`,
        "utf8"
    );

    fs.renameSync(temporaryPath, filePath);
}

function getPostingSlot(
    env: NodeJS.ProcessEnv = process.env,
    now = new Date()
): string {
    if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
        if (!env.GITHUB_RUN_ID || !/^\d+$/.test(env.GITHUB_RUN_ID)) {
            throw new Error("手動実行のGITHUB_RUN_IDがありません。");
        }

        const postingDate = env.POSTING_DATE ?? "";
        const postSlot = env.POST_SLOT ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) {
            throw new Error("posting_date はYYYY-MM-DD形式で指定してください。");
        }
        const [year, month, day] = postingDate.split("-").map(Number);
        const parsedDate = new Date(Date.UTC(year!, month! - 1, day!));
        if (
            parsedDate.getUTCFullYear() !== year ||
            parsedDate.getUTCMonth() !== month! - 1 ||
            parsedDate.getUTCDate() !== day
        ) {
            throw new Error("posting_date が実在する日付ではありません。");
        }
        if (!["0730", "1205", "1815"].includes(postSlot)) {
            throw new Error("post_slot は0730、1205、1815のいずれかを指定してください。");
        }

        const japanDate = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(now);
        if (postingDate !== japanDate) {
            throw new Error("posting_date は現在の日本時間の日付と一致する必要があります。");
        }

        return `${postingDate}-${postSlot}`;
    }

    if (env.GITHUB_EVENT_NAME !== "schedule") {
        throw new Error(
            "投稿履歴付きの実行はGitHub Actionsのscheduleまたはworkflow_dispatchのみ対応しています。"
        );
    }

    const scheduledTime = scheduleSlots[env.POST_SCHEDULE ?? ""];

    if (!scheduledTime) {
        throw new Error(
            "想定外の投稿スケジュールです。安全のため投稿を中止します。"
        );
    }

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);

    const part = (type: string): string =>
        parts.find((item) => item.type === type)?.value ?? "";

    return `${part("year")}-${part("month")}-${part("day")}-${scheduledTime}`;
}

async function preparePost(
    history: HistoryEntry[],
    slot: string,
    generateText: () => Promise<string>,
    now = new Date(),
    runId = "",
): Promise<HistoryEntry | null> {
    if (
        history.some(
            (post) =>
                post.slot === slot ||
                (runId && post.runId === runId)
        )
    ) {
        return null;
    }

    const previousPosts = history.map((post) => post.postText);

    for (
        let attempt = 0;
        attempt < maxGenerationAttempts;
        attempt++
    ) {
        const generated = await generateText();

        let formatted: string;

        try {
            formatted = ogiri.formatPostText(generated);
        } catch {
            continue;
        }

        if (Array.from(formatted).length > maxPostCharacters) {
            continue;
        }

        if (ogiri.hasDuplicatePost(previousPosts, formatted)) {
            continue;
        }

        return {
            slot,
            runId,
            postText: formatted,
            status: "reserved",
            createdAt: now.toISOString(),
        };
    }

    throw new Error(
        `${maxGenerationAttempts}回生成しましたが、投稿可能な重複なしの大喜利を作れませんでした。`
    );
}

function markPosted(
    history: HistoryEntry[],
    slot: string,
    xPostId: string,
    now = new Date()
): HistoryEntry[] {
    const target = history.find((post) => post.slot === slot);

    if (!target || target.status !== "reserved") {
        throw new Error(
            "投稿枠が予約済みでないため、投稿履歴を更新できません。"
        );
    }

    if (!xPostId) {
        throw new Error("Xの投稿IDがありません。");
    }

    return history.map((post) =>
        post.slot === slot
            ? {
                ...post,
                status: "posted",
                xPostId,
                postedAt: now.toISOString(),
            }
            : post
    );
}

export = {
    loadHistory,
    saveHistory,
    getPostingSlot,
    preparePost,
    markPosted,
};