import type { PageServerLoad } from "./$types";
import { readPrivate } from "../../private.server";
import { Redacted, Effect } from "effect";
import { effect, read } from "../../effect.server";
import { remoteThing } from "./thing.remote";

// Contextual route typing must survive the adapter, including route-specific params.
export const load = effect.handler((event) =>
	Effect.gen(function* () {
		const config = readPrivate();
		const remote = yield* Effect.promise(() => remoteThing());
		return {
			id: event.params.id,
			identity: yield* read,
			remote,
			port: Redacted.value(config.PORT),
			secret: JSON.stringify(config.SECRET),
		};
	}),
) satisfies PageServerLoad;
