import { expect, test } from "bun:test";
import { asSchema } from "ai";
import { preparedReviewWorkPacketSchema } from "../src/review/prepare-review-work";
import { persistReviewWork, reviewWorkContext, reviewWorkCheckpointDraftSchema, reviewWorkInputSchema } from "../src/review/work-execution";
import { workHash } from "../src/review/work-plan";
import { reviewWorkResultArtifactSchema, reviewWorkResultPath } from "../src/review/work-runtime";
import { reviewWorkInputDigest, snapshotReviewWorkInputs } from "../src/review/work-inputs";

function fixture() {
  const unit = { id: workHash("component"), axis: "engineering-quality" as const, component: "src", paths: ["src/index.ts"], requirementIds: [], policyDigest: workHash("policy") };
  const snapshot = snapshotReviewWorkInputs({unit,base:new Map(),head:new Map([["src/index.ts","blob"]]),requirements:[],claim:"Validate input"});
  const packet = preparedReviewWorkPacketSchema.parse({ schemaVersion:1,unit,inputSnapshot:snapshot,inputDigest:reviewWorkInputDigest(snapshot),
    manifest:{schemaVersion:1,baseSha:"a".repeat(40),headSha:"b".repeat(40),patchFingerprint:workHash("patch"),entries:[{path:"src/index.ts",status:"modified",kind:"excluded",patchCharacters:0,patchTokens:0,patchSha256:workHash("patch"),classification:["generated"],addedLines:0,deletedLines:0}]},
    requirements:[],originalClaim:"Validate input",priorAssessment:null,patches:[],reuseInvalidation:null });
  const checkpoint = reviewWorkCheckpointDraftSchema.parse({status:"complete",reviewedEntries:[0],remainingEntries:[],observations:[],nextSteps:[],limitations:[],completedReport:{axis:unit.axis,
    scope:{claim:packet.originalClaim,dirtyState:"Clean",inspectedSupportingContext:[]},coverage:{staticOnly:[],unreached:[]},churn:{window:"90 days",symbolCoverage:[],fileFallbacks:[]},
    probes:[],candidates:[{title:"Reject invalid input",location:{path:"src/index.ts",line:1,symbol:null},evidence:["Input bypasses validation"],impact:"Invalid state persists",impactSummary:"Invalid state persists",remedy:"Validate at boundary",staticOnly:true,churn:null,uncertainty:[],evidenceRefs:[]}],verifiedClaims:[],limitations:[],specialistChecks:null,requirementChecks:[]}});
  const files=new Map<string,string>(), writes:string[]=[];
  const input = {packet,checkpoint,attemptId:"current-attempt",async assertCurrent(){},proof:{schemaVersion:2,inputSnapshot:snapshot,sources:[],probes:[],external:[]},
    invocation:{rootSessionId:"root",invocationId:"native-call",sessionId:"child",turnId:"turn"},
    evidence:{async readTextFile({path}:{path:string}){return files.get(path)??null;},async writeTextFile({path,content}:{path:string;content:string}){writes.push("receipt");files.set(path,content);}},
    store:{async put(value:{scopeKey:string;inputDigest:string;data:string}){writes.push("store");return value;}},validateProof:async()=>true};
  return {input,files,writes};
}

test("completed work is persisted before its native receipt and survives a failed receipt write",async()=>{
  const f=fixture(); let saved="";
  await expect(persistReviewWork({...f.input,store:{async put(value){saved=value.data;}},evidence:{...f.input.evidence,async writeTextFile(){throw new Error("receipt unavailable");}}})).rejects.toThrow("receipt unavailable");
  expect(JSON.parse(saved).checkpoint.status).toBe("complete");
  const result=await persistReviewWork(f.input);
  expect(result).toEqual({workId:f.input.packet.unit.id,status:"complete"});
  expect(f.writes).toEqual(["store","receipt"]);
  const artifact=reviewWorkResultArtifactSchema.parse(JSON.parse(f.files.get(reviewWorkResultPath(f.input.packet.manifest.patchFingerprint,result.workId))!));
  expect(artifact.invocation).toEqual(f.input.invocation);
});

test("an invalid dependency, missing coverage or expanded finding scope cannot be persisted",async()=>{
  const f=fixture();
  await expect(persistReviewWork({...f.input,validateProof:async()=>false})).rejects.toThrow("supporting dependencies");
  await expect(persistReviewWork({...f.input,checkpoint:{...f.input.checkpoint,reviewedEntries:[]}})).rejects.toThrow("exact review scope");
  const expanded=structuredClone(f.input.checkpoint); expanded.completedReport!.candidates[0]!.location.path="outside.ts";
  await expect(persistReviewWork({...f.input,checkpoint:expanded})).rejects.toThrow("assigned file scope");
  expect(f.writes).toEqual([]);
});

test("a completed assessment cannot be replaced by changed findings during the same input revision",async()=>{
  const f=fixture();await persistReviewWork(f.input);
  const changed=structuredClone(f.input.checkpoint);changed.completedReport!.candidates=[];
  await expect(persistReviewWork({...f.input,checkpoint:changed})).rejects.toThrow("immutable");
  expect(f.writes).toEqual(["store","receipt"]);
});

test("new admitted attempts replace the current pointer only after preserving completed history",async()=>{
  const f=fixture();
  const history=new Map<string,string>();
  const store={async put(value:{scopeKey:string;inputDigest:string;data:string}){history.set(workHash(value.data),value.data);}};
  await persistReviewWork({...f.input,store});
  const path=reviewWorkResultPath(f.input.packet.manifest.patchFingerprint,f.input.packet.unit.id);
  const original=f.files.get(path)!;
  const checkpoint=structuredClone(f.input.checkpoint);checkpoint.completedReport!.candidates=[];
  const next={...f.input,attemptId:"next-attempt",checkpoint,store};
  await expect(persistReviewWork({...next,store:{async put(){throw new Error("store unavailable");}}})).rejects.toThrow("store unavailable");
  expect(f.files.get(path)).toBe(original);
  let checks=0;
  await expect(persistReviewWork({...next,async assertCurrent(){if(++checks===2)throw new Error("superseded");}})).rejects.toThrow("superseded");
  expect(f.files.get(path)).toBe(original);
  expect(history.size).toBe(2);
  await persistReviewWork(next);
  expect(history.size).toBe(2);
  expect(reviewWorkResultArtifactSchema.parse(JSON.parse(f.files.get(path)!)).attemptId).toBe("next-attempt");
  expect([...history.values()].some(data=>JSON.parse(data).checkpoint.completedReport.candidates.length===1)).toBe(true);
  await expect(persistReviewWork({...next,checkpoint:f.input.checkpoint})).rejects.toThrow("immutable");
  const {attemptId:_attempt,schemaVersion:_version,...legacy}=JSON.parse(original);
  expect(reviewWorkResultArtifactSchema.safeParse(legacy).success).toBe(false);
  f.files.set(path,JSON.stringify(legacy));
  await persistReviewWork(next);
  expect(reviewWorkResultArtifactSchema.parse(JSON.parse(f.files.get(path)!)).attemptId).toBe("next-attempt");
});

test("fresh external evidence completes beside retained history, while stale external claims cannot",async()=>{
  const { authenticatedEvidenceSandbox } = await import("../src/review/authenticated-evidence");
  const { captureReviewWorkProof, validateCurrentReviewWorkProof, validateReviewWorkProof } = await import("../src/review/prepare-review-work");
  const { recordWorkExternalObservation, externalObservationPath } = await import("../src/review/external-observations");
  const f=fixture();
  const evidence=authenticatedEvidenceSandbox(f.input.evidence,"root","d".repeat(64));
  const sandbox={...evidence,async run(){throw new Error("External validation must not execute commands");}};
  const packet=f.input.packet, identity=packet.manifest;
  const claims={async assertCurrent(){},async assertHealthy(){},async fail(){},async claim(_path:string,owner:string){return {acquired:true,owner};},async release(){}};
  const assigned={fingerprint:identity.patchFingerprint,workId:packet.unit.id,attemptId:f.input.attemptId};
  const old=await recordWorkExternalObservation(evidence,claims,{...assigned,attemptId:"old-attempt"},{kind:"image",target:"/workspace/screenshot.png",content:"historical observed image"});
  let proof=await captureReviewWorkProof(evidence,identity.patchFingerprint,packet.unit,packet.inputSnapshot,f.input.attemptId);
  const checkpoint=structuredClone(f.input.checkpoint), candidate=checkpoint.completedReport!.candidates[0]!;
  candidate.staticOnly=false;candidate.evidenceRefs=[{kind:"external",id:old.id}];
  const validateProof=(assessment:Parameters<typeof validateCurrentReviewWorkProof>[3])=>validateCurrentReviewWorkProof(sandbox,identity,undefined,assessment,packet.inputSnapshot,f.input.attemptId);
  await expect(persistReviewWork({...f.input,evidence,checkpoint,proof,validateProof})).rejects.toThrow("supporting dependencies");
  const fresh=await recordWorkExternalObservation(evidence,claims,assigned,{kind:"web",target:"https://example.com/official-docs",content:"current observed response"});
  proof=await captureReviewWorkProof(evidence,identity.patchFingerprint,packet.unit,packet.inputSnapshot,f.input.attemptId);
  expect(proof.external.map(item=>item.id)).toEqual([old.id,fresh.id]);
  await expect(persistReviewWork({...f.input,evidence,checkpoint,proof,validateProof})).rejects.toThrow("supporting dependencies");
  candidate.evidenceRefs=[{kind:"external",id:fresh.id}];
  await expect(persistReviewWork({...f.input,evidence,checkpoint,proof:{...proof,external:[fresh]},validateProof})).rejects.toThrow("supporting dependencies");
  expect(await persistReviewWork({...f.input,evidence,checkpoint,proof,validateProof})).toMatchObject({status:"complete"});
  const artifact=reviewWorkResultArtifactSchema.parse(JSON.parse((await evidence.readTextFile({path:reviewWorkResultPath(identity.patchFingerprint,packet.unit.id)}))!));
  expect(await validateReviewWorkProof(sandbox,{...identity,headSha:"c".repeat(40)},undefined,artifact.assessment,packet.inputSnapshot)).toBe(false);
  await evidence.writeTextFile({path:externalObservationPath(fresh.id),content:"different signed response"});
  expect(await validateProof(artifact.assessment)).toBe(false);
});

test("model work draft cannot forge application identities; projection keeps storage/proof out",async()=>{
  const f=fixture();
  expect(reviewWorkInputSchema.safeParse({action:{operation:"complete",reviewedEntries:[0],report:f.input.checkpoint.completedReport},workId:workHash("forged")} ).success).toBe(false);
  const forged=structuredClone(f.input.checkpoint);Object.assign(forged.completedReport!.candidates[0]!,{id:"attacker",severity:"BLOCKING"});
  expect(reviewWorkInputSchema.safeParse({action:{operation:"complete",reviewedEntries:[0],report:forged.completedReport}}).success).toBe(false);
  const model=reviewWorkContext(f.input.packet);
  expect(model).not.toHaveProperty("inputSnapshot");expect(model).not.toHaveProperty("inputDigest");
  const schema=await asSchema(reviewWorkInputSchema).jsonSchema;
  expect(schema).toHaveProperty("additionalProperties",false);
  expect(schema).toHaveProperty("properties.action");
  expect(JSON.stringify(schema)).not.toContain("sourceAttemptId");
  expect(JSON.stringify(schema)).not.toContain("invocationId");
  const reportPath = "properties.action.anyOf.2.properties.report.properties";
  expect(schema).toHaveProperty(`${reportPath}.candidates.items.required`, expect.arrayContaining(["evidenceRefs"]));
  expect(schema).toHaveProperty(`${reportPath}.probes.items.required`, expect.arrayContaining(["evidenceRefs"]));
  expect(schema).toHaveProperty(`${reportPath}.specialistChecks.anyOf.0.items.required`, expect.arrayContaining(["evidenceRefs"]));
  expect(schema).toHaveProperty(`${reportPath}.requirementChecks.anyOf.0.items.required`, expect.arrayContaining(["evidenceRefs"]));
  const missing = structuredClone(f.input.checkpoint);
  const { evidenceRefs: _refs, ...candidateWithoutRefs } = missing.completedReport!.candidates[0]!;
  expect(reviewWorkInputSchema.safeParse({action:{operation:"complete",reviewedEntries:[0],report:{...missing.completedReport,candidates:[candidateWithoutRefs]}}}).success).toBe(false);

});

test("fabricated behavioral success cannot complete; a real shared execution can", async () => {
  const { authenticatedEvidenceSandbox } = await import("../src/review/authenticated-evidence");
  const { captureReviewWorkProof, validateCurrentReviewWorkProof } = await import("../src/review/prepare-review-work");
  const { runSharedReviewProbe, recordWorkProbeReceipt } = await import("../src/review/probe-execution");
  const f = fixture();
  const packet = { ...f.input.packet, unit: { ...f.input.packet.unit, axis: "test-against-spec" as const } };
  const checkpoint = structuredClone(f.input.checkpoint);
  const report = checkpoint.completedReport!;
  report.axis = "test-against-spec"; report.candidates = [];
  report.specialistChecks = [{ entries:[0],requirement:"Reject invalid input",source:"Claim",expected:"Rejection",environment:"Prepared sandbox",action:"bun test",observed:"All tests passed",status:"passed",evidenceRefs:[] }];
  const claims = { async assertCurrent() {}, async assertHealthy() {}, async fail() {}, async claim(_path:string,owner:string) { return {acquired:true,owner}; }, async release() {} };
  const evidence = authenticatedEvidenceSandbox(f.input.evidence,"root","d".repeat(64));
  let executions = 0;
  const sandbox = {...evidence, async run() { throw new Error("Validation must not execute commands"); }};
  const identity = packet.manifest;
  const validateProof = (assessment: Parameters<typeof validateCurrentReviewWorkProof>[3]) => validateCurrentReviewWorkProof(sandbox,identity,undefined,assessment,packet.inputSnapshot,"current-attempt");
  let proof = await captureReviewWorkProof(evidence,identity.patchFingerprint,packet.unit,packet.inputSnapshot,"current-attempt");
  await expect(persistReviewWork({...f.input,packet,checkpoint,proof,evidence,validateProof})).rejects.toThrow("supporting dependencies");
  expect(executions).toBe(0); expect(f.writes).toEqual([]);
  const command = { command:"bun test",cwd:".",stdin:null,environment:[],rerun:false };
  const context = {repositoryId:"R_1",origin:{attemptId:"origin-attempt",sessionId:"native-producer",callId:"probe"},evidence,claims,
    observe:async()=>({sourceDigest:"a".repeat(64),environmentDigest:"b".repeat(64),externalStateDigest:null,reuse:"same-snapshot" as const}),
    execute:async()=>{executions++;return {exitCode:0,stdout:"Actual successful execution",stderr:""};}};
  const first = await runSharedReviewProbe(command,context);
  const shared = await runSharedReviewProbe(command,{...context,origin:{attemptId:"current-attempt",sessionId:"native-consumer",callId:"reuse"}});
  expect(shared.reused).toBe(true); expect(shared.receipt.executionId).toBe(first.receipt.executionId);
  await recordWorkProbeReceipt(evidence,claims,identity.patchFingerprint,packet.unit.id,shared.receipt,undefined,"current-attempt");
  proof = await captureReviewWorkProof(evidence,identity.patchFingerprint,packet.unit,packet.inputSnapshot,"current-attempt");
  report.specialistChecks![0]!.evidenceRefs=[{kind:"probe",id:"00000000-0000-4000-8000-000000000000"}];
  await expect(persistReviewWork({...f.input,packet,checkpoint,proof,evidence,validateProof})).rejects.toThrow("supporting dependencies");
  report.specialistChecks![0]!.evidenceRefs=[{kind:"probe",id:shared.receipt.executionId}];
  expect(await persistReviewWork({...f.input,packet,checkpoint,proof,evidence,validateProof})).toEqual({workId:packet.unit.id,status:"complete"});
  expect(executions).toBe(1);

  // A new admitted attempt uses the retained physical workspace and unit index.
  // An earlier reference alone cannot establish that this attempt consumed it.
  const nextValidate = (assessment: Parameters<typeof validateCurrentReviewWorkProof>[3]) => validateCurrentReviewWorkProof(sandbox,identity,undefined,assessment,packet.inputSnapshot,"next-attempt");
  const staleProof = proof;
  proof = await captureReviewWorkProof(evidence,identity.patchFingerprint,packet.unit,packet.inputSnapshot,"next-attempt");
  expect(proof.probes).toEqual([]);
  await expect(persistReviewWork({...f.input,attemptId:"next-attempt",packet,checkpoint,proof:staleProof,evidence:evidence,validateProof:nextValidate})).rejects.toThrow("supporting dependencies");
  const fresh = await runSharedReviewProbe({...command,rerun:true},{...context,evidence:evidence,origin:{attemptId:"next-attempt",sessionId:"native-new",callId:"fresh"}});
  await recordWorkProbeReceipt(evidence,claims,identity.patchFingerprint,packet.unit.id,fresh.receipt,undefined,"next-attempt");
  proof = await captureReviewWorkProof(evidence,identity.patchFingerprint,packet.unit,packet.inputSnapshot,"next-attempt");
  expect(proof.probes.map(item=>item.executionId)).toEqual([fresh.receipt.executionId]);
  // The old ID remains in authenticated storage but is excluded from this proof.
  await expect(persistReviewWork({...f.input,attemptId:"next-attempt",packet,checkpoint,proof,evidence:evidence,validateProof:nextValidate})).rejects.toThrow("supporting dependencies");
  report.specialistChecks![0]!.evidenceRefs=[{kind:"probe",id:fresh.receipt.executionId}];
  expect(await persistReviewWork({...f.input,attemptId:"next-attempt",packet,checkpoint,proof,evidence:evidence,validateProof:nextValidate})).toEqual({workId:packet.unit.id,status:"complete"});
  expect(executions).toBe(2);
});
