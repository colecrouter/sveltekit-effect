/** Bridge raw environment strings without replacing Kit 3's typed configuration. */
import { ConfigProvider, Layer, Redacted } from "effect";

/** Produce a native provider for consumers that parse configuration outside Effects. */
export function configProvider(read: () => Record<string, string | undefined>) {
	return ConfigProvider.fromEnv({
		env: Object.fromEntries(
			Object.entries(read()).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
	});
}

/** Read raw values at acquisition; parsed Kit configuration should use a typed service. */
export function configLayer(read: () => Record<string, string | undefined>) {
	return Layer.suspend(() => ConfigProvider.layer(configProvider(read)));
}

/** Preserve optionality and preexisting Redacted values while wrapping defined inputs. */
export type PrivateEnvironment<T extends Record<string, unknown>> = {
	readonly [K in keyof T]: T[K] extends infer V
		? V extends undefined
			? undefined
			: V extends Redacted.Redacted<unknown>
				? V
				: Redacted.Redacted<V>
		: never;
};

/** Adapt a private source without re-parsing Kit 3 values or copying its env schema. */
export function privateEnv<T extends Record<string, unknown>>(
	read: () => T,
): PrivateEnvironment<T> {
	// Read at consumption, not module import: dynamic private variables can be
	// initialized by the adapter later. Keep absence distinct from a wrapped value.
	const entries = Object.entries(read()).map(([key, value]) => [
		key,
		value === undefined || Redacted.isRedacted(value) ? value : Redacted.make(value),
	]);
	// The mapping preserves the supplied env object's string keys and optionality;
	// TypeScript cannot infer that relationship through Object.fromEntries.
	return Object.fromEntries(entries) as PrivateEnvironment<T>;
}
