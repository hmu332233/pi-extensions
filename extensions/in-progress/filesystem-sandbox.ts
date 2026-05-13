/**
 * Filesystem Sandbox Extension
 *
 * Controls pi's built-in file tools with path policy checks and replaces the
 * agent `bash` tool with an OS-sandboxed implementation. `user_bash` is
 * intentionally left untouched.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool, isToolCallEventType } from "@mariozechner/pi-coding-agent";

const ALLOW_WRITE_PATHS = [".", "/tmp", "/private/tmp"] as const;
const DENY_READ_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;
const DENY_SENSITIVE_FILE_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "*credential*", "*secret*"] as const;

// 도구 입력 경로를 cwd 기준의 절대 경로로 변환한다.
function resolvePolicyPath(inputPath: string, cwd: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith("~/")) return path.resolve(homedir(), inputPath.slice(2));
	return path.resolve(cwd, inputPath);
}

// 정책에 적힌 경로를 cwd 기준의 절대 경로로 변환한다.
function resolveConfiguredPath(configuredPath: string, cwd: string): string {
	if (configuredPath === "~") return homedir();
	if (configuredPath.startsWith("~/")) return path.resolve(homedir(), configuredPath.slice(2));
	return path.resolve(cwd, configuredPath);
}

// 이미 존재하는 경로의 symlink를 실제 경로로 해소한다.
function canonicalizeExistingPath(targetPath: string): string {
	return realpathSync.native(targetPath);
}

// 새 파일 경로도 가장 가까운 기존 parent를 기준으로 canonical target으로 바꾼다.
function canonicalizeTargetPath(targetPath: string): string {
	const absoluteTarget = path.resolve(targetPath);
	let current = absoluteTarget;
	const missingParts: string[] = [];

	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		missingParts.push(path.basename(current));
		current = parent;
	}

	const canonicalParent = existsSync(current) ? canonicalizeExistingPath(current) : current;
	return path.resolve(canonicalParent, ...missingParts.reverse());
}

// 쓰기 허용 root 목록을 canonical path 기준으로 계산한다.
function getAllowWriteRoots(cwd: string): string[] {
	const roots = new Set<string>();

	for (const configuredPath of ALLOW_WRITE_PATHS) {
		const resolved = resolveConfiguredPath(configuredPath, cwd);
		roots.add(canonicalizeTargetPath(resolved));

		if (resolved === "/tmp" && existsSync("/tmp")) {
			roots.add(canonicalizeExistingPath("/tmp"));
		}
	}

	return [...roots];
}

// 읽기 차단 root 목록을 canonical path 기준으로 계산한다.
function getDenyReadRoots(cwd: string): string[] {
	return DENY_READ_PATHS.map((configuredPath) => canonicalizeTargetPath(resolveConfiguredPath(configuredPath, cwd)));
}

// child가 parent 자체이거나 그 하위 경로인지 path boundary를 지켜 확인한다.
function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// 민감 파일명 패턴이 read/write deny에 걸리는지 확인한다.
function matchesSensitiveFilePattern(targetPath: string): boolean {
	const basename = path.basename(targetPath);
	return DENY_SENSITIVE_FILE_PATTERNS.some((pattern) => globPatternMatchesBasename(pattern, basename));
}

// 고정 정책의 단순 basename glob 패턴을 검사한다.
function globPatternMatchesBasename(pattern: string, basename: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(basename);
}

// 쓰기 대상이 허용된 root 내부이고 민감 파일명이 아닌지 확인한다.
function isWriteAllowed(targetPath: string, cwd: string): boolean {
	const canonicalTarget = canonicalizeTargetPath(targetPath);
	if (matchesSensitiveFilePattern(canonicalTarget)) return false;
	return getAllowWriteRoots(cwd).some((root) => isPathInside(root, canonicalTarget));
}

// 읽기 대상이 민감 파일명 또는 차단 root 내부인지 확인한다.
function isReadDenied(targetPath: string, cwd: string): boolean {
	const canonicalTarget = canonicalizeTargetPath(targetPath);
	if (matchesSensitiveFilePattern(canonicalTarget)) return true;
	return getDenyReadRoots(cwd).some((root) => isPathInside(root, canonicalTarget));
}

// 차단 결과를 UI 알림과 tool_call block 응답으로 통일한다.
function blockToolCall(reason: string, ctx: ExtensionContext): ToolCallEventResult {
	if (ctx.hasUI) ctx.ui.notify(reason, "warning");
	return { block: true, reason };
}

// 파일 도구별 path policy를 실행 전 선검증한다.
function evaluateFileToolPolicy(event: ToolCallEvent, cwd: string): string | undefined {
	if (isToolCallEventType("write", event) && !isWriteAllowed(resolvePolicyPath(event.input.path, cwd), cwd)) {
		return `write blocked by filesystem sandbox: ${event.input.path}`;
	}

	if (isToolCallEventType("edit", event)) {
		const target = resolvePolicyPath(event.input.path, cwd);
		if (!isWriteAllowed(target, cwd)) return `edit blocked by filesystem sandbox write policy: ${event.input.path}`;
		if (isReadDenied(target, cwd)) return `edit blocked by filesystem sandbox read policy: ${event.input.path}`;
	}

	if (isToolCallEventType("read", event) && isReadDenied(resolvePolicyPath(event.input.path, cwd), cwd)) {
		return `read blocked by filesystem sandbox: ${event.input.path}`;
	}

	if (isToolCallEventType("grep", event)) {
		const targetPath = event.input.path ?? ".";
		if (isReadDenied(resolvePolicyPath(targetPath, cwd), cwd)) return `grep blocked by filesystem sandbox: ${targetPath}`;
	}

	if (isToolCallEventType("find", event)) {
		const targetPath = event.input.path ?? ".";
		if (isReadDenied(resolvePolicyPath(targetPath, cwd), cwd)) return `find blocked by filesystem sandbox: ${targetPath}`;
	}

	if (isToolCallEventType("ls", event)) {
		const targetPath = event.input.path ?? ".";
		if (isReadDenied(resolvePolicyPath(targetPath, cwd), cwd)) return `ls blocked by filesystem sandbox: ${targetPath}`;
	}

	return undefined;
}

// agent bash 프로세스 트리를 sandbox-runtime으로 감싼다.
function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				const timeoutHandle = timeout && timeout > 0 ? setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				}, timeout * 1000) : undefined;

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (error) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(error);
				});

				const onAbort = () => {
					if (!child.pid) return;
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

// extension 진입점에서 파일 도구 정책과 sandboxed bash override를 등록한다.
export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxInitialized = false;
	let bashBlockReason = "Filesystem sandbox has not been initialized yet.";

	pi.registerTool({
		...localBash,
		label: "bash (filesystem sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxInitialized) throw new Error(bashBlockReason);

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const reason = evaluateFileToolPolicy(event, ctx.cwd);
		if (reason) return blockToolCall(reason, ctx);
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxInitialized = false;
			bashBlockReason = `Filesystem sandbox is not supported on ${platform}.`;
			ctx.ui.notify(bashBlockReason, "warning");
			return;
		}

		try {
			await SandboxManager.initialize({
				filesystem: {
					denyRead: [...DENY_READ_PATHS, ...DENY_SENSITIVE_FILE_PATTERNS],
					allowWrite: [...ALLOW_WRITE_PATHS],
					denyWrite: [...DENY_SENSITIVE_FILE_PATTERNS],
				},
				network: {},
			} as SandboxRuntimeConfig);

			sandboxInitialized = true;
			bashBlockReason = "";
			ctx.ui.setStatus("filesystem-sandbox", ctx.ui.theme.fg("accent", "🔒 FS sandbox"));
			ctx.ui.notify("Filesystem sandbox initialized", "info");
		} catch (error) {
			sandboxInitialized = false;
			bashBlockReason = `Filesystem sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(bashBlockReason, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (!sandboxInitialized) return;
		try {
			await SandboxManager.reset();
		} finally {
			sandboxInitialized = false;
			bashBlockReason = "Filesystem sandbox has been shut down.";
		}
	});
}
