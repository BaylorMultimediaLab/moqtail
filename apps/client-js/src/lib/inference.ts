import * as tf from '@tensorflow/tfjs';
import * as cocossd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs-backend-webgpu'; // Must import to register the backend

/**
 * 1. Unified Setup: Ensures the T1000 is ready BEFORE the model loads
 */
export async function initializeObjectDetection() {
  // Wait for WebGPU registration
  await tf.setBackend('webgpu');
  await tf.ready();
  
  console.log("T1000 WebGPU Backend Active:", tf.getBackend());

  // Only load the model AFTER tf.ready()
  const model = await cocossd.load();
  return model;
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