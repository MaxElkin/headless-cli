// Structured output: holding an agent's final reply to a JSON Schema.
//
// Three of the harnesses can enforce one themselves, each spelling it
// differently, and the rest cannot enforce anything at all. `--json-schema`
// is the one way in: the schema is translated into the harness's own flag
// where there is one, and otherwise put to the agent in the prompt, which is
// all a caller could have done by hand anyway. Nothing is ever silently
// dropped — a run says which of the two routes it took.
//
//   claude       --json-schema <text>          (inline)
//   antigravity  --json-schema <text>          (inline; text or a path)
//   codex        --output-schema <file>        (a file, written here)
//   the rest     appended to the prompt
//
// The caller is expected to check the reply as well. A prompted schema is a
// request, not a guarantee, and even an enforced one says nothing about
// whether the values make sense.

import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentName, BuiltCommand } from "../types.js";

export interface ForkSchema {
  /** The schema as it is passed on: compact JSON, whatever came in. */
  text: string;
  /** The same, parsed, for the prompt route to print it readably. */
  value: unknown;
}

/** How a harness is given the schema. */
export type SchemaRoute = "flag" | "prompt";

const flagged: Partial<Record<AgentName, (schema: ForkSchema) => string[]>> = {
  claude: (schema) => ["--json-schema", schema.text],
  antigravity: (schema) => ["--json-schema", schema.text],
  codex: (schema) => ["--output-schema", schemaFile(schema)],
};

export function forkSchemaRoute(agent: AgentName): SchemaRoute {
  return flagged[agent] ? "flag" : "prompt";
}

/** What a run says about the route it took, for a caller reading stderr. */
export function describeForkSchema(agent: AgentName): string {
  return forkSchemaRoute(agent) === "flag"
    ? `${agent} is given the JSON schema as its own flag`
    : `${agent} has no schema flag: the JSON schema is asked for in the prompt`;
}

/**
 * The schema named by `--json-schema`: JSON as written, or a file holding it.
 *
 * Parsed here rather than passed through, so a schema that is not JSON is a
 * refusal before an agent is launched rather than an error from the harness
 * halfway through a run.
 */
export function loadForkSchema(given: string | undefined): ForkSchema | undefined {
  if (given === undefined) return undefined;
  const trimmed = given.trim();
  if (!trimmed) throw new Error("--json-schema needs a JSON schema or a path to one");
  // A leading bracket is JSON either way: an array is refused below as the
  // wrong shape rather than reported as a file nobody meant to name.
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const text = looksLikeJson ? trimmed : readSchemaFile(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const where = looksLikeJson ? "--json-schema" : `--json-schema file ${trimmed}`;
    throw new Error(`${where} is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--json-schema must be a JSON object");
  }
  return { text: JSON.stringify(value), value };
}

function readSchemaFile(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`--json-schema file not found: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/**
 * The prompt with the schema appended, for a harness that cannot enforce one.
 *
 * Appended rather than prepended: the instruction is what the agent is there
 * for, and the shape of the answer is the last thing it needs to read.
 */
export function withForkSchemaPrompt(
  agent: AgentName,
  prompt: string,
  schema: ForkSchema | undefined,
): string {
  if (!schema || forkSchemaRoute(agent) === "flag") return prompt;
  return (
    `${prompt}\n\nEnd your reply with one JSON object, and nothing after it, ` +
    `matching this JSON Schema:\n${JSON.stringify(schema.value, null, 2)}`
  );
}

/** The built command with the harness's own schema flag in it. */
export function withForkSchemaArgs(
  agent: AgentName,
  built: BuiltCommand,
  schema: ForkSchema | undefined,
): BuiltCommand {
  const flags = schema ? flagged[agent]?.(schema) : undefined;
  if (!flags) return built;
  return { ...built, args: inserted(built.args, flags) };
}

/**
 * The flags put where a harness will read them: before a trailing `-`, which
 * is codex's "the prompt comes on stdin" and not a flag's value, and at the
 * end otherwise.
 */
export function inserted(args: string[], flags: string[]): string[] {
  const last = args.length - 1;
  if (last >= 0 && args[last] === "-") {
    return [...args.slice(0, last), ...flags, "-"];
  }
  return [...args, ...flags];
}

/**
 * The schema on disk, for a harness that takes a path.
 *
 * In a directory of its own under the system temporary directory, which the
 * agent only reads: the schema is this launch's, and a file named after the
 * launch cannot be the one another run is reading.
 */
function schemaFile(schema: ForkSchema): string {
  const directory = mkdtempSync(join(tmpdir(), "headless-schema-"));
  const path = join(directory, "schema.json");
  writeFileSync(path, `${schema.text}\n`, "utf8");
  return path;
}

/**
 * What `--json-schema` cannot be combined with.
 *
 * It holds one reply to a shape, so it means nothing where there is no reply
 * to read: an attached or tmux session answers to a person, not to a caller.
 * Docker and Modal run the agent somewhere this process's files are not, so
 * the file route could not be read. A prompt file with a harness that has no
 * flag has nowhere for the schema to go, since the prompt is not this
 * process's to rewrite.
 */
export function validateForkSchema(parsed: {
  agent?: AgentName;
  forkJsonSchema?: string;
  promptFile?: string;
  tmux?: boolean;
  forkAttach?: boolean;
  docker?: boolean;
  modal?: boolean;
}): void {
  if (parsed.forkJsonSchema === undefined) return;
  if (!parsed.agent) throw new Error("--json-schema needs an agent");
  if (parsed.forkAttach || parsed.tmux) {
    throw new Error("--json-schema is for a reply a caller reads, not for an interactive session");
  }
  if (parsed.docker || parsed.modal) {
    throw new Error("--json-schema is not supported with --docker or --modal");
  }
  if (parsed.promptFile && forkSchemaRoute(parsed.agent) === "prompt") {
    throw new Error(
      `--json-schema with ${parsed.agent} is asked for in the prompt, which --prompt-file ` +
        "does not leave room for; pass the prompt with --prompt",
    );
  }
}
