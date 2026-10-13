# sveltekit-effect

`sveltekit-effect` connects native Effect programs and Layers to SvelteKit's
server request lifecycle. Use it in server loads, actions, endpoints, hooks and
remote functions, while keeping service requirements visible in your Effect
types and supplying dependencies through ordinary `Effect.provide`.

A SvelteKit application often needs both long-lived services, such as a database
pool, and services specific to one request, such as an authenticated session.
The package gives those services distinct lifetimes: retain fully supplied
Layers for the application's lifetime, and provide request Layers wherever you
execute a program. Layers can come from server modules, hooks or typed locals;
the application chooses how to compose them.

`createIntegration()` provides a request hook, an Effect runner and retained
Layer ownership. Install the hook around server work, then call `effect(program)`
to await an Effect at any point in a handler. Use `effect.handler` when the whole
callback returns an Effect, or `effect.for(event)` to bind execution explicitly.
All three share the same lifecycle and dependency checks. Optional typed defaults
save repeated provision of common services without hiding an unsatisfied
requirement from TypeScript.

The integration also:

- Shares retained Layer dependencies using Effect's native memoization, and
  releases them when the integration is disposed.
- Interrupts running Effects when the request aborts or its callback finishes,
  and waits for their finalizers before completing the request boundary.
- Connects native Effect spans to SvelteKit's OpenTelemetry context when server
  tracing is enabled, using the application's existing telemetry provider.
- Offers private environment adaptation that preserves types and wraps defined
  values in `Redacted`, plus a native ConfigProvider bridge for raw env strings.
- Provides separate development HMR and adapter-node shutdown helpers.

The package wraps execution and resource ownership. Your application still
chooses its service graph, error-to-response handling, telemetry exporters and
configuration sources. Effects remain ordinary Effects, and Layers remain
ordinary Layers; no AST transform or custom Vite plugin is required.

The current implementation is validated with Effect `4.0.0`, SvelteKit
`2.66.0` and `3.0.1`. Execution is scoped to awaited server callbacks; streaming,
live queries and detached background work are outside the current lifecycle.
The server runtime uses `Promise.withResolvers`; Node deployments require Node 22
or newer, and other runtimes must provide that API.

## Getting started

```ts
// src/lib/server/effect.ts (use your application's server alias)
import { createIntegration } from "sveltekit-effect/server";
import { DatabasePoolLive } from "./database";

export const integration = createIntegration();
export const DatabaseLive = integration.retain(DatabasePoolLive);
export const effect = integration.effect.withDefaults(DatabaseLive);
```

```ts
// hooks.server.ts
import { integration } from "$lib/server/effect";
export const handle = integration.handle;
```

Compose this handle before callbacks that execute Effects using SvelteKit's
`sequence`. Retention accepts only fully supplied Layers: first-request inputs
must never become application dependencies. Default Layers also must be closed.
`withDefaults` returns a new runner and does not imply retention. Ordinary
`Effect.provide` retains its ordinary execution scope and overrides defaults.

```ts
// +page.server.ts
import type { PageServerLoad } from "./$types";
import { effect } from "$lib/server/effect";
export const load = effect.handler(({ params }) =>
	getThing(params.id).pipe(Effect.map((thing) => ({ thing }))),
) satisfies PageServerLoad;

// data.remote.ts
export const getThingRemote = query(
	IdSchema,
	effect.handler((id) => getThing(id)),
);
```

The core uses the current request only for execution ownership. Explicitly
provided Layers can come from server imports, hooks, locals or any normal Effect
composition. No public application runtime or service registry is required.

On platforms without AsyncLocalStorage, capture before any await:

```ts
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
	const run = effect.for(event);
	await somethingElse();
	return { thing: await run(getThing(event.params.id)) };
};
```

`handler` captures at callback entry. Remote events share ownership through
`locals`, not event-object identity. Calling outside an admitted request fails.
`runRequest(event, callback)` is the lower-level boundary for hosts and tests.

## Building and supplying Layers

Build services using native Effect Layers. This example assumes your database
module exports asynchronous `connectDatabase` and a `DatabaseConnection` type
with `getThing` and `close` methods:

```ts
// src/lib/server/database.ts
import { Context, Effect, Layer } from "effect";
import { connectDatabase, type DatabaseConnection } from "./database-driver";

export class Database extends Context.Service<Database, DatabaseConnection>()("app/Database") {}

export const DatabasePoolLive = Layer.effect(
	Database,
	Effect.acquireRelease(
		Effect.tryPromise(() => connectDatabase()),
		// The owning scope closes the connection, including after failed acquisition
		// of another service in the same graph.
		(database) => Effect.promise(() => database.close()),
	),
);

export const getThing = (id: string) =>
	Effect.gen(function* () {
		const database = yield* Database;
		return yield* Effect.tryPromise(() => database.getThing(id));
	});
```

Supply a service's construction dependencies before retaining it. A shared Layer
identity lets multiple retained graphs reuse its acquisition:

```ts
// ThingsLive requires Database; both retained graphs share DatabasePoolLive.
export const ThingsLive = integration.retain(
	ThingsServiceLive.pipe(Layer.provide(DatabasePoolLive)),
);
export const ReportsLive = integration.retain(
	ReportsServiceLive.pipe(Layer.provide(DatabasePoolLive)),
);
export const effect = integration.effect.withDefaults(Layer.merge(ThingsLive, ReportsLive));
```

Request services remain explicit. For example, a hook can construct a session
Layer using an application's `Session` service and store it in typed locals:

```ts
// hooks.server.ts
import { sequence } from "@sveltejs/kit/hooks";
import { Layer } from "effect";
import { integration } from "$lib/server/effect";
import { Session, readSession } from "$lib/server/session";

export const handle = sequence(integration.handle, async ({ event, resolve }) => {
	// Declare sessionLayer in App.Locals with this Layer's service type.
	event.locals.sessionLayer = Layer.succeed(Session, await readSession(event));
	return resolve(event);
});
```

```ts
// +page.server.ts
import type { PageServerLoad } from "./$types";
import { Effect } from "effect";
import { effect } from "$lib/server/effect";
import { getAccount } from "$lib/server/accounts";

export const load: PageServerLoad = async (event) => {
	const run = effect.for(event);
	const account = await run(getAccount().pipe(Effect.provide(event.locals.sessionLayer)));
	return { account };
};
```

There is no required locals layout. Merge several request Layers with
`Layer.merge`, or provide them separately with `Effect.provide`. Remotes can
obtain locals through `getRequestEvent()` from `$app/server` and use the same
provision pattern. Keep request Layers outside `integration.retain`.

## Lifecycle

`retain` is lazy. It acquires once per integration and shares dependencies by
Layer identity using Effect's native memoization. `dispose` stops admission,
interrupts active Effects, waits for whole request callbacks and their finalizers,
then closes all retained runtimes. Do not await disposal inside an active request.
Application startup probes belong in application Layers; prewarm a retained Layer
with ordinary Effect execution from the server init hook if readiness is required.

Use `sveltekit-effect/dev` to register `import.meta.hot` cleanup, independently of
the production adapter. `sveltekit-effect/node` registers adapter-node's shutdown
callback and returns an unregister function. Process-level telemetry flush/shutdown
ordering is application policy.

Register HMR cleanup in the server module that creates the integration:

```ts
// src/lib/server/effect.ts
import { registerDevelopmentLifecycle } from "sveltekit-effect/dev";
import { createIntegration } from "sveltekit-effect/server";
import { DatabasePoolLive } from "./database";

export const integration = createIntegration();
export const DatabaseLive = integration.retain(DatabasePoolLive);
export const effect = integration.effect.withDefaults(DatabaseLive);

// Replacing this module drains the old generation and releases retained services.
registerDevelopmentLifecycle(import.meta.hot, integration);
```

Vite's `dispose` callback starts asynchronous cleanup; it does not serialize new
module evaluation behind that cleanup. Allow old and new service generations to
briefly overlap. The dev helper uses no Node APIs and can also be used when your
production target is Workers; register the Node shutdown helper only for
adapter-node hosts.

Workers must only retain services valid across requests. Isolate termination has
no guaranteed disposal callback. Request-owned platform handles must stay local.

Streaming, live queries and detached background work are intentionally excluded.
The request boundary interrupts pending work when its callback returns. Returning
an unresolved Effect Promise for streaming is unsupported in this version.

## Configuration and tracing

`privateEnv(() => environment)` from `sveltekit-effect/config` wraps every
defined private value in `Redacted`, preserving inferred value types, optional
properties and existing Redacted values. Supply the private env object from your
chosen SvelteKit static or dynamic module; Kit 3 parsed values retain their types.
Read dynamic values at the scope where they are needed.

```ts
const config = privateEnv(() => env);
// Unwrap only at the boundary that needs the underlying value.
const port = Redacted.value(config.PORT);
```

`configLayer(() => rawEnvironment)` separately bridges raw string values to the
native Effect ConfigProvider at Layer acquisition time. Native Config decoding
continues to work normally; use `Config.redacted` when decoding secrets there.

When `event.tracing.enabled` is true, execution automatically uses the host's
OpenTelemetry provider and parents native Effect spans to the active OTel span,
falling back to SvelteKit's current span. Sampling flags and trace state are
preserved. Use ordinary `Effect.withSpan` to name operations. The package installs
no SDK or exporter and creates no automatic operation span.

`createIntegration({ decorate })` accepts a requirement-preserving Effect
transformation for application logging context or other execution policies.
`sveltekit-effect/otel` exports `TracingLive` for explicitly instrumented work
outside requests. Expected failures should be handled before running the program;
the package does not map them into HTTP errors.

## Development

Built with Vite+. Run `vp install`, `vp check`, `vp test run`, and
`vp run build`. Type checks include negative requirements tests. Runtime tests
cover shared retention, ordinary provision and overrides, derived remote events,
concurrency, interruption and failed acquisition cleanup.

GitHub Actions runs `vp check` on pushes and pull requests. It checks formatting,
lint and TypeScript through the existing type-aware Vite+ configuration; the
`check` script delegates to that same command.

## Compatibility fixtures

The `fixtures/kit2` and `fixtures/kit3` apps validate generated route types,
whole-handler Effects, SSR and remote HTTP calls. Install each fixture with
`vp install`, then run `vp run test:fixtures` from this repository. Their pinned
pnpm configuration ensures Kit and Vite+ share one Vite runtime.

For a local consumer, build and pack this package with `vp run build` and
`vp exec npm pack`, then install that tarball using `vp add`. A source-directory
symlink can introduce a second Svelte/Kit type identity from development
dependencies; the packed artifact exercises the actual published layout.

Server exports include Svelte's export condition so the host bundles the
`$app/server` virtual import. No AST plugin or custom Vite plugin is required.

## License

[MIT](./LICENSE).
