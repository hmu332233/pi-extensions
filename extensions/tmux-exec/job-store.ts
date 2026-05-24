import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TmuxJobPaths, TmuxMeta, TmuxMode, TmuxStatus } from "./schema";

export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_TAIL_LINES = 200;

export interface CreateJobInput {
	name?: string;
	command: string;
	cwd: string;
	workspaceRoot: string;
	mode: TmuxMode;
	keepPane: boolean;
	timeoutMs: number | null;
	env?: Record<string, string>;
	session: string;
	startedBy?: string;
	request?: string;
}

export interface CreatedJob {
	meta: TmuxMeta;
	jobDir: string;
	commandPath: string;
	userCommandPath: string;
	paths: TmuxJobPaths;
}

export function runsRoot(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "tmux-runs");
}

export function slugify(input: string, fallback = "job"): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || fallback;
}

export function shortHash(input: string): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 6);
}

export function makeSessionName(workspaceRoot: string): string {
	const base = slugify(path.basename(workspaceRoot), "workspace").slice(0, 32);
	return `pi-tmux-${base}-${shortHash(workspaceRoot)}`;
}

export function makeJobId(name: string, now = new Date()): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/T/, "-")
		.replace(/\..+$/, "");
	return `${stamp}-${slugify(name)}-${randomBytes(3).toString("hex")}`;
}

export function makeWindowName(name: string, jobId: string): string {
	const suffix = jobId.slice(-6);
	return `${slugify(name).slice(0, 36)}-${suffix}`;
}

export function ensureInsideWorkspace(workspaceRoot: string, candidate: string): string {
	const resolved = path.resolve(workspaceRoot, candidate || ".");
	assertInside(workspaceRoot, resolved, candidate);
	return resolved;
}

export async function ensureInsideWorkspaceReal(workspaceRoot: string, candidate: string): Promise<string> {
	const resolved = ensureInsideWorkspace(workspaceRoot, candidate);
	const [realWorkspace, realCandidate] = await Promise.all([realpath(workspaceRoot), realpath(resolved)]);
	assertInside(realWorkspace, realCandidate, candidate);
	return resolved;
}

export function toRelative(workspaceRoot: string, absolutePath: string): string {
	const relative = path.relative(workspaceRoot, absolutePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : absolutePath;
}

export function pathsFor(workspaceRoot: string, jobId: string): { jobDir: string; paths: TmuxJobPaths } {
	const jobDir = path.join(runsRoot(workspaceRoot), jobId);
	return {
		jobDir,
		paths: {
			jobDir: toRelative(workspaceRoot, jobDir),
			stdout: toRelative(workspaceRoot, path.join(jobDir, "stdout.log")),
			stderr: toRelative(workspaceRoot, path.join(jobDir, "stderr.log")),
		},
	};
}

export async function createJob(input: CreateJobInput): Promise<CreatedJob> {
	await mkdir(runsRoot(input.workspaceRoot), { recursive: true });

	const name = slugify(input.name || input.command.split(/\s+/).slice(0, 3).join("-"));
	const id = makeJobId(name);
	const window = makeWindowName(name, id);
	const { jobDir, paths } = pathsFor(input.workspaceRoot, id);
	await mkdir(jobDir, { recursive: true });

	const now = new Date().toISOString();
	const meta: TmuxMeta = {
		id,
		name,
		command: input.command,
		cwd: input.cwd,
		createdAt: now,
		startedAt: null,
		finishedAt: null,
		mode: input.mode,
		status: "created",
		tmux: {
			session: input.session,
			window,
			pane: null,
		},
		pid: null,
		timeoutMs: input.timeoutMs,
		keepPane: input.keepPane,
		stdoutPath: paths.stdout,
		stderrPath: paths.stderr,
		startedBy: input.startedBy,
		request: input.request,
	};

	await writeFile(path.join(jobDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
	await writeFile(path.join(jobDir, "status"), "created\n", "utf8");
	await writeFile(path.join(jobDir, "stdout.log"), "", "utf8");
	await writeFile(path.join(jobDir, "stderr.log"), "", "utf8");

	const userCommandPath = path.join(jobDir, "user-command.sh");
	await writeFile(userCommandPath, `${input.command}\n`, "utf8");
	await chmod(userCommandPath, 0o700);

	const commandPath = path.join(jobDir, "command.sh");
	await writeFile(commandPath, buildWrapperScript({ jobDir, cwd: input.cwd, keepPane: input.keepPane, env: input.env ?? {} }), "utf8");
	await chmod(commandPath, 0o700);

	return { meta, jobDir, commandPath, userCommandPath, paths };
}

export async function updateMeta(workspaceRoot: string, meta: TmuxMeta): Promise<void> {
	const { jobDir } = pathsFor(workspaceRoot, meta.id);
	await writeFile(path.join(jobDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

export async function readMeta(workspaceRoot: string, jobId: string): Promise<TmuxMeta> {
	const { jobDir } = pathsFor(workspaceRoot, jobId);
	const raw = await readFile(path.join(jobDir, "meta.json"), "utf8");
	return JSON.parse(raw) as TmuxMeta;
}

export async function listJobDirs(workspaceRoot: string): Promise<Array<{ jobId: string; absolutePath: string; mtimeMs: number | null }>> {
	const root = runsRoot(workspaceRoot);
	try {
		await access(root, fsConstants.R_OK);
	} catch {
		return [];
	}

	const entries = await readdir(root, { withFileTypes: true });
	const dirs: Array<{ jobId: string; absolutePath: string; mtimeMs: number | null }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const absolutePath = path.join(root, entry.name);
		dirs.push({ jobId: entry.name, absolutePath, mtimeMs: await statMtimeMs(absolutePath) });
	}
	return dirs.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
}

export async function listMetas(workspaceRoot: string): Promise<TmuxMeta[]> {
	const metas: TmuxMeta[] = [];
	for (const entry of await listJobDirs(workspaceRoot)) {
		try {
			metas.push(await readMeta(workspaceRoot, entry.jobId));
		} catch {
			// Ignore incomplete or malformed job dirs; cleanup can handle them later.
		}
	}
	return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function removeJobDir(workspaceRoot: string, jobId: string): Promise<void> {
	const { jobDir } = pathsFor(workspaceRoot, jobId);
	await rm(jobDir, { recursive: true, force: true });
}

export async function fileExists(file: string): Promise<boolean> {
	try {
		await access(file, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function readTextIfExists(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

export async function writeStatus(workspaceRoot: string, jobId: string, status: TmuxStatus): Promise<void> {
	const { jobDir } = pathsFor(workspaceRoot, jobId);
	await writeFile(path.join(jobDir, "status"), `${status}\n`, "utf8");
}

export async function readStatusFile(workspaceRoot: string, jobId: string): Promise<TmuxStatus> {
	const { jobDir } = pathsFor(workspaceRoot, jobId);
	const raw = (await readTextIfExists(path.join(jobDir, "status")))?.trim();
	if (isTmuxStatus(raw)) return raw;
	return "unknown";
}

export async function readExitCode(workspaceRoot: string, jobId: string): Promise<number | null> {
	const { jobDir } = pathsFor(workspaceRoot, jobId);
	const raw = (await readTextIfExists(path.join(jobDir, "exit_code")))?.trim();
	if (!raw) return null;
	const code = Number.parseInt(raw, 10);
	return Number.isFinite(code) ? code : null;
}

export function isTmuxStatus(value: unknown): value is TmuxStatus {
	return typeof value === "string" && ["created", "running", "done", "failed", "killed", "timeout", "orphaned", "unknown"].includes(value);
}

export function isTerminalStatus(status: TmuxStatus): boolean {
	return ["done", "failed", "killed", "timeout", "orphaned"].includes(status);
}

export async function markFinished(workspaceRoot: string, meta: TmuxMeta, status: TmuxStatus): Promise<TmuxMeta> {
	const now = new Date().toISOString();
	meta.status = status;
	meta.finishedAt = meta.finishedAt || now;
	await writeStatus(workspaceRoot, meta.id, status);
	const { jobDir } = pathsFor(workspaceRoot, meta.id);
	await writeFile(path.join(jobDir, "finished_at"), `${meta.finishedAt}\n`, "utf8");
	await updateMeta(workspaceRoot, meta);
	return meta;
}

export function pidAlive(pid: number | null | undefined): boolean | null {
	if (!pid || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM" ? true : false;
	}
}

export async function statMtimeMs(file: string): Promise<number | null> {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return null;
	}
}

export async function readOutput(workspaceRoot: string, jobId: string, stream: "stdout" | "stderr", tailLines = DEFAULT_TAIL_LINES, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
	const { jobDir } = pathsFor(workspaceRoot, jobId);
	const file = path.join(jobDir, stream === "stdout" ? "stdout.log" : "stderr.log");
	const text = (await readTextIfExists(file)) ?? "";
	return tailText(text, tailLines, maxBytes);
}

export async function readCombinedOutput(workspaceRoot: string, jobId: string, tailLines = DEFAULT_TAIL_LINES, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
	const stdout = await readOutput(workspaceRoot, jobId, "stdout", tailLines, maxBytes);
	const stderr = await readOutput(workspaceRoot, jobId, "stderr", tailLines, maxBytes);
	return [`[stdout]`, stdout || "(empty)", ``, `[stderr]`, stderr || "(empty)"].join("\n");
}

export function tailText(text: string, tailLines = DEFAULT_TAIL_LINES, maxBytes = DEFAULT_MAX_BYTES): string {
	const safeTailLines = Math.max(1, Math.floor(tailLines || DEFAULT_TAIL_LINES));
	const safeMaxBytes = Math.max(1024, Math.floor(maxBytes || DEFAULT_MAX_BYTES));
	const lines = text.split(/\r?\n/);
	const lineTrimmed = lines.length > safeTailLines;
	let sliced = lines.slice(Math.max(0, lines.length - safeTailLines)).join("\n");
	let byteTrimmed = false;
	const bytes = Buffer.byteLength(sliced, "utf8");
	if (bytes > safeMaxBytes) {
		const buffer = Buffer.from(sliced, "utf8");
		sliced = buffer.subarray(Math.max(0, buffer.length - safeMaxBytes)).toString("utf8");
		byteTrimmed = true;
	}
	if (lineTrimmed || byteTrimmed) {
		const reasons = [lineTrimmed ? `last ${safeTailLines} lines` : undefined, byteTrimmed ? `last ${safeMaxBytes} bytes` : undefined].filter(Boolean).join(" and ");
		sliced = `[tmux-exec] output truncated to ${reasons}; full log remains in the job directory\n${sliced}`;
	}
	return sliced;
}

export function attachCommand(meta: TmuxMeta): string {
	return `tmux attach -t ${meta.tmux.session}`;
}

function assertInside(workspaceRoot: string, candidate: string, original: string): void {
	const relative = path.relative(workspaceRoot, candidate);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`cwd must stay inside workspace: ${original}`);
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildWrapperScript(input: { jobDir: string; cwd: string; keepPane: boolean; env: Record<string, string> }): string {
	const envExports = Object.entries(input.env)
		.map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return "";
			return `export ${key}=${shellQuote(value)}`;
		})
		.filter(Boolean)
		.join("\n");

	return `#!/usr/bin/env bash
set -uo pipefail

JOB_DIR=${shellQuote(input.jobDir)}
USER_COMMAND="$JOB_DIR/user-command.sh"
KEEP_PANE=${input.keepPane ? "1" : "0"}

cd ${shellQuote(input.cwd)} || exit 127

printf '%s\n' "running" > "$JOB_DIR/status"
date -u +%Y-%m-%dT%H:%M:%SZ > "$JOB_DIR/started_at"
echo "$$" > "$JOB_DIR/pid"
${envExports}

set +e
(
  JOB_DIR="$JOB_DIR" bash -lc 'source "$JOB_DIR/user-command.sh"'
) > >(tee -a "$JOB_DIR/stdout.log") \
  2> >(tee -a "$JOB_DIR/stderr.log" >&2)
code=$?
set -e

echo "$code" > "$JOB_DIR/exit_code"
date -u +%Y-%m-%dT%H:%M:%SZ > "$JOB_DIR/finished_at"

if [ "$code" -eq 0 ]; then
  printf '%s\n' "done" > "$JOB_DIR/status"
else
  printf '%s\n' "failed" > "$JOB_DIR/status"
fi

touch "$JOB_DIR/done"

if [ "$KEEP_PANE" = "1" ]; then
  echo
  echo "[tmux-exec] job finished with exit code $code"
  echo "[tmux-exec] logs: $JOB_DIR"
  exec "\${SHELL:-/bin/sh}"
fi

exit "$code"
`;
}
