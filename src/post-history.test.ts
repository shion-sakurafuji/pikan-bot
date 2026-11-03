import assert = require("node:assert/strict");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import test = require("node:test");
import history = require("./post-history");

const sample = "お題: 昔の学校\n回答: ロボットが給食を食べる。";

test("GitHub ActionsのUTC cronを3つの日本時間投稿枠へ対応させる", () => {
    const expected: [string, string, string][] = [
        ["30 22 * * *", "2026-10-24T22:30:00Z", "2026-10-25-0730"],
        ["5 3 * * *", "2026-10-25T03:05:00Z", "2026-10-25-1205"],
        ["15 9 * * *", "2026-10-25T09:15:00Z", "2026-10-25-1815"],
    ];

    for (const [schedule, instant, slot] of expected) {
        assert.equal(
            history.getPostingSlot(
                {
                    GITHUB_EVENT_NAME: "schedule",
                    POST_SCHEDULE: schedule,
                },
                new Date(instant)
            ),
            slot
        );
    }
});

test("dispatch入力の3枠を指定された投稿日付き枠IDへ変換する", () => {
    const now = new Date("2026-10-24T15:00:00Z");
    for (const [postSlot, expected] of [
        ["0730", "2026-10-25-0730"],
        ["1205", "2026-10-25-1205"],
        ["1815", "2026-10-25-1815"],
    ]) {
        assert.equal(history.getPostingSlot({
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_RUN_ID: "123",
            POST_SLOT: postSlot,
            POSTING_DATE: "2026-10-25",
        }, now), expected);
    }
});

test("dispatchの日付はJST当日で検証し、不正な入力を拒否する", () => {
    const input = {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ID: "123",
        POST_SLOT: "0730",
        POSTING_DATE: "2026-10-25",
    };
    assert.equal(history.getPostingSlot(input, new Date("2026-10-24T15:00:00Z")), "2026-10-25-0730");

    const invalidInputs = [
        { ...input, POST_SLOT: "0700" },
        { ...input, POSTING_DATE: "2026-02-29" },
        { ...input, POSTING_DATE: "2026-10-24" },
        { ...input, POSTING_DATE: "2026-1-25" },
        { ...input, GITHUB_RUN_ID: "" },
    ];
    for (const invalidInput of invalidInputs) {
        assert.throws(() => history.getPostingSlot(invalidInput, new Date("2026-10-24T15:00:00Z")));
    }
});

test("未知のスケジュール・実行方法では投稿しない", () => {
    assert.throws(
        () => history.getPostingSlot({
            GITHUB_EVENT_NAME: "schedule",
            POST_SCHEDULE: "* * * * *",
        }),
        /想定外/
    );

    for (const obsoleteJstCron of ["30 7 * * *", "5 12 * * *", "15 18 * * *"]) {
        assert.throws(
            () => history.getPostingSlot({
                GITHUB_EVENT_NAME: "schedule",
                POST_SCHEDULE: obsoleteJstCron,
            }),
            /想定外/
        );
    }

    assert.throws(
        () => history.getPostingSlot({
            GITHUB_EVENT_NAME: "push",
        }),
        /のみ対応/
    );
});

test("投稿枠を予約し、投稿ID付きで完了にできる", async () => {
    const now = new Date("2026-10-25T00:00:00Z");

    const entry = await history.preparePost(
        [],
        "2026-10-25-0730",
        async () => sample,
        now,
        "100"
    );

    assert.ok(entry);
    assert.equal(entry.status, "reserved");
    assert.equal(entry.runId, "100");

    const posted = history.markPosted(
        [entry],
        entry.slot,
        "123456",
        now
    );

    assert.equal(posted[0]?.status, "posted");
    assert.equal(posted[0]?.xPostId, "123456");
    assert.equal(entry.status, "reserved");
});

test("予約済みの枠では再生成を呼ばない", async () => {
    const previous = await history.preparePost(
        [],
        "2026-10-25-0730",
        async () => sample,
        new Date(),
        "100"
    );

    assert.ok(previous);

    let calls = 0;

    const generate = async () => {
        calls++;
        return sample;
    };

    assert.equal(
        await history.preparePost(
            [previous],
            previous.slot,
            generate
        ),
        null
    );

    assert.equal(
        await history.preparePost(
            [previous],
            "2026-10-26-0730",
            generate,
            new Date(),
            "100"
        ),
        null
    );

    assert.equal(calls, 0);
});

test("重複した場合は再生成する", async () => {
    const previous = await history.preparePost(
        [],
        "2026-10-25-0730",
        async () => sample
    );

    assert.ok(previous);

    let calls = 0;

    const result = await history.preparePost(
        [previous],
        "2026-10-25-1205",
        async () => {
            calls++;

            return calls === 1
                ? sample
                : "お題: 夜の学校\n回答: 校庭が一人で走る。";
        }
    );

    assert.ok(result);
    assert.equal(calls, 2);
    assert.match(result.postText, /夜の学校/);
});

test("形式不正・文字数超過なら再生成する", async () => {
    let calls = 0;

    const valid = await history.preparePost(
        [],
        "slot1",
        async () => {
            calls++;

            if (calls === 1) {
                return "壊れた形式";
            }

            if (calls === 2) {
                return `お題: あ\n回答: ${"い".repeat(300)}`;
            }

            return sample;
        }
    );

    assert.ok(valid);
    assert.equal(calls, 3);

    await assert.rejects(
        history.preparePost(
            [valid],
            "slot2",
            async () => sample
        ),
        /5回生成/
    );
});

test("履歴の保存と読み込み", async () => {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "saboteso-history-")
    );

    const filePath = path.join(
        tempDir,
        "data",
        "history.json"
    );

    try {
        assert.deepEqual(history.loadHistory(filePath), []);

        const entry = await history.preparePost(
            [],
            "slot1",
            async () => sample
        );

        assert.ok(entry);

        history.saveHistory([entry], filePath);

        assert.deepEqual(
            history.loadHistory(filePath),
            [entry]
        );

        fs.writeFileSync(
            filePath,
            '{ "unexpected": true }'
        );

        assert.throws(
            () => history.loadHistory(filePath),
            /形式が不正/
        );
    } finally {
        fs.rmSync(tempDir, {
            recursive: true,
            force: true,
        });
    }
});