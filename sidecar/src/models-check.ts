// A model reference must name a model pi-ai knows, or every run settles `no_model` with no further detail.
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export class UnknownModel extends Error {
	readonly suggestions: readonly string[];
	constructor(ref: ModelRef, suggestions: readonly string[]) {
		const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
		super(`Unknown model ${ref.provider}/${ref.modelId}.${hint}`);
		this.suggestions = suggestions;
	}
}

/** Throws `UnknownModel` when `ref` is not in the catalog. The faux provider registers lazily, so it is trusted. */
export function assertKnownModel(models: Models, ref: ModelRef): void {
	if (ref.provider === "faux") return;
	if (models.getModel(ref.provider, ref.modelId) !== undefined) return;
	const ids = models.getModels(ref.provider).map((model) => model.id);
	const ranked = ids
		.map((id) => ({ id, distance: distance(normalize(ref.modelId), normalize(id)) }))
		.filter((entry) => entry.distance <= 2)
		.sort((a, b) => a.distance - b.distance)
		.map((entry) => entry.id);
	throw new UnknownModel(ref, ranked.length > 0 ? ranked.slice(0, 5) : ids.slice(0, 8));
}

const normalize = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Levenshtein distance; ids are short, so the plain quadratic version is fine. */
function distance(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0]!;
		previous[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const temp = previous[j]!;
			previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = temp;
		}
	}
	return previous[b.length]!;
}
