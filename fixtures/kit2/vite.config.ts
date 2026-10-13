import { sveltekit } from "@sveltejs/kit/vite";
export default async () => ({ plugins: await sveltekit() });
