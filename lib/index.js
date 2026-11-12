/**
 * codegraph wiring, host half.
 *
 * Registers one Typert Remote service, `codegraphInstall`, that drives the
 * npm-published codegraph CLI from a browser dialog:
 *
 * - `status` reports whether the CLI exists, whether a `codegraph` MCP server
 *   is already wired into this DSH home, and whether the installed CLI knows
 *   the `dsh` installer target.
 * - `start` launches one install or uninstall run and returns its id at once;
 *   the process keeps streaming into a bounded line buffer.
 * - `poll` returns the lines appended since a cursor, so the dialog renders a
 *   live log without a websocket of its own.
 * - `cancel` kills the running child.
 *
 * Two knowledge points shape the flow. `codegraph install --yes` skips its own
 * interactive "install the CLI on your PATH?" step, so the CLI install is done
 * here with npm before the wiring runs. And the published CLI (1.6.2) predates
 * the `dsh` target, so when `codegraph install --print-config dsh` fails the
 * patch row is written directly in the shape that target would have produced.
 */
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load the Typert protocol package.
 *
 * A bundle installed from a packed tarball resolves it by bare specifier. A
 * linked checkout outside the profile directory does not: DSH routes
 * `@deepseek-ai/*` requests only for modules that live under the profile, so
 * the bare import fails there. The fallback resolves the same package from the
 * running installation, which keeps `link:` development working without
 * changing anything for a published install.
 *
 * @returns {Promise<object>} the protocol module namespace.
 */
async function importTypertProtocol() {
	try {
		return await import("@deepseek-ai/dsh-typert-protocol");
	} catch (error) {
		for (const scopeDir of installedScopeDirs()) {
			const entry = path.join(scopeDir, "dsh-typert-protocol", "lib", "index.js");
			try {
				await access(entry);
			} catch {
				continue;
			}
			try {
				return await import(pathToFileURL(entry).href);
			} catch {
				break;
			}
		}
		throw error;
	}
}

/**
 * Candidate `node_modules/@deepseek-ai` directories of the running DSH.
 *
 * The host process is started as `dsh <install-root> <profile> ...`, where the
 * install root holds `node_modules/@deepseek-ai`, and Electron's `argv[1]` is a
 * file inside that same tree. Reading them is enough to find the protocol
 * package without depending on an environment variable DSH does not export to
 * plugins.
 *
 * @returns {string[]} existing-looking scope directories, best candidate first.
 */
function installedScopeDirs() {
	const scope = path.join("node_modules", "@deepseek-ai");
	const candidates = [];
	const fromEnv = process.env.DSH_INSTALL_DIR;
	if (fromEnv !== undefined) candidates.push(path.dirname(fromEnv));
	const marker = path.sep + scope;
	for (const argument of process.argv.slice(1)) {
		if (typeof argument !== "string") continue;
		const at = argument.indexOf(marker);
		if (at > 0) candidates.push(argument.slice(0, at) + marker);
		candidates.push(path.join(argument, scope));
	}
	return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

const { Remote, RemoteError, TypertRemoteService } = await importTypertProtocol();

/** Wire namespace; every endpoint is `codegraphInstall/<method>`. */
const SERVICE = "codegraphInstall";

/** The npm package whose CLI provides the MCP server. */
const NPM_PACKAGE = "@colbymchenry/codegraph";

/** MCP server name; this is also the tool prefix the model sees. */
const SERVER_NAME = "codegraph";

/** The MCP client bundle every row points at. */
const MCP_CLIENT_NAME = "@deepseek-ai/dsh-mcp-client";

/** DSH reads its plugin patches from these two file names. */
const PATCH_FILE = "cordis.patch.yml";
const INSTRUCTIONS_FILE = "AGENTS.md";

/** The installer's own marker fence, reused so both writers stay interchangeable. */
const SECTION_START = "<!-- CODEGRAPH_START -->";
const SECTION_END = "<!-- CODEGRAPH_END -->";

/** Recognises a row that already serves this MCP server, in either file. */
const HAS_SERVER = /(^|[\s{,])["']?serverName["']?\s*:\s*["']?codegraph["']?\s*([,}#]|$)/mu;

/** Recognises the MCP client bundle inside a row block. */
const IS_MCP_CLIENT = /(^|[\s{,])["']?name["']?\s*:\s*["']?@deepseek-ai\/dsh-mcp-client["']?/mu;

/** Recognises our own row id, the one the CLI's `dsh` target writes. */
const IS_ROW_ID = /(^|[\s{,])["']?id["']?\s*:\s*["']?mcp-codegraph["']?\s*([,}#]|$)/mu;

/** Bounded per-run log; a wedged install cannot grow the host heap. */
const RUN_LINE_LIMIT = 4000;

/** Runs older than this are dropped from the map on the next start. */
const RUN_RETENTION_MS = 30 * 60 * 1000;

/** The argument vector the MCP server is started with. */
const MCP_ARGS = ["serve", "--mcp"];

/**
 * The instructions block, byte-identical to `codegraph`'s own installer so a
 * later `codegraph install -t dsh` rewrites it instead of appending a second.
 */
const INSTRUCTIONS_BLOCK = `${SECTION_START}
## CodeGraph

In repositories indexed by CodeGraph (a \`.codegraph/\` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): \`codegraph_explore\` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): \`codegraph explore "<symbol names or question>"\` prints the same output.

If there is no \`.codegraph/\` directory, skip CodeGraph entirely — indexing is the user's decision.
${SECTION_END}`;

/**
 * Declare one direct Remote method without decorator syntax: this runtime has
 * V8 decorators switched off, so `@Remote(...)` is a hard SyntaxError here.
 *
 * @param {object} Proto - Class carrying the method.
 * @param {string} method - Method name, which is also the wire export name.
 * @returns {void}
 */
function declareRemote(Proto, method) {
	const initializers = [];
	Remote(method)(void 0, {
		name: method,
		"static": false,
		private: false,
		addInitializer(initializer) {
			initializers.push(initializer);
		}
	});
	if (initializers.length !== 1) {
		throw new Error(`codegraph-init: cannot declare Remote method '${method}'`);
	}
	initializers[0].call(Object.create(Proto.prototype));
}

/**
 * This DSH home, honouring the same `DSH_HOME` override the Host itself uses.
 *
 * @returns {string} absolute path of the harness home.
 */
function dshHome() {
	const value = process.env.DSH_HOME?.trim();
	if (!value) return path.join(os.homedir(), ".dsh");
	const inHome = value === "~" || value.startsWith("~/");
	return path.resolve(inHome ? path.join(os.homedir(), value.slice(1)) : value);
}

/**
 * Read a text file, mapping "absent" onto `null` instead of throwing.
 *
 * @param {string} file - Absolute path.
 * @returns {Promise<string | null>} the contents, or null when missing.
 */
async function readText(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Run one shell command line and collect its output without touching any run
 * buffer. Login shell semantics matter here: a DSH launched from Finder gets
 * the launchd PATH, and the user's node bin lives on the profile PATH only.
 *
 * @param {string} command - Command line handed to `/bin/sh -lc`.
 * @param {{timeoutMs?: number}} [options] - Kill the child after this long.
 * @returns {Promise<{code: number, out: string, err: string}>} exit code and both streams.
 */
function execCapture(command, options = {}) {
	const timeoutMs = options.timeoutMs ?? 20_000;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("/bin/sh", ["-lc", command], {
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"]
			});
		} catch (error) {
			resolve({ code: -1, out: "", err: String(error) });
			return;
		}
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			err += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, out, err: String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, out, err });
		});
	});
}

/**
 * Locate the codegraph CLI, its version and the npm that would install it.
 *
 * @returns {Promise<{found: boolean, path: string | null, version: string | null, npm: string | null}>} the probe.
 */
async function probeCli() {
	const npm = await execCapture("command -v npm");
	const npmPath = npm.code === 0 ? npm.out.trim().split("\n")[0] : null;
	const located = await execCapture("command -v codegraph");
	const found = located.code === 0 && located.out.trim() !== "";
	if (!found) return { found: false, path: null, version: null, npm: npmPath === "" ? null : npmPath };
	const cliPath = located.out.trim().split("\n")[0];
	const version = await execCapture("codegraph --version");
	const text = `${version.out}\n${version.err}`.trim();
	const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/u.exec(text);
	return {
		found: true,
		path: cliPath.startsWith("/") ? cliPath : null,
		version: match ? match[0] : text.split("\n")[0] ?? null,
		npm: npmPath === "" ? null : npmPath
	};
}

/**
 * Ask the installed CLI whether it ships the `dsh` installer target.
 *
 * @returns {Promise<boolean>} whether `codegraph install -t dsh` is understood.
 */
async function supportsDshTarget() {
	const probe = await execCapture("codegraph install --print-config dsh", { timeoutMs: 30_000 });
	return probe.code === 0 && /serverName/u.test(probe.out);
}

/**
 * Whether any patch file — this home's or a profile's — already serves the
 * `codegraph` MCP server.
 *
 * @param {string} home - Absolute DSH home.
 * @returns {Promise<object>} the wiring snapshot the dialog renders.
 */
async function wiringState(home) {
	const homePatch = path.join(home, PATCH_FILE);
	const homeText = await readText(homePatch);
	const profilesDir = path.join(home, "profiles");
	const profiles = [];
	let entries = [];
	try {
		entries = await readdir(profilesDir, { withFileTypes: true });
	} catch {}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const patchPath = path.join(profilesDir, entry.name, PATCH_FILE);
		const text = await readText(patchPath);
		profiles.push({ name: entry.name, patchPath, configured: text !== null && HAS_SERVER.test(text) });
	}
	const instructionsPath = path.join(home, INSTRUCTIONS_FILE);
	const instructionsText = await readText(instructionsPath);
	const homeConfigured = homeText !== null && HAS_SERVER.test(homeText);
	return {
		home: { patchPath: homePatch, exists: homeText !== null, configured: homeConfigured },
		profiles,
		instructions: { path: instructionsPath, present: instructionsText !== null && instructionsText.includes(SECTION_START) },
		configured: homeConfigured || profiles.some((entry) => entry.configured)
	};
}

/**
 * Split a YAML file into lines while remembering its line ending.
 *
 * @param {string} text - File contents.
 * @returns {{lines: string[], eol: string}} lines without terminators.
 */
function splitLines(text) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/u);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines, eol };
}

/**
 * Render lines back into file contents, always ending with one newline.
 *
 * @param {string[]} lines - Body lines.
 * @param {string} eol - Line ending to use.
 * @returns {string} file contents.
 */
function joinLines(lines, eol) {
	return lines.length === 0 ? "" : `${lines.join(eol)}${eol}`;
}

/**
 * Blank lines, YAML document markers and full-line comments.
 *
 * @param {string} line - One raw line.
 * @returns {boolean} whether the line carries no structure.
 */
function isTrivia(line) {
	const text = line.trim();
	return text === "" || text === "---" || text.startsWith("#");
}

/** A top-level list item, which is the only shape the patch loader accepts. */
function isTopLevelItem(line) {
	return /^-(\s|$)/u.test(line);
}

/**
 * Classify the file's structure: empty (no items), a top-level block list, or
 * something this writer must not touch (flow-style `[]`, a mapping, JSON).
 *
 * @param {string[]} lines - Body lines.
 * @returns {{kind: "empty" | "list" | "other", emptyList: number}} the layout.
 */
function layoutOf(lines) {
	const content = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!isTrivia(lines[index])) content.push(index);
	}
	if (content.length === 0) return { kind: "empty", emptyList: -1 };
	if (content.length === 1 && /^\[\s*\]\s*(#.*)?$/u.test(lines[content[0]])) return { kind: "empty", emptyList: content[0] };
	const first = lines[content[0]];
	const everyLineListed = content.every((index) => /^\s/u.test(lines[index]) || isTopLevelItem(lines[index]));
	return { kind: isTopLevelItem(first) && everyLineListed ? "list" : "other", emptyList: -1 };
}

/**
 * The row this plugin owns, in the exact shape `codegraph`'s `dsh` target
 * writes it — except `command`, which is pinned to the CLI's absolute path so
 * the MCP server also starts when DSH inherits a PATH without the node bin.
 *
 * @param {string} command - Executable the MCP client spawns.
 * @returns {string[]} the row, `- insert:` wrapper included, unindented.
 */
function serverRowLines(command) {
	return [
		"- insert:",
		"    - id: mcp-codegraph",
		`      name: '${MCP_CLIENT_NAME}'`,
		"      config:",
		"        serverName: codegraph",
		"        transport: stdio",
		`        command: ${command}`,
		"        args:",
		...MCP_ARGS.map((arg) => `          - ${arg}`)
	];
}

/**
 * Add the MCP row to a patch file body, refusing layouts the loader rejects.
 *
 * @param {string} text - Current file contents.
 * @param {string} command - Executable to pin.
 * @returns {{text: string, action: "created" | "inserted" | "unchanged"}} the edit.
 */
function insertServerRow(text, command) {
	const { lines, eol } = splitLines(text);
	if (HAS_SERVER.test(text)) return { text: joinLines(lines, eol), action: "unchanged" };
	const layout = layoutOf(lines);
	if (layout.kind === "other") {
		throw new Error(
			`${PATCH_FILE} is not a top-level YAML list, so the codegraph row cannot be appended safely; add it by hand: ${path.join("$DSH_HOME", PATCH_FILE)}`
		);
	}
	const row = serverRowLines(command);
	if (layout.kind === "empty") {
		const body = layout.emptyList >= 0 ? lines.filter((_, index) => index !== layout.emptyList) : lines;
		const kept = body.filter((line) => line.trim() !== "");
		return { text: joinLines([...(kept.length === 0 ? [] : [...kept, ""]), ...row], eol), action: "created" };
	}
	const body = [...lines];
	while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
	return { text: joinLines([...body, "", ...row], eol), action: "inserted" };
}

/**
 * A block parent that only introduces a nested list, such as `- insert:`.
 *
 * @param {string} line - One raw line.
 * @returns {boolean} whether the line opens a child list instead of holding data.
 */
function isContainerLine(line) {
	return /^\s*-\s*[A-Za-z0-9_-]+\s*:\s*$/u.test(line);
}

/**
 * Child items of one container block, at the children's own indentation.
 *
 * Deeper `- ` lines belong to a child's own value (an `args:` list), so they
 * must not read as siblings — that mistake left half a row behind.
 *
 * @param {string[]} lines - Body lines.
 * @param {number} from - First line of the block (the container item).
 * @param {number} to - Last line of the block.
 * @returns {number[][]} one `[start, end]` span per child item.
 */
function blockChildren(lines, from, to) {
	let indent = Number.POSITIVE_INFINITY;
	for (let index = from + 1; index <= to; index += 1) {
		const match = /^(\s+)-(\s|$)/u.exec(lines[index]);
		if (match === null) continue;
		if (match[1].length < indent) indent = match[1].length;
	}
	if (!Number.isFinite(indent)) return [];
	const spans = [];
	let start = -1;
	for (let index = from + 1; index <= to; index += 1) {
		const match = /^(\s+)-(\s|$)/u.exec(lines[index]);
		const isSibling = match !== null && match[1].length === indent;
		if (!isSibling) continue;
		if (start >= 0) spans.push([start, index - 1]);
		start = index;
	}
	if (start >= 0) spans.push([start, to]);
	return spans;
}

/**
 * Whether one block of YAML is a `codegraph` MCP row.
 *
 * @param {string} text - Block text, newline joined.
 * @returns {boolean} whether removing this block removes the server.
 */
function isOurRow(text) {
	return HAS_SERVER.test(text) || (IS_ROW_ID.test(text) && IS_MCP_CLIENT.test(text));
}

/**
 * Remove every `codegraph` MCP row from a patch file body.
 *
 * Two shapes reach here: the CLI's own `- insert:` container holding our row as
 * a child, and a row written flat at the top level. A container loses only its
 * matching children — and the container itself once it has none left — so an
 * unrelated insert block in the same file survives.
 *
 * @param {string} text - Current file contents.
 * @returns {{text: string, action: "removed" | "absent"}} the edit.
 */
function removeServerRows(text) {
	const { lines, eol } = splitLines(text);
	if (!HAS_SERVER.test(text) && !IS_ROW_ID.test(text)) return { text: joinLines(lines, eol), action: "absent" };
	const doomed = new Set();
	const drop = (from, to) => {
		for (let line = from; line <= to; line += 1) doomed.add(line);
	};
	let blockStart = -1;
	for (let index = 0; index <= lines.length; index += 1) {
		const atBoundary = index === lines.length || isTopLevelItem(lines[index]);
		if (!atBoundary) continue;
		if (blockStart >= 0) {
			let end = index - 1;
			while (end > blockStart && isTrivia(lines[end])) end -= 1;
			if (isContainerLine(lines[blockStart])) {
				const children = blockChildren(lines, blockStart, end);
				const removed = children.filter(([from, to]) => isOurRow(lines.slice(from, to + 1).join("\n")));
				for (const [from, to] of removed) drop(from, to);
				if (children.length > 0 && removed.length === children.length) drop(blockStart, end);
			} else if (isOurRow(lines.slice(blockStart, end + 1).join("\n"))) {
				drop(blockStart, end);
			}
		}
		blockStart = index;
	}
	const kept = lines.filter((_, index) => !doomed.has(index));
	const collapsed = [];
	for (const line of kept) {
		if (line.trim() === "" && (collapsed.length === 0 || collapsed[collapsed.length - 1].trim() === "")) continue;
		collapsed.push(line);
	}
	while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") collapsed.pop();
	return { text: joinLines(collapsed, eol), action: "removed" };
}

/**
 * Upsert the marker-fenced instructions block.
 *
 * @param {string} text - Current file contents.
 * @returns {{text: string, action: "created" | "updated" | "unchanged"}} the edit.
 */
function upsertInstructions(text) {
	const start = text.indexOf(SECTION_START);
	const end = text.indexOf(SECTION_END);
	if (start >= 0 && end > start) {
		const next = `${text.slice(0, start)}${INSTRUCTIONS_BLOCK}${text.slice(end + SECTION_END.length)}`;
		return { text: next, action: next === text ? "unchanged" : "updated" };
	}
	const body = text.replace(/\s*$/u, "");
	const next = body === "" ? `${INSTRUCTIONS_BLOCK}\n` : `${body}\n\n${INSTRUCTIONS_BLOCK}\n`;
	return { text: next, action: "created" };
}

/**
 * Strip the marker-fenced instructions block.
 *
 * @param {string} text - Current file contents.
 * @returns {{text: string, action: "removed" | "absent"}} the edit.
 */
function removeInstructions(text) {
	const start = text.indexOf(SECTION_START);
	const end = text.indexOf(SECTION_END);
	if (start < 0 || end < start) return { text, action: "absent" };
	const before = text.slice(0, start).replace(/\s+$/u, "");
	const after = text.slice(end + SECTION_END.length).replace(/^\s+/u, "");
	let next = "";
	if (before !== "" && after !== "") next = `${before}\n\n${after}`;
	else if (before !== "") next = `${before}\n`;
	else if (after !== "") next = `${after}\n`;
	return { text: next, action: "removed" };
}

/**
 * Append one line to a run's bounded buffer.
 *
 * @param {object} run - Run record.
 * @param {"step" | "out" | "err" | "ok" | "note"} kind - Line class the dialog styles.
 * @param {string} text - One line, ideally without a terminator.
 * @returns {void}
 */
function pushLine(run, kind, text) {
	run.seq += 1;
	run.lines.push({ seq: run.seq, kind, text });
	if (run.lines.length > RUN_LINE_LIMIT) {
		const dropped = run.lines.length - RUN_LINE_LIMIT;
		run.lines.splice(0, dropped);
		run.dropped += dropped;
	}
}

/**
 * Stream one command into the run buffer until it exits.
 *
 * @param {object} run - Run record owning the log.
 * @param {string} command - Command line handed to `/bin/sh -lc`.
 * @param {{timeoutMs?: number}} [options] - Kill the child after this long.
 * @returns {Promise<number>} the exit code.
 */
function runStreaming(run, command, options = {}) {
	const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
	pushLine(run, "step", `$ ${command}`);
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("/bin/sh", ["-lc", command], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			pushLine(run, "err", String(error));
			resolve(-1);
			return;
		}
		run.child = child;
		const timer = setTimeout(() => {
			pushLine(run, "err", `超时（${Math.round(timeoutMs / 1000)}s），已终止该命令`);
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		const feed = (kind) => (chunk) => {
			for (const line of String(chunk).split(/\r?\n/u)) {
				if (line.trim() === "") continue;
				pushLine(run, kind, line);
			}
		};
		child.stdout.on("data", feed("out"));
		child.stderr.on("data", feed("err"));
		child.on("error", (error) => {
			clearTimeout(timer);
			run.child = null;
			pushLine(run, "err", String(error));
			resolve(-1);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			run.child = null;
			resolve(code ?? -1);
		});
	});
}

/**
 * The codegraph wiring service.
 */
class CodegraphInstallService extends TypertRemoteService {
	/** Nothing below may run before the Host context exists. */
	static inject = [];

	/**
	 * @param {object} ctx - Host context.
	 */
	constructor(ctx) {
		super(ctx, SERVICE);
		this.runs = new Map();
		this.activeRunId = null;
	}

	/**
	 * Report the CLI and the current wiring; the dialog asks once per open.
	 *
	 * @param {object} request - Unused; kept so every endpoint takes one object.
	 * @returns {Promise<object>} the status the dialog renders before a run.
	 */
	async status(request) {
		void request;
		const home = dshHome();
		const cli = await probeCli();
		const wiring = await wiringState(home);
		const supports = cli.found ? await supportsDshTarget() : false;
		return {
			dshHome: home,
			serverName: SERVER_NAME,
			cli,
			wiring,
			cliSupportsDshTarget: supports,
			activeRunId: this.activeRunId
		};
	}

	/**
	 * Launch one install or uninstall run; the dialog polls for the log.
	 *
	 * @param {{action?: string, removeCli?: boolean}} request - What to run.
	 * @returns {Promise<{runId: string}>} the id to poll.
	 */
	async start(request) {
		const action = request?.action;
		if (action !== "install" && action !== "uninstall") {
			throw new RemoteError("codegraph/invalid-request", "action must be 'install' or 'uninstall'", { action: action ?? null });
		}
		const active = this.activeRunId === null ? null : this.runs.get(this.activeRunId);
		if (active !== undefined && active !== null && !active.done) {
			throw new RemoteError("codegraph/busy", "another codegraph run is still in progress", { runId: active.id });
		}
		this.pruneRuns();
		const run = {
			id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			action,
			removeCli: request?.removeCli === true,
			lines: [],
			seq: 0,
			dropped: 0,
			done: false,
			cancelled: false,
			ok: null,
			error: null,
			child: null,
			startedAt: Date.now(),
			finishedAt: null
		};
		this.runs.set(run.id, run);
		this.activeRunId = run.id;
		void this.execute(run).catch((error) => {
			run.ok = false;
			run.error = error instanceof Error ? error.message : String(error);
			pushLine(run, "err", run.error);
			run.done = true;
			run.finishedAt = Date.now();
			this.ctx.logger?.warn?.(`codegraph-init: run failed: ${run.error}`);
		});
		return { runId: run.id };
	}

	/**
	 * Read the lines appended after a cursor.
	 *
	 * @param {{runId?: string, after?: number}} request - Cursor.
	 * @returns {Promise<object>} appended lines plus the run's outcome.
	 */
	async poll(request) {
		const run = this.runs.get(request?.runId);
		if (run === undefined) {
			throw new RemoteError("codegraph/not-found", "no such codegraph run; it may predate a Host restart", { runId: request?.runId ?? null });
		}
		const after = Number.isFinite(request?.after) ? Number(request.after) : 0;
		return {
			runId: run.id,
			action: run.action,
			lines: run.lines.filter((line) => line.seq > after),
			next: run.seq,
			dropped: run.dropped,
			done: run.done,
			ok: run.ok,
			error: run.error,
			active: this.activeRunId === run.id
		};
	}

	/**
	 * Kill the run's child process, if it still has one.
	 *
	 * @param {{runId?: string}} request - Which run.
	 * @returns {Promise<{runId: string, cancelled: boolean}>} the outcome.
	 */
	async cancel(request) {
		const run = this.runs.get(request?.runId);
		if (run === undefined) {
			throw new RemoteError("codegraph/not-found", "no such codegraph run", { runId: request?.runId ?? null });
		}
		const child = run.child;
		if (child !== null) {
			pushLine(run, "err", "已取消，正在终止当前命令");
			try {
				child.kill("SIGTERM");
			} catch {}
		}
		run.cancelled = true;
		run.finishedAt = run.finishedAt ?? Date.now();
		run.done = true;
		run.ok = false;
		run.error = run.error ?? "cancelled";
		return { runId: run.id, cancelled: child !== null };
	}

	/**
	 * Drop a finished run from the map so its lines stop occupying memory.
	 *
	 * @param {{runId?: string}} request - Which run.
	 * @returns {Promise<{runId: string, forgotten: boolean}>} the outcome.
	 */
	async forget(request) {
		const id = request?.runId;
		const run = this.runs.get(id);
		if (run === undefined) return { runId: id ?? null, forgotten: false };
		if (!run.done) return { runId: run.id, forgotten: false };
		this.runs.delete(run.id);
		if (this.activeRunId === run.id) this.activeRunId = null;
		return { runId: run.id, forgotten: true };
	}

	/**
	 * Discard runs nobody can poll any more.
	 *
	 * @returns {void}
	 */
	pruneRuns() {
		const cutoff = Date.now() - RUN_RETENTION_MS;
		for (const [id, run] of this.runs) {
			if (run.done && (run.finishedAt ?? 0) < cutoff) this.runs.delete(id);
		}
	}

	/**
	 * Drive one run to completion, streaming each step into its buffer.
	 *
	 * @param {object} run - Run record from `start`.
	 * @returns {Promise<void>} resolution when the run finished.
	 */
	async execute(run) {
		try {
			if (run.action === "install") await this.runInstall(run);
			else await this.runUninstall(run);
			run.ok = !run.cancelled;
			if (run.cancelled) run.error = run.error ?? "cancelled";
		} catch (error) {
			run.ok = false;
			run.error = run.cancelled ? "cancelled" : error instanceof Error ? error.message : String(error);
			pushLine(run, "err", run.error);
		} finally {
			run.done = true;
			run.finishedAt = Date.now();
			if (this.activeRunId === run.id) this.activeRunId = null;
		}
	}

	/**
	 * Ensure the CLI, then wire one `codegraph` MCP server into this DSH home.
	 *
	 * @param {object} run - Run record receiving the log.
	 * @returns {Promise<void>} resolution when the wiring is verified.
	 */
	async runInstall(run) {
		const home = dshHome();
		pushLine(run, "step", "1/4 检查 codegraph CLI");
		let cli = await probeCli();
		if (!cli.npm) throw new Error("找不到 npm；请先让 npm 出现在 PATH 上，再重试");
		if (!cli.found) {
			pushLine(run, "note", "未找到 codegraph，开始安装 npm 包");
			const code = await runStreaming(run, `npm install -g ${NPM_PACKAGE}@latest`, { timeoutMs: 15 * 60 * 1000 });
			if (code !== 0) {
				pushLine(run, "note", `若上面是 EACCES / EPERM，用 sudo 手工装一次再回来重试：sudo npm install -g ${NPM_PACKAGE}`);
				throw new Error(`npm 安装失败（退出码 ${code}）：${NPM_PACKAGE}`);
			}
			cli = await probeCli();
			if (!cli.found) throw new Error("npm 报告安装成功，但 PATH 上仍然找不到 codegraph");
		} else {
			pushLine(run, "note", `已安装 codegraph ${cli.version ?? "(版本未知)"}：${cli.path ?? "PATH"}`);
		}
		const cliVersion = cli.version;
		const cliPath = cli.path ?? SERVER_NAME;

		pushLine(run, "step", "2/4 判断当前 CLI 是否认识 dsh 目标");
		const supports = await supportsDshTarget();
		let wiredByCli = false;
		if (supports) {
			pushLine(run, "note", "CLI 自带 dsh target，交给 codegraph install 处理");
			const code = await runStreaming(run, "codegraph install -y -l global -t dsh", { timeoutMs: 5 * 60 * 1000 });
			if (code === 0) {
				const state = await wiringState(home);
				wiredByCli = state.configured;
				if (!wiredByCli) pushLine(run, "note", "codegraph install 退出成功，但没有写入 codegraph 行，改用插件内置写入");
			} else {
				pushLine(run, "note", `codegraph install 退出码 ${code}，改用插件内置写入`);
			}
		} else {
			pushLine(run, "note", `npm 版 codegraph ${cliVersion ?? ""} 还没有 dsh target（上游 2026-10-30 才加入），由插件直接写 DSH 接线`);
		}

		if (!wiredByCli) {
			pushLine(run, "step", "3/4 写入 DSH 的 MCP 接线");
			await this.writeWiring(run, home, cliPath);
		} else {
			pushLine(run, "step", "3/4 写入 DSH 的 MCP 接线（由 CLI 完成）");
			await this.writeInstructions(run, home);
		}

		pushLine(run, "step", "4/4 校验");
		const state = await wiringState(home);
		if (!state.configured) throw new Error(`接线校验失败：${path.join(home, PATCH_FILE)} 里没有 codegraph 行`);
		pushLine(run, "ok", `codegraph MCP 已接入：${state.home.patchPath}`);
		pushLine(run, "note", "新开一个会话后生效（若 dsh-hmr 已关闭，需要重启 DSH）。");
	}

	/**
	 * Write the patch row and the instructions block directly.
	 *
	 * @param {object} run - Run record receiving the log.
	 * @param {string} home - Absolute DSH home.
	 * @param {string} command - Executable the MCP client must spawn.
	 * @returns {Promise<void>} resolution after both files are written.
	 */
	async writeWiring(run, home, command) {
		const state = await wiringState(home);
		const elsewhere = state.profiles.filter((entry) => entry.configured);
		if (elsewhere.length > 0) {
			pushLine(run, "note", `profile 里已有接线，跳过本 home 的写入：${elsewhere.map((entry) => entry.patchPath).join(", ")}`);
		} else {
			const patchPath = state.home.patchPath;
			const current = (await readText(patchPath)) ?? "";
			const edit = insertServerRow(current, command);
			if (edit.action !== "unchanged") {
				await mkdir(path.dirname(patchPath), { recursive: true });
				await writeFile(patchPath, edit.text, "utf8");
				pushLine(run, "note", `${edit.action === "created" ? "新建" : "追加"}接线：${patchPath}`);
			} else {
				pushLine(run, "note", `接线已存在：${patchPath}`);
			}
		}
		await this.writeInstructions(run, home);
	}

	/**
	 * Upsert the CodeGraph instructions block in `$DSH_HOME/AGENTS.md`.
	 *
	 * @param {object} run - Run record receiving the log.
	 * @param {string} home - Absolute DSH home.
	 * @returns {Promise<void>} resolution after the file is written.
	 */
	async writeInstructions(run, home) {
		const file = path.join(home, INSTRUCTIONS_FILE);
		const current = await readText(file);
		if (current === null) {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, `${INSTRUCTIONS_BLOCK}\n`, "utf8");
			pushLine(run, "note", `新建说明文件：${file}`);
			return;
		}
		const edit = upsertInstructions(current);
		if (edit.action === "unchanged") {
			pushLine(run, "note", `说明块已存在：${file}`);
			return;
		}
		await writeFile(file, edit.text, "utf8");
		pushLine(run, "note", `${edit.action === "created" ? "追加" : "更新"}说明块：${file}`);
	}

	/**
	 * Remove the MCP row, then optionally the global CLI.
	 *
	 * @param {object} run - Run record receiving the log.
	 * @returns {Promise<void>} resolution when the wiring is gone.
	 */
	async runUninstall(run) {
		const home = dshHome();
		pushLine(run, "step", "1/3 检查 codegraph CLI");
		const cli = await probeCli();
		if (cli.found) pushLine(run, "note", `已安装 codegraph ${cli.version ?? "(版本未知)"}：${cli.path ?? "PATH"}`);
		else pushLine(run, "note", "PATH 上没有 codegraph，只清理配置文件");

		pushLine(run, "step", "2/3 移除 DSH 的 MCP 接线");
		let removedByCli = false;
		if (cli.found && (await supportsDshTarget())) {
			const code = await runStreaming(run, "codegraph uninstall -y -l global -t dsh", { timeoutMs: 5 * 60 * 1000 });
			const state = await wiringState(home);
			removedByCli = code === 0 && !state.configured;
			if (!removedByCli) pushLine(run, "note", "CLI 没有清干净（或该版本不含 dsh target），继续按插件内置方式清理");
		}
		if (!removedByCli) await this.clearWiring(run, home);

		pushLine(run, "step", "3/3 校验");
		const state = await wiringState(home);
		if (state.configured) throw new Error("卸载校验失败：仍能找到 codegraph MCP 行");
		pushLine(run, "ok", "codegraph MCP 接线已移除");
		if (run.removeCli) {
			if (!cli.found) {
				pushLine(run, "note", "PATH 上本来就没有 codegraph，跳过 CLI 卸载");
			} else {
				pushLine(run, "step", `移除全局 CLI：npm uninstall -g ${NPM_PACKAGE}`);
				const code = await runStreaming(run, `npm uninstall -g ${NPM_PACKAGE}`, { timeoutMs: 5 * 60 * 1000 });
				if (code !== 0) pushLine(run, "note", `npm uninstall 退出码 ${code}，CLI 可能仍在 PATH 上`);
			}
		}
		pushLine(run, "note", "新开一个会话后生效（若 dsh-hmr 已关闭，需要重启 DSH）。");
	}

	/**
	 * Remove the patch rows and the instructions block from this home.
	 *
	 * @param {object} run - Run record receiving the log.
	 * @param {string} home - Absolute DSH home.
	 * @returns {Promise<void>} resolution after both files are edited.
	 */
	async clearWiring(run, home) {
		const state = await wiringState(home);
		if (state.home.configured) {
			const patchPath = state.home.patchPath;
			const current = (await readText(patchPath)) ?? "";
			const edit = removeServerRows(current);
			if (edit.action === "removed") {
				await writeFile(patchPath, edit.text, "utf8");
				pushLine(run, "note", `已移除接线：${patchPath}`);
			}
		}
		for (const profile of state.profiles) {
			if (!profile.configured) continue;
			const current = (await readText(profile.patchPath)) ?? "";
			const edit = removeServerRows(current);
			if (edit.action !== "removed") continue;
			await writeFile(profile.patchPath, edit.text, "utf8");
			pushLine(run, "note", `已移除 profile 接线：${profile.patchPath}`);
		}
		if (state.instructions.present) {
			const file = state.instructions.path;
			const current = (await readText(file)) ?? "";
			const edit = removeInstructions(current);
			if (edit.action === "removed") {
				if (edit.text.trim() === "") {
					await rm(file, { force: true });
					pushLine(run, "note", `说明文件已空，删除：${file}`);
				} else {
					await writeFile(file, edit.text, "utf8");
					pushLine(run, "note", `已移除说明块：${file}`);
				}
			}
		}
	}
}

declareRemote(CodegraphInstallService, "status");
declareRemote(CodegraphInstallService, "start");
declareRemote(CodegraphInstallService, "poll");
declareRemote(CodegraphInstallService, "cancel");
declareRemote(CodegraphInstallService, "forget");

export { CodegraphInstallService, CodegraphInstallService as default };
