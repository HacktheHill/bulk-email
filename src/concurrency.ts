export async function processWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
	const controller = new AbortController();
	let cursor = 0;
	let fatalError: unknown;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length && fatalError === undefined) {
			const item = items[cursor++];
			if (item === undefined) return;
			try {
				await worker(item, controller.signal);
			} catch (error) {
				fatalError ??= error;
				controller.abort(error);
			}
		}
	});
	await Promise.all(runners);
	if (fatalError !== undefined) throw fatalError;
}
