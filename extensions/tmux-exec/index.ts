import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import {
	TmuxCaptureParamsSchema,
	TmuxKillParamsSchema,
	TmuxReadParamsSchema,
	TmuxRunParamsSchema,
	TMUX_TOOL_NAMES,
	TmuxStatusParamsSchema,
	TmuxWaitParamsSchema,
	type TmuxJobStatus,
} from "./schema";
import { captureResultText, readResultText, runResultText, statusResultText } from "./render";
import { isTerminalStatus } from "./job-store";
import {
	captureJob,
	cleanupJobs,
	formatJobDetails,
	getJobStatus,
	killJob,
	listJobsWithStatus,
	readJob,
	runJob,
	waitForJob,
	type RunnerContext,
} from "./runner";
import { formatJobsList, jobSelectLabel, updateTmuxUi } from "./ui";

const SCOPED_GUIDANCE = [
	"You are now in scoped tmux task mode.",
	"Use tmux_* tools automatically when useful for this request.",
	"Prefer bash/read/grep for short deterministic work.",
	"Prefer tmux_run/status/read/wait/capture for long-running, watch, dev server, interactive/TUI, parallel, or human-handoff work.",
	"Use tmux_read or tmux_wait for reliable stdout/stderr. tmux_capture is observation-only and must not be treated as parseable stdout.",
	"Do not use tmux_kill unless the user asked to stop a job or a tmux job clearly needs cleanup.",
].join("\n");

const ADMIN_COMMANDS = new Set(["jobs", "status", "read", "capture", "wait", "kill", "cleanup", "attach", "done", "run"]);

export default function tmuxExecExtension(pi: ExtensionAPI) {
	let scopedTmuxMode = false;
	let previousTools: string[] | undefined;
	let currentScopedRequest: string | undefined;

	function runner(ctx: ExtensionContext, overrides?: { startedBy?: string; request?: string }): RunnerContext {
		return {
			workspaceRoot: ctx.cwd,
			exec: (command, args = [], options = {}) => pi.exec(command, args, options),
			signal: ctx.signal,
			startedBy: overrides?.startedBy ?? currentScopedRequest,
			request: overrides?.request ?? currentScopedRequest,
		};
	}

	function withoutTmuxTools(names: string[]): string[] {
		return names.filter((name) => !TMUX_TOOL_NAMES.includes(name as (typeof TMUX_TOOL_NAMES)[number]));
	}

	function deactivateTmuxTools() {
		pi.setActiveTools(withoutTmuxTools(pi.getActiveTools()));
	}

	function openScopedTools() {
		if (!previousTools) previousTools = pi.getActiveTools();
		pi.setActiveTools([...new Set([...previousTools, ...TMUX_TOOL_NAMES])]);
		scopedTmuxMode = true;
	}

	function closeScopedTools() {
		scopedTmuxMode = false;
		currentScopedRequest = undefined;
		if (previousTools) pi.setActiveTools(previousTools);
		else deactivateTmuxTools();
		previousTools = undefined;
	}

	function assertScopedTool(toolName: string) {
		if (!scopedTmuxMode) {
			throw new Error(`${toolName} is only available after starting a scoped /tmux task.`);
		}
	}

	function emit(content: string, details?: Record<string, unknown>) {
		pi.sendMessage({ customType: "tmux-exec", content, display: true, details });
	}

	pi.registerMessageRenderer("tmux-exec", (message, _options, theme) => {
		return new Text(`${theme.fg("accent", theme.bold("tmux-exec"))}\n${message.content}`, 0, 0);
	});

	registerTools(pi, runner, assertScopedTool, async (ctx) => updateTmuxUi(ctx, runner(ctx), scopedTmuxMode, currentScopedRequest));

	pi.on("session_start", async (_event, ctx) => {
		previousTools = undefined;
		scopedTmuxMode = false;
		currentScopedRequest = undefined;
		deactivateTmuxTools();
		await updateTmuxUi(ctx, runner(ctx), false);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (scopedTmuxMode) closeScopedTools();
		await updateTmuxUi(ctx, runner(ctx), scopedTmuxMode, currentScopedRequest);
	});

	pi.registerCommand("tmux", {
		description: "Start a scoped tmux task or manage tmux jobs",
		handler: async (args, ctx) => {
			const parsed = parseTmuxArgs(args);
			if (parsed.kind === "help") {
				emit(helpText());
				return;
			}

			if (parsed.kind === "scope") {
				openScopedTools();
				currentScopedRequest = parsed.request;
				await updateTmuxUi(ctx, runner(ctx), scopedTmuxMode, currentScopedRequest);
				const prompt = `${SCOPED_GUIDANCE}\n\nUser request:\n${parsed.request}`;
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				return;
			}

			await handleAdminCommand(parsed.command, parsed.rest, ctx, emit, runner(ctx, { startedBy: `/tmux ${args}`, request: args }), () => {
				closeScopedTools();
			});
			await updateTmuxUi(ctx, runner(ctx), scopedTmuxMode, currentScopedRequest);
		},
	});
}

function registerTools(
	pi: ExtensionAPI,
	runner: (ctx: ExtensionContext) => RunnerContext,
	assertScopedTool: (toolName: string) => void,
	refreshUi: (ctx: ExtensionContext) => Promise<void>,
) {
	pi.registerTool({
		name: "tmux_run",
		label: "tmux run",
		description: "Run a shell command as a tmux-backed job with file-based stdout/stderr/status logs. Use for long-running, watch, dev server, interactive/TUI, parallel, or human-handoff work.",
		promptSnippet: "Run shell commands in a tmux-backed job with observable logs and attachable pane",
		promptGuidelines: [
			"Use tmux_run for long-running, watch, dev server, interactive/TUI, parallel, or human-handoff commands inside scoped /tmux mode.",
			"Prefer bash for short deterministic commands that only need immediate output.",
		],
		parameters: TmuxRunParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			assertScopedTool("tmux_run");
			onUpdate?.({ content: [{ type: "text", text: "Starting tmux job..." }] });
			const result = await runJob({ ...runner(ctx), signal }, params);
			await refreshUi(ctx);
			return { content: [{ type: "text", text: runResultText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "tmux_status",
		label: "tmux status",
		description: "Get status for a tmux-exec job from the job store, with pane/pid liveness reconciliation.",
		promptSnippet: "Check tmux-exec job status",
		promptGuidelines: ["Use tmux_status to check a tmux job before deciding whether to wait, read logs, capture, or kill it."],
		parameters: TmuxStatusParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertScopedTool("tmux_status");
			const status = await getJobStatus({ ...runner(ctx), signal }, params.jobId);
			await refreshUi(ctx);
			return { content: [{ type: "text", text: statusResultText(status) }], details: status };
		},
	});

	pi.registerTool({
		name: "tmux_read",
		label: "tmux read",
		description: "Read file-backed stdout/stderr logs for a tmux-exec job. This is the reliable way to recover command output.",
		promptSnippet: "Read reliable file-backed stdout/stderr from a tmux job",
		promptGuidelines: ["Use tmux_read, not tmux_capture, when you need reliable stdout/stderr from a tmux job."],
		parameters: TmuxReadParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertScopedTool("tmux_read");
			const result = await readJob({ ...runner(ctx), signal }, params);
			await refreshUi(ctx);
			return { content: [{ type: "text", text: readResultText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "tmux_capture",
		label: "tmux capture",
		description: "Capture the current tmux pane screen for observation only. Do not use this as reliable stdout/stderr.",
		promptSnippet: "Capture current tmux pane screen for observation only",
		promptGuidelines: ["Use tmux_capture only for observation/debugging of a pane; use tmux_read for reliable command output."],
		parameters: TmuxCaptureParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertScopedTool("tmux_capture");
			const result = await captureJob({ ...runner(ctx), signal }, params);
			await refreshUi(ctx);
			return { content: [{ type: "text", text: captureResultText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "tmux_wait",
		label: "tmux wait",
		description: "Wait for a tmux-exec job to reach a terminal status and return stdout/stderr tails. Wait timeout does not kill the job.",
		promptSnippet: "Wait for a tmux job to complete and return log tails",
		promptGuidelines: ["Use tmux_wait for oneshot tmux jobs whose completion you need before answering."],
		parameters: TmuxWaitParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			assertScopedTool("tmux_wait");
			onUpdate?.({ content: [{ type: "text", text: `Waiting for ${params.jobId}...` }] });
			const result = await waitForJob({ ...runner(ctx), signal }, params);
			await refreshUi(ctx);
			return { content: [{ type: "text", text: runResultText(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "tmux_kill",
		label: "tmux kill",
		description: "Stop a tmux-exec job and mark it killed. Use only when the user asks to stop a job or cleanup is clearly required.",
		promptSnippet: "Kill a tmux-exec job",
		promptGuidelines: ["Use tmux_kill only when the user explicitly asks to stop a tmux job or when cleanup is clearly necessary."],
		parameters: TmuxKillParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertScopedTool("tmux_kill");
			const status = await killJob({ ...runner(ctx), signal }, params);
			await refreshUi(ctx);
			return { content: [{ type: "text", text: statusResultText(status) }], details: status };
		},
	});
}

async function handleAdminCommand(
	command: string,
	rest: string,
	ctx: ExtensionCommandContext,
	emit: (content: string, details?: Record<string, unknown>) => void,
	runner: RunnerContext,
	closeScopedTools: () => void,
) {
	switch (command) {
		case "done": {
			closeScopedTools();
			ctx.ui.notify("tmux scoped mode closed", "info");
			return;
		}
		case "jobs": {
			await showJobs(ctx, emit, runner);
			return;
		}
		case "status": {
			const jobId = firstArg(rest);
			if (!jobId) return emit("Usage: /tmux status <job-id>");
			const status = await getJobStatus(runner, jobId);
			emit(statusResultText(status), { status });
			return;
		}
		case "read": {
			const [jobId, stream] = splitArgs(rest);
			if (!jobId) return emit("Usage: /tmux read <job-id> [stdout|stderr|combined]");
			const result = await readJob(runner, { jobId, stream: stream as "stdout" | "stderr" | "combined" | undefined });
			emit(readResultText(result), { result });
			return;
		}
		case "capture": {
			const jobId = firstArg(rest);
			if (!jobId) return emit("Usage: /tmux capture <job-id>");
			const result = await captureJob(runner, { jobId });
			emit(captureResultText(result), { result });
			return;
		}
		case "wait": {
			const [jobId, timeout] = splitArgs(rest);
			if (!jobId) return emit("Usage: /tmux wait <job-id> [timeoutMs]");
			const timeoutMs = timeout ? Number(timeout) : undefined;
			if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) return emit("timeoutMs must be a positive number. Wait timeout does not kill the job.");
			const result = await waitForJob(runner, { jobId, timeoutMs });
			emit(runResultText(result), { result });
			return;
		}
		case "kill": {
			const jobId = firstArg(rest);
			if (!jobId) return emit("Usage: /tmux kill <job-id>");
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Kill tmux job?", `Stop ${jobId} and kill its pane if needed?`);
				if (!ok) return;
			}
			const status = await killJob(runner, { jobId, killPane: true });
			emit(statusResultText(status), { status });
			return;
		}
		case "cleanup": {
			const options = parseCleanupOptions(rest);
			if (!options.dryRun && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Apply tmux cleanup?", "This removes matching .pi/tmux-runs job directories. Running panes are not killed automatically.");
				if (!ok) return;
			}
			const result = await cleanupJobs(runner, options);
			emit(formatCleanupResult(result), { result });
			return;
		}
		case "attach": {
			const jobId = firstArg(rest);
			if (!jobId) return emit("Usage: /tmux attach <job-id>");
			const status = await getJobStatus(runner, jobId);
			emit(formatAttach(status), { status });
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Attach now?", `Temporarily leave Pi and attach to ${status.tmux.session}? Detach from tmux to return.`);
				if (ok) await attachNow(ctx, status.tmux.session);
			}
			return;
		}
		case "run": {
			if (!rest.trim()) return emit("Usage: /tmux run <command>");
			const result = await runJob(runner, { name: "tmux-run", command: rest, mode: "oneshot", wait: false, keepPane: true });
			emit(runResultText(result), { result });
			return;
		}
		default:
			emit(helpText());
	}
}

async function showJobs(ctx: ExtensionCommandContext, emit: (content: string, details?: Record<string, unknown>) => void, runner: RunnerContext) {
	const jobs = await listJobsWithStatus(runner);
	if (!ctx.hasUI || jobs.length === 0) {
		emit(formatJobsList(jobs), { jobs });
		return;
	}

	const labels = jobs.map(jobSelectLabel);
	const selectedLabel = await ctx.ui.select("tmux jobs", labels);
	if (!selectedLabel) return;
	const selected = jobs[labels.indexOf(selectedLabel)];
	if (!selected) return;

	const action = await ctx.ui.select("tmux job action", ["Show details", "Show attach command", "Read stdout", "Read stderr", "Capture pane", "Kill job"]);
	if (!action) return;

	if (action === "Show details") {
		emit(formatJobDetails(selected), { status: selected });
	} else if (action === "Show attach command") {
		emit(formatAttach(selected), { status: selected });
	} else if (action === "Read stdout" || action === "Read stderr") {
		const stream = action === "Read stdout" ? "stdout" : "stderr";
		const result = await readJob(runner, { jobId: selected.jobId, stream });
		emit(readResultText(result), { result });
	} else if (action === "Capture pane") {
		const result = await captureJob(runner, { jobId: selected.jobId });
		emit(captureResultText(result), { result });
	} else if (action === "Kill job") {
		if (isTerminalStatus(selected.status)) {
			emit(`Job is already ${selected.status}: ${selected.jobId}`);
			return;
		}
		const ok = await ctx.ui.confirm("Kill tmux job?", `Stop ${selected.jobId}?`);
		if (!ok) return;
		const status = await killJob(runner, { jobId: selected.jobId, killPane: true });
		emit(statusResultText(status), { status });
	}
}

function parseTmuxArgs(args: string): { kind: "help" } | { kind: "scope"; request: string } | { kind: "admin"; command: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "help" };
	const [command, rest] = splitFirst(trimmed);
	if (command === "start") {
		return rest.trim() ? { kind: "scope", request: rest.trim() } : { kind: "help" };
	}
	if (ADMIN_COMMANDS.has(command)) return { kind: "admin", command, rest };
	return { kind: "scope", request: trimmed };
}

function parseCleanupOptions(rest: string): { olderThanHours?: number; includeRunning?: boolean; dryRun?: boolean } {
	const tokens = splitArgs(rest);
	const options: { olderThanHours?: number; includeRunning?: boolean; dryRun?: boolean } = { dryRun: true };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--apply") options.dryRun = false;
		else if (token === "--include-running") options.includeRunning = true;
		else if (token.startsWith("--older-than=")) options.olderThanHours = Number(token.slice("--older-than=".length));
		else if (token === "--older-than" && tokens[i + 1]) options.olderThanHours = Number(tokens[++i]);
	}
	if (options.olderThanHours !== undefined && (!Number.isFinite(options.olderThanHours) || options.olderThanHours < 0)) {
		options.olderThanHours = 24;
	}
	return options;
}

function formatCleanupResult(result: Awaited<ReturnType<typeof cleanupJobs>>): string {
	const header = result.dryRun ? "tmux cleanup dry-run" : "tmux cleanup applied";
	if (result.candidates.length === 0) return `${header}: no candidates`;
	const lines = result.candidates.map((candidate) => {
		const age = Number.isFinite(candidate.ageHours) ? `${candidate.ageHours.toFixed(1)}h` : "unknown age";
		const marker = candidate.malformed ? " malformed" : "";
		return `- ${candidate.jobId} ${candidate.status}${marker} ${candidate.name} ${age} ${candidate.jobDir}`;
	});
	if (result.removed.length > 0) lines.push("", `removed: ${result.removed.join(", ")}`);
	else if (result.dryRun) lines.push("", "Use /tmux cleanup --apply to remove these job directories.");
	return [header, ...lines].join("\n");
}

function formatAttach(status: TmuxJobStatus): string {
	return [
		`Attach command for ${status.jobId}:`,
		status.attachCommand,
		"",
		`session: ${status.tmux.session}`,
		`window: ${status.tmux.window}`,
		`pane: ${status.tmux.pane ?? ""}`,
		"Detach from tmux to return to Pi (usually Ctrl-b then d).",
	].join("\n");
}

async function attachNow(ctx: ExtensionCommandContext, session: string): Promise<void> {
	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		setTimeout(() => {
			const maybeTui = tui as unknown as { stop?: () => void; start?: () => void };
			try {
				maybeTui.stop?.();
				spawnSync("tmux", ["attach", "-t", session], { stdio: "inherit" });
			} finally {
				maybeTui.start?.();
				done(undefined);
			}
		}, 0);

		return {
			render(width: number) {
				const line = theme.fg("accent", `Attaching to tmux session ${session}...`);
				return [line.slice(0, Math.max(0, width))];
			},
			invalidate() {},
		};
	});
}

function helpText(): string {
	return [
		"tmux-exec commands:",
		"/tmux <request>                 Open scoped tmux mode and delegate the request to the agent",
		"/tmux start <request>           Same as above",
		"/tmux done                      Close scoped tmux mode and restore previous tools",
		"/tmux jobs                      Show recent/running tmux jobs",
		"/tmux status <job-id>           Show job status",
		"/tmux read <job-id> [stream]    Read stdout, stderr, or combined logs",
		"/tmux capture <job-id>          Capture pane screen for observation only",
		"/tmux wait <job-id> [ms]        Wait for job completion; wait timeout does not kill the job",
		"/tmux kill <job-id>             Stop a job",
		"/tmux attach <job-id>           Show attach command, optionally attach now",
		"/tmux cleanup [--older-than H] [--include-running] [--apply]",
		"/tmux run <command>             Directly start a tmux job (debug/admin helper)",
	].join("\n");
}

function splitFirst(input: string): [string, string] {
	const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	return [match?.[1] ?? "", match?.[2] ?? ""];
}

function firstArg(input: string): string | undefined {
	return splitArgs(input)[0];
}

function splitArgs(input: string): string[] {
	return input.trim().split(/\s+/).filter(Boolean);
}
