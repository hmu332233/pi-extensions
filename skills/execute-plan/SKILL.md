---
name: execute-plan
description: 명시적으로 호출되었을 때 기존 plan Markdown을 실제 작업으로 실행합니다. plan을 끝까지 읽고, 필요한 파일만 확인한 뒤 최소 변경으로 구현하며, 명확하고 저위험인 project-local 검증은 바로 실행하고 그 외 검증/후속 탐색/도구 설치/범위 확장은 확인받습니다.
---

# Execute Plan Skill

This skill is intended for explicit invocation, for example:

- `/skill:execute-plan .plan/2026-...md`

It is an execution workflow for an existing plan document. Bias toward following the plan exactly, making minimal targeted changes, running obvious low-risk project-local validation when immediately available, and asking before unclear validation or scope expansion.

## Primary Outcome

Implement the plan document in the current working directory with the smallest safe set of changes, then report what changed, which immediate validation ran, and what validation remains pending if any.

## Non-Negotiable Rules

1. Read the referenced plan document fully before changing files.
2. Do not implement work that is outside the plan unless the user explicitly approves it.
3. Inspect only files clearly needed to execute the plan.
4. Do not edit, overwrite, or update the plan document unless the user explicitly asks for progress updates or checklist/status changes.
5. Treat broad exploration, cleanup, dependency/vendor inspection, tool installation, config changes, and follow-up improvements as separate from implementation.
6. Run validation without asking only when the exact action is obvious, low-risk, project-local, and does not require network access, installation, deep discovery, or likely file/external state changes.
7. If validation or any next step is unclear, invasive, costly, may modify state, may access the network, may inspect dependency/vendor/generated/cache directories, or may expand scope, stop and ask the user with concise options.

## Workflow

### 1. Load and Understand the Plan

1. Read the plan document completely.
2. Identify:
   - requested outcome
   - assumptions and resolved ambiguities
   - files or areas mentioned in `Context Reviewed`
   - plan checklist items
   - out-of-scope items
   - validation section
3. If the plan is missing, unreadable, internally contradictory, stale, or materially ambiguous, stop and ask for clarification.

Do not start implementation until the plan is understood.

### 2. Restate Scope Briefly

Before making changes, briefly state the intended implementation scope when useful, especially if:

- the plan is non-trivial
- the request says “그대로” or “exactly”
- there are risks or tradeoffs in the plan
- the plan's validation step may require a gated decision later

Keep this short. Do not turn it into a new planning phase.

### 3. Inspect Context Surgically

Inspect only project-local files needed for the planned changes.

Allowed by default:

- files explicitly named in the plan
- nearby files needed to match style or APIs
- obvious project metadata such as `package.json`, README, or config files when directly relevant

Do not inspect by default:

- `node_modules/`, vendor directories, generated artifacts, caches, build output
- unrelated source areas
- parent directories or external paths
- secrets or credential locations

If deeper inspection seems necessary, stop and ask with options.

### 4. Implement Minimally

Apply the planned changes with minimal, targeted edits.

Guidelines:

- Prefer the existing project style.
- Avoid opportunistic refactors.
- Avoid formatting unrelated code.
- Avoid changing public behavior beyond the plan.
- Do not add abstractions, options, or generic frameworks unless the plan explicitly requires them.
- If implementation reveals the plan is wrong or incomplete, stop and explain the mismatch instead of improvising broadly.

### 5. Validation Decision Workflow

After implementation, run validation immediately only when it is obvious, low-risk, and project-local.

Immediate validation is allowed when all of the following are true:

- the exact command or check is explicit in the plan or immediately obvious from nearby project-local files
- it does not require network access, dependency installation, or new tooling
- it does not require inspecting dependency/vendor/generated/cache/build-output directories
- it is unlikely to modify files, lockfiles, snapshots, caches, external services, or external state
- it does not require broad exploration or expand the plan scope

Examples of signals that may identify immediate validation:

- plan document validation notes
- clearly relevant `package.json` scripts
- `tsconfig.json` / `jsconfig.json`
- existing test/lint/build configs
- README instructions that are directly relevant and already reviewed

If one clear safe validation action exists, run it and report the result.

If multiple plausible validation actions exist, validation appears non-trivial, or no immediate validation path is apparent, do not search deeply just to invent one. Stop and ask the user to choose from concise options.

Example response:

```text
구현은 완료했습니다. 바로 실행해도 안전한 단일 검증 경로는 확정하지 못했습니다.
가능한 선택지는:
1. 검증 생략, 수동 확인 절차만 안내
2. 기존 project-local 명령 실행: <command>
3. 가벼운 파일/구문 확인만 수행
4. 추가 탐색/도구 설치/네트워크 사용 기반 검증 — 명시 승인 필요
어떻게 진행할까요?
```

### 6. Prohibited Without Explicit Approval

Do not do any of the following unless the user explicitly approves that specific action:

- install dependencies or run network-based tools
- run validation or commands likely to modify files, lockfiles, caches outside the workspace, or external state
- add validation tooling or project config solely for this task
- inspect `node_modules`, vendor, generated, cache, or build-output directories for validation discovery
- read or write files outside the current working directory
- perform broad cleanup, refactoring, migration, or unrelated fixes
- attempt to reproduce every detail of an internal/private implementation when a public API satisfies the plan

### 7. Report Results

After implementation and any validation that was run or deferred, report concisely:

- plan file executed
- files changed
- checklist items completed at a high level
- validation run, skipped, or pending
- if validation was skipped/unavailable, why
- recommended manual verification steps

## Response Style

Be concise and explicit. Prefer Korean when the user's request is in Korean.

Do not apologize unless something actually went wrong. If a boundary or confirmation gate is hit, explain the reason and provide options.
