import { env } from "$env/dynamic/private";
import { privateEnv } from "sveltekit-effect/config";
export const readPrivate = () =>
	privateEnv(() => ({
		PORT: env.FIXTURE_PORT ?? "3000",
		SECRET: env.FIXTURE_SECRET ?? "fixture-secret",
	}));
