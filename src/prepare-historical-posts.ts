import fs = require("node:fs");
import path = require("node:path");
import historicalEventResearch = require("./historical-event-research");
import historicalEventVerification = require("./historical-event-verification");
import historicalPosts = require("./historical-posts");
import postHistory = require("./post-history");

function setReady(ready: boolean): void {
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
	}
}

async function main(): Promise<void> {
	const slot = postHistory.getPostingSlot();
	const postingDate = slot.slice(0, 10);
	const targetDate = historicalPosts.getTargetHistoricalDateForPostingDate(postingDate);
	const filePath = process.env.HISTORICAL_POSTS_FILE ?? path.join(process.cwd(), "data", "historical-posts.json");
	const previousPostTexts = postHistory.loadHistory().map((entry) => entry.postText);
	const prepared = await historicalPosts.prepareHistoricalDay(filePath, postingDate, targetDate, {
		research: (date, excludedEventKeys) => {
			const [researchYear, researchMonth, researchDay] = date.split("-").map(Number);
			return historicalEventResearch.getHistoricalEventCandidates(
				researchYear!, researchMonth!, researchDay!, fetch, 8, excludedEventKeys,
			);
		},
		verify: (candidates) => historicalEventVerification.verifyHistoricalEventCandidates(candidates),
	}, previousPostTexts);
	const currentPost = prepared.posts.find((post) => post.slot === slot);
	const ready = currentPost?.status === "pending";

	console.log(`対象日: ${targetDate}`);
	console.log(`日次状態: ${prepared.status}`);
	console.log(`確定済み投稿数: ${prepared.posts.length}`);
	console.log(`今回の投稿枠: ${ready ? "準備済み" : "投稿なし"}`);
	setReady(ready);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});