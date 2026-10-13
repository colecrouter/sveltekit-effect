import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import type { RequestEvent } from "@sveltejs/kit";

const ambient = vi.hoisted(() => ({
	get: () => {
		throw new Error("No request");
	},
}));
vi.mock("$app/server", () => ({ getRequestEvent: () => ambient.get() }));
import { BoundaryClosed, createIntegration } from "../src/server.js";

class Database extends Context.Service<Database, { identity: object }>()("test/Database") {}
class Auth extends Context.Service<Auth, string>()("test/Auth") {}

const event = (): Pick<RequestEvent, "locals" | "request"> => ({
	locals: {},
	request: new Request("https://example.test"),
});
const identity = Effect.gen(function* () {
	return (yield* Database).identity;
});

describe("request execution and explicit retention", () => {
	it("shares retained acquisition across concurrent requests and closes once after drain", async () => {
		const integration = createIntegration();
		let acquisitions = 0;
		let releases = 0;
		const layer = integration.retain(
			Layer.effect(
				Database,
				Effect.acquireRelease(
					Effect.sync(() => {
						acquisitions++;
						return { identity: {} };
					}),
					() =>
						Effect.sync(() => {
							releases++;
						}),
				),
			),
		);
		const values = await Promise.all(
			[event(), event()].map((request) =>
				integration.runRequest(request, () =>
					integration.effect.for(request)(identity.pipe(Effect.provide(layer))),
				),
			),
		);
		expect(values[0]).toBe(values[1]);
		expect(acquisitions).toBe(1);
		expect(releases).toBe(0);
		await integration.dispose();
		await integration.dispose();
		expect(releases).toBe(1);
	});

	it("keeps ordinary provided acquisition local and explicit provision overrides defaults", async () => {
		const integration = createIntegration();
		let releases = 0;
		const defaults = Layer.succeed(Auth, "default");
		const run = integration.effect.withDefaults(defaults);
		const request = event();
		await integration.runRequest(request, async () => {
			const bound = run.for(request);
			expect(await bound(Effect.service(Auth))).toBe("default");
			expect(
				await bound(Effect.service(Auth).pipe(Effect.provide(Layer.succeed(Auth, "explicit")))),
			).toBe("explicit");
			const local = Layer.effect(
				Database,
				Effect.acquireRelease(Effect.succeed({ identity: {} }), () =>
					Effect.sync(() => {
						releases++;
					}),
				),
			);
			await bound(identity.pipe(Effect.provide(local)));
			expect(releases).toBe(1);
		});
		await integration.dispose();
	});

	it("binds derived remote events through shared locals and preserves concurrent request context", async () => {
		const storage = new AsyncLocalStorage<Pick<RequestEvent, "locals" | "request">>();
		ambient.get = () => storage.getStore() as never;
		const integration = createIntegration();
		const first = event();
		const second = event();
		const handler = integration.effect.handler((value: string) => Effect.succeed(value));
		const results = await Promise.all(
			[first, second].map((request, index) =>
				integration.runRequest(request, () =>
					storage.run({ ...request }, async () => {
						await Promise.resolve();
						return handler(String(index));
					}),
				),
			),
		);
		expect(results).toEqual(["0", "1"]);
		await integration.dispose();
	});

	it("interrupts detached work and waits for its finalizer before releasing the request", async () => {
		const integration = createIntegration();
		const entered = Promise.withResolvers<void>();
		let finalized = false;
		const request = event();
		let captured: ReturnType<typeof integration.effect.for> | undefined;
		await integration.runRequest(request, async () => {
			captured = integration.effect.for(request);
			void captured(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							finalized = true;
						}),
					);
					entered.resolve();
					return yield* Effect.never;
				}).pipe(Effect.scoped),
			).catch(() => undefined);
			await entered.promise;
		});
		expect(finalized).toBe(true);
		await expect(captured!(Effect.void)).rejects.toBeInstanceOf(BoundaryClosed);
		await integration.dispose();
	});

	it("closes retained dependencies even after acquisition failure", async () => {
		const integration = createIntegration();
		let releases = 0;
		const resource = Layer.effect(
			Auth,
			Effect.acquireRelease(Effect.succeed("auth"), () =>
				Effect.sync(() => {
					releases++;
				}),
			),
		);
		const failure = integration.retain(
			Layer.effect(
				Database,
				Effect.gen(function* () {
					yield* Auth;
					return yield* Effect.fail("acquisition failed");
				}),
			).pipe(Layer.provide(resource)),
		);
		const request = event();
		await expect(
			integration.runRequest(request, () =>
				integration.effect.for(request)(identity.pipe(Effect.provide(failure))),
			),
		).rejects.toBe("acquisition failed");
		await integration.dispose();
		expect(releases).toBe(1);
	});
});

describe("application shutdown and request cancellation", () => {
	it("waits for ordinary handler work before releasing retained resources", async () => {
		const integration = createIntegration();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const order: string[] = [];
		const resource = integration.retain(
			Layer.effect(
				Auth,
				Effect.acquireRelease(Effect.succeed("owned"), () =>
					Effect.sync(() => {
						order.push("release");
					}),
				),
			),
		);
		const request = event();
		const running = integration.runRequest(request, async () => {
			await integration.effect.for(request)(Effect.service(Auth).pipe(Effect.provide(resource)));
			entered.resolve();
			await finish.promise;
			order.push("handler");
		});
		await entered.promise;
		const disposal = integration.dispose();
		expect(integration.dispose()).toBe(disposal);
		await Promise.resolve();
		expect(order).toEqual([]);
		await expect(integration.runRequest(event(), () => Promise.resolve())).rejects.toBeInstanceOf(
			BoundaryClosed,
		);
		finish.resolve();
		await running;
		await disposal;
		expect(order).toEqual(["handler", "release"]);
	});

	it("propagates request abort through Effect finalization", async () => {
		const integration = createIntegration();
		const controller = new AbortController();
		const request = {
			locals: {},
			request: new Request("https://example.test", { signal: controller.signal }),
		};
		const entered = Promise.withResolvers<void>();
		let finalized = false;
		const running = integration.runRequest(request, () =>
			integration.effect.for(request)(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							finalized = true;
						}),
					);
					entered.resolve();
					return yield* Effect.never;
				}).pipe(Effect.scoped),
			),
		);
		// Attach an observer before cancellation rejects the handler Promise.
		const rejected = expect(running).rejects.toBeDefined();
		await entered.promise;
		controller.abort();
		await rejected;
		expect(finalized).toBe(true);
		await integration.dispose();
	});

	it("shares dependencies between separately retained closed graphs", async () => {
		const integration = createIntegration();
		let acquisitions = 0;
		const shared = Layer.effect(
			Database,
			Effect.sync(() => {
				acquisitions++;
				return { identity: {} };
			}),
		);
		const first = integration.retain(shared);
		const second = integration.retain(
			Layer.effect(
				Auth,
				Effect.gen(function* () {
					yield* Database;
					return "auth";
				}),
			).pipe(Layer.provide(shared)),
		);
		const request = event();
		await integration.runRequest(request, async () => {
			const run = integration.effect.for(request);
			await run(identity.pipe(Effect.provide(first)));
			await run(Effect.service(Auth).pipe(Effect.provide(second)));
		});
		expect(acquisitions).toBe(1);
		await integration.dispose();
	});
});
