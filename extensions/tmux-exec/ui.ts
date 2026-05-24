import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTerminalStatus } from "./job-store";
import { jobSummary } from "./render";
import { listJobsWithStatus, type RunnerContext } from "./runner";
import type { TmuxJobStatus } from "./schema";

export async function updateTmuxUi(ctx: ExtensionContext, runner: RunnerContext, scopedMode: boolean, scopedRequest?: string): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const jobs = await listJobsWithStatus(runner);
		const running = jobs.filter((job) => !isTerminalStatus(job.status));
		const statusText = scopedMode
			? `tmux: scoped${running.length ? ` · ${running.length} running` : ""}`
			: running.length
				? `tmux: ${running.length} running`
				: undefined;
		ctx.ui.setStatus("tmux-exec", statusText);

		if (!scopedMode && running.length === 0) {
			ctx.ui.setWidget("tmux-exec", undefined);
			return;
		}

		const lines: string[] = [];
		lines.push(scopedMode ? "TMUX SCOPED MODE" : "TMUX JOBS");
		if (scopedRequest) lines.push(`request: ${truncate(scopedRequest, 100)}`);
		const shown = [...running, ...jobs.filter((job) => isTerminalStatus(job.status)).slice(0, 3)].slice(0, 6);
		if (shown.length === 0) {
			lines.push("no tmux jobs yet");
		} else {
			for (const job of shown) {
				lines.push(...formatWidgetJob(job));
			}
		}
		ctx.ui.setWidget("tmux-exec", lines);
	} catch (error) {
		ctx.ui.setStatus("tmux-exec", `tmux: ${(error as Error).message}`);
	}
}

export function formatJobsList(jobs: TmuxJobStatus[]): string {
	if (jobs.length === 0) return "No tmux jobs found.";
	return jobs.map((job) => jobSummary(job)).join("\n");
}

export function jobSelectLabel(job: TmuxJobStatus): string {
	const req = job.startedBy || job.request;
	const suffix = req ? ` · ${truncate(req.replace(/\s+/g, " "), 60)}` : "";
	return `${job.status.padEnd(8)} ${job.name} · ${job.jobId} · ${job.tmux.session} · ${job.tmux.pane ?? "no-pane"}${suffix}`;
}

function formatWidgetJob(job: TmuxJobStatus): string[] {
	const marker = isTerminalStatus(job.status) ? (job.status === "done" ? "✓" : "×") : "●";
	const req = job.startedBy || job.request;
	const attach = `attach: ${job.attachCommand}`;
	const main = `${marker} ${job.name} ${job.status} session ${job.tmux.session} pane ${job.tmux.pane ?? ""}`;
	return req ? [main, `  started by: ${truncate(req, 90)}`, `  ${attach}`] : [main, `  ${attach}`];
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
