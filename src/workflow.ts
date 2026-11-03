import ogiri = require("./ogiri");

type GenerateText = () => Promise<string>;
type PostText = (text: string) => Promise<unknown>;

const maxPostCharacters = 280;

async function runOgiriWorkflow(generateText: GenerateText, postText: PostText) {
	const generatedText = await generateText();
	const formattedText = ogiri.formatPostText(generatedText);
	const shouldPost = process.env.X_POST_ENABLED === "true";

	if (!shouldPost) {
		return { postText: formattedText, posted: false };
	}

	if (Array.from(formattedText).length > maxPostCharacters) {
		throw new Error(`投稿文は${maxPostCharacters}文字以内にしてください。`);
	}

	await postText(formattedText);
	return { postText: formattedText, posted: true };
}

export = { runOgiriWorkflow };