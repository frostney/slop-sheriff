import { convexTest } from "convex-test";
import convexSchema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import { prepareReviewWork, preparedReviewWorkPacketSchema, preparedReviewWorkPlanSchema, reviewWorkProofSchema, type PreparedReviewWorkPacket } from "../src/review/prepare-review-work";
import { reviewEvidenceManifestSchema, writeIncludedReviewEvidence } from "../src/review/evidence-bundle";
import { reviewWorkPlanPath, workHash } from "../src/review/work-plan";
import { reviewWorkAssessmentSchema, workAssessmentStorageKey, type ReviewWorkAssessment } from "../src/review/work-results";
import { observeReviewSource } from "../src/review/source-observations";
import { completedReviewWorkStore, type CompletedReviewWork } from "../src/review/work-storage";
import type { CompletedWorkEnvelope } from "../src/review/work-storage-contracts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sheriff-work-"));
  const files = new Map<string,string>();
  const runtime = {
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path,content); },
    async removePath({ path }: {path:string}) { for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key); },
    async run({ command }: { command: string }) {
      const proc = Bun.spawn(["bash", "-c", command.replaceAll("/workspace", root)], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout,stderr,exitCode] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
      return { stdout,stderr,exitCode };
    },
  };
  const sandbox = authenticatedEvidenceSandbox(runtime,"review-root","ab".repeat(32));
  async function git(...args: string[]) {
    const proc = Bun.spawn(["git","-C",root,...args], { stdout: "pipe",stderr: "pipe" });
    const [stdout,stderr,exitCode] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
    if (exitCode) throw new Error(stderr);
    return stdout.trim();
  }
  async function commit(content: Record<string,string>) {
    for (const [path,text] of Object.entries(content)) { await mkdir(dirname(join(root,path)),{recursive:true}); await writeFile(join(root,path),text); }
    await git("add","."); await git("commit","--quiet","-m","fixture update"); return git("rev-parse","HEAD");
  }
  await git("init","--quiet"); await git("config","user.name","Fixture"); await git("config","user.email","fixture@example.test");
  const baseSha = await commit({"src/a/index.ts":"export const a = 0;\n","src/b/index.ts":"export const b = 0;\n","shared/contract.ts":"export const limit = 1;\n"});
  const headSha = await commit({"src/a/index.ts":"export const a = 1;\n","src/b/index.ts":"export const b = 1;\n"});
  const envelopes = new Map<string,CompletedWorkEnvelope>();
  const context = { repositoryId: "R_widget",pullRequest:43,deliveryId:"attempt-without-published-baseline" };
  const store = completedReviewWorkStore(context,{ secret:"ab".repeat(32),request:async (operation,raw) => {
    const input = raw as { scopeKey: string;inputDigest:string;envelope:CompletedWorkEnvelope };
    if (operation === "put") { const envelope = input.envelope; envelopes.set(`${envelope.binding.scopeKey}/${envelope.binding.inputDigest}`,envelope); return {result:"stored"}; }
    if (operation === "get") return envelopes.get(`${input.scopeKey}/${input.inputDigest}`) ?? null;
    return [...envelopes.values()].reverse().find(item=>item.binding.scopeKey === input.scopeKey) ?? null;
  }});
  async function prepare(head: string, overrides: {claim?:string;attemptId?:string;store?:Parameters<typeof prepareReviewWork>[3]} = {}) {
    const patchFingerprint = workHash([baseSha,head]);
    const paths = ["src/a/index.ts","src/b/index.ts"];
    const entries = [];
    for (const path of paths) {
      const patch = await git("diff","--full-index",baseSha,head,"--",path);
      entries.push(await writeIncludedReviewEvidence(sandbox,{patchFingerprint,path,patch,patchTokens:1,status:"modified"}));
    }
    const manifest = reviewEvidenceManifestSchema.parse({schemaVersion:1,baseSha,headSha:head,patchFingerprint,entries});
    const trusted = {...context,deliveryId:overrides.attemptId??context.deliveryId,installationId:1,owner:"acme",repo:"widget",repository:"acme/widget",repositoryDatabaseId:1,repositoryCreatedAt:0,baseSha,headSha:head,patchFingerprint};
    const plan = await prepareReviewWork(sandbox,trusted,{manifest,requirements:[],decisions:[{axis:"engineering-quality",selected:true,reason:"Core review",paths}],config:{lanes:[]},claim:overrides.claim??"Implement both component constants."},overrides.store ?? {store});
    const packets = await Promise.all(plan.units.map(async unit=>preparedReviewWorkPacketSchema.parse(JSON.parse((await sandbox.readTextFile({path:unit.packetPath}))!))));
    return {plan,packets,trusted};
  }
  function assessment(packet: PreparedReviewWorkPacket):ReviewWorkAssessment {
    return reviewWorkAssessmentSchema.parse({schemaVersion:1,unit:packet.unit,inputDigest:packet.inputDigest,sourceBaseSha:packet.manifest.baseSha,sourceHeadSha:packet.manifest.headSha,
      proof:{schemaVersion:2,inputSnapshot:packet.inputSnapshot,sources:[],probes:[],external:[]},checkpoint:{status:"complete",reviewedEntries:[0],remainingEntries:[],observations:[],nextSteps:[],limitations:[],completedReport:{axis:packet.unit.axis,scope:{claim:packet.originalClaim,dirtyState:"Clean exact head",inspectedSupportingContext:[]},coverage:{staticOnly:[],unreached:[]},churn:{window:"Current change",symbolCoverage:[],fileFallbacks:[]},probes:[],candidates:[],verifiedClaims:["Inspected the component behavior"],limitations:[],specialistChecks:null,requirementChecks:[]}}});
  }
  async function save(record: ReviewWorkAssessment) { await store.put({...workAssessmentStorageKey(record),data:JSON.stringify(record)}); }
  return {root,files,runtime,sandbox,git,commit,baseSha,headSha,prepare,assessment,save,store,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test("a new head reuses completed independent work before any published baseline exists",async()=>{
  const f = await fixture();
  try {
    const first = await f.prepare(f.headSha);
    await f.save(f.assessment(first.packets[0]!)); // The other unit has never completed.
    const nextHead = await f.commit({"src/b/index.ts":"export const b = 2;\n"});
    const next = await f.prepare(nextHead);
    expect(next.plan.units.map(unit=>[unit.component,unit.status])).toEqual([["src/a","reused"],["src/b","pending"]]);
    expect(next.plan.units[0]!.reusableAssessment!.sourceHeadSha).toBe(f.headSha);
    const persisted = preparedReviewWorkPlanSchema.parse(JSON.parse((await f.sandbox.readTextFile({path:reviewWorkPlanPath(next.plan.patchFingerprint)}))!));
    expect(persisted).toEqual(next.plan);
    expect(f.files.get(next.plan.units[0]!.packetPath)).toStartWith("known-good-review-signed-v1 ");
    expect(await f.sandbox.readTextFile({path:next.plan.units[0]!.resultPath})).toBeNull(); // Root owns current receipt issuance.
  } finally { await f.cleanup(); }
});

test("a tiny fix carries the prior candidate and original claim beside its exact update patch",async()=>{
  const f = await fixture();
  try {
    const first = await f.prepare(f.headSha);
    const record = f.assessment(first.packets[0]!);
    record.checkpoint.completedReport!.candidates.push({title:"The component constant is wrong",location:{path:"src/a/index.ts",line:1,symbol:"a"},evidence:["Expected two; observed one"],impact:"Wrong exported behavior",remedy:"Return two",staticOnly:true,churn:null,uncertainty:[]});
    await f.save(record);
    const nextHead = await f.commit({"src/a/index.ts":"export const a = 2;\n"});
    const next = await f.prepare(nextHead);
    const packet = next.packets[0]!;
    expect(next.plan.units[0]!.status).toBe("pending");
    expect(packet.originalClaim).toBe(first.packets[0]!.originalClaim);
    expect(packet.priorAssessment!.checkpoint.completedReport!.candidates).toEqual(record.checkpoint.completedReport!.candidates);
    expect(packet.patches[0]!.fromHead).toBe(f.headSha);
    expect(packet.patches[0]!.content).toContain("-export const a = 1;");
    expect(packet.patches[0]!.content).toContain("+export const a = 2;");
    expect(packet.patches[0]!.content).not.toContain("-export const a = 0;");
  } finally { await f.cleanup(); }
});

test("changed supporting source and unknown proof invalidate otherwise matching work",async()=>{
  const f = await fixture();
  try {
    const first = await f.prepare(f.headSha);
    const record = f.assessment(first.packets[0]!);
    const proof = reviewWorkProofSchema.parse(record.proof);
    proof.sources.push(await observeReviewSource(f.sandbox,first.trusted,{operation:"read",revision:"head",path:"shared/contract.ts",query:null,cursor:null}));
    record.proof = proof;
    await f.save(record);
    const nextHead = await f.commit({"shared/contract.ts":"export const limit = 2;\n"});
    const next = await f.prepare(nextHead);
    expect(next.plan.units[0]!.inputDigest).toBe(first.plan.units[0]!.inputDigest);
    expect(next.plan.units[0]!.status).toBe("pending");
    record.proof = {unknownContract:true}; await f.save(record);
    expect((await f.prepare(nextHead)).plan.units[0]!.status).toBe("pending");
  } finally { await f.cleanup(); }
});

test("operational failures and artifact tampering never turn into silent fresh assessment",async()=>{
  const f = await fixture();
  try {
    const first = await f.prepare(f.headSha);
    const record = f.assessment(first.packets[0]!);
    const proof = reviewWorkProofSchema.parse(record.proof);
    proof.sources.push(await observeReviewSource(f.sandbox,first.trusted,{operation:"read",revision:"head",path:"shared/contract.ts",query:null,cursor:null}));
    record.proof = proof; await f.save(record);
    const failedStore = {get:async():Promise<CompletedReviewWork|null>=>{throw new Error("storage unavailable");},latest:f.store.latest};
    await expect(f.prepare(f.headSha,{store:{store:failedStore}})).rejects.toThrow("storage unavailable");
    const originalRun = f.runtime.run;
    f.runtime.run = async input => input.command.includes("--no-replace-objects") ? {exitCode:128,stdout:"",stderr:"workspace disk unavailable"} : originalRun(input);
    await expect(f.prepare(f.headSha)).rejects.toThrow("workspace disk unavailable");
    f.runtime.run = originalRun;
    f.files.set(first.plan.units[0]!.packetPath,"tampered packet");
    await expect(f.sandbox.readTextFile({path:first.plan.units[0]!.packetPath})).rejects.toThrow("authentication failed");
  } finally { await f.cleanup(); }
});

test("changed trusted claim prevents reuse, while malformed historical data remains untrusted",async()=>{
  const f = await fixture();
  try {
    const first = await f.prepare(f.headSha); await f.save(f.assessment(first.packets[0]!));
    expect((await f.prepare(f.headSha,{claim:"Implement a different behavior."})).plan.units[0]!.status).toBe("pending");
    const corrupt = {get:async({scopeKey,inputDigest}:{scopeKey:string;inputDigest:string})=>({data:"{invalid",scopeKey,inputDigest,sourceAttemptId:"old"}),latest:f.store.latest};
    const next = await f.prepare(f.headSha,{store:{store:corrupt}});
    expect(next.plan.units.every(unit=>unit.status === "pending")).toBe(true);
    expect(next.packets[0]!.reuseInvalidation).toContain("unknown assessment contract");
  } finally { await f.cleanup(); }
});

test("interruption before the first completion preserves progress without declaring it reused",async()=>{
  const f = await fixture();
  try {
    const first = await f.prepare(f.headSha);
    const record = f.assessment(first.packets[0]!);
    record.checkpoint = {status:"in-progress",reviewedEntries:[],remainingEntries:[0],observations:[{disposition:"lead",summary:"The component export was inspected; caller verification remains.",evidence:["The export now returns one."]}],nextSteps:["Verify the public caller."],limitations:[],completedReport:null};
    await f.save(record);
    const nextHead = await f.commit({"src/b/index.ts":"export const b = 3;\n"});
    const next = await f.prepare(nextHead);
    expect(next.plan.units[0]!.status).toBe("pending");
    expect(next.plan.units[0]!.reusableAssessment).toBeNull();
    expect(next.packets[0]!.priorAssessment!.checkpoint.observations).toEqual(record.checkpoint.observations);
    expect(next.packets[0]!.priorAssessment!.checkpoint.nextSteps).toEqual(record.checkpoint.nextSteps);
  } finally { await f.cleanup(); }
});

test("current completion consumes fresh probe and external receipts, while later reuse rejects them", async () => {
  const { captureReviewWorkProof, validateCurrentReviewWorkProof, validateReviewWorkProof } = await import("../src/review/prepare-review-work");
  const { runSharedReviewProbe, recordWorkProbeReceipt } = await import("../src/review/probe-execution");
  const { recordWorkExternalObservation } = await import("../src/review/external-observations");
  const f = await fixture();
  try {
    const { packets, trusted } = await f.prepare(f.headSha);
    const packet = packets[0]!;
    const claims = { async assertCurrent() {}, async assertHealthy() {}, async fail() {}, async claim(_path:string,owner:string) { return {acquired:true,owner}; }, async release() {} };
    const result = await runSharedReviewProbe({ command:"printf 'fresh observation'; mkdir generated", cwd:".", stdin:null, environment:[], rerun:true }, {
      repositoryId:trusted.repositoryId, origin:{attemptId:trusted.deliveryId,sessionId:"native-child",callId:"probe"}, evidence:f.sandbox, claims,
      observe:async()=>({sourceDigest:"a".repeat(64),environmentDigest:"b".repeat(64),externalStateDigest:null,reuse:"fresh"}),
      execute:async()=>f.sandbox.run({command:"printf 'fresh observation'; mkdir generated"}),
    });
    await recordWorkProbeReceipt(f.sandbox,claims,trusted.patchFingerprint,packet.unit.id,result.receipt,undefined,trusted.deliveryId);
    await recordWorkExternalObservation(f.sandbox,claims,{fingerprint:trusted.patchFingerprint,workId:packet.unit.id,attemptId:trusted.deliveryId},{kind:"web",target:"https://example.com/official-docs",content:"Observed native documentation response"});
    const record = f.assessment(packet);
    record.proof = await captureReviewWorkProof(f.sandbox,trusted.patchFingerprint,packet.unit,packet.inputSnapshot,trusted.deliveryId);
    expect(await validateCurrentReviewWorkProof(f.sandbox,trusted,undefined,record,packet.inputSnapshot,trusted.deliveryId)).toBe(true);
    expect(await validateReviewWorkProof(f.sandbox,trusted,undefined,record,packet.inputSnapshot)).toBe(false);
    expect(await validateCurrentReviewWorkProof(f.sandbox,trusted,undefined,record,packet.inputSnapshot,"other-attempt")).toBe(false);
    const proof = reviewWorkProofSchema.parse(record.proof);
    record.proof = {...proof,external:[]};
    expect(await validateCurrentReviewWorkProof(f.sandbox,trusted,undefined,record,packet.inputSnapshot,trusted.deliveryId)).toBe(false);
    const { external:_external,...old } = proof;
    record.proof = {...old,schemaVersion:1};
    expect(await validateReviewWorkProof(f.sandbox,trusted,undefined,record,packet.inputSnapshot)).toBe(false);
  } finally { await f.cleanup(); }
});

test("changed supporting source persists a new immutable Convex version and the next head reuses it", async () => {
  const f = await fixture();
  const priorToken = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "work-version-regression";
  const modules = { "../convex/_generated/server.js": () => import("../convex/_generated/server.js"), "../convex/reviewWorkData.ts": () => import("../convex/reviewWorkData"), "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle"), "../convex/http.ts": () => import("../convex/http") };
  const t = convexTest(convexSchema, modules);
  try {
    const request = async (operation:"put"|"get"|"latest",body:unknown) => {
      const response = await t.fetch(`/review-work/${operation}`, { method:"POST", headers:{authorization:"Bearer work-version-regression","content-type":"application/json"}, body:JSON.stringify(body) });
      if (!response.ok) throw new Error(`Actual completed-work HTTP ${response.status}`);
      return response.json();
    };
    async function attempt(headSha:string,number:number) {
      await t.mutation(internal.reviewLifecycle.admit,{deliveryId:`version-${number}`,repository:"acme/widget",repositoryId:"R_widget",pullRequest:43,headSha,eventTime:number,body:"{}",event:"pull_request",signature:""});
      const [job] = await t.mutation(internal.reviewLifecycle.claim,{capacity:4});
      if (!job) throw new Error("Fixture admission did not claim work");
      const store = completedReviewWorkStore({repositoryId:"R_widget",pullRequest:43,deliveryId:job.attemptId},{secret:"ab".repeat(32),request});
      return {job,store};
    }
    const firstAttempt = await attempt(f.headSha,1);
    const first = await f.prepare(f.headSha,{attemptId:firstAttempt.job.attemptId,store:{store:firstAttempt.store}});
    const original = f.assessment(first.packets[0]!);
    const proof = reviewWorkProofSchema.parse(original.proof);
    proof.sources.push(await observeReviewSource(f.sandbox,first.trusted,{operation:"read",revision:"head",path:"shared/contract.ts",query:null,cursor:null}));
    original.proof = proof;
    await firstAttempt.store.put({...workAssessmentStorageKey(original),data:JSON.stringify(original)});
    await t.mutation(internal.reviewLifecycle.finish,{attemptId:firstAttempt.job.attemptId,outcome:"complete"});
    const changedHead = await f.commit({"shared/contract.ts":"export const limit = 2;\n"});
    const changedAttempt = await attempt(changedHead,2);
    const changed = await f.prepare(changedHead,{attemptId:changedAttempt.job.attemptId,store:{store:changedAttempt.store}});
    expect(changed.plan.units[0]!.inputDigest).toBe(first.plan.units[0]!.inputDigest);
    expect(changed.plan.units[0]!.status).toBe("pending");
    const revised = f.assessment(changed.packets[0]!);
    const revisedProof = reviewWorkProofSchema.parse(revised.proof);
    revisedProof.sources.push(await observeReviewSource(f.sandbox,changed.trusted,{operation:"read",revision:"head",path:"shared/contract.ts",query:null,cursor:null}));
    revised.proof = revisedProof;
    expect(await changedAttempt.store.put({...workAssessmentStorageKey(revised),data:JSON.stringify(revised)})).toBe("stored");
    expect(await t.run(ctx=>ctx.db.query("completedReviewWork").take(10))).toHaveLength(2);
    const latest = await changedAttempt.store.get(workAssessmentStorageKey(revised));
    expect(latest?.sourceAttemptId).toBe(changedAttempt.job.attemptId);
    expect(JSON.parse(latest!.data).proof.sources[0].id).toBe(revisedProof.sources[0]!.id);
    // Same checkpoint with a different proof is also an immutable progress version.
    const progress = {...revised,checkpoint:{status:"in-progress" as const,reviewedEntries:[],remainingEntries:[0],observations:[],nextSteps:["Check caller"],limitations:[],completedReport:null}};
    await changedAttempt.store.put({...workAssessmentStorageKey(progress),data:JSON.stringify(progress)});
    await changedAttempt.store.put({...workAssessmentStorageKey(progress),data:JSON.stringify({...progress,proof})});
    expect(await t.run(ctx=>ctx.db.query("completedReviewWork").take(10))).toHaveLength(4);
    expect(JSON.parse((await changedAttempt.store.get(workAssessmentStorageKey(revised)))!.data)).toEqual(revised);
    await t.mutation(internal.reviewLifecycle.finish,{attemptId:changedAttempt.job.attemptId,outcome:"complete"});
    const nextHead = await f.commit({"src/b/index.ts":"export const b = 3;\n"});
    const nextAttempt = await attempt(nextHead,3);
    const next = await f.prepare(nextHead,{attemptId:nextAttempt.job.attemptId,store:{store:nextAttempt.store}});
    expect(next.plan.units[0]!.status).toBe("reused");
    expect(next.plan.units[0]!.reusableAssessment!.sourceHeadSha).toBe(changedHead);
    expect(next.plan.units[1]!.status).toBe("pending");
  } finally {
    if (priorToken===undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN; else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN=priorToken;
    await f.cleanup();
  }
});
