/** Compile-time contract checks are never executed as runtime regression tests. */
import { Context, Effect, Layer } from "effect";
import { createIntegration } from "../src/server.js";
class Database extends Context.Service<Database, string>()("types/Database") {}
class Auth extends Context.Service<Auth, string>()("types/Auth") {}
const integration = createIntegration();
const runner = integration.effect.withDefaults(Layer.succeed(Database, "database"));
export function verifyTypes() {
	// Both TypeScript and Effect must reject this deliberately unsupplied requirement.
	// @ts-expect-error No default service supplies Auth.
	// @effect-diagnostics-next-line missingEffectContext:off
	void runner(Effect.service(Auth));
	void runner(Effect.service(Database));
	void runner(Effect.service(Auth).pipe(Effect.provideService(Auth, "auth")));
	const open = Layer.effect(Database, Effect.service(Auth));
	// @ts-expect-error Retention must never capture a request construction dependency.
	// @effect-diagnostics-next-line missingLayerContext:off
	integration.retain(open);
	// @ts-expect-error Default construction also requires a closed Layer.
	// @effect-diagnostics-next-line missingLayerContext:off
	runner.withDefaults(open);
}

// Parsed types and optional properties survive adaptation without a second schema.
import { privateEnv } from "../src/config.js";
import { Redacted } from "effect";
const config = privateEnv(() => ({
	PORT: 3000,
	TOKEN: undefined as string | undefined,
	EXISTING: Redacted.make(123),
}));
const port: Redacted.Redacted<number> = config.PORT;
const token: Redacted.Redacted<string> | undefined = config.TOKEN;
const existing: Redacted.Redacted<number> = config.EXISTING;
export const typeProof = { port, token, existing };

const optional = privateEnv((): { TOKEN?: string } => ({}));
const optionalToken: Redacted.Redacted<string> | undefined = optional.TOKEN;
export const optionalTypeProof = optionalToken;
