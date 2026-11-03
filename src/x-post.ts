import crypto = require("node:crypto");

type XCredentials = {
	apiKey: string;
	apiSecret: string;
	accessToken: string;
	accessTokenSecret: string;
};

type CreatePostResponse = {
	data?: {
		id?: string;
		text?: string;
	};
};

const endpoint = "https://api.x.com/2/tweets";
const DEFAULT_POST_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function getPostTimeoutMs(): number {
	const configuredTimeout = process.env.X_POST_TIMEOUT_MS;
	if (configuredTimeout === undefined) return DEFAULT_POST_TIMEOUT_MS;
	const timeout = Number(configuredTimeout);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
		throw new Error(`X_POST_TIMEOUT_MS は1から${MAX_TIMEOUT_MS}までのミリ秒で指定してください。`);
	}
	return timeout;
}

function encodeOAuthValue(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function createAuthorizationHeader(credentials: XCredentials): string {
	const oauthParameters: Record<string, string> = {
		oauth_consumer_key: credentials.apiKey,
		oauth_nonce: crypto.randomBytes(16).toString("hex"),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
		oauth_token: credentials.accessToken,
		oauth_version: "1.0",
	};

	const normalizedParameters = Object.entries(oauthParameters)
		.map(([key, value]) => [encodeOAuthValue(key), encodeOAuthValue(value)] as const)
		.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
		)
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const signatureBase = ["POST", encodeOAuthValue(endpoint), encodeOAuthValue(normalizedParameters)].join("&");
	const signingKey = `${encodeOAuthValue(credentials.apiSecret)}&${encodeOAuthValue(credentials.accessTokenSecret)}`;
	oauthParameters.oauth_signature = crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");

	const headerParameters = Object.entries(oauthParameters)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${encodeOAuthValue(key)}="${encodeOAuthValue(value)}"`)
		.join(", ");

	return `OAuth ${headerParameters}`;
}

function getCredentials(): XCredentials {
	const credentials = {
		apiKey: process.env.X_API_KEY,
		apiSecret: process.env.X_API_SECRET,
		accessToken: process.env.X_ACCESS_TOKEN,
		accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
	};

	if (Object.values(credentials).some((value) => !value)) {
		throw new Error(
			"X_API_KEY、X_API_SECRET、X_ACCESS_TOKEN、X_ACCESS_TOKEN_SECRET を環境変数に設定してください。",
		);
	}

	return credentials as XCredentials;
}

async function postTweet(tweetText: string, fetchImplementation: typeof fetch = fetch): Promise<CreatePostResponse["data"]> {
	if (!tweetText.trim()) {
		throw new Error("投稿文が空です。");
	}

	const credentials = getCredentials();
	const response = await fetchImplementation(endpoint, {
		method: "POST",
		headers: {
			Authorization: createAuthorizationHeader(credentials),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ text: tweetText }),
		signal: AbortSignal.timeout(getPostTimeoutMs()),
	});

	if (!response.ok) {
		throw new Error(`X APIへの投稿に失敗しました (HTTP ${response.status})`);
	}

	const result = (await response.json()) as CreatePostResponse;
	if (!result.data?.id || !result.data.text) {
		throw new Error("X APIの応答に投稿データが含まれていません。");
	}

	return result.data;
}

export = { postTweet, getPostTimeoutMs };