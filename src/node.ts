/** Optional adapter-node shutdown registration; production Workers need no Node host. */
import process from "node:process";

/** Register graceful disposal and return a listener-removal function for HMR. */
export function registerNodeLifecycle(owner: { dispose(): Promise<void> }): () => void {
	const shutdown = () => owner.dispose();
	process.on("sveltekit:shutdown", shutdown);
	return () => process.off("sveltekit:shutdown", shutdown);
}
