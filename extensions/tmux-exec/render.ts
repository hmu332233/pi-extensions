import type { TmuxJobStatus } from "./schema";
import type { RunJobResult } from "./runner";

export function jobSummary(status: TmuxJobStatus): string {
	const exit = status.exitCode === null ? "" : ` exit ${status.exitCode}`;
	const pane = status.tmux.pane ? ` pane ${status.tmux.pane}` : "";
	return `${status.status}${exit} · ${status.name} · ${status.jobId}${pane}`;
}

export function runResultText(result: RunJobResult): string {
	const lines = [
		`tmux job ${result.jobId}: ${result.status}`,
		`session: ${result.tmux.session}`,
		`window: ${result.tmux.window}`,
		`pane: ${result.tmux.pane ?? ""}`,
		`attach: ${result.attachCommand}`,
		`stdout: ${result.paths.stdout}`,
		`stderr: ${result.paths.stderr}`,
	];
	if (result.exitCode !== null) lines.push(`exitCode: ${result.exitCode}`);
	if (result.timedOut) lines.push("wait: timed out; job may still be running");
	if (result.stdoutTail !== undefined) lines.push("", "stdout tail:", result.stdoutTail || "(empty)");
	if (result.stderrTail !== undefined) lines.push("", "stderr tail:", result.stderrTail || "(empty)");
	return lines.join("\n");
}

export function statusResultText(status: TmuxJobStatus): string {
	return [
		`tmux job ${status.jobId}: ${status.status}`,
		`name: ${status.name}`,
		`exitCode: ${status.exitCode ?? ""}`,
		`startedAt: ${status.startedAt ?? ""}`,
		`finishedAt: ${status.finishedAt ?? ""}`,
		`paneAlive: ${status.tmuxPaneAlive ?? "unknown"}`,
		`pidAlive: ${status.pidAlive ?? "unknown"}`,
		`session: ${status.tmux.session}`,
		`window: ${status.tmux.window}`,
		`pane: ${status.tmux.pane ?? ""}`,
		`attach: ${status.attachCommand}`,
	].join("\n");
}

export function readResultText(input: { jobId: string; stream: string; output: string }): string {
	return [`tmux job ${input.jobId} ${input.stream} output:`, input.output || "(empty)"].join("\n");
}

export function captureResultText(input: { jobId: string; warning: string; capture: string }): string {
	return [`tmux job ${input.jobId} pane capture`, input.warning, "", input.capture || "(empty)"].join("\n");
}
