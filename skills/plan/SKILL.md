---
name: plan
description: 구현 전에 작업 계획을 세워 달라는 요청이 있을 때 사용합니다. 모호한 요구사항을 먼저 명확히 하고, 관련 프로젝트 파일을 검토한 뒤, 기존 계획 파일을 덮어쓰지 않고 현재 작업 디렉토리의 .plan 아래에 신중하고 최소한이며 검증 가능한 Markdown 계획을 새로 작성합니다.
disable-model-invocation: true
---

# Plan Skill

Use this skill for `/skill:plan <requirement>` requests. This is a planning workflow, not an implementation workflow.

Bias toward caution over speed. For trivial requests, use judgment, but do not silently assume important details.

## Primary Outcome

Create a new Markdown plan file under `.plan/` in the current working directory after the requirement is clear and relevant project context has been reviewed.

The plan should help avoid common coding mistakes by making assumptions, tradeoffs, scope, success criteria, and verification explicit before implementation begins.

## Non-Negotiable Rules

1. Do not implement the requested change while running this skill.
2. Do not create a `.plan` file until material ambiguity is resolved.
3. If something important is unclear, stop, name what is unclear, and ask concise clarifying questions.
4. If multiple plausible interpretations exist, present them instead of choosing silently.
5. Never overwrite, replace, or truncate existing plan files unless the user explicitly asks to modify that exact file.
6. Use `write` only for new plan files. Use `edit` on existing plan files only when explicitly requested.
7. `.plan/` is relative to the current working directory where Pi is running, not relative to this skill's package directory.

## Workflow

### 1. Think Before Planning

Before reading many files or writing a plan, inspect the user's request for:

- missing target project, feature, command, behavior, or files
- missing constraints, non-goals, compatibility requirements, or deadlines
- missing validation or acceptance criteria
- multiple plausible interpretations
- requests that appear broader or more complex than necessary

If details are missing and material to the plan:

1. State the uncertainty plainly.
2. Ask the minimum number of clarifying questions.
3. Stop. Do not create a plan file yet.

If the request is clear enough to plan safely:

- State any assumptions in the plan.
- Surface relevant tradeoffs.
- Prefer the simplest approach that satisfies the request.
- Push back in the plan if a requested approach appears unnecessarily complex or risky.

### 2. Review Context Surgically

After ambiguity is resolved, inspect only the files needed to create a concrete plan.

Guidelines:

- Search/list files to locate the relevant area.
- Read relevant files before proposing code changes.
- Do not inspect unrelated areas just because they are nearby.
- Do not propose refactors, cleanup, formatting changes, or abstractions unrelated to the request.
- If unrelated dead code or issues are noticed, mention them as out of scope instead of planning to change them.
- Record every reviewed path in the plan under `Context Reviewed` with a short reason.

### 3. Plan for Simplicity

The plan must describe the minimum work needed to satisfy the clarified requirement.

Avoid:

- features beyond what was requested
- abstractions for single-use code
- speculative flexibility or configurability
- broad refactors
- error handling for impossible or irrelevant scenarios
- cleanup of code not touched by the requested change

Every planned change should trace directly to the user's request. If a step does not trace to the request, remove it or mark it explicitly as optional/out of scope.

### 4. Make Success Verifiable

Transform the task into concrete, verifiable goals.

For each meaningful plan step, include a verification check when possible:

```text
- [ ] 1. <step> → verify: <check>
```

Examples:

- `Add validation` → `write or update tests for invalid inputs, then make them pass`
- `Fix bug` → `reproduce with a test or command, then verify it passes`
- `Refactor` → `confirm tests pass before and after`

If success criteria are weak or unknowable from the request, ask for clarification before creating the plan.

## Plan File Creation

### Directory

Create `.plan/` in the current working directory if it does not exist.

Before writing a plan file:

1. Inspect existing `.plan` files.
2. Check for filename collisions.
3. Choose a unique filename.

### Filename Rule

Use this pattern:

```text
.plan/YYYY-MM-DD-HHMM-<slug>.md
```

Examples:

```text
.plan/2026-05-04-1530-add-plan-skill.md
.plan/2026-05-04-1530-add-plan-skill-2.md
.plan/2026-05-04-1530-add-plan-skill-3.md
```

Rules:

- Use the current local date and time for `YYYY-MM-DD-HHMM`.
- Create a short lowercase kebab-case slug from the clarified requirement.
- If the filename exists, append `-2`, `-3`, and so on until a unique filename is found.
- Do not reuse an existing filename unless the user explicitly requested overwriting that exact file.

## Plan Document Template

Use this Markdown structure:

```md
---
title: <short title>
createdAt: <ISO timestamp>
status: planned
source: /skill:plan
---

# <Title>

## Original Request

<user's original request>

## Clarified Requirement

<refined and actionable requirement>

## Assumptions

- <explicit assumption, or "None">

## Ambiguities Resolved

- <resolved ambiguity or decision, or "None">

## Tradeoffs / Pushback

- <tradeoff, simpler alternative, or reason no pushback is needed>

## Context Reviewed

- `<path>` — <why it was reviewed>

## Plan

- [ ] 1. <minimal step> → verify: <check>
- [ ] 2. <minimal step> → verify: <check>
- [ ] 3. <minimal step> → verify: <check>

## Out of Scope

- <related work intentionally not included, or "None">

## Risks / Considerations

- <risk or consideration>

## Validation

- <overall validation method>
```

Keep `## Plan` as a Markdown task list so later tooling can parse it.

## Response After Creating the Plan

After writing the new plan file, respond with:

- the path of the created plan file
- a brief summary of the clarified scope
- key assumptions or tradeoffs
- validation notes

Do not start implementation unless the user separately asks for it.
