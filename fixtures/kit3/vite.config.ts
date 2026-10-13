import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-node";
export default async () => ({
	plugins: await sveltekit({
		adapter: adapter(),
		tracing: { server: true },
		experimental: { remoteFunctions: true },
	}),
});
