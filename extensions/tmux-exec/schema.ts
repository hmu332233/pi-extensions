import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TMUX_TOOL_NAMES = [
	"tmux_run",
	"tmux_status",
	"tmux_read",
	"tmux_capture",
	"tmux_wait",
	"tmux_kill",
] as const;

export const TERMINAL_STATUSES = ["done", "failed", "killed", "timeout", "orphaned"] as const;
export const ALL_STATUSES = ["created", "running", ...TERMINAL_STATUSES, "unknown"] as const;

export type TmuxStatus = (typeof ALL_STATUSES)[number];
export type TmuxMode = "oneshot" | "long_running" | "interactive";
export type TmuxStream = "stdout" | "stderr" | "combined";

export interface TmuxTarget {
	session: string;
	window: string;
	pane: string | null;
}

export interface TmuxMeta {
	id: string;
	name: string;
	command: string;
	cwd: string;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	mode: TmuxMode;
	status: TmuxStatus;
	tmux: TmuxTarget;
	pid: number | null;
	timeoutMs: number | null;
	keepPane: boolean;
	stdoutPath: string;
	stderrPath: string;
	startedBy?: string;
	request?: string;
}

export interface TmuxJobStatus {
	jobId: string;
	name: string;
	status: TmuxStatus;
	exitCode: number | null;
	tmuxPaneAlive: boolean | null;
	pidAlive: boolean | null;
	startedAt: string | null;
	finishedAt: string | null;
	cwd: string;
	tmux: TmuxTarget;
	paths: TmuxJobPaths;
	attachCommand: string;
	startedBy?: string;
	request?: string;
}

export interface TmuxJobPaths {
	jobDir: string;
	stdout: string;
	stderr: string;
}

export interface TmuxRunParams {
	name?: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	mode?: TmuxMode;
	wait?: boolean;
	timeoutMs?: number;
	keepPane?: boolean;
	maxOutputBytes?: number;
	tailLines?: number;
}

export interface TmuxReadParams {
	jobId: string;
	stream?: TmuxStream;
	tailLines?: number;
	maxBytes?: number;
}

export interface TmuxWaitParams {
	jobId: string;
	timeoutMs?: number;
	tailLines?: number;
	maxBytes?: number;
}

export interface TmuxCaptureParams {
	jobId: string;
	lines?: number;
}

export interface TmuxKillParams {
	jobId: string;
	signal?: "TERM" | "KILL" | "INT";
	killPane?: boolean;
}

export const TmuxRunParamsSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Human-friendly job name. Defaults to a slug from command." })),
	command: Type.String({ description: "Shell command to run inside a tmux job." }),
	cwd: Type.Optional(Type.String({ description: "Working directory relative to the current workspace. Defaults to the workspace root." })),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional environment variables for the command." })),
	mode: Type.Optional(StringEnum(["oneshot", "long_running", "interactive"] as const)),
	wait: Type.Optional(Type.Boolean({ description: "Wait for completion before returning. Useful for oneshot commands." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum time to wait in milliseconds. Wait timeout does not kill the job; call tmux_kill if needed." })),
	keepPane: Type.Optional(Type.Boolean({ description: "Keep the tmux pane open after command completion. Defaults to true." })),
	maxOutputBytes: Type.Optional(Type.Number({ description: "Maximum output bytes included in the tool result tail." })),
	tailLines: Type.Optional(Type.Number({ description: "Number of stdout/stderr tail lines included in the tool result." })),
});

export const TmuxStatusParamsSchema = Type.Object({
	jobId: Type.String({ description: "tmux-exec job id." }),
});

export const TmuxReadParamsSchema = Type.Object({
	jobId: Type.String({ description: "tmux-exec job id." }),
	stream: Type.Optional(StringEnum(["stdout", "stderr", "combined"] as const)),
	tailLines: Type.Optional(Type.Number({ description: "Tail this many lines. Defaults to 200." })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes returned. Defaults to 50000." })),
});

export const TmuxCaptureParamsSchema = Type.Object({
	jobId: Type.String({ description: "tmux-exec job id." }),
	lines: Type.Optional(Type.Number({ description: "Number of screen lines to capture. Defaults to 200." })),
});

export const TmuxWaitParamsSchema = Type.Object({
	jobId: Type.String({ description: "tmux-exec job id." }),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum time to wait in milliseconds. Defaults to 60000." })),
	tailLines: Type.Optional(Type.Number({ description: "Tail this many lines in the result. Defaults to 100." })),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes returned per stream tail. Defaults to 50000." })),
});

export const TmuxKillParamsSchema = Type.Object({
	jobId: Type.String({ description: "tmux-exec job id." }),
	signal: Type.Optional(StringEnum(["TERM", "KILL", "INT"] as const)),
	killPane: Type.Optional(Type.Boolean({ description: "Kill the tmux pane after interrupting the process. Defaults to true." })),
});
