import fs = require("node:fs");
import path = require("node:path");
import historicalPosts = require("./historical-posts");
import postHistory = require("./post-history");

function setReady(ready: boolean): void {
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
}

function getAttemptId(): string {
	const runId = process.env.GITHUB_RUN_ID;
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
	if (!runId || !runAttempt) throw new Error("GitHub Actionsの投稿試行IDがありません。");
	return `${runId}-${runAttempt}`;
}

function main(): void {
	const slot = postHistory.getPostingSlot();
	const filePath = process.env.HISTORICAL_POSTS_FILE ?? path.join(process.cwd(), "data", "historical-posts.json");
	const reserved = historicalPosts.reserveHistoricalPost(filePath, slot, getAttemptId());
	setReady(reserved);
	console.log(reserved ? `投稿枠 ${slot} を送信前状態として保存しました。` : `投稿枠 ${slot} は送信対象ではありません。`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}