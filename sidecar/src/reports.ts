// Failures the Harness reports without failing the calling operation (faulted tasks, hook errors, a failed session)
// are stored in durable_agent_reports and announced on the durable_agent_reports channel, where the Rails relay
// picks them up.
//
// pi-durable 1.3.0 calls `onReport(error)` only. Newer releases add an `info` argument describing the failure
// (`session_failed`, `task_faulted`, `task_parked`, ...); the fields below are read from it when present.
import type { Pool } from "pg";
import { log } from "./log.ts";

export const REPORTS_CHANNEL = "durable_agent_reports";

type ReportShape = {
	type?: string;
	extension?: string;
	conversationId?: number;
	task?: { id?: number; kind?: string; conversationId?: number };
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const shape = (info: unknown): ReportShape => (typeof info === "object" && info !== null ? (info as ReportShape) : {});

export function createReporter(pool: Pool): (error: unknown, info?: unknown) => void {
	return (error, info) => {
		const report = shape(info);
		const type = report.type ?? "error";
		const conversationId = report.task?.conversationId ?? report.conversationId ?? null;
		const message = describe(error);
		log.error("harness report", { type, message, task: report.task, extension: report.extension, error });

		void pool
			.query<{ id: string }>(
				`INSERT INTO durable_agent_reports (type, conversation_id, task_id, task_kind, extension, message, info)
				 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				[
					type,
					conversationId,
					report.task?.id ?? null,
					report.task?.kind ?? null,
					report.extension ?? null,
					message,
					JSON.stringify(report),
				],
			)
			.then(async (result) => {
				const id = result.rows[0]?.id === undefined ? undefined : Number(result.rows[0].id);
				const payload = JSON.stringify({ id, type, conversationId, taskId: report.task?.id, message });
				await pool.query("SELECT pg_notify($1, $2)", [REPORTS_CHANNEL, payload]);
			})
			.catch((failure) => log.error("report delivery failed", { error: failure }));
	};
}
