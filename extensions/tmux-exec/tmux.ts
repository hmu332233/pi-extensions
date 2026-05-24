export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed?: boolean;
}

export type ExecFn = (
	command: string,
	args?: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number; env?: Record<string, string> },
) => Promise<ExecResult>;

export async function checkTmuxAvailable(exec: ExecFn, signal?: AbortSignal): Promise<string> {
	const result = await exec("tmux", ["-V"], { signal, timeout: 5000 });
	if (result.code !== 0) {
		throw new Error(`tmux is not available: ${result.stderr || result.stdout || `exit ${result.code}`}`);
	}
	return result.stdout.trim() || "tmux";
}

export async function ensureSession(exec: ExecFn, session: string, cwd: string, signal?: AbortSignal): Promise<void> {
	const has = await exec("tmux", ["has-session", "-t", session], { signal, timeout: 5000 });
	if (has.code === 0) return;

	const created = await exec("tmux", ["new-session", "-d", "-s", session, "-n", "control", "-c", cwd], {
		signal,
		timeout: 5000,
	});
	if (created.code !== 0) {
		throw new Error(`failed to create tmux session ${session}: ${created.stderr || created.stdout}`);
	}
}

export async function newJobWindow(exec: ExecFn, input: { session: string; window: string; cwd: string; commandPath: string; signal?: AbortSignal }): Promise<string> {
	const command = `bash ${shellQuote(input.commandPath)}`;
	const result = await exec(
		"tmux",
		["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", input.session, "-n", input.window, "-c", input.cwd, command],
		{ signal: input.signal, timeout: 5000 },
	);
	if (result.code !== 0) {
		throw new Error(`failed to create tmux window: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

export async function paneAlive(exec: ExecFn, pane: string | null | undefined, signal?: AbortSignal): Promise<boolean | null> {
	if (!pane) return null;
	const result = await exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { signal, timeout: 5000 });
	if (result.code !== 0) return false;
	return result.stdout.split(/\r?\n/).includes(pane);
}

export async function capturePane(exec: ExecFn, pane: string, lines: number, signal?: AbortSignal): Promise<string> {
	const start = `-${Math.max(1, Math.floor(lines))}`;
	const result = await exec("tmux", ["capture-pane", "-p", "-t", pane, "-S", start], { signal, timeout: 5000 });
	if (result.code !== 0) {
		throw new Error(`failed to capture tmux pane ${pane}: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

export async function sendCtrlC(exec: ExecFn, pane: string, signal?: AbortSignal): Promise<void> {
	const result = await exec("tmux", ["send-keys", "-t", pane, "C-c"], { signal, timeout: 5000 });
	if (result.code !== 0) {
		throw new Error(`failed to send C-c to pane ${pane}: ${result.stderr || result.stdout}`);
	}
}

export async function killPane(exec: ExecFn, pane: string, signal?: AbortSignal): Promise<void> {
	const result = await exec("tmux", ["kill-pane", "-t", pane], { signal, timeout: 5000 });
	if (result.code !== 0) {
		throw new Error(`failed to kill tmux pane ${pane}: ${result.stderr || result.stdout}`);
	}
}

export async function killProcess(pid: number, signalName: "TERM" | "KILL" | "INT"): Promise<boolean> {
	try {
		process.kill(pid, `SIG${signalName}`);
		return true;
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
