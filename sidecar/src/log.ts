type Level = "info" | "warn" | "error";

const write = (level: Level, message: string, fields: Record<string, unknown> = {}): void => {
	const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields }, (_key, value) =>
		value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
	);
	(level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};

export const log = {
	info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
	warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
	error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
