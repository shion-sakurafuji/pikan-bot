import ogiri = require("./ogiri");
import xPost = require("./x-post");
import workflow = require("./workflow");

async function main(): Promise<void> {
	const result = await workflow.runOgiriWorkflow(ogiri.generateOgiri, xPost.postTweet);

	console.log("投稿用テキスト:");
	console.log(result.postText);
	if (result.posted) {
		console.log("Xへの投稿が完了しました。");
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`大喜利の生成に失敗しました: ${message}`);
	process.exitCode = 1;
});
