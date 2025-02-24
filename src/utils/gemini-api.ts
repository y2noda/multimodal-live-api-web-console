import { GoogleGenerativeAI } from "@google/generative-ai";

// Geminiモデルを初期化する関数
function initializeGeminiModel(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
}

// シーン分析結果を送信する関数
export async function analyzeSceneSummary(
    apiKey: string,
    sceneSummaries: string
): Promise<string> {
    try {
        const model = initializeGeminiModel(apiKey);
        const prompt = `以下の動画シーンの分析結果から、動画全体の流れを要約してください：\n\n${sceneSummaries}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("シーン分析の要約中にエラーが発生しました:", error);
        throw error;
    }
}
