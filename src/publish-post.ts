import history = require("./post-history");
import xPost = require("./x-post");

async function main(): Promise<void> {
    const slot = history.getPostingSlot();

    const saved = history.loadHistory();

    const entry = saved.find(
        (post) => post.slot === slot
    );

    if (!entry || entry.status !== "reserved") {
        throw new Error(
            `投稿枠 ${slot} の予約が確認できません。Xへの送信を中止します。`
        );
    }

    const posted = await xPost.postTweet(entry.postText);

    if (!posted?.id) {
        throw new Error(
            "Xから投稿IDが返されませんでした。"
        );
    }

    history.saveHistory(
        history.markPosted(saved, slot, posted.id)
    );

    console.log(
        `Xへの投稿が完了しました。投稿ID: ${posted.id}`
    );
}

main().catch((error: unknown) => {
    console.error(
        error instanceof Error ? error.message : String(error)
    );

    process.exitCode = 1;
});