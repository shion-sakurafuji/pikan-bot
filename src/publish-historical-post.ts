import path = require("node:path");
import historicalPosts = require("./historical-posts");
import postHistory = require("./post-history");
import xPost = require("./x-post");

async function runIfPostingEnabled(env: NodeJS.ProcessEnv, publish: () => Promise<void>): Promise<boolean> {
	const enabled = env.PIKAN_AUTOPUBLISH_ENABLED === "true" && env.X_POST_ENABLED === "true" &&
		(env.GITHUB_EVENT_NAME === "schedule" ||
			(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.POST_TO_X === "true"));
	if (!enabled) return false;
	await publish();
	return true;
}

function getAttemptId(): string {
	const runId = process.env.GITHUB_RUN_ID;
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
	if (!runId || !runAttempt) throw new Error("GitHub Actionsの投稿試行IDがありません。");
	return `${runId}-${runAttempt}`;
}

async function main(): Promise<void> {
	const ran = await runIfPostingEnabled(process.env, async () => {
		const slot = postHistory.getPostingSlot();
		const filePath = process.env.HISTORICAL_POSTS_FILE ?? path.join(process.cwd(), "data", "historical-posts.json");
		const result = await historicalPosts.publishReservedHistoricalPost(
			filePath,
			slot,
			getAttemptId(),
			xPost.postTweet,
		);
		console.log(result.posted ? `投稿枠 ${slot} の送信が完了しました。` : `投稿枠 ${slot} は送信されませんでした（状態: ${result.status}）。`);
	});
	if (!ran) console.log("投稿許可条件がそろわないため、Xへの送信を行いません。");
}

if (require.main === module) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

export = { runIfPostingEnabled };