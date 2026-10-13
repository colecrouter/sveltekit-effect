import { Config, Effect, Redacted } from "effect";
import { expect, it } from "vite-plus/test";
import { configLayer, privateEnv } from "../src/config.js";
import { registerDevelopmentLifecycle } from "../src/dev.js";

it("reads raw configuration at Layer acquisition rather than module import", async () => {
	let environment = { PORT: "3000", MISSING: undefined };
	const layer = configLayer(() => environment);
	environment = { PORT: "4000", MISSING: undefined };
	expect(await Effect.runPromise(Config.Number("PORT").pipe(Effect.provide(layer)))).toBe(4000);
});

it("registers host-neutral development disposal without Node registration", async () => {
	let callback: (() => void | Promise<void>) | undefined;
	let disposed = false;
	registerDevelopmentLifecycle(
		{
			dispose: (dispose) => {
				callback = dispose;
			},
		},
		{
			dispose: async () => {
				disposed = true;
			},
		},
	);
	expect(disposed).toBe(false);
	await callback!();
	expect(disposed).toBe(true);
});

it("redacts every defined private value without changing parsed types or existing wrappers", () => {
	const secret = Redacted.make("already wrapped");
	const values = privateEnv(() => ({
		PORT: 4000,
		SECRET: "private",
		EXISTING: secret,
		OPTIONAL: undefined,
		SETTINGS: { enabled: true },
	}));
	expect(Redacted.value(values.PORT)).toBe(4000);
	expect(Redacted.value(values.SECRET)).toBe("private");
	expect(values.EXISTING).toBe(secret);
	expect(values.OPTIONAL).toBeUndefined();
	expect(Redacted.value(values.SETTINGS)).toEqual({ enabled: true });
	expect(JSON.stringify(values)).not.toContain("private");
	expect(JSON.stringify(values)).not.toContain("already wrapped");
});

it("reads dynamic private values at consumption and retains missing optional keys", () => {
	let value: string | undefined;
	const read = () => privateEnv(() => ({ TOKEN: value }));
	expect(read().TOKEN).toBeUndefined();
	value = "runtime value";
	expect(Redacted.value(read().TOKEN!)).toBe(value);
});
