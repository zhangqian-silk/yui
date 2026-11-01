import assert from "node:assert/strict";
import test from "node:test";
import { businessScenarios } from "./business-scenarios.mjs";
import { allocationPlan } from "./business-participant.mjs";
import { gradeBusiness } from "./judge.mjs";
import { chainStages, routesStage, isSessionRecovery, parseOptions } from "./common.mjs";
import { gradeInstructionObligations } from "./obligations.mjs";
import { observedDimensions } from "./dimensions.mjs";

test("business chains resolve distributed signed revisions and request changes against independent literal answers", () => {
  for (const [name, scene] of Object.entries(businessScenarios)) {
    const originals = [];
    assert.equal(chainStages(name), 3);
    assert.equal(parseOptions(["--mode", "fake", "--product", "/product", "--out", "/new",
      "--scenarios", name]).scenarios[0], name);
    for (let i = 0; i < 3; i++) {
      originals.push(...scene.stages[i].materials.map(JSON.parse));
      const actual = allocationPlan(originals, scene.stages[i].request);
      assert.deepEqual(actual, scene.expected[i], `${name} stage ${i + 1}`);
      const decisions = [{ id: "decision-1", title: "effect", rationale: JSON.stringify(actual) }];
      assert.equal(gradeBusiness(decisions, "effect", i + 1, scene.expected[i]).status, "pass");
      assert.equal(gradeBusiness([...decisions, ...decisions], "effect", i + 1, scene.expected[i]).status, "fail");
      const changed = structuredClone(actual);
      changed.remainingKits++;
      assert.equal(gradeBusiness([{ title: "effect", rationale: JSON.stringify(changed) }],
        "effect", i + 1, scene.expected[i]).status, "fail");
    }
  }
  assert.deepEqual([1, 2, 3].filter(n => routesStage("business-route", n)), [1, 2, 3]);
  assert.equal(isSessionRecovery("business-recovery"), true);
});

test("missing source and newer draft do not become effective allocation authority", () => {
  const scene = businessScenarios["business-conflict"];
  const first = scene.stages[0].materials.map(JSON.parse);
  assert.throws(() => allocationPlan(first.filter(d => !d.stock), scene.stages[0].request), /stock/);
  const later = [...first, ...scene.stages[1].materials.map(JSON.parse)];
  assert.deepEqual(allocationPlan(later, scene.stages[1].request), scene.expected[1]);
  const withoutSignedAmendment = later.filter(d => d.document !== "attendance-correction");
  assert.notDeepEqual(allocationPlan(withoutSignedAmendment, scene.stages[1].request), scene.expected[1]);
});

test("unknown Task-context carrier limits instruction observation, never the objective business dimension", () => {
  const gap = { status: "unknown", reason: "unreviewed inline carrier" };
  const loads = gradeInstructionObligations([], [], { taskContextObservation: gap }, { status: "unknown" });
  assert.equal(loads.status, "unknown");
  assert.deepEqual(loads.taskContextObligation, gap);
  const dimensions = observedDimensions({ terminal: { threadId: "thread", turnId: "turn" },
    business: { status: "pass" }, loads });
  assert.equal(dimensions.business.status, "pass");
  assert.equal(dimensions.instructionOutputCoverage.status, "unknown");
});
