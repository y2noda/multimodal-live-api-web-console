import { FFmpeg } from "@ffmpeg/ffmpeg";
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { AudioRecorder } from "../../lib/audio-recorder";
import type { LiveConfig, ToolCall } from "../../multimodal-live-types";
import { generateSummaryAndEssay } from "../../utils/gemini-api";
import "./scene-analyzer.scss";

interface SceneInfo {
    blob: Blob;
    startTime: number;
    endTime: number;
    description?: string;
    isAnalyzed: boolean;
}

interface AnalysisStatus {
    analyzedScenes: Set<number>;
    totalScenes: number;
}

interface ProcessingStatus {
    isVideoProcessing: boolean;
    isAnalyzing: boolean;
    isProcessing?: boolean;
    processingMessage?: string;
}

interface SceneAnalysisState {
    scenes: SceneInfo[];
    currentIndex: number;
    processingStatus: ProcessingStatus;
    summary?: string;
    essay?: string;
    analysisStatus: AnalysisStatus;
}

const ffmpeg = new FFmpeg();

const sceneAnalysisDeclaration: FunctionDeclaration = {
    name: "analyze_scene",
    description: "ユーザーとの対話を通じて動画シーンの分析を行います",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            scene_index: {
                type: SchemaType.NUMBER,
                description:
                    "現在分析中のシーンのインデックス（0から始まる）。このパラメータは現在のシーンを示すだけで、移動先の指定には使用されません。",
            },
            scene_description: {
                type: SchemaType.STRING,
                description: "ユーザーとの対話に基づくシーンの説明。人物、場所、活動内容、感情表現、天候、時間帯、色彩、音声など、できるだけ多くの情報を含めてください。また、五感（視覚、聴覚、触覚、味覚、嗅覚）を使った描写も取り入れると、より豊かな表現になります。",
            },
            should_move: {
                type: SchemaType.BOOLEAN,
                description:
                    "シーンを移動するべきかどうか。trueの場合のみ、次のシーンに移動します。ユーザーとの対話が十分に行われ、ユーザーが次のシーンに移動する準備ができたと判断した場合にのみtrueを返してください。それ以外の場合は必ずfalseを返してください。",
            },
            target_scene_index: {
                type: SchemaType.NUMBER,
                description:
                    "移動先のシーンのインデックス（0から始まる）。should_moveがtrueの場合のみ使用され、指定がない場合は次のシーンに移動します。有効な範囲は0からシーン数-1までです。",
            },
            is_analysis_complete: {
                type: SchemaType.BOOLEAN,
                description:
                    "現在のシーンの分析が完了したかどうか。trueの場合、現在のシーンの分析が完了したことを示しますが、自動的に次のシーンへ移動するわけではありません。シーンの移動はshould_moveパラメータによって制御されます。ユーザーから十分に情報を得られていない場合はfalseを返してください。",
            },
        },
        required: [
            "scene_index",
            "scene_description",
            "should_move",
            "is_analysis_complete",
        ],
    },
};

function SceneAnalyzerComponent() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const { client, setConfig, connected } = useLiveAPIContext();

    const [state, setState] = useState<SceneAnalysisState>({
        scenes: [],
        currentIndex: 0,
        processingStatus: {
            isVideoProcessing: false,
            isAnalyzing: false,
        },
        analysisStatus: {
            analyzedScenes: new Set(),
            totalScenes: 0,
        },
    });

    const [audioRecorder] = useState(() => new AudioRecorder());

    // 既存のstate定義の下に追加
    const [originalVideo, setOriginalVideo] = useState<string | null>(null);
    const originalVideoRef = useRef<HTMLVideoElement>(null);

    // blobUrlsをrefとして保持
    const blobUrls = useRef<Map<number, string>>(new Map());

    // ドラッグ&ドロップの状態管理を追加
    const [isDragging, setIsDragging] = useState(false);
    
    // 要約とエッセイを同時に生成中の状態
    const [isGeneratingBoth, setIsGeneratingBoth] = useState(false);
    
    // エッセイスタイルの選択肢
    const [essayStyle, setEssayStyle] = useState("一般的");
    
    // エッセイの長さの選択肢
    const [essayLength, setEssayLength] = useState("中程度");
    
    // エッセイドロワーの状態
    const [isEssayDrawerOpen, setIsEssayDrawerOpen] = useState(false);

    // FFmpegの初期化
    useEffect(() => {
        const load = async () => {
            if (!ffmpeg.loaded) {
                await ffmpeg.load();
            }
        };
        load();
    }, []);

    // Geminiの設定
    useEffect(() => {
        setConfig({
            model: "models/gemini-2.0-flash-exp",
            generationConfig: {
                responseModalities: "audio",
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Aoede",
                        },
                    },
                },
            },
            systemInstruction: {
                parts: [
                    {
                        text: "あなたは動画分析の対話アシスタントです。ユーザーと対話しながら、各シーンの内容について詳しく分析してください。ユーザーからの質問に答え、重要な要素について説明を促してください。\n\n重要: 各シーンでは十分な対話を行ってください。ユーザーとの対話が不十分な場合は、should_moveをfalseに設定してください。is_analysis_completeはシーンの分析が完了したことを示すだけで、自動的に次のシーンに移動するわけではありません。ユーザーが次のシーンに移動する準備ができたと判断した場合のみ、should_moveをtrueに設定してください。\n\n注意: ユーザーが手動で次のシーンに移動した場合、前のシーンが分析中でなければ自動的に分析完了としてマークされます。分析中のシーンは、ユーザーが手動で移動しても自動的に分析完了としてマークされません。分析が完了していないシーンは、動画から視覚的に確認できる情報に基づいて分析が完了したとみなされます。\n\nシーン分析では、以下の要素について詳細に情報を収集してください：\n1. 人物：誰が映っているか、その表情や動作、服装など\n2. 場所：どこで撮影されているか、周囲の環境や特徴\n3. 活動内容：何をしているか、どのような行動や出来事が起きているか\n4. 感情表現：シーンから感じられる感情や雰囲気\n5. 天候・時間帯：晴れ/雨/曇り、朝/昼/夕方/夜など\n6. 色彩：主な色調や印象的な色の使い方\n7. 音声：聞こえる音や会話（ある場合）\n8. 五感的表現：視覚だけでなく、聴覚、触覚、味覚、嗅覚に関連する要素\n\nこれらの情報を総合的に収集し、scene_descriptionに詳細かつ豊かな表現で記述してください。",
                    },
                ],
            },
            tools: [{ functionDeclarations: [sceneAnalysisDeclaration] }],
        });
    }, [setConfig]);

    // 分析状態を更新するヘルパー関数
    const updateAnalysisStatus = useCallback(
        (
            prevState: SceneAnalysisState,
            sceneIndex: number,
            isComplete: boolean,
            description?: string
        ): Partial<SceneAnalysisState> => {
            const analyzedScenes = new Set(
                prevState.analysisStatus.analyzedScenes
            );
            if (isComplete) {
                analyzedScenes.add(sceneIndex);
            }

            const updatedScenes = [...prevState.scenes];
            updatedScenes[sceneIndex] = {
                ...updatedScenes[sceneIndex],
                isAnalyzed: isComplete,
                ...(description && { description }),
            };

            return {
                scenes: updatedScenes,
                analysisStatus: {
                    analyzedScenes,
                    totalScenes: prevState.scenes.length,
                },
            };
        },
        []
    );

    // ツールコール時の処理を修正
    useEffect(() => {
        const onToolCall = async (toolCall: ToolCall) => {
            const fc = toolCall.functionCalls.find(
                (fc) => fc.name === sceneAnalysisDeclaration.name
            );

            if (fc) {
                const args = fc.args as {
                    scene_index: number;
                    scene_description: string;
                    should_move: boolean;
                    target_scene_index?: number;
                    is_analysis_complete: boolean;
                };

                setState((prev) => {
                    // 現在のシーンの状態を更新
                    const updatedState = {
                        ...prev,
                        ...updateAnalysisStatus(
                            prev,
                            prev.currentIndex,
                            args.is_analysis_complete,
                            args.scene_description
                        ),
                        processingStatus: {
                            ...prev.processingStatus,
                            isAnalyzing: false,
                        },
                    };

                    // 自動移動の条件を確認 - should_moveのみを条件とし、is_analysis_completeは無視する
                    // これにより、分析が完了しても明示的な移動指示がない限り自動的に次のシーンに移動しない
                    const shouldAutoMove = args.should_move;

                    if (shouldAutoMove) {
                        const hasTargetScene =
                            typeof args.target_scene_index === "number" &&
                            args.target_scene_index >= 0 &&
                            args.target_scene_index < prev.scenes.length;

                        // 次のシーンのインデックスを決定
                        const nextIndex =
                            hasTargetScene &&
                            args.target_scene_index !== undefined
                                ? args.target_scene_index
                                : Math.min(
                                      prev.currentIndex + 1,
                                      prev.scenes.length - 1
                                  );

                        // 次のシーンが存在し、現在のシーンと異なる場合のみ移動
                        if (nextIndex !== prev.currentIndex) {
                            console.log(`シーン${prev.currentIndex}から${nextIndex}へ移動します（should_move=${args.should_move}）`);
                            return {
                                ...updatedState,
                                currentIndex: nextIndex,
                                processingStatus: {
                                    ...updatedState.processingStatus,
                                    isAnalyzing:
                                        !prev.scenes[nextIndex].isAnalyzed &&
                                        connected,
                                },
                            };
                        }
                    } else {
                        console.log(`シーン${prev.currentIndex}の分析状態: is_analysis_complete=${args.is_analysis_complete}, should_move=${args.should_move}`);
                    }

                    return updatedState;
                });

                client.sendToolResponse({
                    functionResponses: [
                        {
                            response: { success: true },
                            id: fc.id,
                        },
                    ],
                });
            }
        };

        client.on("toolcall", onToolCall);
        return () => {
            client.off("toolcall", onToolCall);
        };
    }, [client, connected, updateAnalysisStatus]);

    // 音声録音の処理
    useEffect(() => {
        let animationFrameId: number | null = null;
        let audioBuffer: string[] = [];
        let lastSendTime = 0;
        const sendInterval = 200; // 送信間隔（ミリ秒）
        let isProcessing = false; // 処理中フラグ
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 5;
        
        // バッファリングして送信する関数
        const sendBufferedAudio = async () => {
            const currentTime = performance.now();
            
            // 送信間隔を確認し、処理中でなく、バッファにデータがある場合のみ送信
            if (!isProcessing && audioBuffer.length > 0 && (currentTime - lastSendTime >= sendInterval)) {
                isProcessing = true;
                try {
                    // バッファに溜まったデータを一度に送信
                    const combinedData = audioBuffer.join('');
                    await client.sendRealtimeInput([
                        {
                            mimeType: "audio/pcm;rate=16000",
                            data: combinedData,
                        },
                    ]);
                    lastSendTime = currentTime;
                    audioBuffer = [];
                    reconnectAttempts = 0; // 送信成功したらリセット
                } catch (error) {
                    console.error('音声データ送信エラー:', error);
                    // 接続が切れた場合は再接続を試みる
                    if (reconnectAttempts < maxReconnectAttempts) {
                        reconnectAttempts++;
                        console.log(`再接続を試みます (${reconnectAttempts}/${maxReconnectAttempts})...`);
                    }
                } finally {
                    isProcessing = false;
                }
            }
            
            // 次のフレームで再度実行（接続中の場合のみ）
            if (connected) {
                animationFrameId = requestAnimationFrame(sendBufferedAudio);
            }
        };

        const onData = (base64: string) => {
            // データをバッファに追加（バッファサイズを制限）
            if (audioBuffer.length < 50) { // 最大バッファサイズを制限
                audioBuffer.push(base64);
            }
        };

        // 接続時は常に録音を開始
        if (connected) {
            // 既存の録音を停止してからクリーンな状態で開始
            audioRecorder.stop();
            audioRecorder.off("data"); // すべてのイベントリスナーを削除
            
            setTimeout(() => {
                audioRecorder.on("data", onData).start().catch(err => {
                    console.error('録音開始エラー:', err);
                });
                // バッファリング処理を開始
                animationFrameId = requestAnimationFrame(sendBufferedAudio);
            }, 100); // 少し遅延させて確実に停止処理が完了するようにする
        } else {
            audioRecorder.stop();
            audioRecorder.off("data"); // すべてのイベントリスナーを削除
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
        }

        // 接続状態の監視
        const checkConnection = () => {
            if (connected && client.ws && client.ws.readyState !== WebSocket.OPEN) {
                console.warn('WebSocket接続が閉じられています。再接続を試みます...');
                // 再接続処理
                try {
                    // 現在の設定を取得
                    const currentConfig = client.getConfig();
                    if (currentConfig?.model) {
                        // 既存の接続を閉じる
                        client.disconnect();
                        // 少し待ってから再接続
                        setTimeout(async () => {
                            try {
                                // 型アサーションを使用して型エラーを解決
                                await client.connect(currentConfig as LiveConfig);
                                console.log('WebSocket再接続成功');
                                // 録音を再開
                                audioRecorder.stop();
                                setTimeout(() => {
                                    audioRecorder.on("data", onData).start().catch(err => {
                                        console.error('録音再開エラー:', err);
                                    });
                                }, 100);
                            } catch (error) {
                                console.error('WebSocket再接続失敗:', error);
                            }
                        }, 1000);
                    }
                } catch (error) {
                    console.error('再接続処理エラー:', error);
                }
            }
        };
        
        // 定期的に接続状態をチェック
        const connectionCheckInterval = setInterval(checkConnection, 5000);

        return () => {
            audioRecorder.off("data", onData);
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            clearInterval(connectionCheckInterval);
        };
    }, [connected, client, audioRecorder]);

    // シーンを検出する関数
    const detectScenes = useCallback(async (file: File): Promise<{ scenes: SceneInfo[], duration: number }> => {
        const inputFileName = "input.mp4";
        const scenes: SceneInfo[] = [];

        try {
            console.log("シーン検出開始:", file.name);

            // FFmpegの初期化
            if (!ffmpeg.loaded) {
                console.log("FFmpegを読み込み中...");
                await ffmpeg.load();
                console.log("FFmpeg読み込み完了");
            }

            // 動画ファイルを書き込み
            console.log("動画ファイルを変換中...");
            const videoData = await file.arrayBuffer();
            const videoUint8Array = new Uint8Array(videoData);
            console.log("ファイルサイズ:", videoUint8Array.length, "bytes");
            await ffmpeg.writeFile(inputFileName, videoUint8Array);
            console.log("動画ファイル変換完了");

            // 動画の長さを取得
            console.log("動画の長さを取得中...");
            let durationOutput = "";
            ffmpeg.on("log", ({ message }) => {
                durationOutput += `${message}\n`;
                console.log("FFmpeg log:", message);
            });

            await ffmpeg.exec(["-i", inputFileName]);
            const durationMatch = durationOutput.match(
                /Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/
            );
            const duration = durationMatch
                ? Number.parseInt(durationMatch[1]) * 3600 +
                  Number.parseInt(durationMatch[2]) * 60 +
                  Number.parseFloat(durationMatch[3])
                : 0;
            console.log("動画の長さ:", duration, "秒");

            // シーン検出を実行
            console.log("シーン検出実行中...");
            let sceneOutput = "";
            ffmpeg.on("log", ({ message }) => {
                sceneOutput = `${sceneOutput}${message}\n`;
                console.log("FFmpeg log:", message);
            });

            await ffmpeg.exec([
                "-i",
                inputFileName,
                "-vf",
                "select='gt(scene,0.4)',showinfo",
                "-f",
                "null",
                "-",
            ]);

            // タイムスタンプを抽出
            const timestamps = extractTimestamps(sceneOutput);
            console.log("検出されたタイムスタンプ:", timestamps);

            // シーンの開始・終了時間を計算
            const sceneTimings =
                timestamps.length > 0
                    ? [0, ...timestamps, duration]
                    : [0, duration];
            console.log("シーンの区切り:", sceneTimings);

            // 各シーンを抽出
            for (let i = 0; i < sceneTimings.length - 1; i++) {
                const startTime = sceneTimings[i];
                const endTime = sceneTimings[i + 1];
                if (endTime <= startTime) continue; // 無効なシーンをスキップ

                const outputFileName = `scene_${i}.mp4`;
                console.log(
                    `シーン${i + 1}を抽出中:`,
                    startTime,
                    "->",
                    endTime
                );

                try {
                    await ffmpeg.exec([
                        "-i",
                        inputFileName,
                        "-ss",
                        startTime.toString(),
                        "-to",
                        endTime.toString(),
                        "-c",
                        "copy",
                        outputFileName,
                    ]);

                    const data = await ffmpeg.readFile(outputFileName);
                    const blob = new Blob([data], { type: "video/mp4" });
                    scenes.push({
                        blob,
                        startTime,
                        endTime,
                        isAnalyzed: false,
                    });
                    console.log(`シーン${i + 1}の抽出完了`);
                } catch (e) {
                    console.error(`シーン${i + 1}の抽出に失敗:`, e);
                } finally {
                    try {
                        await ffmpeg.deleteFile(outputFileName);
                    } catch {}
                }
            }

            return { scenes, duration };
        } catch (error) {
            console.error("シーン検出処理でエラーが発生しました:", error);
            console.log("エラー詳細:", {
                error,
                stack: error instanceof Error ? error.stack : undefined,
                message:
                    error instanceof Error ? error.message : String(error),
            });
            return { scenes: [], duration: 0 };
        }
    }, []);

    const extractTimestamps = (log: string): number[] => {
        const timestamps = new Set<number>();
        const regex = /pts_time:(\d+\.\d+)/g;

        let result = regex.exec(log);
        while (result !== null) {
            timestamps.add(Number(result[1]));
            result = regex.exec(log);
        }

        return Array.from(timestamps).sort((a, b) => a - b);
    };

    // getBlobUrl関数を追加
    const getBlobUrl = useCallback((scene: SceneInfo, index: number): string => {
        try {
            if (!blobUrls.current.has(index)) {
                if (!scene || !scene.blob) {
                    console.error(`シーン${index}のBlobが存在しません`);
                    return "";
                }
                const blob = new Blob([scene.blob], { type: "video/mp4" });
                const url = URL.createObjectURL(blob);
                blobUrls.current.set(index, url);
                console.log(`シーン${index}のBlobURL作成: ${url}`);
            }
            return blobUrls.current.get(index) || "";
        } catch (error) {
            console.error(`シーン${index}のBlobURL作成に失敗:`, error);
            return "";
        }
    }, []);

    // ビデオファイルを処理する関数
    const processVideoFile = useCallback(
        async (file: File) => {
            try {
                setState((prev) => ({
                    ...prev,
                    processingStatus: {
                        ...prev.processingStatus,
                        isVideoProcessing: true,
                        isProcessing: true,
                        processingMessage: "ビデオを処理中...",
                    },
                }));

                // 既存のBlobURLをクリーンアップ
                for (const url of blobUrls.current.values()) {
                    URL.revokeObjectURL(url);
                }
                blobUrls.current.clear();

                // 元の動画のBlobURLを作成
                const originalVideoUrl = URL.createObjectURL(file);
                setOriginalVideo(originalVideoUrl);

                // FFmpegを使用してシーンを検出
                const result = await detectScenes(file);
                const scenes = result.scenes;
                const duration = result.duration;

                if (scenes.length === 0) {
                    throw new Error("シーンを検出できませんでした");
                }

                // 各シーンのBlobURLを事前に作成
                scenes.forEach((scene: SceneInfo, index: number) => {
                    if (scene?.blob) {
                        try {
                            getBlobUrl(scene, index);
                        } catch (error) {
                            console.error(`シーン${index}のBlobURL作成に失敗:`, error);
                        }
                    }
                });

                setState((prev) => ({
                    ...prev,
                    scenes,
                    currentIndex: 0,
                    videoDuration: duration,
                    processingStatus: {
                        ...prev.processingStatus,
                        isVideoProcessing: false,
                        isProcessing: false,
                        processingMessage: "",
                    },
                }));

                // 最初のシーンの分析を自動的に開始
                if (scenes.length > 0 && connected) {
                    console.log("最初のシーンの分析を自動的に開始します");
                    client.send([
                        {
                            text: `このシーンについて説明してください。これは${scenes.length}シーン中の1番目のシーンです。シーンの内容を詳しく分析し、重要な要素について説明してください。ユーザーとの対話を通じて分析を深めてください。十分な対話が行われるまで次のシーンには移動しないでください。`,
                        },
                    ]);
                    
                    setState(prev => ({
                        ...prev,
                        processingStatus: {
                            ...prev.processingStatus,
                            isAnalyzing: true,
                        },
                    }));
                    
                    // 音声録音を確実に開始
                    audioRecorder.stop();
                    setTimeout(() => {
                        // 音声録音の再開はuseEffectで行われるため、ここでは明示的に接続状態を更新するだけ
                        
                        // 接続状態を一度リセットして再接続を促す（useEffectのconnected依存配列をトリガー）
                        client.disconnect();
                        setTimeout(() => {
                            const currentConfig = client.getConfig();
                            if (currentConfig?.model) {
                                client.connect(currentConfig as LiveConfig).then(() => {
                                    // 再接続完了
                                }).catch(err => {
                                    console.error("音声録音のための再接続に失敗しました:", err);
                                });
                            }
                        }, 500);
                    }, 100);
                }
            } catch (error) {
                console.error("ビデオ処理エラー:", error);
                setState((prev) => ({
                    ...prev,
                    processingStatus: {
                        ...prev.processingStatus,
                        isVideoProcessing: false,
                        isProcessing: false,
                        processingMessage: `エラー: ${error instanceof Error ? error.message : "不明なエラー"}`,
                    },
                }));
            }
        },
        [detectScenes, getBlobUrl, client, connected, audioRecorder]
    );

    // ファイルアップロードのハンドラーを修正
    const handleVideoUpload = useCallback(
        async (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (!file) return;

            await processVideoFile(file);
        },
        [processVideoFile]
    );

    // ドラッグ&ドロップのハンドラー
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files[0];
            if (file?.type.startsWith("video/")) {
                processVideoFile(file);
            }
        },
        [processVideoFile]
    );

    // シーンの静止画を取得する関数
    const captureSceneImage = useCallback(async (scene: SceneInfo, index: number): Promise<string | undefined> => {
        try {
            // 一時的なビデオ要素を作成
            const tempVideo = document.createElement('video');
            tempVideo.muted = true;
            tempVideo.autoplay = false;
            
            // シーンのBlobURLを取得
            let blobUrl = getBlobUrl(scene, index);
            
            // BlobURLが無効な場合は再作成を試みる
            if (!blobUrl) {
                console.log(`シーン${index}のBlobURLが無効なため再作成します`);
                // 古いURLがあれば削除
                const oldUrl = blobUrls.current.get(index);
                if (oldUrl) {
                    URL.revokeObjectURL(oldUrl);
                    blobUrls.current.delete(index);
                }
                
                // 新しいBlobを作成
                if (scene?.blob) {
                    const newBlob = new Blob([scene.blob], { type: "video/mp4" });
                    blobUrl = URL.createObjectURL(newBlob);
                    blobUrls.current.set(index, blobUrl);
                    console.log(`シーン${index}のBlobURLを再作成しました: ${blobUrl}`);
                } else {
                    console.error(`シーン${index}のBlobが存在しないため画像を取得できません`);
                    return undefined;
                }
            }
            
            tempVideo.src = blobUrl;
            
            // ビデオの読み込みを待つ
            await new Promise((resolve, reject) => {
                tempVideo.onloadeddata = resolve;
                tempVideo.onerror = (e) => {
                    console.error(`シーン${index}のビデオ読み込みに失敗:`, e);
                    reject(e);
                };
                tempVideo.load();
            });
            
            // シーンの中間点に移動
            const midpointTime = (scene.endTime - scene.startTime) / 2;
            tempVideo.currentTime = midpointTime;
            
            // フレームが読み込まれるのを待つ
            await new Promise((resolve, reject) => {
                tempVideo.onseeked = resolve;
                tempVideo.onerror = (e) => {
                    console.error(`シーン${index}のシーク中にエラー:`, e);
                    reject(e);
                };
            });
            
            // キャンバスにフレームを描画
            const canvas = document.createElement('canvas');
            canvas.width = tempVideo.videoWidth;
            canvas.height = tempVideo.videoHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) return undefined;
            
            ctx.drawImage(tempVideo, 0, 0, canvas.width, canvas.height);
            
            // Base64形式で画像データを取得
            const base64Data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
            
            // 一時要素をクリーンアップ
            tempVideo.remove();
            
            return base64Data;
        } catch (error) {
            console.error(`シーン${index + 1}の静止画取得に失敗:`, error);
            return undefined;
        }
    }, [getBlobUrl]);

    // ファイル入力のハンドラーを追加
    const handleFileInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) {
                handleVideoUpload(e);
            }
            // 同じファイルを再度選択できるようにinputをリセット
            e.target.value = "";
        },
        [handleVideoUpload]
    );


    // 時間をフォーマットする関数
    const formatTime = useCallback((seconds: number): string => {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }, []);

    // 要約とエッセイを同時に生成する処理
    const handleGenerateSummaryAndEssay = useCallback(async () => {
        try {
            setIsGeneratingBoth(true);
            
            // 既存の要約とエッセイをクリア
            setState((prev) => ({ ...prev, essay: undefined }));
            
            // APIキーの確認
            const apiKey = process.env.REACT_APP_GEMINI_API_KEY || localStorage.getItem("GEMINI_API_KEY");
            if (!apiKey) {
                console.error("Gemini APIキーが設定されていません");
                return;
            }
            
            // シーンの要約を構築
            const sceneSummaries = state.scenes
                .filter((scene) => scene.isAnalyzed)
                .map((scene, index) => {
                    const timeFormatted = `${formatTime(scene.startTime)} - ${formatTime(scene.endTime)}`;
                    return `シーン ${index + 1} (${timeFormatted}): ${scene.description || "説明なし"}`;
                })
                .join("\n\n");
            
            // 再生成前に各シーンのBlobURLが有効であることを確認
            state.scenes.forEach((scene, index) => {
                if (scene?.blob) {
                    // BlobURLが存在しない、または無効になっている場合は再作成
                    if (!blobUrls.current.has(index) || !blobUrls.current.get(index)) {
                        try {
                            // 古いURLがあれば削除
                            const oldUrl = blobUrls.current.get(index);
                            if (oldUrl) {
                                URL.revokeObjectURL(oldUrl);
                                blobUrls.current.delete(index);
                            }
                            // 新しいURLを作成
                            getBlobUrl(scene, index);
                        } catch (error) {
                            console.error(`シーン${index}のBlobURL再作成に失敗:`, error);
                        }
                    }
                }
            });
                
            // シーンの画像を取得
            const sceneImagesData = await Promise.all(
                state.scenes
                    .filter((scene) => scene.isAnalyzed)
                    .map(async (scene, index) => {
                        const imageBase64 = await captureSceneImage(scene, index);
                        return {
                            index,
                            startTime: scene.startTime,
                            endTime: scene.endTime,
                            description: scene.description || "説明なし",
                            imageBase64
                        };
                    })
            );
            
            // 要約とエッセイを生成
            const { summary, essay } = await generateSummaryAndEssay(
                apiKey,
                sceneSummaries,
                essayStyle,
                essayLength,
                sceneImagesData
            );
            
            // 状態を更新（要約とエッセイの両方を保存）
            setState((prev) => ({ ...prev, summary, essay }));
            
            // エッセイドロワーを開く
            setIsEssayDrawerOpen(true);
        } catch (error) {
            console.error("要約とエッセイの生成に失敗しました:", error);
        } finally {
            setIsGeneratingBoth(false);
        }
    }, [state.scenes, captureSceneImage, essayStyle, essayLength, getBlobUrl, formatTime]);

    // エッセイドロワーの表示
    const renderEssayDrawer = () => {
        // クリップボードにコピーする関数
        const copyEssayToClipboard = () => {
            if (state.essay) {
                navigator.clipboard.writeText(state.essay)
                    .then(() => {
                        // コピー成功時の処理
                        const toast = document.createElement('div');
                        toast.className = 'copy-toast';
                        toast.textContent = 'エッセイをクリップボードにコピーしました';
                        document.body.appendChild(toast);
                        
                        // 3秒後にトーストを削除
                        setTimeout(() => {
                            toast.classList.add('hide');
                            setTimeout(() => {
                                document.body.removeChild(toast);
                            }, 300);
                        }, 3000);
                    })
                    .catch(err => {
                        console.error('クリップボードへのコピーに失敗しました:', err);
                        alert('コピーに失敗しました。もう一度お試しください。');
                    });
            }
        };

        return (
            <>
                {isEssayDrawerOpen && (
                    <div 
                        className="overlay" 
                        onClick={() => setIsEssayDrawerOpen(false)} 
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') setIsEssayDrawerOpen(false);
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label="エッセイを閉じる"
                    />
                )}
                <div className={`essay-drawer ${isEssayDrawerOpen ? 'open' : ''}`}>
                    <div className="essay-drawer-header">
                        <h3>エッセイ</h3>
                        <div className="drawer-actions">
                            <div className="essay-options">
                                <div className="option-group">
                                    <label htmlFor="essay-style">スタイル:</label>
                                    <select
                                        id="essay-style"
                                        value={essayStyle}
                                        onChange={(e) => setEssayStyle(e.target.value)}
                                        disabled={isGeneratingBoth}
                                    >
                                        <option value="一般的">一般的</option>
                                        <option value="物語風">物語風</option>
                                        <option value="解説風">解説風</option>
                                        <option value="詩的">詩的</option>
                                        <option value="学術的">学術的</option>
                                    </select>
                                </div>
                                <div className="option-group">
                                    <label htmlFor="essay-length">長さ:</label>
                                    <select
                                        id="essay-length"
                                        value={essayLength}
                                        onChange={(e) => setEssayLength(e.target.value)}
                                        disabled={isGeneratingBoth}
                                    >
                                        <option value="短め">短め</option>
                                        <option value="中程度">中程度</option>
                                        <option value="長め">長め</option>
                                    </select>
                                </div>
                            </div>
                            {state.essay && (
                                <button
                                    type="button"
                                    className="action-button copy-button"
                                    onClick={copyEssayToClipboard}
                                    title="クリップボードにコピー"
                                >
                                    <span className="material-symbols-outlined">content_copy</span>
                                </button>
                            )}
                            <button
                                type="button"
                                className="action-button regenerate-button"
                                onClick={handleGenerateSummaryAndEssay}
                                disabled={isGeneratingBoth}
                                title="エッセイを再生成"
                            >
                                {isGeneratingBoth ? (
                                    <div className="loading-spinner" />
                                ) : (
                                    <span className="material-symbols-outlined">refresh</span>
                                )}
                            </button>
                            <button
                                type="button"
                                className="action-button"
                                onClick={() => setIsEssayDrawerOpen(false)}
                                title="閉じる"
                            >
                                <span className="material-symbols-outlined">close</span>
                            </button>
                        </div>
                    </div>
                    <div className="essay-content">
                        {isGeneratingBoth ? (
                            <div className="generating-message">
                                <div className="loading-spinner" />
                                <p>エッセイを生成中...</p>
                            </div>
                        ) : state.essay ? (
                            <>
                                {state.essay.split('\n\n').map((paragraph, i) => (
                                    <p key={`paragraph-${i}-${paragraph.substring(0, 10)}`}>{paragraph}</p>
                                ))}
                                <div className="essay-actions">
                                    <button 
                                        type="button"
                                        className="copy-full-button"
                                        onClick={copyEssayToClipboard}
                                    >
                                        <span className="material-symbols-outlined">content_copy</span>
                                        エッセイ全文をコピー
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="no-essay">
                                エッセイはまだ生成されていません。「エッセイを生成」ボタンをクリックしてください。
                            </div>
                        )}
                    </div>
                </div>
            </>
        );
    };

    // シーン変更時の処理を修正
    const handleSceneChange = useCallback(
        (index: number) => {
            setState((prev) => {
                const nextScene = prev.scenes[index];
                if (!nextScene) {
                    console.error(`シーン${index}が存在しません`);
                    return prev;
                }

                // 事前にBlobURLを作成
                try {
                    getBlobUrl(nextScene, index);
                } catch (error) {
                    console.error(`シーン${index}のBlobURL作成に失敗:`, error);
                }

                // 前のシーンを自動的に分析完了としてマーク
                const updatedScenes = [...prev.scenes];
                const prevIndex = prev.currentIndex;
                // 前のシーンが未分析かつ分析中でない場合のみ自動的に分析完了としてマーク
                if (prevIndex !== index && !updatedScenes[prevIndex].isAnalyzed && !prev.processingStatus.isAnalyzing) {
                    console.log(`シーン${prevIndex}を自動的に分析完了としてマークします`);
                    updatedScenes[prevIndex] = {
                        ...updatedScenes[prevIndex],
                        isAnalyzed: true,
                        description: updatedScenes[prevIndex].description || `シーン${prevIndex + 1}の視覚的な内容に基づく自動分析`
                    };
                }

                // 新しいシーンに移動し、未分析の場合は分析を開始
                const updatedState = {
                    ...prev,
                    scenes: updatedScenes,
                    currentIndex: index,
                    processingStatus: {
                        ...prev.processingStatus,
                        isAnalyzing: !nextScene.isAnalyzed && connected,
                    },
                    analysisStatus: {
                        ...prev.analysisStatus,
                        analyzedScenes: new Set([...prev.analysisStatus.analyzedScenes, ...(updatedScenes[prevIndex].isAnalyzed ? [prevIndex] : [])]),
                    }
                };

                if (connected && !nextScene.isAnalyzed) {
                    client.send([
                        {
                            text: `このシーンについて説明してください。これは${
                                prev.scenes.length
                            }シーン中の${index + 1}番目のシーンです。シーンの内容を詳しく分析し、重要な要素について説明してください。ユーザーとの対話を通じて分析を深めてください。十分な対話が行われるまで次のシーンには移動しないでください。`,
                        },
                    ]);

                    return {
                        ...updatedState,
                        ...updateAnalysisStatus(updatedState, index, false),
                    };
                }

                return updatedState;
            });
        },
        [client, connected, updateAnalysisStatus, getBlobUrl]
    );

    // コンポーネントのクリーンアップ
    useEffect(() => {
    
        return () => {
            for (const url of blobUrls.current.values()) {
                URL.revokeObjectURL(url);
            }
        };
    }, []);

    // シーンが変更されたときにBlobURLを事前に作成
    useEffect(() => {
        if (state.scenes.length > 0 && state.currentIndex >= 0 && state.currentIndex < state.scenes.length) {
            const currentScene = state.scenes[state.currentIndex];
            if (currentScene?.blob) {
                try {
                    getBlobUrl(currentScene, state.currentIndex);
                } catch (error) {
                    console.error(`現在のシーン(${state.currentIndex})のBlobURL作成に失敗:`, error);
                }
            }
        }
    }, [state.scenes, state.currentIndex, getBlobUrl]);

    return (
        <div className="scene-analyzer">
            <div className="scene-analyzer-header">
                <h2>シーン分析</h2>
                <div className="scene-analyzer-actions">
                    {/* ヘッダー部分のエッセイ再表示ボタンを削除 */}
                </div>
            </div>

            <div 
                className={`upload-area ${isDragging ? "dragging" : ""} ${
                    state.processingStatus.isVideoProcessing || state.processingStatus.isProcessing ? "processing" : ""
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    type="file"
                    accept="video/*"
                    onChange={handleFileInputChange}
                    disabled={state.processingStatus.isVideoProcessing || state.processingStatus.isProcessing}
                    id="video-upload"
                    className="hidden-input"
                />
                <label htmlFor="video-upload" className="upload-label">
                    <span className="material-symbols-outlined upload-icon">
                        upload_file
                    </span>
                    <div className="upload-text">
                        {state.processingStatus.isVideoProcessing || state.processingStatus.isProcessing ? (
                            <>
                                <div className="loading-spinner" />
                                <p>{state.processingStatus.processingMessage || "動画を処理中..."}</p>
                            </>
                        ) : (
                            <>
                                <p>ここに動画をドロップ</p>
                                <p>または</p>
                                <button
                                    type="button"
                                    className="upload-button"
                                    onClick={() =>
                                        document
                                            .getElementById("video-upload")
                                            ?.click()
                                    }
                                >
                                    ファイルを選択
                                </button>
                            </>
                        )}
                    </div>
                </label>
            </div>

            <div className="video-container">
                {/* 元の動画と現在のシーンを横並びで表示 */}
                <div className="videos-row">
                    {/* 元の動画 */}
                    {originalVideo && (
                        <div className="original-video">
                            <h3>元の動画</h3>
                            <video
                                ref={originalVideoRef}
                                src={originalVideo}
                                controls
                                muted // 動画の音声をミュート
                            >
                                <track kind="captions" />
                            </video>
                        </div>
                    )}

                    {/* 現在のシーン */}
                    {state.scenes.length > 0 && (
                        <div className="scene-viewer">
                            <h3>
                                現在のシーン{" "}
                                {state.scenes[state.currentIndex].isAnalyzed
                                    ? "(分析済み)"
                                    : "(未分析)"}
                            </h3>
                            {state.scenes[state.currentIndex] && state.scenes[state.currentIndex].blob ? (
                                <video
                                    ref={videoRef}
                                    src={getBlobUrl(
                                        state.scenes[state.currentIndex],
                                        state.currentIndex
                                    )}
                                    controls
                                    autoPlay
                                    muted
                                    onError={(e) => {
                                        console.error("ビデオ読み込みエラー:", e);
                                        // エラー発生時に再度BlobURLを作成して再試行
                                        const scene = state.scenes[state.currentIndex];
                                        if (scene?.blob) {
                                            try {
                                                // 古いURLを削除
                                                const oldUrl = blobUrls.current.get(state.currentIndex);
                                                if (oldUrl) {
                                                    URL.revokeObjectURL(oldUrl);
                                                    blobUrls.current.delete(state.currentIndex);
                                                }
                                                // 新しいURLを作成
                                                const newUrl = getBlobUrl(scene, state.currentIndex);
                                                if (videoRef.current) {
                                                    videoRef.current.src = newUrl;
                                                    videoRef.current.load();
                                                }
                                            } catch (error) {
                                                console.error("ビデオ再読み込み失敗:", error);
                                            }
                                        }
                                    }}
                                />
                            ) : (
                                <div className="video-error">
                                    <p>ビデオデータを読み込めませんでした</p>
                                </div>
                            )}

                            {/* シーンの説明を表示 */}
                            {state.scenes[state.currentIndex].description && (
                                <div className="scene-description">
                                    <h4>シーンの説明</h4>
                                    <p>
                                        {
                                            state.scenes[state.currentIndex]
                                                .description
                                        }
                                    </p>
                                </div>
                            )}

                            <div className="scene-status">
                                <p>
                                    シーン {state.currentIndex + 1} /{" "}
                                    {state.scenes.length}
                                </p>
                                <p>
                                    状態:{" "}
                                    {state.processingStatus.isAnalyzing ? (
                                        <>分析中 </>
                                    ) : state.scenes[state.currentIndex]
                                          .isAnalyzed ? (
                                        state.scenes.every(
                                            (scene) => scene.isAnalyzed
                                        ) ? (
                                            "全シーン分析完了"
                                        ) : (
                                            "分析完了"
                                        )
                                    ) : (
                                        "未分析"
                                    )}
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {state.scenes.length > 0 && (
                <div className="scene-controls">
                    <button
                        type="button"
                        className="nav-button"
                        onClick={() =>
                            handleSceneChange(state.currentIndex - 1)
                        }
                        disabled={state.currentIndex === 0}
                    >
                        <span className="material-symbols-outlined">
                            navigate_before
                        </span>
                        前のシーン
                    </button>

                    <div className="scene-indicator">
                        {state.scenes.map((scene, index) => (
                            <div
                                key={`scene-${scene.startTime}-${scene.endTime}`}
                                className={`scene-dot ${
                                    index === state.currentIndex ? "active" : ""
                                } ${scene.isAnalyzed ? "analyzed" : ""}`}
                                onClick={() => handleSceneChange(index)}
                                onKeyPress={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        handleSceneChange(index);
                                    }
                                }}
                                role="button"
                                tabIndex={0}
                                title={
                                    scene.description ||
                                    (scene.isAnalyzed
                                        ? `シーン ${index + 1}`
                                        : "分析待ち")
                                }
                            />
                        ))}
                    </div>

                    <div className="scene-nav-buttons">
                        <button
                            type="button"
                            className="nav-button"
                            onClick={() =>
                                handleSceneChange(state.currentIndex + 1)
                            }
                            disabled={
                                state.currentIndex === state.scenes.length - 1
                            }
                        >
                            次のシーン
                            <span className="material-symbols-outlined">
                                navigate_next
                            </span>
                        </button>

                        {/* エッセイ再表示ボタン - エッセイが生成済みの場合に表示 */}
                        {state.essay && !isEssayDrawerOpen && (
                            <button
                                type="button"
                                className="nav-button essay-show-button"
                                onClick={() => setIsEssayDrawerOpen(true)}
                            >
                                <span className="material-symbols-outlined">
                                    visibility
                                </span>
                                エッセイを表示
                            </button>
                        )}

                        {/* エッセイ生成ボタン - エッセイがまだ生成されていない場合に表示 */}
                        {!state.essay && (
                            <button
                                type="button"
                                className="nav-button combined-button"
                                onClick={handleGenerateSummaryAndEssay}
                                disabled={
                                    !state.scenes.every((scene) => scene.isAnalyzed) || 
                                    isGeneratingBoth
                                }
                            >
                                {isGeneratingBoth ? (
                                    <>
                                        <div className="loading-spinner" />
                                        生成中...
                                    </>
                                ) : (
                                    <>
                                        <span className="material-symbols-outlined">
                                            auto_awesome
                                        </span>
                                        エッセイを生成
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* エッセイドロワー */}
            {renderEssayDrawer()}
        </div>
    );
}

export const SceneAnalyzer = memo(SceneAnalyzerComponent);

