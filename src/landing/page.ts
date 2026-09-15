export const siteOrigin = "https://slop-sheriff.dev";
export const repositoryUrl = "https://github.com/frostney/slop-sheriff";

const description = "Meet Slop Sheriff, a cowboy GitHub code reviewer. Focused review lanes, concise findings, and evidence you can inspect. Deploy it on your own infrastructure.";

export function llmsTxt(): string {
  return `# Slop Sheriff

> Meet Slop Sheriff, a cowboy GitHub code reviewer. Focused review lanes, concise findings, and evidence you can inspect. Deploy it on your own infrastructure.

- Canonical: ${siteOrigin}
- GitHub: ${repositoryUrl}

## What it does

Slop Sheriff reviews pull requests with focused specialist lanes, then reconciles findings into one report. Impact summaries stay short; evidence stays inspectable. You self-host it with your own GitHub connection, model access, and infrastructure.

## What this is not

This is a self-hosted GitHub code reviewer. It is not a hosted SaaS, a merge bot, or a claim about whether a person or an AI wrote the code.
`;
}


export function landingPage(indexable: boolean, sourceRevision?: string): string {
  const revision = sourceRevision && /^[a-f0-9]{40}$/i.test(sourceRevision) ? sourceRevision : "main";
  const installGuideUrl = `${repositoryUrl}/blob/${revision}/docs/install.md`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f6f0e4">
<title>Slop Sheriff | A new code reviewer in town</title>
<meta name="description" content="${description}">
<meta name="robots" content="${indexable ? "index, follow" : "noindex, nofollow"}">
<link rel="canonical" href="${siteOrigin}/">
<link rel="icon" type="image/png" href="/assets/slop-sheriff-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Slop Sheriff">
<meta property="og:title" content="Slop Sheriff | A new code reviewer in town">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${siteOrigin}/">
<meta property="og:image" content="${siteOrigin}/assets/slop-sheriff-social.jpg">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta property="og:image:alt" content="Slop Sheriff, a robot cowboy following a trail of code through the desert">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Slop Sheriff | A new code reviewer in town">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${siteOrigin}/assets/slop-sheriff-social.jpg">
<meta name="twitter:image:alt" content="Slop Sheriff, a robot cowboy following a trail of code through the desert">
<style>
:root{color-scheme:light;--paper:#f6f0e4;--ink:#282b29;--muted:#565a52;--line:#c8c4b5;--teal:#155c58;--rust:#9d4328;--mono:ui-monospace,SFMono-Regular,Consolas,monospace;--serif:Rockwell,"Rockwell Nova","DejaVu Serif",Georgia,serif}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit;text-underline-offset:4px}a:hover{color:var(--teal)}a:focus-visible,summary:focus-visible{outline:3px solid var(--teal);outline-offset:5px}::selection{background:#c5ded4}img{max-width:100%;display:block}h1,h2,h3,p{margin:0}h1,h2{font-family:var(--serif);font-weight:900;letter-spacing:-.045em;line-height:1.07}h1{font-size:clamp(3.2rem,6.5vw,5.7rem)}h2{font-size:clamp(2.2rem,4vw,3.6rem)}h3{font-size:1.12rem;line-height:1.4}p+p{margin-top:16px}.wrap{width:min(1160px,calc(100% - 64px));margin-inline:auto}.skip{position:absolute;top:-100px;left:20px;z-index:2;background:var(--paper);padding:12px}.skip:focus{top:12px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-block:25px;border-bottom:1px solid var(--ink)}.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-family:var(--serif);font-weight:900;font-size:1.3rem}.brand img{border-radius:50%;width:44px;height:44px}.nav{display:flex;gap:28px;font-size:.88rem;font-weight:650}.nav a{text-decoration:none;padding-block:8px}.eyebrow{font:650 .72rem/1.5 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--teal);margin-bottom:22px}.hero{padding-top:60px}.hero-intro{display:grid;grid-template-columns:1.3fr 1fr;gap:64px;align-items:end;margin-bottom:42px}.hero h1{max-width:700px}.hero h1 span{color:var(--rust)}.hero-copy{max-width:410px;padding-bottom:5px}.hero-copy p{font-size:1.12rem}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:22px;margin-top:25px}.button{display:inline-flex;align-items:center;gap:25px;background:var(--teal);color:#fff;padding:13px 20px;text-decoration:none;font-weight:650;border:1px solid var(--teal)}.button:hover{background:#104b47;color:#fff}.text-link{font-size:.92rem;font-weight:650}.hero-art{width:100%;height:auto;aspect-ratio:2/1;object-fit:cover;border:1px solid var(--ink);border-radius:3px}.caption{display:flex;justify-content:space-between;gap:20px;padding-block:14px;font:500 .72rem/1.5 var(--mono);color:var(--muted)}.section{padding-block:86px;border-bottom:1px solid var(--line)}.section-intro{display:grid;grid-template-columns:1fr 1fr;gap:80px;margin-bottom:40px;align-items:end}.section-intro p{max-width:490px;color:var(--muted)}.section-intro .eyebrow{color:var(--teal)}.lanes{border-top:1px solid var(--ink)}.lane{display:grid;grid-template-columns:45px minmax(200px,.9fr) 1.5fr;gap:16px;align-items:start;padding-block:23px;border-bottom:1px solid var(--line)}.lane:last-child{border-bottom:0}.lane-number{font:500 .8rem/1.8 var(--mono);color:var(--rust)}.lane p{color:var(--muted);font-size:.95rem}.lane small{display:block;font:500 .68rem/1.5 var(--mono);color:var(--teal);margin-top:6px;text-transform:uppercase;letter-spacing:.04em}.review-layout{display:grid;grid-template-columns:.8fr 1.2fr;gap:70px;align-items:start}.review-copy p{margin-top:22px;color:var(--muted)}.review-copy .eyebrow{margin-top:0}.review{background:#fffdf7;border:1px solid var(--ink);box-shadow:7px 7px 0 #ded8c9}.review-head{display:flex;align-items:center;gap:13px;padding:18px 22px;border-bottom:1px solid var(--line);font-size:.87rem}.review-head img{width:38px;height:38px;border-radius:50%}.review-head strong{display:block}.review-head small{color:var(--muted)}.review-body{padding:26px}.tag{display:inline-block;font:600 .67rem/1.5 var(--mono);text-transform:uppercase;color:var(--rust);border:1px solid #d9b7a6;padding:3px 8px;margin-bottom:14px}.review h3{font-size:1.17rem}.location{font:.73rem/1.7 var(--mono);color:var(--muted);margin-block:10px 18px;overflow-wrap:anywhere}.review p{font-size:.93rem}.review details{border-top:1px solid var(--line);margin-top:22px;padding-top:15px}.review summary{cursor:pointer;font-weight:650;font-size:.9rem;padding-block:5px}.review details p{margin-top:14px}.review code{font-size:.84em}.review-note{font:500 .69rem/1.6 var(--mono);color:var(--muted);margin-top:17px}.install{background:var(--ink);color:var(--paper);margin-top:76px;padding-block:70px}.install .eyebrow{color:#b7d6c7}.install-layout{display:grid;grid-template-columns:1fr 1fr;gap:70px}.install h2{max-width:430px}.install p{color:#d0d2c8;margin-top:22px}.install a:hover{color:#b7d6c7}.install .button{background:#c1d9c9;color:var(--ink);border-color:#c1d9c9}.steps{margin:0;padding:0;list-style:none;counter-reset:step}.steps li{counter-increment:step;position:relative;padding:0 0 26px 43px}.steps li::before{content:"0" counter(step);position:absolute;left:0;font:.76rem/1.8 var(--mono);color:#b7d6c7}.steps h3{font-size:1rem}.steps p{font-size:.9rem;margin-top:7px}.config{margin-top:26px;padding-top:27px;border-top:1px solid #64675e;display:grid;grid-template-columns:1fr 1fr;gap:70px}.config p{margin:0;font-size:.9rem}.config pre{margin:0;font:.84rem/1.8 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}.config .comment{color:#bbc6b8}.limits{display:grid;grid-template-columns:1fr 1fr;gap:70px;padding-block:70px}.limits h3{font-family:var(--serif);font-size:1.6rem;margin-bottom:17px}.limits p{font-size:.93rem;color:var(--muted)}.footer{border-top:1px solid var(--ink);padding-block:28px 40px;display:flex;justify-content:space-between;align-items:center;gap:30px;font-size:.83rem}.footer p{color:var(--muted)}.footer-links{display:flex;gap:25px}.star{color:var(--rust);margin-right:7px}
@media(min-width:1600px){.wrap{width:min(1300px,calc(100% - 100px))}}
@media(max-width:850px){.hero-intro,.section-intro,.review-layout,.install-layout,.config,.limits{gap:32px}.hero-intro{grid-template-columns:1.15fr 1fr}.hero-copy p{font-size:1rem}.nav{gap:18px}.review-layout{grid-template-columns:1fr 1.15fr}.review-body{padding:20px}.lane{grid-template-columns:30px minmax(160px,.8fr) 1fr}}
@media(max-width:640px){body{font-size:16px}.wrap{width:calc(100% - 36px)}.masthead{padding-block:18px;gap:16px}.brand{font-size:1.06rem;gap:8px}.brand img{width:34px;height:34px}.nav{gap:17px;font-size:.8rem}.nav .desktop-link{display:none}.hero{padding-top:36px}.hero-intro,.section-intro,.review-layout,.install-layout,.config,.limits{grid-template-columns:1fr;gap:27px}.hero-intro{margin-bottom:29px}.hero h1{font-size:clamp(3.05rem,11vw,4.4rem)}.hero-copy{max-width:none}.hero-copy p{font-size:1.05rem}.eyebrow{margin-bottom:16px}.actions{margin-top:23px}.caption{font-size:.63rem;gap:12px}.caption span:last-child{text-align:right}.section{padding-block:53px}.section-intro{margin-bottom:28px}.lane{grid-template-columns:27px 1fr;gap:7px 10px;padding-block:21px}.lane p{grid-column:2}.lane small{display:inline-block;margin:6px 0 0}.review{box-shadow:4px 4px 0 #ded8c9}.review-copy p{margin-top:17px}.install{margin-top:48px;padding-block:48px}.install-layout{gap:37px}.config{margin-top:5px;gap:20px}.limits{padding-block:48px;gap:34px}.footer{align-items:flex-start;flex-direction:column;gap:15px;padding-bottom:28px}.footer-links{gap:24px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="masthead wrap">
<a class="brand" href="/" aria-label="Slop Sheriff home"><img src="/assets/slop-sheriff-icon.png" width="44" height="44" alt="">Slop Sheriff</a>
<nav class="nav" aria-label="Main navigation"><a class="desktop-link" href="#review">The review</a><a href="#install">Self-host</a><a href="${repositoryUrl}">GitHub ↗</a></nav>
</header>
<main id="main">
<section class="hero wrap" aria-labelledby="hero-title">
<p class="eyebrow">A cowboy with a code review habit</p>
<div class="hero-intro">
<h1 id="hero-title">There’s a new<br><span>reviewer in town.</span></h1>
<div class="hero-copy"><p>Meet Slop Sheriff. Your pull request rides in; a robot cowboy checks the claims, follows the evidence, and leaves you findings worth a closer look.</p><div class="actions"><a class="button" href="#install">Put the Sheriff to work <span aria-hidden="true">↗</span></a><a class="text-link" href="#review">See a review ↓</a></div></div>
</div>
<img class="hero-art" src="/assets/slop-sheriff-hero.webp" width="1774" height="887" alt="Slop Sheriff, a robot cowboy carrying review notes and following code tracks toward a Clean code sign" fetchpriority="high">
<div class="caption"><span>GitHub pull requests. A little frontier spirit.</span><span>Self-hosted · Review-only · Advisory by default</span></div>
</section>
<section class="section wrap" id="lanes" aria-labelledby="lanes-title">
<div class="section-intro"><div><p class="eyebrow">01 / A posse with a purpose</p><h2 id="lanes-title">Different trails.<br>One review.</h2></div><p>Focused lanes inspect the change from different angles. Their evidence comes together in one report, with related findings reconciled and uncertainty kept visible.</p></div>
<div class="lanes">
<div class="lane"><span class="lane-number">01</span><h3>Reuse &amp; design<small>Core lane</small></h3><p>Look for duplicated logic, competing representations, and abstractions that earn their place.</p></div>
<div class="lane"><span class="lane-number">02</span><h3>Claims &amp; specification<small>Core lane</small></h3><p>Compare the change with its stated requirements. Find gaps between what was promised and what was built.</p></div>
<div class="lane"><span class="lane-number">03</span><h3>Engineering quality<small>Core lane</small></h3><p>Trace correctness, failure paths, trust boundaries, and the cost of maintaining the code.</p></div>
<div class="lane"><span class="lane-number">04</span><h3>Test against the spec<small>Requirements and real interfaces</small></h3><p>Exercise explicit requirements through the available UI, API, or runtime. Unavailable execution stays unverified.</p></div>
<div class="lane"><span class="lane-number">05</span><h3>Test health<small>When affected tests are in scope</small></h3><p>Check whether tests protect public behavior, catch relevant failures, and tolerate internal refactors.</p></div>
<div class="lane"><span class="lane-number">06</span><h3>Discoverability<small>When public web content is in scope</small></h3><p>Inspect crawl controls, metadata, semantics, rendering, and the paths that help people find the page.</p></div>
<div class="lane"><span class="lane-number">07</span><h3>Writing quality<small>When authored language is in scope</small></h3><p>Flag concrete clarity problems in prose, strings, and comments, with an economical rewrite.</p></div>
</div>
</section>
<section class="section wrap" id="review" aria-labelledby="review-title">
<div class="review-layout"><div class="review-copy"><p class="eyebrow">02 / Show your work, partner</p><h2 id="review-title">Short impact.<br>Long evidence.</h2><p>Each new finding leads with an impact summary of at most 300 characters. Expand it for the evidence and a suggested remedy.</p><p>Findings keep stable identities across reviews. After a completed full review, follow-up reviews inspect the changed files and revalidate selected earlier findings.</p><p>The cowboy voice is optional. Set <code>personality: false</code> for plain language; evidence and severity stay the same.</p></div>
<div><article class="review" aria-label="Synthetic example review finding"><header class="review-head"><img src="/assets/slop-sheriff-icon.png" alt="" width="38" height="38" loading="lazy"><div><strong>Slop Sheriff <span aria-hidden="true">★</span></strong><small>Synthetic example · Engineering quality</small></div></header><div class="review-body"><span class="tag">Important</span><h3>Check ownership before returning the invoice</h3><div class="location">src/invoices/get-invoice.ts · line 24</div><p>A signed-in user can fetch another account’s invoice by changing the ID. Check the invoice’s account against the caller before returning its contents.</p><details><summary>Evidence &amp; suggested fix</summary><p><strong>Evidence.</strong> In this invented example, the handler authenticates the caller, then loads an invoice by ID without checking its account. A request as account A with account B’s invoice ID returns B’s invoice.</p><p><strong>Remedy.</strong> Scope the lookup to the caller’s account. Add an API test that requests an invoice belonging to another account and expects access to be denied without returning invoice content.</p><p><strong>Scope.</strong> This illustrates the finding format. It is not a result from a live review or a performance claim.</p></details></div></article><p class="review-note">Illustrative finding. No customer code or review results shown.</p></div>
</div>
</section>
<section class="install" id="install" aria-labelledby="install-title"><div class="wrap">
<div class="install-layout"><div><p class="eyebrow">03 / Your ranch. Your rules.</p><h2 id="install-title">Give the Sheriff<br>a place to hang<br>its hat.</h2><p>Run your own deployment with your own GitHub connection, model access, and infrastructure. You control which repositories it reviews and pay the services you use.</p><div class="actions"><a class="button" href="${installGuideUrl}">Follow the setup guide <span aria-hidden="true">↗</span></a></div></div>
<ol class="steps"><li><h3>Set up your infrastructure</h3><p>Clone the repository and install with Bun. Create your Vercel and Convex projects, and configure AI Gateway model access.</p></li><li><h3>Connect your GitHub App</h3><p>Authorize the repositories you choose and connect GitHub events through Vercel Connect and Eve’s native GitHub channel.</p></li><li><h3>Validate, deploy, then enable reviews</h3><p>Run the offline checks, configure the required secrets, and deploy your app. Follow the guide to verify webhook delivery before reviewing a pull request.</p></li></ol></div>
<div class="config"><p>Start advisory. Commit this optional configuration to your repository’s base branch as <code>.github/slop-sheriff.yml</code>. Configuration is read from the trusted base revision, so a pull request cannot change its own review policy.</p><pre><code><span class="comment"># .github/slop-sheriff.yml</span>
blocking: false
personality: true
profile: balanced</code></pre></div>
</div></section>
<section class="limits wrap" aria-label="Permissions and limitations"><div><h3>Review powers, carefully scoped.</h3><p>The app reads repository contents and pull request context, and writes review comments and Checks. It does not push branches, merge pull requests, or change repository settings. Provider credentials stay out of the repository sandbox.</p><p>Review the required GitHub permissions and service configuration in the <a href="${installGuideUrl}">self-hosting guide</a>.</p></div><div><h3>A second set of eyes.</h3><p>Model-assisted review can miss bugs or raise false positives. Humans remain responsible for decisions. Failed or unavailable checks remain visible as limitations; an incomplete review is not a clean bill of health.</p><p>The Sheriff reviews code and writing for concrete problems. It does not determine whether a person or AI wrote them.</p></div></section>
</main>
<footer class="footer wrap"><p><span class="star" aria-hidden="true">★</span> Slop Sheriff. Follow the evidence.</p><div class="footer-links"><a href="${repositoryUrl}">Source on GitHub ↗</a><a href="${installGuideUrl}">Self-hosting guide ↗</a></div></footer>
</body>
</html>`;
}
