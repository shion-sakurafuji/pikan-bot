
type HistoricalEvent = {
    year: number;
    text: string;
    source: string;
};

type WikipediaResponse = {
    events: {
        year: number;
        text: string;
    }[];
};

async function getHistoricalEvents(
    month: number,
    day: number,
    year: number
): Promise<HistoricalEvent[]> {
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");

    const url =
        `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`歴史情報の取得失敗: ${response.status}`);
    }

    const data = (await response.json()) as WikipediaResponse;

    return data.events
        .filter(event => event.year === year)
        .map(event => ({
            year: event.year,
            text: event.text,
            source: url
        }));
}

export = { getHistoricalEvents };
