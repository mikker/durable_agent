// Turns the SQLite dialect pi-durable's storage core (and the gem's own SQL) speaks into Postgres. The rest of that
// SQL (`ON CONFLICT(id) DO UPDATE`, `excluded.col`, partial indexes, `LIMIT ?`) is already valid Postgres.
const memo = new Map<string, string>();

export function toPostgres(sql: string): string {
	let translated = memo.get(sql);
	if (translated === undefined) {
		translated = translate(sql);
		memo.set(sql, translated);
	}
	return translated;
}

function translate(sql: string): string {
	return numberPlaceholders(insertOrIgnore(dropJsonValid(dropStrict(sql))));
}

/** `?` → `$1, $2, …`, leaving quoted literals, quoted identifiers and `--` comments alone. */
export function numberPlaceholders(sql: string): string {
	let out = "";
	let n = 0;
	let i = 0;
	while (i < sql.length) {
		const char = sql[i] as string;
		if (char === "'" || char === '"') {
			const end = closingQuote(sql, i, char);
			out += sql.slice(i, end);
			i = end;
		} else if (char === "-" && sql[i + 1] === "-") {
			const newline = sql.indexOf("\n", i);
			const end = newline === -1 ? sql.length : newline;
			out += sql.slice(i, end);
			i = end;
		} else {
			out += char === "?" ? `$${++n}` : char;
			i++;
		}
	}
	return out;
}

// A doubled quote inside a quoted run is an escaped quote, so scanning on just continues past it.
function closingQuote(sql: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < sql.length) {
		if (sql[i] === quote) {
			if (sql[i + 1] === quote) i += 2;
			else return i + 1;
		} else i++;
	}
	return sql.length;
}

function dropStrict(sql: string): string {
	return sql.replace(/\)\s*STRICT\b/g, ")");
}

// A column constraint takes the whitespace before it; a table constraint (`, CHECK (…)`) takes its comma too.
function dropJsonValid(sql: string): string {
	return sql.replace(/(?:\s*,\s*|\s+)CHECK\s*\(\s*json_valid\s*\(\s*\w+\s*\)\s*\)/gi, "");
}

function insertOrIgnore(sql: string): string {
	if (!/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) return sql;
	const insert = sql.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\b/i, "$1INSERT INTO");
	const returning = insert.search(/\sRETURNING\s/i);
	if (returning === -1) return `${insert.replace(/[\s;]*$/, "")} ON CONFLICT DO NOTHING`;
	return `${insert.slice(0, returning).replace(/\s*$/, "")} ON CONFLICT DO NOTHING${insert.slice(returning)}`;
}
