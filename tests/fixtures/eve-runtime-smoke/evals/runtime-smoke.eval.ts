import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Checks public GET/HEAD responses through compiled Eve routes and routed root-copy child streaming through production instrumentation.",
  tags: ["mock-model", "runtime-smoke"],
  async test(t) {
    // Exercise production channel discovery and Nitro's compiled route names.
    // Content and host-policy matrices remain in the landing unit tests.
    for (const [path, contentType] of [
      ["/", "text/html"],
      ["/robots.txt", "text/plain"],
      ["/sitemap.xml", "application/xml"],
      ["/assets/slop-sheriff-hero.webp", "image/webp"],
      ["/assets/slop-sheriff-icon.png", "image/png"],
      ["/assets/slop-sheriff-social.jpg", "image/jpeg"],
    ] as const) {
      const get = await t.target.fetch(path);
      await t.require(get.status, equals(200));
      t.check(get.headers.get("content-type"), includes(contentType));
      const body = await get.arrayBuffer();
      t.check(body.byteLength > 0, equals(true));
      if (path === "/robots.txt") {
        t.check(new TextDecoder().decode(body), includes("Allow: /$\nAllow: /assets/\nDisallow: /eve/\n"));
      }
      const head = await t.target.fetch(path, { method: "HEAD" });
      t.check(head.status, equals(200));
      for (const header of ["content-type", "cache-control", "etag", "x-robots-tag"]) {
        t.check(head.headers.get(header), equals(get.headers.get(header)));
      }
      t.check((await head.arrayBuffer()).byteLength, equals(0));
    }
    for (const method of ["GET", "HEAD"]) {
      t.check((await t.target.fetch("/robots{.txt}", { method })).status, equals(404));
    }

    const projectSession = t.newSession();
    const projectTurn = await projectSession.send("KGR-EVAL-AUTHORED-ROOT KGR-EVAL-PROJECT-LANES");
    projectTurn.expectOk();
    projectTurn.messageIncludes("AUTHORED-REVIEW-COMPLETE");
    projectTurn.noFailedActions();
    const projectChildren = projectTurn.events.filter((event) => event.type === "subagent.called");
    await t.require(projectChildren.length, equals(2));
    for (const event of projectChildren) {
      const child = await t.target.attachSession(event.data.childSessionId);
      child.succeeded();
      child.calledTool("fixture_checkpoint", { count: 1 });
    }

    const budgetSession = t.newSession();
    const budget = await budgetSession.send("KGR-EVAL-BUDGET-ROOT");
    budget.expectOk();
    budget.messageIncludes("BUDGET-RECONCILIATION-COMPLETE");
    budget.calledTool("fixture_step", { count: 1 });
    budget.noFailedActions();

    const roleSession = t.newSession();
    const roleTurn = await roleSession.send("KGR-EVAL-ROLE-ROOT");
    roleTurn.expectOk();
    roleTurn.messageIncludes("ROLE-RESOLUTION-COMPLETE");
    roleTurn.noFailedActions();

    let turn = await t.send("KGR-EVAL-SUBAGENT-ROUTING");
    if (!t.sessionId) throw new Error("Expected a root session");
    // Delegation returns a working receipt in Eve 0.52. Continue reading the
    // real session stream until the child result wakes and completes the root.
    let cursor = turn.events.length;
    const parentEvents = [...turn.events];
    while (turn.message !== "SUBAGENT-ROUTING-COMPLETE") {
      turn = await t.target.watchTurn(t.sessionId, { startIndex: cursor }).result();
      cursor += turn.events.length;
      parentEvents.push(...turn.events);
    }

    const delegated = parentEvents.find((event) => event.type === "subagent.called");
    if (!delegated) throw new Error("Expected a delegated child session");
    const child = await t.target.attachSession(delegated.data.childSessionId);
    child.succeeded();
    child.calledTool("fixture_step", { count: 1, input: { marker: "routing" } });
    child.messageIncludes("SUBAGENT-CHILD-COMPLETE");

    const initial = await t.target.attachSession(t.sessionId);
    initial.succeeded();
    turn.noFailedActions();
    initial.calledSubagent("agent", {
      count: 1,
    });
    t.eventOrder([
      { type: "subagent.called", data: { childSessionId: delegated.data.childSessionId }, count: 1 },
      { type: "message.received", data: { message: /Result:\nSUBAGENT-CHILD-COMPLETE/ }, count: 1 },
      { type: "message.completed", data: { message: "SUBAGENT-ROUTING-COMPLETE" }, count: 1 },
    ]);
    t.messageIncludes("SUBAGENT-ROUTING-COMPLETE");

    // The waiting Workflow must finish its child before the same parent turn
    // returns. This also proves Eve builds and executes without an app SDK pin.
    const workflowTurn = await t.send("KGR-EVAL-WORKFLOW-ROUTING");
    workflowTurn.expectOk();
    workflowTurn.calledTool("fixture_workflow", { count: 1 });
    t.messageIncludes("WORKFLOW-ROUTING-COMPLETE");
    workflowTurn.noFailedActions();
    const workflowDelegation = workflowTurn.events.find((event) => event.type === "subagent.called");
    if (!workflowDelegation) throw new Error("Expected a Workflow child session");
    const workflowChild = await t.target.attachSession(workflowDelegation.data.childSessionId);
    workflowChild.succeeded();
    workflowChild.calledTool("fixture_step", { count: 1, input: { marker: "routing" } });
    workflowChild.messageIncludes("SUBAGENT-CHILD-COMPLETE");

    const authored = await t.send("KGR-EVAL-AUTHORED-ROOT");
    authored.expectOk();
    authored.calledTool("review_workflow", { count: 1 });
    t.messageIncludes("AUTHORED-REVIEW-COMPLETE");
    authored.noFailedActions();
    const children = authored.events.filter((event) => event.type === "subagent.called");
    if (new Set(children.map((event) => event.data.childSessionId)).size !== 5) throw new Error("Expected three lanes, one scout, and a fresh continuation");
    for (const event of children) {
      const child = await t.target.attachSession(event.data.childSessionId);
      child.succeeded();
    }

    const scoutRecoverySession = t.newSession();
    const recoveredScout = await scoutRecoverySession.send("KGR-EVAL-AUTHORED-ROOT KGR-EVAL-SCOUT-PROSE");
    recoveredScout.expectOk();
    recoveredScout.messageIncludes("AUTHORED-REVIEW-COMPLETE");
    recoveredScout.noFailedActions();
    const recoveryChildren = recoveredScout.events.filter((event) => event.type === "subagent.called");
    if (recoveryChildren.length !== 6) throw new Error("Expected one failed scout, one receipt retry, and no replacement completed lanes");
    const retriedScout = recoveryChildren.find((event) => event.data.callId.endsWith(":receipt-retry"));
    if (!retriedScout) throw new Error("Scout output failure never reached application recovery");
    const retrySession = await t.target.attachSession(retriedScout.data.childSessionId);
    retrySession.succeeded();

    const repeated = await t.send("KGR-EVAL-AUTHORED-REPEAT");
    repeated.messageIncludes("AUTHORED-REPLAY-COMPLETE");
    repeated.noFailedActions();
    const repeatedChildren = repeated.events.filter((event) => event.type === "subagent.called");
    if (new Set(repeatedChildren.map((event) => event.data.childSessionId)).size !== 3) throw new Error("Same-root replay did not reuse complete checkpoints");

    const guardedSession = t.newSession();
    const guarded = await guardedSession.send("KGR-EVAL-ROOT-GUARD");
    guarded.messageIncludes("ROOT-GUARD-COMPLETE");
    const guardedChildren = guarded.events.filter((event) => event.type === "subagent.called");
    if (guardedChildren.length !== 1 || !guardedChildren[0]) throw new Error("Nested orchestration dispatched grandchildren");
    const guardedChild = await t.target.attachSession(guardedChildren[0].data.childSessionId);
    guardedChild.succeeded();
    guardedChild.calledTool("review_workflow", { status: "failed", count: 1 });
    guardedChild.notCalledTool("agent");

    const concurrentSession = t.newSession();
    const concurrent = await concurrentSession.send("KGR-EVAL-CONCURRENT-ROOT");
    concurrent.messageIncludes("CONCURRENT-GUARD-COMPLETE");
    const concurrentChildren = concurrent.events.filter((event) => event.type === "subagent.called");
    if (new Set(concurrentChildren.map((event) => event.data.childSessionId)).size !== 5) throw new Error("Concurrent invocation admitted duplicate lanes");

    const windowSession = t.newSession();
    const window = await windowSession.send("KGR-EVAL-WINDOW-ROOT");
    window.event("turn.failed");
    const requested = window.events.find((event) => event.type === "actions.requested" && event.data.actions.some((action) => "toolName" in action && action.toolName === "review_workflow"));
    if (!requested || requested.type !== "actions.requested" || requested.data.stepIndex !== 16) throw new Error("Workflow cutoff was not exercised at step sixteen");
    if (window.events.some((event) => event.type === "subagent.called")) throw new Error("Workflow cutoff dispatched a child");
    if (!JSON.stringify(window.events).includes("further workflow dispatch is forbidden")) throw new Error("Workflow cutoff did not fail through the application hook");
  },
});
