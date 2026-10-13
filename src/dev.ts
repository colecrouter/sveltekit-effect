/** Development cleanup does not import Node APIs into server deployment bundles. */
export interface HotLifecycle {
	dispose(callback: () => void | Promise<void>): void;
}

/** Dispose the old application generation when Vite replaces its owning module. */
export function registerDevelopmentLifecycle(
	hot: HotLifecycle | undefined,
	owner: { dispose(): Promise<void> },
): void {
	hot?.dispose(() => owner.dispose());
}
