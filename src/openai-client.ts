type JsonSchemaFormat = {
	name: string;
	schema: Record<string, unknown>;
	strict?: boolean;
};

type OpenAiRequestOptions = {
	model?: string;
	tools?: { type: "web_search" }[];
	jsonSchema?: JsonSchemaFormat;
	fetchImplementation?: typeof fetch;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

type ResponsesApiResponse = {
	output?: Array<{
		type?: string;
		content?: Array<{
			type?: string;
			text?: string;
		}>;
	}>;
	error?: {
		message?: string;
		code?: string | null;
	};
};

class OpenAiRequestError extends Error {
	constructor(
		message: string,
		readonly httpStatus: number | undefined,
		readonly apiCode: string | undefined,
	) {
		super(message);
		this.name = "OpenAiRequestError";
	}
}

function sanitizeDiagnostic(value: string, apiKey: string): string {
	return value
		.replaceAll(apiKey, "[REDACTED]")
		.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:sk|rk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
		.replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*)["']?[^\s,"']+/gi, "$1[REDACTED]")
		.slice(0, 500);
}

function getRequestTimeoutMs(tools?: OpenAiRequestOptions["tools"]): number {
	const usesWebSearch = tools?.some((tool) => tool.type === "web_search") ?? false;
	const environmentName = usesWebSearch ? "OPENAI_WEB_SEARCH_TIMEOUT_MS" : "OPENAI_REQUEST_TIMEOUT_MS";
	const defaultTimeout = usesWebSearch ? DEFAULT_WEB_SEARCH_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
	const configuredTimeout = process.env[environmentName];
	if (configuredTimeout === undefined) return defaultTimeout;

	const timeout = Number(configuredTimeout);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
		throw new Error(`${environmentName} は1から${MAX_TIMEOUT_MS}までのミリ秒で指定してください。`);
	}
	return timeout;
}

async function requestOpenAi(input: string, options: OpenAiRequestOptions = {}): Promise<string> {
	const apiKey = process.env.OPENAI_API_KEY;
	const model = options.model ?? process.env.OPENAI_MODEL;
	if (!apiKey || !model) {
		throw new Error("OPENAI_API_KEY と OPENAI_MODEL を環境変数に設定してください。");
	}

	const requestBody: Record<string, unknown> = { model, input };
	if (options.tools) requestBody.tools = options.tools;
	if (options.jsonSchema) {
		requestBody.text = {
			format: {
				type: "json_schema",
				name: options.jsonSchema.name,
				strict: options.jsonSchema.strict ?? true,
				schema: options.jsonSchema.schema,
			},
		};
	}

	let response: Response;
	try {
		response = await (options.fetchImplementation ?? fetch)("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(getRequestTimeoutMs(options.tools)),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new OpenAiRequestError(`OpenAI API通信に失敗しました: ${sanitizeDiagnostic(message, apiKey)}`, undefined, undefined);
	}

	let result: ResponsesApiResponse;
	try {
		result = (await response.json()) as ResponsesApiResponse;
	} catch {
		throw new OpenAiRequestError(
			response.ok ? "OpenAI APIの応答をJSONとして読み取れません。" : "OpenAI APIエラー応答をJSONとして読み取れません。",
			response.status,
			undefined,
		);
	}

	if (!response.ok) {
		const message = result.error?.message ?? `OpenAI APIエラー (${response.status})`;
		const code = result.error?.code ?? undefined;
		throw new OpenAiRequestError(
			sanitizeDiagnostic(message, apiKey),
			response.status,
			code ? sanitizeDiagnostic(code, apiKey) : undefined,
		);
	}

	const outputText = result.output
		?.filter((item) => item.type === "message")
		.flatMap((item) => item.content ?? [])
		.filter((item) => item.type === "output_text")
		.map((item) => item.text ?? "")
		.join("")
		.trim();
	if (!outputText) {
		throw new Error("OpenAI APIの出力テキストが空です。");
	}

	return outputText;
}

export = { requestOpenAi, OpenAiRequestError, getRequestTimeoutMs };