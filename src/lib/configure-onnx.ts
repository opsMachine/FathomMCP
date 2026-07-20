import { env } from "@xenova/transformers";
import * as ONNX_NODE from "onnxruntime-node";

const ONNX = (ONNX_NODE as { default?: typeof ONNX_NODE }).default ?? ONNX_NODE;

let configured = false;

/**
 * Cap native ONNX memory use before @xenova/transformers loads a session.
 * Xenova 2.x only passes executionProviders to InferenceSession.create;
 * we patch create so every session gets conservative thread/arena settings.
 */
export function configureOnnxRuntime(): void {
  if (configured) return;
  configured = true;

  process.env.OMP_NUM_THREADS ??= process.env.EMBED_INTRA_OP_THREADS ?? "1";
  process.env.OPENBLAS_NUM_THREADS ??= "1";
  process.env.MKL_NUM_THREADS ??= "1";

  const intra = Number(process.env.EMBED_INTRA_OP_THREADS ?? "1");
  const inter = Number(process.env.EMBED_INTER_OP_THREADS ?? "1");
  const enableArena = process.env.EMBED_CPU_MEM_ARENA === "1";

  const { InferenceSession } = ONNX;
  if (!InferenceSession?.create) {
    console.warn("configureOnnxRuntime: InferenceSession unavailable — skipping patch");
    configured = true;
    return;
  }
  const originalCreate = InferenceSession.create.bind(InferenceSession);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (InferenceSession as any).create = async (
    arg: Parameters<typeof InferenceSession.create>[0],
    options?: Parameters<typeof InferenceSession.create>[1]
  ) =>
    originalCreate(arg, {
      ...(options ?? {}),
      executionProviders: ["cpu"],
      executionMode: "sequential",
      intraOpNumThreads: intra,
      interOpNumThreads: inter,
      enableCpuMemArena: enableArena,
      enableMemPattern: false,
      graphOptimizationLevel: "basic",
    });

  const wasm = env.backends?.onnx?.wasm as { numThreads?: number } | undefined;
  if (wasm) wasm.numThreads = 1;
}
