/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const AudioRecordingWorklet = `
class AudioProcessingWorklet extends AudioWorkletProcessor {

  // バッファサイズを4096に増加（16kHzで約4倍の安定性）
  buffer = new Int16Array(4096);

  // current write index
  bufferWriteIndex = 0;
  
  // エラー発生時のリトライカウンター
  retryCount = 0;
  maxRetries = 3;
  
  // 処理中フラグ
  isProcessing = false;

  // バッファ送信のしきい値（バッファサイズの割合）
  sendThreshold = 0.75;

  constructor() {
    super();
    this.hasAudio = false;
  }

  /**
   * @param inputs Float32Array[][] [input#][channel#][sample#] so to access first inputs 1st channel inputs[0][0]
   * @param outputs Float32Array[][]
   */
  process(inputs, outputs, parameters) {
    try {
      if (inputs[0]?.length) {
        const channel0 = inputs[0][0];
        if (channel0 && channel0.length > 0) {
          this.processChunk(channel0);
        }
      }
    } catch (error) {
      console.error('Audio processing error:', error);
      // エラー発生時もtrueを返して処理を継続
    }
    return true;
  }

  sendAndClearBuffer(){
    if (this.isProcessing) return; // 既に処理中なら重複実行を防止
    
    try {
      this.isProcessing = true;
      
      // バッファにデータがある場合のみ送信
      if (this.bufferWriteIndex > 0) {
        try {
          this.port.postMessage({
            event: "chunk",
            data: {
              int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
            },
          });
          this.bufferWriteIndex = 0;
          this.retryCount = 0; // 成功したらリトライカウンターをリセット
        } catch (error) {
          console.error('Error sending audio buffer:', error);
          this.retryCount++;
          
          // リトライ回数が上限を超えた場合はバッファをクリア
          if (this.retryCount > this.maxRetries) {
            console.warn('Max retries exceeded, clearing buffer');
            this.bufferWriteIndex = 0;
            this.retryCount = 0;
          }
        }
      }
    } catch (error) {
      console.error('Send buffer error:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  processChunk(float32Array) {
    try {
      const l = float32Array.length;
      
      for (let i = 0; i < l; i++) {
        // convert float32 -1 to 1 to int16 -32768 to 32767
        const int16Value = float32Array[i] * 32768;
        this.buffer[this.bufferWriteIndex++] = int16Value;
        if(this.bufferWriteIndex >= this.buffer.length) {
          this.sendAndClearBuffer();
        }
      }

      // バッファが一定量たまったら送信（バッファサイズの75%以上）
      if(this.bufferWriteIndex >= this.buffer.length * this.sendThreshold) {
        this.sendAndClearBuffer();
      }
    } catch (error) {
      console.error('Process chunk error:', error);
      // エラー発生時はバッファをクリア
      this.bufferWriteIndex = 0;
    }
  }
}
`;

export default AudioRecordingWorklet;
