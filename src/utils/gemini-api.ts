import { GoogleGenerativeAI } from "@google/generative-ai";

// Geminiモデルを初期化する関数
function initializeGeminiModel(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

// シーン情報の型定義
interface SceneData {
    index: number;
    startTime: number;
    endTime: number;
    description: string;
    imageBase64?: string;
}

// シーン分析結果を送信する関数
export async function analyzeSceneSummary(
    apiKey: string,
    sceneSummaries: string,
    sceneImages?: SceneData[]
): Promise<string> {
    try {
        const model = initializeGeminiModel(apiKey);
        
        if (sceneImages && sceneImages.length > 0) {
            // 画像と説明を含めたマルチモーダルリクエストを作成
            const parts = [];
            
            // テキストプロンプトを追加
            parts.push({
                text: `以下の動画シーンの分析結果と各シーンのキーフレームから、動画全体の流れを要約してください。各シーンの視覚的な特徴も考慮して詳細に説明してください：\n\n${sceneSummaries}`
            });
            
            // 各シーンの画像を追加
            for (const scene of sceneImages) {
                if (scene.imageBase64) {
                    parts.push({
                        inlineData: {
                            data: scene.imageBase64,
                            mimeType: "image/jpeg"
                        }
                    });
                    parts.push({
                        text: `シーン${scene.index + 1}（${scene.startTime}秒 - ${scene.endTime}秒）のキーフレーム: ${scene.description}`
                    });
                }
            }
            
            const result = await model.generateContent({
                contents: [{ role: "user", parts }]
            });
            const response = await result.response;
            console.log('summary', response.text());

            return response.text();
        } else {
            // 従来のテキストのみのリクエスト
            const prompt = `以下の動画シーンの分析結果から、動画全体の流れを要約してください：\n\n${sceneSummaries}`;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        }
    } catch (error) {
        console.error("シーン分析の要約中にエラーが発生しました:", error);
        throw error;
    }
}

// 要約からエッセイ風の文章を生成する関数
export async function generateEssayFromSummary(
    apiKey: string,
    summary: string,
    style: string = "一般的",
    length: string = "中程度"
): Promise<string> {
    try {
        const model = initializeGeminiModel(apiKey);
        
        // エッセイ生成のためのプロンプト
        const prompt = `
あなたは優れた文章家です。以下の動画要約を元に、個人的な日記やSNS投稿のような親しみやすいエッセイを生成してください。

【文体スタイル】: ${style}
【文章の長さ】: ${length}

【動画要約】:
${summary}

以下の点に注意して執筆してください：
1. 一人称視点で、個人的な体験や感想として書く
2. 家族や友人との交流、日常の出来事を中心に描写する
3. 感情や思い出を自然に織り交ぜる
4. 短めの段落で読みやすく構成する
5. 写真や場所への言及を含める
6. 将来への期待や希望で締めくくる
7. 動画の各シーンに含まれる詳細な情報（人物、場所、活動、感情、天候、時間帯など）を豊かに表現する
8. 五感（視覚、聴覚、触覚、味覚、嗅覚）を使った描写を取り入れる

文章の構成：
- 導入部：体験の背景や状況を簡潔に説明する
- 展開部：体験の詳細、感情の変化、気づきなどを描写する
- 結論部：体験から得た学びや将来への展望を述べる

文体は親しみやすく、読者が自分の体験として共感できるような表現を心がけてください。
段落は短めにし、読みやすさを重視してください。
写真や訪れた場所についての言及を自然に織り込んでください。

このような日記風のエッセイを生成してください。`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("エッセイ風文章の生成中にエラーが発生しました:", error);
        throw error;
    }
}

// シーン分析から要約とエッセイを同時に生成する関数
export async function generateSummaryAndEssay(
    apiKey: string,
    sceneSummaries: string,
    style: string = "一般的",
    length: string = "中程度",
    sceneImages?: SceneData[]
): Promise<{ summary: string; essay: string }> {
    try {
        const model = initializeGeminiModel(apiKey);
        
        // まず要約を生成
        let summary: string;
        
        if (sceneImages && sceneImages.length > 0) {
            // 画像と説明を含めたマルチモーダルリクエストを作成
            const parts = [];
            
            // テキストプロンプトを追加
            parts.push({
                text: `以下の動画シーンの分析結果と各シーンのキーフレームから、動画全体の流れを要約してください。各シーンの視覚的な特徴も考慮して詳細に説明してください。人物、場所、活動内容、感情表現、天候、時間帯、色彩、音声など、できるだけ多くの情報を含めてください：\n\n${sceneSummaries}`
            });
            
            // 各シーンの画像を追加
            for (const scene of sceneImages) {
                if (scene.imageBase64) {
                    parts.push({
                        inlineData: {
                            data: scene.imageBase64,
                            mimeType: "image/jpeg"
                        }
                    });
                    parts.push({
                        text: `シーン${scene.index + 1}（${scene.startTime}秒 - ${scene.endTime}秒）のキーフレーム: ${scene.description}`
                    });
                }
            }
            
            const result = await model.generateContent({
                contents: [{ role: "user", parts }]
            });
            const response = await result.response;
            summary = response.text();
        } else {
            // 従来のテキストのみのリクエスト
            const prompt = `以下の動画シーンの分析結果から、動画全体の流れを要約してください。人物、場所、活動内容、感情表現、天候、時間帯、色彩、音声など、できるだけ多くの情報を含めてください：\n\n${sceneSummaries}`;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            summary = response.text();
        }
        
        // 次に要約からエッセイを生成
        const essayPrompt = `
あなたは優れた文章家です。以下の動画要約を元に、個人的な日記やSNS投稿のような親しみやすいエッセイを生成してください。

【文体スタイル】: ${style}
【文章の長さ】: ${length}

【動画要約】:
${summary}

以下の点に注意して執筆してください：
1. 一人称視点で、個人的な体験や感想として書く
2. 家族や友人との交流、日常の出来事を中心に描写する
3. 感情や思い出を自然に織り交ぜる
4. 短めの段落で読みやすく構成する
5. 写真や場所への言及を含める
6. 将来への期待や希望で締めくくる
7. 動画の各シーンに含まれる詳細な情報（人物、場所、活動、感情、天候、時間帯など）を豊かに表現する
8. 五感（視覚、聴覚、触覚、味覚、嗅覚）を使った描写を取り入れる

文章の構成：
- 導入部：体験の背景や状況を簡潔に説明する
- 展開部：体験の詳細、感情の変化、気づきなどを描写する
- 結論部：体験から得た学びや将来への展望を述べる

文体は親しみやすく、読者が自分の体験として共感できるような表現を心がけてください。
段落は短めにし、読みやすさを重視してください。
写真や訪れた場所についての言及を自然に織り込んでください。

このような日記風のエッセイを生成してください。`;

        const essayResult = await model.generateContent(essayPrompt);
        const essayResponse = await essayResult.response;
        const essay = essayResponse.text();
        
        return { summary, essay };
    } catch (error) {
        console.error("要約とエッセイの生成中にエラーが発生しました:", error);
        throw error;
    }
}
