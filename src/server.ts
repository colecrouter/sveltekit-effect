/** Effect execution with explicit provision and SvelteKit-owned request lifetimes. */

import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { getRequestEvent } from "$app/server";
import { withSvelteKitTracing } from "./otel.js";

/** A bound event preserves framework span access on platforms without async context. */
export type ExecutionEvent = Pick<RequestEvent, "locals"> & Partial<Pick<RequestEvent, "tracing">>;

/** Execution cannot start once its owner has begun closing. */
export class BoundaryClosed extends Error {
	constructor() {
		super("The Effect execution boundary is closed");
		this.name = "BoundaryClosed";
	}
}

/** A runner permits only requirements supplied by its selected default Layer. */
export interface EffectRunner<Services = never> {
	<A, E>(program: Effect.Effect<A, E, Services>): Promise<A>;
	/** Bind before awaiting when ambient request context is unavailable. */
	for(event: ExecutionEvent): EffectRunner<Services>;
	/** Return a new runner; defaults do not change resource ownership. */
	withDefaults<R, E>(layer: Layer.Layer<R, E, never>): EffectRunner<Services | R>;
	/** Capture the request at callback entry and preserve the callback arguments. */
	handler<Args extends ReadonlyArray<unknown>, A, E>(
		callback: (...args: Args) => Effect.Effect<A, E, Services>,
	): (...args: Args) => Promise<A>;
}

/** A host decorator captures tracing or logging context immediately before scheduling. */
export interface IntegrationOptions {
	readonly decorate?: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

type ExecutionBoundary = {
	readonly controller: AbortController;
	readonly pending: Set<Promise<void>>;
	readonly completion: Promise<void>;
	close(): void;
};

/** Retention and request execution are independent of the application's service graph. */
export function createIntegration(options: IntegrationOptions = {}) {
	// Derived remote events share locals, whereas event object identity changes.
	const boundaries = new WeakMap<object, ExecutionBoundary>();
	const active = new Set<ExecutionBoundary>();
	const memoMap = Layer.makeMemoMapUnsafe();
	const retained = new Set<{ dispose(): Promise<void> }>();
	let closing = false;
	let disposal: Promise<void> | undefined;

	const requireBoundary = (event: ExecutionEvent) => {
		const boundary = boundaries.get(event.locals);
		if (closing || !boundary || boundary.controller.signal.aborted) throw new BoundaryClosed();
		return boundary;
	};

	const makeRunner = <Services>(
		defaults: Layer.Layer<Services, unknown, never>,
		bound?: {
			readonly boundary: ExecutionBoundary;
			readonly event: ExecutionEvent;
		},
	): EffectRunner<Services> => {
		const run = <A, E>(program: Effect.Effect<A, E, Services>): Promise<A> => {
			// Capture ambient SvelteKit and tracing context before Effect schedules work.
			const event = bound?.event ?? getRequestEvent();
			const boundary = bound?.boundary ?? requireBoundary(event);
			if (closing || boundary.controller.signal.aborted)
				return Promise.reject(new BoundaryClosed());
			const supplied = withSvelteKitTracing(Effect.provide(program, defaults), event);
			const decorated = options.decorate ? options.decorate(supplied) : supplied;
			const promise = Effect.runPromise(decorated, {
				signal: boundary.controller.signal,
			});
			// Observe rejection immediately while returning the original Promise to callers.
			const completion = promise.then(
				() => undefined,
				() => undefined,
			);
			boundary.pending.add(completion);
			void completion.then(() => boundary.pending.delete(completion));
			return promise;
		};
		return Object.assign(run, {
			for: (event: ExecutionEvent) =>
				makeRunner(defaults, { boundary: requireBoundary(event), event }),
			withDefaults: <R, E>(layer: Layer.Layer<R, E, never>) =>
				makeRunner(Layer.merge(defaults, layer), bound),
			handler:
				<Args extends ReadonlyArray<unknown>, A, E>(
					callback: (...args: Args) => Effect.Effect<A, E, Services>,
				) =>
				(...args: Args) => {
					const event = bound?.event ?? getRequestEvent();
					const runner = makeRunner(defaults, bound ?? { boundary: requireBoundary(event), event });
					return runner(callback(...args));
				},
		});
	};

	const effect = makeRunner(Layer.empty);

	/** Retain only closed graphs so acquisition cannot capture the first request. */
	const retain = <R, E>(layer: Layer.Layer<R, E, never>): Layer.Layer<R, E, never> => {
		if (closing) throw new BoundaryClosed();
		// Native runtimes own acquisition fibers and finalizers; one memo map shares
		// repeated dependencies between retained graphs, without sharing request inputs.
		const runtime = ManagedRuntime.make(layer, { memoMap });
		retained.add(runtime);
		return Layer.fromBuild(() =>
			Effect.suspend(() => (closing ? Effect.die(new BoundaryClosed()) : runtime.contextEffect)),
		);
	};

	/** Wrap downstream hooks and handlers, including their ordinary awaited Promises. */
	const runRequest = async <A>(
		event: Pick<RequestEvent, "locals" | "request">,
		operation: () => Promise<A>,
	): Promise<A> => {
		if (closing || event.request.signal.aborted) throw new BoundaryClosed();
		if (boundaries.has(event.locals))
			throw new Error("An Effect boundary already owns this request");
		const completion = Promise.withResolvers<void>();
		const controller = new AbortController();
		const boundary: ExecutionBoundary = {
			controller,
			pending: new Set(),
			completion: completion.promise,
			close: () => controller.abort(),
		};
		const abort = () => boundary.close();
		event.request.signal.addEventListener("abort", abort, { once: true });
		boundaries.set(event.locals, boundary);
		active.add(boundary);
		try {
			return await operation();
		} finally {
			// Streaming is deliberately excluded: handler completion interrupts detached work.
			boundary.close();
			event.request.signal.removeEventListener("abort", abort);
			await Promise.all(boundary.pending);
			active.delete(boundary);
			completion.resolve();
		}
	};

	/** Stop admission, drain requests, then release retained resources exactly once. */
	const dispose = (): Promise<void> => {
		if (disposal) return disposal;
		closing = true;
		// Publish the Promise before abort can synchronously reenter disposal.
		const deferred = Promise.withResolvers<void>();
		disposal = deferred.promise;
		const requests = [...active];
		for (const request of requests) request.close();
		void (async () => {
			await Promise.all(requests.map((request) => request.completion));
			// Attempt every release even if a preceding retained graph fails to close.
			const results = await Promise.allSettled(
				[...retained].reverse().map((runtime) => runtime.dispose()),
			);
			const failures = results
				.filter((result) => result.status === "rejected")
				.map((result) => result.reason);
			if (failures.length) throw new AggregateError(failures, "Retained service disposal failed");
		})().then(deferred.resolve, deferred.reject);
		return disposal;
	};

	/** Structural hook typing works across Kit 2 and Kit 3's moved hook types. */
	const handle = ({
		event,
		resolve,
	}: {
		event: RequestEvent;
		resolve: (event: RequestEvent) => Response | Promise<Response>;
	}): Promise<Response> => runRequest(event, () => Promise.resolve(resolve(event)));

	return { effect, retain, runRequest, handle, dispose };
}
