import * as tf from '@tensorflow/tfjs';
import * as cocossd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs-backend-webgpu'; // Must import to register the backend

async function setupAI() {
  // 1. Force the WebGPU backend
  await tf.setBackend('webgpu');
  
  // 2. Ready the hardware
  await tf.ready();
  
  console.log("Active Backend:", tf.getBackend()); 
  // Should print 'webgpu'. If it says 'cpu' or 'webgl', the T1000 isn't being hit.
}

export interface AIResult {
  detections: cocossd.DetectedObject[];
  metrics: {
    inferenceTime: number; 
    fps: number;           
    modelName: string;     
  };
}

/**
 * RESEARCH PIPELINE: runBenchmark
 * Measures the speed/accuracy trade-off for any input.
 */
export async function runBenchmark(
  model: cocossd.ObjectDetection,
  input: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
  modelLabel: string
): Promise<AIResult> {
  const t0 = performance.now();
  
  // Model inference
  const predictions = await model.detect(input as any, 5, 0.4);
  
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
 * UTILITY: Consistent Dataset Loader
 */
export async function loadImageToBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}