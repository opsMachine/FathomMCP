import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;

let cached: FeatureExtractionPipeline | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (cached) return cached;
  cached = (await pipeline("feature-extraction", EMBED_MODEL, {
    quantized: true,
  })) as FeatureExtractionPipeline;
  return cached;
}

export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const model = await getEmbedder();
  const output = await model(texts, { pooling: "mean", normalize: true });
  const dim = EMBED_DIM;
  const data = output.data as Float32Array;
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(Array.from(data.slice(i * dim, (i + 1) * dim)));
  }
  return result;
}
