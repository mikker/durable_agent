// Failures the Harness reports without failing the calling operation (faulted tasks, hook errors, a failed session)
// are stored in durable_agent_reports; the events module then tells Rails about the new row.
//
// pi-durable 1.3.0 calls `onReport(error)` only. Newer releases add an `info` argument describing the failure
// (`session_failed`, `task_faulted`, `task_parked`, ...); the fields below are read from it when present.
import type { Db } from "./db/index.ts";
import { log } from "./log.ts";

export type ReportEvents = { report(id: number): void };

type ReportShape = {
	type?: string;
	extension?: string;
	conversationId?: number;
	task?: { id?: number; kind?: string; conversationId?: number };
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const shape = (info: unknown): ReportShape => (typeof info === "object" && info !== null ? (info as ReportShape) : {});

export function createReporter(db: Db, events: ReportEvents): (error: unknown, info?: unknown) => void {
	return (error, info) => {
		const report = shape(info);
		const type = report.type ?? "error";
		const message = describe(error);
		log.error("harness report", { type, message, task: report.task, extension: report.extension, error });

		void db
			.get<{ id: number }>(
				`INSERT INTO durable_agent_reports (type, conversation_id, task_id, task_kind, extension, message, info, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id`,
				type,
				report.task?.conversationId ?? report.conversationId ?? null,
				report.task?.id ?? null,
				report.task?.kind ?? null,
				report.extension ?? null,
				message,
				JSON.stringify(report),
			)
			.then((row) => {
				if (row !== undefined) events.report(Number(row.id));
			})
			.catch((failure) => log.error("report delivery failed", { error: failure }));
	};
}
