// Example of a tool that reaches back into Rails: the agent asks for a record, Rails authorizes and serializes it.
// Rails side: GET /internal/agent/records/:type/:id with the shared bearer token (see ../../rails/README.md).
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export function createLookupRecordTool(railsUrl: string, token: string) {
	return defineTool({
		name: "lookup_record",
		description: "Look up one application record by type and id. Returns the record as JSON.",
		parameters: Type.Object({
			type: Type.String({ description: "Record type in snake_case, for example `project` or `invoice`" }),
			id: Type.String({ description: "The record's id" }),
		}),
		// A read with no side effects, so rerunning it after a crash is fine.
		replay: "safe",
		execute: async ({ type, id }, _api, context) => {
			const url = new URL(`/internal/agent/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, railsUrl);
			const response = await fetch(url, {
				headers: { authorization: `Bearer ${token}`, accept: "application/json" },
				signal: context.abortSignal,
			});
			const text = await response.text();
			if (!response.ok) {
				return { output: [{ type: "text", text: `Rails returned ${response.status}: ${text}` }], isError: true };
			}
			return { output: [{ type: "text", text }] };
		},
	});
}
