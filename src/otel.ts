/** Continue SvelteKit operations through Effect without owning host exporters. */
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import type { RequestEvent } from "@sveltejs/kit";
import { Effect, Layer } from "effect";

/** The host's global provider supplies the tracer; no SDK or exporter is registered. */
export const TracingLive = OtelTracer.layerWithoutOtelTracer.pipe(
	Layer.provide(Layer.sync(OtelTracer.OtelTracer, () => trace.getTracer("sveltekit-effect"))),
);

/** Capture parentage synchronously, including unsampled flags and trace state. */
export function withSvelteKitTracing<A, E, R>(
	program: Effect.Effect<A, E, R>,
	event: Partial<Pick<RequestEvent, "tracing">>,
): Effect.Effect<A, E, R> {
	if (!event.tracing?.enabled) return program;

	// A manually nested OTel operation is more precise than the enclosing Kit span.
	// Invalid/no-op active spans must not obscure a valid framework fallback.
	const active = trace.getActiveSpan()?.spanContext();
	const current = event.tracing.current.spanContext();
	const parent = active && isSpanContextValid(active) ? active : current;
	// Effect 4 treats an unparented span as a root, so explicitly seed its external
	// parent before execution rather than relying on OTel's ambient fallback.
	const parented = isSpanContextValid(parent)
		? OtelTracer.withSpanContext(program, parent)
		: program;
	return Effect.provide(parented, TracingLive);
}
