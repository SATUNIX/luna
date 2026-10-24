// json.ts — reading JSON files the console does not own (pi's settings and models, pi-lens state).
//
// Their contents are untrusted: they come back as `unknown` and are narrowed with guard.ts schemas.
// Another program writes them, so one odd field must not hide the rest of the file: `lenient`
// fields drop a value of the wrong type instead of failing the whole object.
import * as fs from "node:fs";
import { parseJson, ValidationError, type OptionalSchema, type Schema } from "../../core/lib/guard.ts";

/** A JSON file's parsed contents, or null when it is missing, unreadable or not JSON. */
export function readJsonFile(file: string): unknown {
	try {
		return parseJson(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** `inner` when it accepts the value; otherwise the field is treated as absent. */
export function lenient<T>(inner: Schema<T>): OptionalSchema<T> {
	return {
		optional: true,
		expected: `${inner.expected} (ignored when invalid)`,
		parse(value, path = "value") {
			try {
				return inner.parse(value, path);
			} catch (error) {
				if (error instanceof ValidationError) return undefined;
				throw error;
			}
		},
	};
}
