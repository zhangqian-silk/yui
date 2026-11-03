// New evaluation adapter. Never changes product behavior, writes a receipt,
// retries an input, or substitutes a terminal for independent business quality.
export function judgeInputHandling({ original, expected, dispatch, run, wakes=[], effect }) {
  const failures=[];
  const require=(value,label)=>{if(!value)failures.push(label);};
  const text=value=>typeof value==="string"&&value.trim().length>0;
  const time=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));
  const refMatches=(ref,type,id)=>ref?.type===type&&ref.taskId===expected?.taskId&&ref.id===id;
  const actorMatches=actor=>actor?.scope==="task"&&actor.taskId===expected?.taskId&&actor.roleName==="leader"
    &&actor.agentId===expected?.agentId&&actor.nativeSessionId===expected?.threadId;
  const receiptMatches=receipt=>{
    const {claim,ack}=receipt??{};
    return text(claim?.requestId)&&text(ack?.requestId)&&text(ack?.reason)
      &&actorMatches(claim.actor)&&actorMatches(ack.actor)
      &&time(claim.at)&&time(ack.at)&&time(effect?.at)
      &&Date.parse(claim.at)<=Date.parse(effect.at)&&Date.parse(effect.at)<=Date.parse(ack.at);
  };
  require(["taskId","messageId","requestId","agentId","threadId"].every(k=>text(expected?.[k]))
    &&typeof expected?.body==="string","expected-exact-identity-required");
  require(original?.taskId===expected?.taskId&&original?.id===expected?.messageId
    &&original?.submissionKey===expected?.requestId&&original?.body===expected?.body,"original-identity-or-body");
  const receipt=original?.submissionReceipt;
  require(receipt?.target?.kind==="task"&&receipt.target.taskId===expected?.taskId
    &&receipt.feedback?.saved?.taskId===expected?.taskId
    &&receipt.feedback.saved.messageId===expected?.messageId,"saved-routing-receipt");
  require(effect?.status==="confirmed"&&!effect.error&&time(effect?.at),"effect-not-confirmed-no-replay");
  const kind=receipt?.routing?.kind;
  if(kind==="enter-planning"){
    require(text(expected?.runId)&&text(expected?.turnId),"planning-run-native-identity-required");
    require(dispatch?.owner===`planning:${expected?.runId}`
      &&dispatch.batchId===`turn:${expected?.taskId}/${expected?.runId}`
      &&refMatches(dispatch.executionRef,"run",expected?.runId)
      &&dispatch.batch?.refs?.some(r=>refMatches(r,"message",expected?.messageId)),"planning-original-run-binding");
    require(run?.id===expected?.runId&&run?.taskId===expected?.taskId&&run?.roleName==="leader"
      &&run?.purpose==="planning"&&run?.effective?.agentId===expected?.agentId,"planning-run-owner");
    const provider=run?.result?.provider;
    require(run?.status==="completed"&&provider?.status==="completed"
      &&provider?.conversationId===expected?.threadId&&provider?.nativeTurnId===expected?.turnId
      &&time(run?.result?.completedAt)&&time(run?.createdAt)
      &&Date.parse(run.createdAt)<=Date.parse(effect?.at)&&Date.parse(effect?.at)<=Date.parse(run.result.completedAt),
      "planning-exact-completed-terminal");
    require(!wakes.some(w=>w.taskId===expected?.taskId&&w.refs?.some(r=>refMatches(r,"message",expected?.messageId))),
      "ambiguous-planning-and-wake-binding");
    // No wake means no wake claim/ACK. If a legal original receipt exists,
    // inspect it rather than treating the planning path as an ACK exemption.
    if(original?.inbox)require(receiptMatches(original.inbox),"existing-original-receipt-invalid");
  }else if(["continue-planning","active-context"].includes(kind)){
    require(text(expected?.wakeId),"exact-wake-id-required");
    const matching=wakes.filter(w=>w.taskId===expected?.taskId&&w.id===expected?.wakeId
      &&w.refs?.some(r=>refMatches(r,"message",expected?.messageId)));
    require(matching.length===1,"wake-original-identity");
    require(matching.length===1&&receiptMatches(matching[0].inbox),"wake-claim-effect-ack-identity-and-order");
  }else require(false,"unsupported-input-route");
  return {status:failures.length?(effect?.status==="unknown"?"unknown":"fail"):"pass",
    protocol:kind==="enter-planning"?"initial-planning-run":"task-wake",failures,
    wakeReceiptApplicable:kind!=="enter-planning",
    scope:"Input disposition correlation only; complete reads, business quality and persistence safety remain independent"};
}
