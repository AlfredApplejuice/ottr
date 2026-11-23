import { createPixellabQuotaAdapter } from "./serviceQuotaPixellab.ts";
import type { ServiceQuotaAdapterDefinition } from "./types.ts";

const pixellab = createPixellabQuotaAdapter();

export const builtInServiceQuotaAdapters: ReadonlyMap<
	string,
	ServiceQuotaAdapterDefinition
> = new Map([[pixellab.id, pixellab]]);
