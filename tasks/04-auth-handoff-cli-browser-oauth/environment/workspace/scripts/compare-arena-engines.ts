import { runCrossEngineReport } from "../src/games/restaurant-arena/cross-engine-report.js";

const backendRoot = process.env.RETRO_BACKEND_ROOT;
if (!backendRoot) throw new Error("Set RETRO_BACKEND_ROOT to the retro-backend checkout.");

const fixtureValidation = Bun.spawnSync({
  cmd: ["uv", "run", "python", `${import.meta.dir}/validate-cross-engine-fixture.py`, "--prove-duplicate-id-rejected"],
  cwd: backendRoot,
  stdout: "pipe",
  stderr: "pipe",
});
if (fixtureValidation.exitCode !== 0) throw new Error(new TextDecoder().decode(fixtureValidation.stderr));

const processResult = Bun.spawnSync({
  cmd: ["uv", "run", "python", "-m", "retro_backend.esim.cross_engine"],
  cwd: backendRoot,
  stdout: "pipe",
  stderr: "pipe",
});
if (processResult.exitCode !== 0) throw new Error(new TextDecoder().decode(processResult.stderr));

const native = Object.fromEntries(runCrossEngineReport().map((record) => [record.scenario, record]));
const esim = Object.fromEntries(
  (JSON.parse(new TextDecoder().decode(processResult.stdout)) as Array<{ scenario: string; records: Array<Record<string, unknown>> }>).map(
    ({ scenario, records }) => [scenario, records[0]!],
  ),
);

const unexpected: string[] = [];
const esimRoutine = esim.routine?.state as { orders?: Array<{ id: string; priority: string }> } | undefined;
const esimIncident = esim.incident as { tick?: number; incident?: { active?: boolean }; equipment?: Array<{ id: string; status: string }> } | undefined;
const routineStep = native.routine?.steps.find((step) => step.kind === "priority");
const nativeRoutinePriority = native.routine?.orders.find(({ id }) => id === routineStep?.orderId)?.priority;
const esimRoutinePriority = esimRoutine?.orders?.find(({ id }) => id === routineStep?.orderId)?.priority;
if (!routineStep || !native.routine?.accepted || esim.routine?.accepted !== true || nativeRoutinePriority !== routineStep.priority || esimRoutinePriority !== nativeRoutinePriority) {
  unexpected.push("routine priority transition differs");
}
const nativeIncident = native.incident;
const esimOvenStatus = esimIncident?.equipment?.find(({ id }) => id === "oven-1")?.status;
if (!nativeIncident || nativeIncident.tick !== esimIncident?.tick || nativeIncident.oven.status !== esimOvenStatus || nativeIncident.oven.emergency !== esimIncident?.incident?.active) {
  unexpected.push("oven incident state differs");
}

const correctionUnsupported = true;

const report = {
  version: "restaurant-arena-cross-engine/v2",
  compared: ["routine", "incident", "manager-correction"],
  fixture: {
    source: "contracts/fixtures/restaurant-arena-cross-engine-v2.json",
    nativeStepsExecuted: Object.fromEntries(Object.entries(native).map(([scenario, record]) => [scenario, record.steps])),
    duplicateFixture: new TextDecoder().decode(fixtureValidation.stdout).trim(),
  },
  results: {
    routine: unexpected.includes("routine priority transition differs") ? "unexpected differences" : "no unexpected differences",
    "oven incident": unexpected.includes("oven incident state differs") ? "unexpected differences" : "no unexpected differences",
    "manager correction": correctionUnsupported ? "explicitly unsupported" : "no unexpected differences",
  },
  unexpected,
  differences: correctionUnsupported ? [{
    scenario: "manager-correction",
    decision: "unsupported",
    reason: "Native correction changes RestaurantState scoring inputs; E-Sim v1 manager directives are intentionally non-mutating.",
  }] : [],
};
console.log(JSON.stringify(report, null, 2));
if (unexpected.length) process.exitCode = 1;
