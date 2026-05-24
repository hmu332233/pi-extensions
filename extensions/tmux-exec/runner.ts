import path from "node:path";
import {
	attachCommand,
	createJob,
	DEFAULT_MAX_BYTES,
	DEFAULT_TAIL_LINES,
	ensureInsideWorkspaceReal,
	fileExists,
	isTerminalStatus,
	listJobDirs,
	listMetas,
	makeSessionName,
	markFinished,
	pathsFor,
	pidAlive,
	readCombinedOutput,
	readExitCode,
	readMeta,
	readOutput,
	readStatusFile,
	readTextIfExists,
	removeJobDir,
	updateMeta,
	writeStatus,
} from "./job-store";
import type { TmuxCaptureParams, TmuxJobStatus, TmuxKillParams, TmuxMeta, TmuxReadParams, TmuxRunParams, TmuxStatus, TmuxWaitParams } from "./schema";
import { capturePane, checkTmuxAvailable, ensureSession, type ExecFn, killPane, killProcess, newJobWindow, paneAlive, sendCtrlC } from "./tmux";

export interface RunnerContext {
	workspaceRoot: string;
	exec: ExecFn;
	signal?: AbortSignal;
	startedBy?: string;
	request?: string;
}

export interface RunJobResult extends TmuxJobStatus {
	paths: {
		jobDir: string;
		stdout: string;
		stderr: string;
	};
	stdoutTail?: string;
	stderrTail?: string;
	timedOut?: boolean;
	waitTimedOut?: boolean;
}

const MAX_RUNNING_JOBS = 8;
const MAX_LONG_RUNNING_JOBS = 4;

export async function runJob(ctx: RunnerContext, params: TmuxRunParams): Promise<RunJobResult> {
	if (!params.command.trim()) throw new Error("command is required");
	await checkTmuxAvailable(ctx.exec, ctx.signal);

	const cwd = await ensureInsideWorkspaceReal(ctx.workspaceRoot, params.cwd ?? ".");
	const mode = params.mode ?? "oneshot";
	await assertRunningJobLimit(ctx, mode);
	const keepPane = params.keepPane ?? true;
	const timeoutMs = params.timeoutMs ?? null;
	const session = makeSessionName(ctx.workspaceRoot);
	const name = params.name || params.command.split(/\s+/).slice(0, 3).join("-");

	const created = await createJob({
		name,
		command: params.command,
		cwd,
		workspaceRoot: ctx.workspaceRoot,
		mode,
		keepPane,
		timeoutMs,
		env: params.env,
		session,
		startedBy: ctx.startedBy,
		request: ctx.request,
	});

	await ensureSession(ctx.exec, session, ctx.workspaceRoot, ctx.signal);
	const pane = await newJobWindow(ctx.exec, {
		session,
		window: created.meta.tmux.window,
		cwd,
		commandPath: created.commandPath,
		signal: ctx.signal,
	});

	created.meta.tmux.pane = pane;
	created.meta.status = "running";
	await writeStatus(ctx.workspaceRoot, created.meta.id, "running");
	await updateMeta(ctx.workspaceRoot, created.meta);

	if (params.wait) {
		const waited = await waitForJob(ctx, {
			jobId: created.meta.id,
			timeoutMs: timeoutMs ?? undefined,
			tailLines: params.tailLines ?? 100,
			maxBytes: params.maxOutputBytes,
		});
		return { ...waited, paths: created.paths };
	}

	return getJobStatus(ctx, created.meta.id);
}

export async function getJobStatus(ctx: RunnerContext, jobId: string): Promise<TmuxJobStatus> {
	const meta = await refreshMetaFromFiles(ctx, await readMeta(ctx.workspaceRoot, jobId));
	const exitCode = await readExitCode(ctx.workspaceRoot, jobId);
	const statusFile = await readStatusFile(ctx.workspaceRoot, jobId);
	const paneIsAlive = await paneAlive(ctx.exec, meta.tmux.pane, ctx.signal);
	const pidIsAlive = pidAlive(meta.pid);
	const { jobDir, paths } = pathsFor(ctx.workspaceRoot, jobId);
	const doneExists = await fileExists(path.join(jobDir, "done"));

	const status = reconcileStatus({
		statusFile,
		exitCode,
		doneExists,
		finishedAt: meta.finishedAt,
		paneIsAlive,
		pidIsAlive,
	});

	if (meta.status !== status) {
		meta.status = status;
		await writeStatus(ctx.workspaceRoot, jobId, status);
		await updateMeta(ctx.workspaceRoot, meta);
	}

	return {
		jobId,
		name: meta.name,
		status,
		exitCode,
		tmuxPaneAlive: paneIsAlive,
		pidAlive: pidIsAlive,
		startedAt: meta.startedAt,
		finishedAt: meta.finishedAt,
		cwd: meta.cwd,
		tmux: meta.tmux,
		paths,
		attachCommand: attachCommand(meta),
		startedBy: meta.startedBy,
		request: meta.request,
	};
}

export async function readJob(ctx: RunnerContext, params: TmuxReadParams): Promise<{ jobId: string; stream: string; output: string; paths: { jobDir: string; stdout: string; stderr: string } }> {
	const stream = params.stream ?? "stdout";
	const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
	const tailLines = params.tailLines ?? DEFAULT_TAIL_LINES;
	await readMeta(ctx.workspaceRoot, params.jobId);
	const output =
		stream === "combined"
			? await readCombinedOutput(ctx.workspaceRoot, params.jobId, tailLines, maxBytes)
			: await readOutput(ctx.workspaceRoot, params.jobId, stream, tailLines, maxBytes);
	return { jobId: params.jobId, stream, output, paths: pathsFor(ctx.workspaceRoot, params.jobId).paths };
}

export async function captureJob(ctx: RunnerContext, params: TmuxCaptureParams): Promise<{ jobId: string; warning: string; capture: string; status: TmuxJobStatus }> {
	const status = await getJobStatus(ctx, params.jobId);
	if (!status.tmux.pane) throw new Error(`job has no tmux pane: ${params.jobId}`);
	const capture = await capturePane(ctx.exec, status.tmux.pane, params.lines ?? 200, ctx.signal);
	return {
		jobId: params.jobId,
		warning: "capture-pane output is for observation only. Use tmux_read for reliable stdout/stderr.",
		capture,
		status,
	};
}

export async function waitForJob(ctx: RunnerContext, params: TmuxWaitParams): Promise<RunJobResult> {
	const timeoutMs = params.timeoutMs ?? 60_000;
	const started = Date.now();
	let current = await getJobStatus(ctx, params.jobId);

	while (!isTerminalStatus(current.status)) {
		if (ctx.signal?.aborted) throw new Error("tmux wait aborted");
		if (Date.now() - started >= timeoutMs) {
			const stdoutTail = await readOutput(ctx.workspaceRoot, params.jobId, "stdout", params.tailLines ?? 100, params.maxBytes ?? DEFAULT_MAX_BYTES);
			const stderrTail = await readOutput(ctx.workspaceRoot, params.jobId, "stderr", params.tailLines ?? 100, params.maxBytes ?? DEFAULT_MAX_BYTES);
			return { ...current, stdoutTail, stderrTail, timedOut: true, waitTimedOut: true };
		}
		await sleep(500);
		current = await getJobStatus(ctx, params.jobId);
	}

	const stdoutTail = await readOutput(ctx.workspaceRoot, params.jobId, "stdout", params.tailLines ?? 100, params.maxBytes ?? DEFAULT_MAX_BYTES);
	const stderrTail = await readOutput(ctx.workspaceRoot, params.jobId, "stderr", params.tailLines ?? 100, params.maxBytes ?? DEFAULT_MAX_BYTES);
	return { ...current, stdoutTail, stderrTail, timedOut: false };
}

export async function killJob(ctx: RunnerContext, params: TmuxKillParams): Promise<TmuxJobStatus> {
	const meta = await readMeta(ctx.workspaceRoot, params.jobId);
	const current = await getJobStatus(ctx, params.jobId);
	const killPaneToo = params.killPane ?? true;

	if (isTerminalStatus(current.status)) {
		if (killPaneToo && current.tmux.pane && current.tmuxPaneAlive) {
			await killPane(ctx.exec, current.tmux.pane, ctx.signal);
		}
		return getJobStatus(ctx, params.jobId);
	}

	if (current.tmux.pane && current.tmuxPaneAlive) {
		await sendCtrlC(ctx.exec, current.tmux.pane, ctx.signal);
		await sleep(800);
		if (killPaneToo && (await paneAlive(ctx.exec, current.tmux.pane, ctx.signal))) {
			await killPane(ctx.exec, current.tmux.pane, ctx.signal);
		}
	}

	if (meta.pid && pidAlive(meta.pid)) {
		await killProcess(meta.pid, params.signal ?? "TERM");
	}

	await markFinished(ctx.workspaceRoot, meta, "killed");
	return getJobStatus(ctx, params.jobId);
}

export async function cleanupJobs(
	ctx: RunnerContext,
	input: { olderThanHours?: number; includeRunning?: boolean; dryRun?: boolean },
): Promise<{ dryRun: boolean; removed: string[]; candidates: Array<{ jobId: string; name: string; status: TmuxStatus; ageHours: number; jobDir: string; malformed?: boolean }> }> {
	const olderThanHours = input.olderThanHours ?? 24;
	const includeRunning = input.includeRunning ?? false;
	const dryRun = input.dryRun ?? true;
	const cutoffMs = Date.now() - olderThanHours * 60 * 60 * 1000;
	const candidates: Array<{ jobId: string; name: string; status: TmuxStatus; ageHours: number; jobDir: string; malformed?: boolean }> = [];

	for (const dir of await listJobDirs(ctx.workspaceRoot)) {
		let meta: TmuxMeta | undefined;
		try {
			meta = await readMeta(ctx.workspaceRoot, dir.jobId);
		} catch {
			const oldEnough = dir.mtimeMs === null ? true : dir.mtimeMs <= cutoffMs;
			if (!oldEnough) continue;
			const { paths } = pathsFor(ctx.workspaceRoot, dir.jobId);
			candidates.push({
				jobId: dir.jobId,
				name: "malformed",
				status: "unknown",
				ageHours: dir.mtimeMs === null ? Number.POSITIVE_INFINITY : (Date.now() - dir.mtimeMs) / 3_600_000,
				jobDir: paths.jobDir,
				malformed: true,
			});
			continue;
		}

		const status = await getJobStatus(ctx, meta.id);
		const time = Date.parse(status.finishedAt || meta.createdAt);
		const oldEnough = Number.isFinite(time) ? time <= cutoffMs : true;
		if (!oldEnough) continue;
		if (!includeRunning && !isTerminalStatus(status.status)) continue;
		const { paths } = pathsFor(ctx.workspaceRoot, meta.id);
		candidates.push({
			jobId: meta.id,
			name: meta.name,
			status: status.status,
			ageHours: Number.isFinite(time) ? (Date.now() - time) / 3_600_000 : Number.POSITIVE_INFINITY,
			jobDir: paths.jobDir,
		});
	}

	const removed: string[] = [];
	if (!dryRun) {
		for (const candidate of candidates) {
			await removeJobDir(ctx.workspaceRoot, candidate.jobId);
			removed.push(candidate.jobId);
		}
	}

	return { dryRun, removed, candidates };
}

export async function listJobsWithStatus(ctx: RunnerContext): Promise<TmuxJobStatus[]> {
	const metas = await listMetas(ctx.workspaceRoot);
	const statuses: TmuxJobStatus[] = [];
	for (const meta of metas) {
		statuses.push(await getJobStatus(ctx, meta.id));
	}
	return statuses;
}

async function assertRunningJobLimit(ctx: RunnerContext, mode: TmuxRunParams["mode"]): Promise<void> {
	const metas = await listMetas(ctx.workspaceRoot);
	const running: Array<{ id: string; name: string; mode: string; status: TmuxStatus }> = [];
	for (const meta of metas) {
		const status = await getJobStatus(ctx, meta.id);
		if (!isTerminalStatus(status.status)) {
			running.push({ id: meta.id, name: meta.name, mode: meta.mode, status: status.status });
		}
	}

	if (running.length >= MAX_RUNNING_JOBS) {
		throw new Error(formatLimitError(`running job limit reached (${running.length}/${MAX_RUNNING_JOBS})`, running));
	}

	if (mode === "long_running" || mode === "interactive") {
		const longRunning = running.filter((job) => job.mode === "long_running" || job.mode === "interactive");
		if (longRunning.length >= MAX_LONG_RUNNING_JOBS) {
			throw new Error(formatLimitError(`long-running job limit reached (${longRunning.length}/${MAX_LONG_RUNNING_JOBS})`, longRunning));
		}
	}
}

function formatLimitError(message: string, jobs: Array<{ id: string; name: string; mode: string; status: TmuxStatus }>): string {
	const shown = jobs.slice(0, 8).map((job) => `- ${job.id} ${job.status} ${job.mode} ${job.name}`).join("\n");
	return `${message}. Stop jobs with /tmux kill <job-id> or inspect them with /tmux jobs.\n${shown}`;
}

function reconcileStatus(input: {
	statusFile: TmuxStatus;
	exitCode: number | null;
	doneExists: boolean;
	finishedAt: string | null;
	paneIsAlive: boolean | null;
	pidIsAlive: boolean | null;
}): TmuxStatus {
	if (input.statusFile === "killed" || input.statusFile === "timeout") return input.statusFile;
	if (input.exitCode !== null) return input.exitCode === 0 ? "done" : "failed";
	if (input.statusFile === "done" || input.statusFile === "failed" || input.statusFile === "orphaned") return input.statusFile;
	if (input.doneExists && input.statusFile !== "unknown") return input.statusFile;
	if (input.finishedAt) return "orphaned";
	if ((input.statusFile === "running" || input.statusFile === "created") && input.paneIsAlive === false && input.pidIsAlive !== true) return "orphaned";
	if (input.statusFile === "running" && input.pidIsAlive === false && input.paneIsAlive !== true) return "orphaned";
	if (input.statusFile === "unknown") return input.paneIsAlive ? "running" : "unknown";
	return input.statusFile;
}

async function refreshMetaFromFiles(ctx: RunnerContext, meta: TmuxMeta): Promise<TmuxMeta> {
	const { jobDir } = pathsFor(ctx.workspaceRoot, meta.id);
	const startedAt = (await readTextIfExists(path.join(jobDir, "started_at")))?.trim() || null;
	const finishedAt = (await readTextIfExists(path.join(jobDir, "finished_at")))?.trim() || null;
	const pidText = (await readTextIfExists(path.join(jobDir, "pid")))?.trim();
	const pid = pidText ? Number.parseInt(pidText, 10) : null;

	let changed = false;
	if (startedAt && meta.startedAt !== startedAt) {
		meta.startedAt = startedAt;
		changed = true;
	}
	if (finishedAt && meta.finishedAt !== finishedAt) {
		meta.finishedAt = finishedAt;
		changed = true;
	}
	if (pid && meta.pid !== pid) {
		meta.pid = pid;
		changed = true;
	}
	if (changed) await updateMeta(ctx.workspaceRoot, meta);
	return meta;
}

export function formatStatusLine(status: TmuxJobStatus): string {
	const exit = status.exitCode === null ? "" : ` exit=${status.exitCode}`;
	const pane = status.tmux.pane ? ` pane=${status.tmux.pane}` : "";
	return `${status.jobId} ${status.status}${exit} ${status.name}${pane}`;
}

export function formatJobDetails(status: TmuxJobStatus): string {
	return [
		`job: ${status.jobId}`,
		`name: ${status.name}`,
		`status: ${status.status}`,
		`exitCode: ${status.exitCode ?? ""}`,
		`cwd: ${status.cwd}`,
		`tmux session: ${status.tmux.session}`,
		`tmux window: ${status.tmux.window}`,
		`tmux pane: ${status.tmux.pane ?? ""}`,
		`pane alive: ${status.tmuxPaneAlive ?? "unknown"}`,
		`pid alive: ${status.pidAlive ?? "unknown"}`,
		`startedAt: ${status.startedAt ?? ""}`,
		`finishedAt: ${status.finishedAt ?? ""}`,
		`stdout: ${status.paths.stdout}`,
		`stderr: ${status.paths.stderr}`,
		`attach: ${status.attachCommand}`,
	].join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
