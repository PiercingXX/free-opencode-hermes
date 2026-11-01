import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";

import { CompletionMemorySyncGuard, getCompletionMemorySyncStatus } from "./memory_runtime.js";
import { evaluateForceSynthesisTrigger } from "./supervisor_runtime.js";
import { SUPERVISOR_TERMINAL_STATUSES } from "./supervisor_store_runtime.js";
import {
  withLockedSession,
  type LockedSession,
  type SupervisorToolDeps,
} from "./supervisor_tool_deps.js";
import {
  applyForceSynthesisOutcome,
  evaluateGoalContractCompletion,
  readTaskStore,
  revokeSessionTaskLeases,
  TASK_TERMINAL_STATUSES,
  withTaskStoreLock,
  writeTaskStore,
  type GoalContract,
} from "./task_runtime.js";
import {
  buildContinuationPrompt,
  buildForceSynthesisPrompt,
  buildLeaseFenceSections,
  buildValidationBlockedChecklist,
  collectForceSynthesisRecordedFacts,
  collectSessionLeaseFences,
  describeValidationBlockers,
  VALIDATION_COULD_NOT_RUN_REASON,
} from "./supervisor_prompts.js";

import { persistForceSynthesisFindings } from "./finding_runtime.js";
import { jsonContent, type JsonToolResult } from "./agent_tool_helpers.js";
import { toolAnnotations } from "./observability_tools.js";

/**
 * Session events that carry a completion-recovery reason. `validation_blocked`
 * is deliberately a SEPARATE type from `validation_failed`: the failed channel
 * is the code-failure channel, and an environment problem must not accumulate
 * there.
 */
const COMPLETION_RECOVERY_EVENT_TYPES = new Set([
  "completion.validation_failed",
  "completion.validation_blocked",
]);

export interface EmitContinuationPromptArgs {
  sessionId: string;
  remainingTasks?: string[];
}

/**
 * Same-lane continuation prompt. Not an MCP tool; compose via the
 * compose-supervisor-prompts skill. Kept as a function so tests and any
 * in-process caller still drive the real formatter and store updates.
 */
export async function emitContinuationPrompt(
  deps: SupervisorToolDeps,
  { sessionId, remainingTasks }: EmitContinuationPromptArgs
): Promise<ReturnType<typeof jsonContent>> {
  return withLockedSession(deps, sessionId, async ({ store, state, reliability }) => {
    const pendingTasks = remainingTasks ?? [];
    const now = Date.now();

    if (deps.isAbortWindowActive(state.abortDetectedAt, now, reliability.abortWindowMs)) {
      return jsonContent({
        status: "cooldown",
        reasonCode: "abort_window_active",
        sessionId,
        continuationCount: state.continuationCount,
        waitMs: reliability.abortWindowMs - (now - (state.abortDetectedAt ?? now)),
      });
    }

    if (state.recoveryInFlight) {
      return jsonContent({
        status: "recovering",
        reasonCode: "retry_in_flight",
        sessionId,
        continuationCount: state.continuationCount,
      });
    }

    const continuationFingerprint = JSON.stringify(pendingTasks);
    const dedupeWindowMs = Math.max(5_000, Math.floor(reliability.retryDedupeWindowMs));

    if (
      deps.shouldDedupeContinuation(
        state.lastContinuationFingerprint,
        state.lastContinuationAt,
        continuationFingerprint,
        now,
        dedupeWindowMs
      )
    ) {
      return jsonContent({
        status: "deduped",
        reasonCode: "continuation_deduped",
        sessionId,
        continuationCount: state.continuationCount,
        dedupeWindowMs,
      });
    }

    state.continuationCount += 1;
    state.lastContinuationFingerprint = continuationFingerprint;
    state.lastContinuationAt = now;
    deps.pushSessionEvent(state, "continuation.injected", `attempt ${state.continuationCount}`);
    await deps.writeSupervisorStore(store);

    const lastCompletionFailure = [...state.events]
      .reverse()
      .find((event) => COMPLETION_RECOVERY_EVENT_TYPES.has(event.type));
    let completionRecoveryReason = deps.parseCompletionValidationReason(
      lastCompletionFailure?.detail
    );
    let memorySyncStatus: Awaited<ReturnType<typeof getCompletionMemorySyncStatus>> | null = null;
    if (state.completionMemorySync) {
      memorySyncStatus = await getCompletionMemorySyncStatus(state.completionMemorySync);
      if (memorySyncStatus.driftDetected) {
        completionRecoveryReason = "completion_memory_drift_detected";
      }
    }

    const validationBlockerDetail =
      completionRecoveryReason === VALIDATION_COULD_NOT_RUN_REASON
        ? (lastCompletionFailure?.detail ?? "").split(";").slice(1).join(";").trim()
        : "";
    const remediationChecklist =
      completionRecoveryReason === VALIDATION_COULD_NOT_RUN_REASON
        ? buildValidationBlockedChecklist(
            validationBlockerDetail || "the goal contract's validationCmd"
          )
        : deps.buildCompletionRepairChecklist(completionRecoveryReason);

    const leaseFences = await collectSessionLeaseFences(sessionId);
    const leaseSections = leaseFences.length > 0 ? buildLeaseFenceSections(leaseFences) : undefined;

    const prompt = buildContinuationPrompt(
      sessionId,
      state.continuationCount,
      state.currentRoute,
      state.completionMemorySync,
      memorySyncStatus,
      completionRecoveryReason,
      remediationChecklist,
      pendingTasks,
      leaseSections
    );

    return jsonContent({
      status: "ready",
      reasonCode: "continuation_emitted",
      sessionId,
      continuationCount: state.continuationCount,
      completionRecoveryReason,
      remediationChecklist,
      memorySyncGuard: state.completionMemorySync ?? null,
      memorySyncStatus,
      leases: leaseFences,
      prompt,
    });
  });
}

interface CompletionGateArgs {
  sessionId: string;
  memorySync?: { agentId: string; scope?: CompletionMemorySyncGuard["scope"]; cwd?: string };
  validationAttempts?: Parameters<typeof evaluateGoalContractCompletion>[2];
}

type GoalContractCitation = { taskId: string; stopConditionCitation: string };

/**
 * The live-session gates `supervisor_complete_session` runs before honoring a
 * "completed" outcome, in order: memory drift, completion readiness, then the
 * goal-contract gate. A refusal has already been recorded on the session (a
 * pending-validation stamp, an event, and a store write); otherwise the stop
 * condition citations for the session's goal contracts are returned.
 */
async function runCompletionGates(
  deps: SupervisorToolDeps,
  { store, state, reliability }: LockedSession,
  now: number,
  { sessionId, memorySync, validationAttempts }: CompletionGateArgs
): Promise<{ refusal: JsonToolResult } | { citations: GoalContractCitation[] }> {
  const refuse = async (
    eventType: string,
    eventDetail: string,
    payload: Record<string, unknown>
  ): Promise<{ refusal: JsonToolResult }> => {
    state.pendingCompletionValidationAt = now;
    deps.pushSessionEvent(state, eventType, eventDetail);
    await deps.writeSupervisorStore(store);
    return { refusal: jsonContent({ status: "running", ...payload }) };
  };

  const memoryGuard: CompletionMemorySyncGuard | undefined = memorySync
    ? {
        agentId: memorySync.agentId.trim(),
        scope: memorySync.scope ?? "project",
        cwd: resolve(memorySync.cwd ?? process.cwd()),
      }
    : state.completionMemorySync;

  if (memoryGuard) {
    const memorySyncStatus = await getCompletionMemorySyncStatus(memoryGuard);
    if (memorySyncStatus.driftDetected) {
      return refuse(
        "completion.validation_failed",
        "completion_memory_drift_detected; refusing early completion",
        {
          reasonCode: "completion_memory_drift_detected",
          sessionId,
          completionValidationWindowMs: reliability.completionValidationWindowMs,
          memorySyncGuard: memoryGuard,
          memorySyncStatus,
          remediationChecklist: deps.buildCompletionRepairChecklist(
            "completion_memory_drift_detected"
          ),
          continuationDirective:
            "Resync memory snapshot first, then continue repair loop and retry completion.",
        }
      );
    }
  }

  const readiness = deps.evaluateCompletionReadiness(state, now, reliability);
  if (!readiness.ok) {
    return refuse(
      "completion.validation_failed",
      `${readiness.reasonCode}; refusing early completion`,
      {
        reasonCode: readiness.reasonCode,
        sessionId,
        completionValidationWindowMs: reliability.completionValidationWindowMs,
        lastOutputAt: state.lastOutputAt ?? null,
        completionEvidenceAt: state.completionEvidenceAt ?? null,
        completionJudgeAt: state.completionJudgeAt ?? null,
        completionJudgeVerdict: state.completionJudgeVerdict ?? null,
        remediationChecklist: deps.buildCompletionRepairChecklist(readiness.reasonCode),
        continuationDirective:
          "Continue repair loop: implement -> verify -> record evidence -> judge -> retry completion.",
      }
    );
  }

  // Goal-contract gate: when a linked task carries a goal contract, completion
  // evaluation cites its stop condition and — if validationCmd is set — expects
  // a verify_edit result for that exact command in the completion evidence.
  const taskStore = await readTaskStore();
  const contractTasks = Object.values(taskStore.tasks).filter(
    (task) =>
      task.sessionId === sessionId &&
      task.goalContract !== undefined &&
      !TASK_TERMINAL_STATUSES.has(task.status)
  );
  const goalContractChecks = contractTasks.map((task) => ({
    taskId: task.taskId,
    ...evaluateGoalContractCompletion(
      task.goalContract!,
      state.completionEvidenceSummary,
      validationAttempts
    ),
  }));

  // A validation that COULD NOT EXECUTE on this lane is neither a pass nor a
  // code failure. It blocks completion — an unrun check never satisfies a stop
  // condition — but it is recorded as a distinct blocker so the continuation
  // prompt says "validation could not execute on this lane" instead of sending
  // the agent to fix code that is fine and burning the failure budget on a
  // misdiagnosis. It is also a legitimate reason to fail over.
  const blockedContracts = goalContractChecks.filter(
    (check) => check.reasonCode === "goal_contract_validation_could_not_run"
  );
  if (blockedContracts.length > 0) {
    const blockerDetail = describeValidationBlockers(blockedContracts);
    // A DISTINCT event type: `completion.validation_failed` is the code-failure
    // channel that feeds the recovery reason, and an environment problem must
    // never be counted there.
    return refuse(
      "completion.validation_blocked",
      `${VALIDATION_COULD_NOT_RUN_REASON}; ${blockerDetail}`,
      {
        reasonCode: VALIDATION_COULD_NOT_RUN_REASON,
        sessionId,
        goalContractChecks,
        validationBlockers: blockedContracts.map((check) => ({
          taskId: check.taskId,
          validationCmd: check.expectedValidationCmd,
          ...check.validationBlocker,
        })),
        remediationChecklist: buildValidationBlockedChecklist(blockerDetail),
        continuationDirective: `Validation could not execute on this lane: ${blockerDetail}. This is an environment problem, not a code failure — do not change code to make it pass. Fix the lane's toolchain or hand this task off to a lane that can run the command, then retry completion.`,
      }
    );
  }

  if (goalContractChecks.some((check) => !check.ok)) {
    return refuse(
      "completion.validation_failed",
      "goal_contract_validation_evidence_missing; refusing early completion",
      {
        reasonCode: "goal_contract_validation_evidence_missing",
        sessionId,
        goalContractChecks,
        remediationChecklist: deps.buildCompletionRepairChecklist(
          "goal_contract_validation_evidence_missing"
        ),
        continuationDirective:
          "Run each goal contract's validationCmd through verify_edit, record the result as completion evidence citing the stop condition, then retry completion.",
      }
    );
  }

  return {
    citations: goalContractChecks.map((check) => ({
      taskId: check.taskId,
      stopConditionCitation: check.stopConditionCitation,
    })),
  };
}

export function registerSupervisorCompletionTools(
  server: McpServer,
  deps: SupervisorToolDeps
): void {
  server.registerTool(
    "supervisor_record_completion_check",
    {
      description:
        "Record deterministic completion evidence and independent judge verdict for a supervised session",
      inputSchema: {
        sessionId: z.string().describe("Supervisor session ID"),
        checkType: z.enum(["evidence", "judge"]).describe("Completion check type"),
        summary: z
          .string()
          .min(1)
          .max(8000)
          .describe("Human-readable summary for evidence or judge result"),
        verdict: z.enum(["pass", "fail"]).optional().describe("Required when checkType='judge'"),
      },
      annotations: toolAnnotations("supervisor_record_completion_check"),
    },
    async ({ sessionId, checkType, summary, verdict }) =>
      withLockedSession(deps, sessionId, async ({ store, state }) => {
        const now = Date.now();

        if (checkType === "evidence") {
          state.completionEvidenceAt = now;
          state.completionEvidenceSummary = summary;
          state.pendingCompletionValidationAt = undefined;
          deps.pushSessionEvent(state, "completion.evidence_recorded", summary);
        } else {
          if (!verdict) {
            return jsonContent({
              status: "invalid",
              reasonCode: "judge_verdict_required",
              sessionId,
            });
          }
          state.completionJudgeAt = now;
          state.completionJudgeVerdict = verdict;
          state.completionJudgeSummary = summary;
          state.pendingCompletionValidationAt = verdict === "pass" ? undefined : now;
          deps.pushSessionEvent(
            state,
            verdict === "pass" ? "completion.judge_pass" : "completion.judge_fail",
            summary
          );
        }

        await deps.writeSupervisorStore(store);

        return jsonContent({
          status: "recorded",
          reasonCode:
            checkType === "evidence" ? "completion_evidence_recorded" : "completion_judge_recorded",
          sessionId,
          checkType,
          completionEvidenceAt: state.completionEvidenceAt ?? null,
          completionJudgeAt: state.completionJudgeAt ?? null,
          completionJudgeVerdict: state.completionJudgeVerdict ?? null,
        });
      })
  );

  server.registerTool(
    "supervisor_complete_session",
    {
      description:
        "Mark a supervised session with a final terminal outcome. Terminal is terminal: a " +
        "session that already ended (completed, interrupted, exhausted, force_synthesized) is a " +
        "no-op — nothing is written, no event is pushed, and the result reports already_terminal " +
        "with the status the session actually holds. forceComplete skips live-session gates; it " +
        "does not reopen a finished record",
      inputSchema: {
        sessionId: z.string().describe("Supervisor session ID"),
        outcome: z
          .enum(["completed", "blocked", "interrupted", "exhausted"])
          .optional()
          .describe("Final outcome"),
        note: z.string().optional().describe("Optional completion note"),
        forceComplete: z
          .boolean()
          .optional()
          .describe("Override output validation gates and finalize immediately"),
        memorySync: z
          .object({
            agentId: z
              .string()
              .min(1)
              .describe("Agent identifier to enforce memory snapshot sync on completion"),
            scope: z
              .enum(["user", "project", "local"])
              .optional()
              .describe("Memory scope to enforce; defaults to project"),
            cwd: z
              .string()
              .optional()
              .describe(
                "Project root used for project/local scope; defaults to current process cwd"
              ),
          })
          .optional()
          .describe("Optional completion-time override for memory sync guard"),
        validationAttempts: z
          .array(
            z.object({
              command: z.string().min(1).max(1000).describe("The validation command as it was run"),
              outcome: z
                .enum(["pass", "fail", "could_not_run", "denied"])
                .describe("verify_edit's outcome for that command"),
              reasonCode: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe("verify_edit's machine-readable cause, e.g. deps_not_installed"),
              remediation: z
                .string()
                .min(1)
                .max(1000)
                .optional()
                .describe("verify_edit's one-sentence remediation for a could_not_run"),
            })
          )
          .max(32)
          .optional()
          .describe(
            "verify_edit outcomes for goal-contract validation commands. A could_not_run attempt " +
              "blocks completion as an ENVIRONMENT problem, never as a code failure"
          ),
      },
      annotations: toolAnnotations("supervisor_complete_session"),
    },
    async ({ sessionId, outcome, note, forceComplete, memorySync, validationAttempts }) =>
      withLockedSession(deps, sessionId, async (session) => {
        const { store, state } = session;
        // Same contract as supervisor_abort_session: terminal is terminal.
        // Completing a session that finished (or was force-synthesized) used
        // to rewrite its status, push another session.completed event, and
        // re-revoke leases. forceComplete is an escape hatch for *live*
        // gates, not a license to reopen a finished record.
        if (SUPERVISOR_TERMINAL_STATUSES.has(state.status)) {
          return jsonContent({
            status: "already_terminal",
            reasonCode: "session_terminal",
            sessionId,
            priorStatus: state.status,
            detail:
              `Session already ended as "${state.status}". Nothing was written, no event was ` +
              "pushed, and no lease was touched — its terminal record is unchanged.",
          });
        }

        const now = Date.now();
        const requestedOutcome = outcome ?? "completed";
        let goalContractCitations: GoalContractCitation[] = [];
        if (requestedOutcome === "completed" && forceComplete !== true) {
          const gate = await runCompletionGates(deps, session, now, {
            sessionId,
            memorySync,
            validationAttempts,
          });
          if ("refusal" in gate) return gate.refusal;
          goalContractCitations = gate.citations;
        }

        state.status = requestedOutcome;
        state.lastProgressAt = now;
        state.pendingCompletionValidationAt = undefined;
        state.abortDetectedAt = undefined;
        state.recoveryInFlight = false;
        deps.pushSessionEvent(state, "session.completed", note ?? state.status);
        await deps.writeSupervisorStore(store);

        // At-most-one-live-instance (MCP-4): every terminal transition revokes
        // the session's task claims, so an orphaned lane cannot hold a live
        // lease after the session ended. Unleased tasks are a pure no-op.
        const revokedLeases = await revokeSessionTaskLeases(sessionId, new Date(now).toISOString());

        return jsonContent({
          status: state.status,
          reasonCode: "session_finalized",
          sessionId,
          goalContractCitations,
          currentAttemptId: state.currentAttemptId,
          revokedLeases,
          state,
        });
      })
  );

  server.registerTool(
    "supervisor_force_synthesis",
    {
      description:
        "Terminal state between success and failure: when a session's budget, step, or stall threshold has tripped, mark it force_synthesized and emit a forced-synthesis prompt demanding a best-effort answer from existing evidence only (no new tool calls), with explicit confidence, explicit unresolved gaps, and citations. Never presented as a normal completion",
      inputSchema: {
        sessionId: z.string().describe("Supervisor session ID"),
        evidence: z
          .array(z.string().min(1).max(4000))
          .max(64)
          .optional()
          .describe(
            "Evidence gathered so far. These items are agent-authored and are NOT verified by the " +
              "server: the prompt renders them as unverified claims beneath the facts the supervisor " +
              "itself recorded, and a claim that conflicts with a recorded fact loses"
          ),
        unresolvedGaps: z
          .array(z.string().min(1).max(2000))
          .max(64)
          .optional()
          .describe("Known unresolved gaps the synthesis must declare"),
        note: z.string().max(2000).optional().describe("Optional operator note"),
      },
      annotations: toolAnnotations("supervisor_force_synthesis"),
    },
    async ({ sessionId, evidence, unresolvedGaps, note }) =>
      withLockedSession(deps, sessionId, async ({ store, state, reliability }) => {
        // exhausted is the reason to force-synthesize; the other three
        // terminals are finished records and must not be rewritten.
        if (SUPERVISOR_TERMINAL_STATUSES.has(state.status) && state.status !== "exhausted") {
          return jsonContent({
            status: state.status,
            reasonCode: "already_terminal",
            sessionId,
          });
        }

        const now = Date.now();
        const trigger = evaluateForceSynthesisTrigger(state, now, reliability);
        if (!trigger.triggered) {
          return jsonContent({
            status: state.status,
            reasonCode: trigger.reasonCode,
            sessionId,
            message:
              "No budget, step, or stall threshold has tripped; continue the normal completion loop instead of forcing synthesis.",
          });
        }

        state.status = "force_synthesized";
        state.forceSynthesisAt = now;
        state.forceSynthesisTrigger = trigger.reasonCode;
        state.recoveryInFlight = false;
        state.pendingCompletionValidationAt = undefined;
        state.continuationCount += 1;
        deps.pushSessionEvent(
          state,
          "session.force_synthesized",
          `trigger: ${trigger.reasonCode}${note ? `; ${note}` : ""}`
        );
        await deps.writeSupervisorStore(store);

        // Mark linked tasks so the task record distinguishes
        // completed | failed | force_synthesized.
        const nowIso = new Date(now).toISOString();
        // The goal contracts are captured on this same pass, before the
        // outcome is applied — no second store read, and the same
        // session-linked non-terminal set the strict completion gate uses.
        const contractTasks: Array<{ taskId: string; goalContract: GoalContract }> = [];
        const linkedTasksMarked = await withTaskStoreLock(async () => {
          const taskStore = await readTaskStore();
          const marked: string[] = [];
          for (const task of Object.values(taskStore.tasks)) {
            if (task.sessionId !== sessionId) continue;
            if (TASK_TERMINAL_STATUSES.has(task.status)) continue;
            if (task.goalContract !== undefined) {
              contractTasks.push({ taskId: task.taskId, goalContract: task.goalContract });
            }
            applyForceSynthesisOutcome(
              task,
              `forced synthesis (${trigger.reasonCode}); best-effort answer produced from partial evidence — not a normal completion`,
              nowIso
            );
            marked.push(task.taskId);
          }
          if (marked.length > 0) {
            await writeTaskStore(taskStore);
          }
          return marked;
        });

        // Ground the salvage prompt in what the supervisor recorded, so the
        // agent-authored `evidence` list below it is read against facts it
        // could not write.
        const recordedFacts = collectForceSynthesisRecordedFacts(state, contractTasks);
        const prompt = buildForceSynthesisPrompt(
          sessionId,
          state.continuationCount,
          state.currentRoute,
          trigger.reasonCode,
          evidence ?? [],
          unresolvedGaps ?? [],
          recordedFacts
        );

        // Incubator, never confirmed. A finding-store failure must not drop
        // the salvage prompt — capture first, label uncertainty.
        const findingRecord = await persistForceSynthesisFindings({
          sessionId,
          taskIds: linkedTasksMarked,
          trigger: trigger.reasonCode,
          nowIso,
        });

        return jsonContent({
          status: "force_synthesized",
          reasonCode: "force_synthesis_emitted",
          sessionId,
          trigger: trigger.reasonCode,
          continuationCount: state.continuationCount,
          linkedTasksMarked,
          recordedFacts,
          findingRecord,
          prompt,
        });
      })
  );
}
