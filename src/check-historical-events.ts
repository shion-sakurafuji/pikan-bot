
import historicalEvents = require("./historical-events");

async function main(): Promise<void> {
    const events = await historicalEvents.getHistoricalEvents(
        10,
        31,
        1926
    );

    console.log(`取得件数: ${events.length}`);

    for (const event of events) {
        console.log("--------------------");
        console.log(`年: ${event.year}`);
        console.log(`出来事: ${event.text}`);
        console.log(`取得元: ${event.source}`);
    }
}

main().catch(console.error);
