import * as tf from '@tensorflow/tfjs';
import * as cocossd from '@tensorflow-models/coco-ssd';

export interface AIResult {
  detections: cocossd.DetectedObject[];
  metrics: {
    inferenceTime: number;
    fps: number;
    modelName: string;
  };
}

/**
 * PIPELINE: Consistent Dataset Benchmarking
 * Pass a 'testFrame' to bypass live video for controlled testing.
 */
export async function runBenchmark(
  model: cocossd.ObjectDetection,
  input: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
  modelLabel: string
): Promise<AIResult> {
  const t0 = performance.now();
  
  // Model inference
  const predictions = await model.detect(input, 5, 0.4);
  
  const delta = performance.now() - t0;

  return {
    detections: predictions,
    metrics: {
      inferenceTime: Number(delta.toFixed(2)),
      fps: Math.round(1000 / delta),
      modelName: modelLabel
    }
  };
}

/**
 * RENDERING: Draw MoQ Relay Metadata
 * This uses the 'official' data from the relay, NOT the local AI.
 */
export function drawRelayBlur(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  relayRects: Array<{ x: number, y: number, w: number, h: number }>
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  relayRects.forEach(rect => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.filter = 'blur(40px)'; // The "Official" Blur
    ctx.drawImage(video, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  });
}