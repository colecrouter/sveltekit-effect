import { Context, Effect, Layer } from "effect";
import { createIntegration } from "sveltekit-effect/server";
export class Database extends Context.Service<Database, { identity: string }>()(
	"fixture/Database",
) {}
export const integration = createIntegration();
export const DatabaseLive = integration.retain(
	Layer.effect(Database, Effect.succeed({ identity: "retained" })),
);
export const effect = integration.effect.withDefaults(DatabaseLive);
export const read = Effect.gen(function* () {
	return (yield* Database).identity;
});
