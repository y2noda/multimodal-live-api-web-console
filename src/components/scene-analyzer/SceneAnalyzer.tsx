import { FFmpeg } from "@ffmpeg/ffmpeg";
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { AudioRecorder } from "../../lib/audio-recorder";
import type { ToolCall } from "../../multimodal-live-types";
import { analyzeSceneSummary } from "../../utils/gemini-api";
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
}

interface SceneAnalysisState {
    scenes: SceneInfo[];
    currentIndex: number;
    processingStatus: ProcessingStatus;
    summary?: string;
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
                description: "ユーザーとの対話に基づくシーンの説明",
            },
            should_move: {
                type: SchemaType.BOOLEAN,
                description:
                    "シーンを移動するべきかどうか。trueの場合、target_scene_indexが指定されていればそのシーンへ、指定がなければ次のシーンへ移動します。ユーザーから十分に情報を得られていない場合はfalseを返してください。",
            },
            target_scene_index: {
                type: SchemaType.NUMBER,
                description:
                    "移動先のシーンのインデックス（0から始まる）。should_moveがtrueの場合のみ使用され、指定がない場合は次のシーンに移動します。有効な範囲は0からシーン数-1までです。",
            },
            is_analysis_complete: {
                type: SchemaType.BOOLEAN,
                description:
                    "現在のシーンの分析が完了したかどうか。trueの場合、現在のシーンの分析が完了したことを示し、自動的に次のシーンへ移動します。ユーザーから十分に情報を得られていない場合はfalseを返してください。",
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

    // 分析状態チェックのヘルパー関数を追加
    const getAnalysisStatus = useCallback((state: SceneAnalysisState) => {
        const currentScene = state.scenes[state.currentIndex];
        const isAllAnalyzed =
            state.analysisStatus.analyzedScenes.size ===
            state.analysisStatus.totalScenes;
        const isCurrentSceneAnalyzed = currentScene?.isAnalyzed ?? false;

        return {
            currentScene,
            isAllAnalyzed,
            isCurrentSceneAnalyzed,
            nextUnanalyzedIndex: state.scenes.findIndex(
                (scene) => !scene.isAnalyzed
            ),
        };
    }, []);

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
    const [isRecording, setIsRecording] = useState(false);

    // 既存のstate定義の下に追加
    const [originalVideo, setOriginalVideo] = useState<string | null>(null);
    const originalVideoRef = useRef<HTMLVideoElement>(null);

    // blobUrlsをrefとして保持
    const blobUrls = useRef<Map<number, string>>(new Map());

    // ドラッグ&ドロップの状態管理を追加
    const [isDragging, setIsDragging] = useState(false);

    // 要約生成中の状態を追加
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);

    // 新しいstate変数を追加
    const [isSummaryDrawerOpen, setIsSummaryDrawerOpen] = useState(false);

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
                        text: "あなたは動画分析の対話アシスタントです。ユーザーと対話しながら、各シーンの内容について詳しく分析してください。ユーザーからの質問に答え、重要な要素について説明を促してください。",
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

                    // 自動移動の条件を確認
                    const shouldAutoMove =
                        args.should_move || args.is_analysis_complete;

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
        const onData = (base64: string) => {
            if (isRecording) {
                client.sendRealtimeInput([
                    {
                        mimeType: "audio/pcm;rate=16000",
                        data: base64,
                    },
                ]);
            }
        };

        if (isRecording) {
            audioRecorder.on("data", onData).start();
        } else {
            audioRecorder.stop();
        }

        return () => {
            audioRecorder.off("data", onData);
        };
    }, [isRecording, client, audioRecorder]);

    // シーン検出処理
    const detectScenes = useCallback(
        async (videoFile: File): Promise<SceneInfo[]> => {
            const inputFileName = "input.mp4";
            const scenes: SceneInfo[] = [];

            try {
                console.log("シーン検出開始:", videoFile.name);

                // FFmpegの初期化
                if (!ffmpeg.loaded) {
                    console.log("FFmpegを読み込み中...");
                    await ffmpeg.load();
                    console.log("FFmpeg読み込み完了");
                }

                // 動画ファイルを書き込み
                console.log("動画ファイルを変換中...");
                const videoData = await videoFile.arrayBuffer();
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

                return scenes;
            } catch (error) {
                console.error("シーン検出処理でエラーが発生しました:", error);
                console.log("エラー詳細:", {
                    error,
                    stack: error instanceof Error ? error.stack : undefined,
                    message:
                        error instanceof Error ? error.message : String(error),
                });
                return [
                    {
                        blob: videoFile,
                        startTime: 0,
                        endTime: 0,
                        isAnalyzed: false,
                    },
                ];
            }
        },
        []
    );

    const extractTimestamps = (log: string): number[] => {
        const timestamps = new Set<number>();
        const regex = /pts_time:(\d+\.\d+)/g;
        let match: RegExpExecArray | null;

        let result = regex.exec(log);
        while (result !== null) {
            timestamps.add(Number(result[1]));
            result = regex.exec(log);
        }

        return Array.from(timestamps).sort((a, b) => a - b);
    };

    // ファイルアップロードのハンドラーを修正
    const handleVideoUpload = useCallback(
        async (file: File) => {
            if (!file) return;

            try {
                // 既存の状態をリセット
                setState({
                    scenes: [],
                    currentIndex: 0,
                    processingStatus: {
                        isVideoProcessing: true,
                        isAnalyzing: false,
                    },
                    analysisStatus: {
                        analyzedScenes: new Set(),
                        totalScenes: 0,
                    },
                });

                // 既存のBlobURLsをクリーンアップ
                for (const url of blobUrls.current.values()) {
                    URL.revokeObjectURL(url);
                }
                blobUrls.current.clear();

                // 元の動画のURLを更新
                if (originalVideo) {
                    URL.revokeObjectURL(originalVideo);
                }
                const videoUrl = URL.createObjectURL(file);
                setOriginalVideo(videoUrl);

                const scenes = await detectScenes(file);

                setState({
                    scenes,
                    currentIndex: 0,
                    processingStatus: {
                        isVideoProcessing: false,
                        isAnalyzing: false,
                    },
                    analysisStatus: {
                        analyzedScenes: new Set(),
                        totalScenes: scenes.length,
                    },
                });
            } catch (error) {
                console.error("シーン分割処理でエラーが発生しました:", error);
                setState((prev) => ({
                    ...prev,
                    processingStatus: {
                        ...prev.processingStatus,
                        isVideoProcessing: false,
                        isAnalyzing: false,
                    },
                }));
            }
        },
        [originalVideo, detectScenes]
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
                handleVideoUpload(file);
            }
        },
        [handleVideoUpload]
    );

    // シーン変更時の処理を修正
    const handleSceneChange = useCallback(
        (index: number) => {
            setState((prev) => {
                const nextScene = prev.scenes[index];

                // 分析中の場合は移動をブロック
                if (prev.processingStatus.isAnalyzing) {
                    return prev;
                }

                // 新しいシーンに移動し、未分析の場合は分析を開始
                const updatedState = {
                    ...prev,
                    currentIndex: index,
                    processingStatus: {
                        ...prev.processingStatus,
                        isAnalyzing: !nextScene.isAnalyzed && connected,
                    },
                };

                if (connected && !nextScene.isAnalyzed) {
                    client.send([
                        {
                            text: `このシーンについて説明してください。これは${
                                prev.scenes.length
                            }シーン中の${index + 1}番目のシーンです。`,
                        },
                    ]);

                    return {
                        ...updatedState,
                        ...updateAnalysisStatus(prev, index, false),
                    };
                }

                return updatedState;
            });
        },
        [client, connected, updateAnalysisStatus]
    );

    // コンポーネントのクリーンアップ
    useEffect(() => {
        return () => {
            for (const url of blobUrls.current.values()) {
                URL.revokeObjectURL(url);
            }
        };
    }, []);

    // getBlobUrl関数を追加
    const getBlobUrl = (scene: SceneInfo, index: number): string => {
        if (!blobUrls.current.has(index)) {
            const blob = new Blob([scene.blob], { type: "video/mp4" });
            blobUrls.current.set(index, URL.createObjectURL(blob));
        }
        return blobUrls.current.get(index) || "";
    };

    // ファイル入力のハンドラーを追加
    const handleFileInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) {
                handleVideoUpload(file);
            }
            // 同じファイルを再度選択できるようにinputをリセット
            e.target.value = "";
        },
        [handleVideoUpload]
    );

    // ボタンの表示状態を管理する関数を追加
    const getSummaryButtonState = () => {
        if (isGeneratingSummary) {
            return {
                icon: <div className="loading-spinner" />,
                text: "要約生成中",
                disabled: true,
            };
        }

        if (!state.scenes.every((scene) => scene.isAnalyzed)) {
            return {
                icon: (
                    <span className="material-symbols-outlined">
                        hourglass_empty
                    </span>
                ),
                text: "分析完了後に要約",
                disabled: true,
            };
        }

        if (state.summary) {
            return {
                icon: (
                    <span className="material-symbols-outlined">
                        visibility
                    </span>
                ),
                text: "要約を表示",
                disabled: false,
            };
        }

        return {
            icon: <span className="material-symbols-outlined">summarize</span>,
            text: "要約を生成",
            disabled: false,
        };
    };

    // 要約の表示処理
    const handleShowSummary = useCallback(() => {
        setIsSummaryDrawerOpen(true);
    }, []);

    // 要約の生成処理
    const handleGenerateSummary = useCallback(async () => {
        try {
            setIsGeneratingSummary(true);

            const sceneSummaries = state.scenes
                .map(
                    (scene, index) =>
                        `シーン${index + 1}（${scene.startTime}秒 - ${
                            scene.endTime
                        }秒）: ${scene.description || "説明なし"}`
                )
                .join("\n\n");

            const apiKey = process.env.REACT_APP_GEMINI_API_KEY;
            if (!apiKey) {
                throw new Error("GEMINI_API_KEY が設定されていません。");
            }

            const summary = await analyzeSceneSummary(apiKey, sceneSummaries);
            setState((prev) => ({ ...prev, summary }));
            setIsSummaryDrawerOpen(true);
        } catch (error) {
            console.error("シーン分析の要約に失敗しました:", error);
        } finally {
            setIsGeneratingSummary(false);
        }
    }, [state.scenes]);

    // 要約の再生成処理を追加
    const handleRegenerateSummary = useCallback(async () => {
        try {
            setIsGeneratingSummary(true);

            // 既存の要約をクリア
            setState((prev) => ({ ...prev, summary: undefined }));

            const sceneSummaries = state.scenes
                .map(
                    (scene, index) =>
                        `シーン${index + 1}（${scene.startTime}秒 - ${
                            scene.endTime
                        }秒）: ${scene.description || "説明なし"}`
                )
                .join("\n\n");

            const apiKey = process.env.REACT_APP_GEMINI_API_KEY;
            if (!apiKey) {
                throw new Error("GEMINI_API_KEY が設定されていません。");
            }

            const summary = await analyzeSceneSummary(apiKey, sceneSummaries);
            setState((prev) => ({ ...prev, summary }));
        } catch (error) {
            console.error("シーン分析の要約の再生成に失敗しました:", error);
        } finally {
            setIsGeneratingSummary(false);
        }
    }, [state.scenes]);

    return (
        <div className="scene-analyzer">
            <div
                className={`upload-area ${isDragging ? "dragging" : ""} ${
                    state.processingStatus.isVideoProcessing ? "processing" : ""
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    type="file"
                    accept="video/*"
                    onChange={handleFileInputChange}
                    disabled={state.processingStatus.isVideoProcessing}
                    id="video-upload"
                    className="hidden-input"
                />
                <label htmlFor="video-upload" className="upload-label">
                    <span className="material-symbols-outlined upload-icon">
                        upload_file
                    </span>
                    <div className="upload-text">
                        {state.processingStatus.isVideoProcessing ? (
                            <>
                                <div className="loading-spinner" />
                                <p>動画を処理中...</p>
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
                        <video
                            ref={videoRef}
                            src={getBlobUrl(
                                state.scenes[state.currentIndex],
                                state.currentIndex
                            )}
                            controls
                            autoPlay
                            muted
                            onEnded={() => {
                                if (
                                    state.currentIndex <
                                        state.scenes.length - 1 &&
                                    state.scenes[state.currentIndex].isAnalyzed
                                ) {
                                    handleSceneChange(state.currentIndex + 1);
                                }
                            }}
                        >
                            <track kind="captions" />
                        </video>

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

                        <button
                            type="button"
                            className="nav-button summary-button"
                            onClick={
                                state.summary
                                    ? handleShowSummary
                                    : handleGenerateSummary
                            }
                            disabled={getSummaryButtonState().disabled}
                        >
                            {getSummaryButtonState().icon}
                            {getSummaryButtonState().text}
                        </button>
                    </div>
                </div>
            )}

            {/* サマリードロワー */}
            <div
                className={`summary-drawer ${
                    isSummaryDrawerOpen ? "open" : ""
                }`}
            >
                <div className="summary-drawer-header">
                    <h3>動画全体の要約</h3>
                    <div className="drawer-actions">
                        {state.summary && (
                            <button
                                type="button"
                                className="action-button regenerate-button"
                                onClick={handleRegenerateSummary}
                                disabled={isGeneratingSummary}
                            >
                                {isGeneratingSummary ? (
                                    <div className="loading-spinner" />
                                ) : (
                                    <span className="material-symbols-outlined">
                                        refresh
                                    </span>
                                )}
                            </button>
                        )}
                        <button
                            type="button"
                            className="action-button close-button"
                            onClick={() => setIsSummaryDrawerOpen(false)}
                        >
                            <span className="material-symbols-outlined">
                                close
                            </span>
                        </button>
                    </div>
                </div>
                <div className="summary-content">
                    {isGeneratingSummary ? (
                        <div className="generating-message">
                            <div className="loading-spinner" />
                            <p>要約を生成中...</p>
                        </div>
                    ) : state.summary ? (
                        <p>{state.summary}</p>
                    ) : (
                        <p className="no-summary">
                            要約はまだ生成されていません
                        </p>
                    )}
                </div>
            </div>

            {/* オーバーレイ */}
            {isSummaryDrawerOpen && (
                <div
                    className="overlay"
                    onClick={() => setIsSummaryDrawerOpen(false)}
                    onKeyPress={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            setIsSummaryDrawerOpen(false);
                        }
                    }}
                    role="button"
                    tabIndex={0}
                />
            )}
        </div>
    );
}

export const SceneAnalyzer = memo(SceneAnalyzerComponent);
