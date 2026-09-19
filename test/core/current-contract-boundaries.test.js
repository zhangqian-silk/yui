import assert from "node:assert/strict";
import test from "node:test";
import { ensureFileTaskControllerIdentity } from "../../dist/controller/clientRuntime.js";
import { createTaskMessage, validateTaskMessage } from "../../dist/message/message.js";
import { createTaskActivationRequest, validateTaskActivationRequest } from "../../dist/task/taskActivation.js";
import { createGateArtifact, validateGateArtifact } from "../../dist/verification/gateArtifact.js";
import { normalizeVerificationPlan } from "../../dist/verification/verificationPlan.js";
import { createSessionOwnerIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";
import { validateStoredRecord } from "../../dist/storage/recordValidation.js";

test("exact Controller restoration validates captured protocol and storage on both responses", async ()=>{
  const identity={executablePath:process.execPath,args:["/fixture/controllerMain.js"],version:"captured-package",
    controllerProtocolVersion:1,storageVersion:"1.7",minimumStorageVersion:"1.0"};
  const status={running:true,protocolVersion:1,version:identity.version,
    storageVersion:"1.7",minimumStorageVersion:"1.0"};
  const restore=(expected=identity,statusChanges={},identityChanges={})=>ensureFileTaskControllerIdentity(
    "/unused/yui-identity-fixture",expected,{
      call:async(_home,method)=>method==="controller.status"
        ? {...status,...statusChanges} : {...identity,...identityChanges},
      spawnController:()=>assert.fail("a running identity must never cause another spawn")
    });
  assert.deepEqual(await restore(),status);
  for(const changes of [{storageVersion:undefined},{storageVersion:"2.0"},{minimumStorageVersion:"1.1"}]) {
    await assert.rejects(restore(identity,changes),/storage|identity/i);
    await assert.rejects(restore(identity,{},changes),/storage|identity/i);
  }
  await assert.rejects(restore(identity,{protocolVersion:2}),/protocol/i);
  await assert.rejects(restore(identity,{}, {controllerProtocolVersion:2}),/protocol|identity/i);
  await assert.rejects(restore({...identity,storageVersion:undefined}),/storage|identity/i);
});

test("current record schemas reject arbitrary unknown fields, not only named retired fields", ()=>{
  const at=new Date("2026-09-18T00:00:00Z");
  const message=createTaskMessage("message-1","task-1","Keep this input","user",{type:"user"},at);
  const activation=createTaskActivationRequest("task-1",{
    requestId:"activate-1",actorId:"operator",authorityRef:"operator:fixture",startMode:"immediate",environmentPlan:{kind:"empty"}
  },at);
  const plan=normalizeVerificationPlan({schemaVersion:1,kind:"verification-plan",id:"checks",version:"1",
    toolchain:{},bootstrap:[],l2:{steps:[{name:"verify",argv:["true"]}]}});
  const artifact=createGateArtifact({projectId:"project-1",level:"L2",commit:"a".repeat(40),
    planDigest:"b".repeat(64),toolchainDigest:"c".repeat(64),boundary:{targetRef:"main",baseHead:"d".repeat(40)}},
    {planId:"checks",planVersion:"1",generator:"fixture"},at);
  const owner=createSessionOwnerIdentity({owner:{scope:"global",roleName:"operator"},agentId:"codex",
    adapterId:"codex",tmux:{serverName:"fixture",socketPath:"/tmp/fixture.sock",sessionName:"operator",windowName:"operator"},
    providerRoot:{pid:4242,startIdentity:"123",attribution:"pane-pid"},recordedAt:at});
  for(const [record,validate] of [
    [message,validateTaskMessage],[activation,validateTaskActivationRequest],[plan,normalizeVerificationPlan],
    [artifact,validateGateArtifact],[owner,value=>validateStoredRecord("session_owners",value)]
  ]) {
    validate(record);
    assert.throws(()=>validate({...record,unexpectedContractField:true}),/unexpectedContractField/);
  }
  assert.equal(message.body,"Keep this input");
});
