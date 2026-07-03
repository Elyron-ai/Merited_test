Execute the next iteration of the Merited build loop. Argument (optional) = max tasks this iteration, default 3: $ARGUMENTS

Follow CLAUDE.md's rules throughout. For this iteration:

1. **Orient.** Read `BUILD-PLAN.md` §4.2 (calendar) and the current workstream sections. Determine the current phase and week from task states already marked in the plan. If `docs/build-log.md` exists, read its last two entries to pick up any carried-over context or blockers.

2. **Select** the next task: the first task in calendar/dependency order whose dependencies are all ✅ done and whose state is not ✅/⛔. Prefer the critical-path task; if it is blocked on something in-flight, pull from the filler lanes named in §4.1/§4.2. State which task you selected and why before writing code.

3. **Study before building.** Re-read the task's full row in its workstream section (§5–§6) AND every BUILD-SPEC section it cites. The Accept clause is the definition of done — quote it.

4. **Build** the task: implementation + the tests its Accept clause demands (write tests alongside, not after). Match the repo's existing idioms. All types from `packages/contracts`. No scope beyond the task row — adjacent improvements go in the build log as suggestions, not code.

5. **Verify**: run the task's own tests, then the workspace suite (`pnpm -r build && pnpm -r test && pnpm lint`, or the closest available subset before FND-16 exists), plus any integration/E2E suites the task touches. Everything green before proceeding. If the task is in a high-scrutiny zone (XC.7), do the security self-review per CLAUDE.md.

6. **Record**: mark the task ✅ in `BUILD-PLAN.md` (same commit), append the `docs/build-log.md` entry, commit as `feat(TASK-ID): <summary>`, and push to the current branch.

7. **Repeat** from step 2 until: the max task count for this iteration is reached, a phase-gate boundary is hit, or you are blocked on a founder-only question. Never cross a phase gate — instead run the gate checklist (BUILD-PLAN §8, XC.5), record the results in `docs/gates/`, and stop.

8. **Report** at the end: tasks completed (IDs + one line each), current position in the calendar, test-suite status, anything blocked and why, and the single next task the following iteration will start with.

If the working tree is dirty or the last build-log entry says a task was left 🚧 doing, finish or cleanly park that task first before selecting a new one.
