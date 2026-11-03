import fs = require("node:fs");
import ogiri = require("./ogiri");
import history = require("./post-history");

function setReady(ready: boolean): void {
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `ready=${ready}\n`
        );
    }
}

async function main(): Promise<void> {
    if (!process.env.GITHUB_RUN_ID) {
        throw new Error(
            "GITHUB_RUN_ID がありません。履歴を保証できないため投稿を中止します。"
        );
    }

    const slot = history.getPostingSlot();

    const saved = history.loadHistory();

    const prepared = await history.preparePost(
        saved,
        slot,
        ogiri.generateOgiri,
        new Date(),
        process.env.GITHUB_RUN_ID
    );

    if (!prepared) {
        console.log(
            `投稿枠 ${slot} は既に使用済みです。再投稿しません。`
        );

        setReady(false);
        return;
    }

    history.saveHistory([...saved, prepared]);

    console.log(
        `投稿枠 ${slot} を予約しました。Xへ送信する前にGitHubへ保存します。`
    );

    console.log(prepared.postText);

    setReady(true);
}

main().catch((error: unknown) => {
    console.error(
        error instanceof Error ? error.message : String(error)
    );

    process.exitCode = 1;
});