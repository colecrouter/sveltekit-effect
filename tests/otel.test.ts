import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import { context, createTraceState, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("$app/server", () => ({
	getRequestEvent: () => {
		throw new Error("Use the event-bound runner in this test");
	},
}));
import { createIntegration } from "../src/server.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer("fixture-kit");
beforeAll(() => provider.register());
beforeEach(() => exporter.reset());
afterAll(async () => {
	await provider.shutdown();
	trace.disable();
	context.disable();
});

const eventFor = (current: ReturnType<typeof tracer.startSpan>, enabled = true) => ({
	locals: {},
	request: new Request("https://example.test"),
	tracing: { enabled, root: current, current },
});

it("uses Kit's fallback parent and keeps concurrent Effect/Promise child chains separate", async () => {
	const integration = createIntegration();
	try {
		await Promise.all(
			[0, 1].map(async (index) => {
				const parent = tracer.startSpan(`kit.load.${index}`);
				const event = eventFor(parent);
				try {
					await integration.runRequest(event, () =>
						integration.effect.for(event)(
							Effect.promise(async () => {
								await Promise.resolve();
								tracer.startActiveSpan(`promise.${index}`, (span) => span.end());
							}).pipe(Effect.withSpan(`domain.${index}`)),
						),
					);
				} finally {
					parent.end();
				}
			}),
		);
		await provider.forceFlush();
		const spans = exporter.getFinishedSpans();
		for (const index of [0, 1]) {
			const parent = spans.find((span) => span.name === `kit.load.${index}`)!;
			const domain = spans.find((span) => span.name === `domain.${index}`)!;
			const promise = spans.find((span) => span.name === `promise.${index}`)!;
			expect(domain.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
			expect(promise.parentSpanContext?.spanId).toBe(domain.spanContext().spanId);
			expect(promise.spanContext().traceId).toBe(parent.spanContext().traceId);
		}
		const domains = spans.filter((span) => span.name.startsWith("domain."));
		expect(domains[0]!.spanContext().traceId).not.toBe(domains[1]!.spanContext().traceId);
	} finally {
		await integration.dispose();
	}
});

it("prefers a manually nested active operation over the framework span", async () => {
	const integration = createIntegration();
	const parent = tracer.startSpan("kit.remote");
	const event = eventFor(parent);
	try {
		await integration.runRequest(event, () =>
			context.with(trace.setSpan(ROOT_CONTEXT, parent), () =>
				tracer.startActiveSpan("manual", async (manual) => {
					try {
						await integration.effect.for(event)(Effect.void.pipe(Effect.withSpan("domain")));
					} finally {
						manual.end();
					}
				}),
			),
		);
		parent.end();
		await provider.forceFlush();
		const spans = exporter.getFinishedSpans();
		expect(spans.find((span) => span.name === "domain")!.parentSpanContext?.spanId).toBe(
			spans.find((span) => span.name === "manual")!.spanContext().spanId,
		);
	} finally {
		parent.end();
		await integration.dispose();
	}
});

it("preserves unsampled flags and trace state from the Kit fallback", async () => {
	const integration = createIntegration();
	const parent = {
		traceId: "11111111111111111111111111111111",
		spanId: "2222222222222222",
		traceFlags: TraceFlags.NONE,
		traceState: createTraceState("vendor=test"),
		isRemote: true,
	};
	const event = eventFor(trace.wrapSpanContext(parent));
	try {
		const observed = await integration.runRequest(event, () =>
			integration.effect.for(event)(
				Effect.map(OtelTracer.currentOtelSpan, (span) => span.spanContext()).pipe(
					Effect.withSpan("unsampled"),
				),
			),
		);
		expect(observed.traceId).toBe(parent.traceId);
		expect(observed.traceFlags).toBe(TraceFlags.NONE);
		expect(observed.traceState?.serialize()).toBe("vendor=test");
		await provider.forceFlush();
		expect(exporter.getFinishedSpans()).toEqual([]);
	} finally {
		await integration.dispose();
	}
});

it("does not install automatic tracing when Kit has disabled it", async () => {
	const integration = createIntegration();
	const parent = tracer.startSpan("kit.disabled");
	const event = eventFor(parent, false);
	try {
		await integration.runRequest(event, () =>
			integration.effect.for(event)(Effect.void.pipe(Effect.withSpan("disabled.domain"))),
		);
		parent.end();
		await provider.forceFlush();
		expect(exporter.getFinishedSpans().map((span) => span.name)).not.toContain("disabled.domain");
	} finally {
		parent.end();
		await integration.dispose();
	}
});

it("falls back to Kit when the ambient span has an invalid context", async () => {
	const integration = createIntegration();
	const parent = tracer.startSpan("kit.fallback");
	const event = eventFor(parent);
	const invalid = trace.wrapSpanContext({
		traceId: "00000000000000000000000000000000",
		spanId: "0000000000000000",
		traceFlags: TraceFlags.NONE,
	});
	try {
		await integration.runRequest(event, () =>
			context.with(trace.setSpan(ROOT_CONTEXT, invalid), () =>
				integration.effect.for(event)(Effect.void.pipe(Effect.withSpan("fallback.domain"))),
			),
		);
		parent.end();
		await provider.forceFlush();
		expect(
			exporter.getFinishedSpans().find((span) => span.name === "fallback.domain")!.parentSpanContext
				?.spanId,
		).toBe(parent.spanContext().spanId);
	} finally {
		parent.end();
		await integration.dispose();
	}
});
