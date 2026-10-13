import { defineEnvVars } from "@sveltejs/kit/env";
export const variables = defineEnvVars({
	FIXTURE_PORT: { schema: (value) => Number(value ?? "3000") },
	FIXTURE_SECRET: { schema: (value) => value ?? "fixture-secret" },
});
