// Failures the Harness reports without failing the calling operation (faulted tasks, hook errors, a failed session)
// are stored in durable_agent_reports; the events module then tells Rails about the new row.
//
// pi-durable 1.3.0 calls `onReport(error)` only. Newer releases add an `info` argument describing the failure
// (`session_failed`, `task_faulted`, `task_parked`, ...); the fields below are read from it when present.
import type { Db } from "./db/index.ts";
import { log } from "./log.ts";

type ReportEvents = { report(id: number): void };

type ReportShape = {
	type?: string;
	extension?: string;
	conversationId?: number;
	task?: { id?: number; kind?: string; conversationId?: number };
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const shape = (info: unknown): ReportShape => (typeof info === "object" && info !== null ? (info as ReportShape) : {});

/** The Harness's `onReport`, plus `settled()`, which shutdown awaits so a report raised just before it is stored. */
export type Reporter = ((error: unknown, info?: unknown) => void) & { settled(): Promise<void> };

export function createReporter(db: Db, events: ReportEvents): Reporter {
	const inFlight = new Set<Promise<void>>();
	const report = (error: unknown, info?: unknown): void => {
		const shaped = shape(info);
		const type = shaped.type ?? "error";
		const message = describe(error);
		log.error("harness report", { type, message, task: shaped.task, extension: shaped.extension, error });
		const stored = store(db, events, type, message, shaped).finally(() => inFlight.delete(stored));
		inFlight.add(stored);
	};
	return Object.assign(report, {
		settled: async () => {
			while (inFlight.size > 0) await Promise.all(inFlight);
		},
	});
}

async function store(db: Db, events: ReportEvents, type: string, message: string, report: ReportShape): Promise<void> {
	try {
		const row = await db.get<{ id: number }>(
			`INSERT INTO durable_agent_reports (type, conversation_id, task_id, task_kind, extension, message, info, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id`,
			type,
			report.task?.conversationId ?? report.conversationId ?? null,
			report.task?.id ?? null,
			report.task?.kind ?? null,
			report.extension ?? null,
			message,
			JSON.stringify(report),
		);
		if (row !== undefined) events.report(Number(row.id));
	} catch (failure) {
		log.error("report delivery failed", { error: failure });
	}
}
