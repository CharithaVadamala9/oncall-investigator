import { handle as handleFrontend } from "./frontend";
import type { HopResult } from "./payment-service";

export interface ChainResult {
  traceId: string;
  frontend: HopResult;
}

export async function runChainOnce(env: Env): Promise<ChainResult> {
  const traceId = crypto.randomUUID();
  const frontend = await handleFrontend(env, traceId);
  return { traceId, frontend };
}
