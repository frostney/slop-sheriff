import { findingBodyHtml } from "../github/review-presentation";
import { exampleFinding, exampleFindingSource } from "./example-finding";
import { siteOrigin } from "../branding";

export { siteOrigin } from "../branding";
export const repositoryUrl = "https://github.com/frostney/slop-sheriff";

const description = "Meet Slop Sheriff, a cowboy GitHub code reviewer. Focused review lanes, concise findings, and evidence you can inspect. Deploy it on your own infrastructure.";

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
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit;text-underline-offset:4px}a:hover{color:var(--teal)}a:focus-visible,summary:focus-visible{outline:3px solid var(--teal);outline-offset:5px}::selection{background:#c5ded4}img{max-width:100%;display:block}h1,h2,h3,p{margin:0}h1,h2{font-family:var(--serif);font-weight:900;letter-spacing:-.045em;line-height:1.07}h1{font-size:clamp(3.2rem,6.5vw,5.7rem)}h2{font-size:clamp(2.2rem,4vw,3.6rem)}h3{font-size:1.12rem;line-height:1.4}p+p{margin-top:16px}.wrap{width:min(1160px,calc(100% - 64px));margin-inline:auto}.skip{position:absolute;top:-100px;left:20px;z-index:2;background:var(--paper);padding:12px}.skip:focus{top:12px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-block:25px;border-bottom:1px solid var(--ink)}.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-family:var(--serif);font-weight:900;font-size:1.3rem}.brand img{border-radius:50%;width:44px;height:44px}.nav{display:flex;gap:28px;font-size:.88rem;font-weight:650}.nav a{text-decoration:none;padding-block:8px}.eyebrow{font:650 .72rem/1.5 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--teal);margin-bottom:22px}.hero{padding-top:60px}.hero-intro{display:grid;grid-template-columns:1.3fr 1fr;gap:64px;align-items:end;margin-bottom:42px}.hero h1{max-width:700px}.hero h1 span{color:var(--rust)}.hero-copy{max-width:410px;padding-bottom:5px}.hero-copy p{font-size:1.12rem}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:22px;margin-top:25px}.button{display:inline-flex;align-items:center;gap:25px;background:var(--teal);color:#fff;padding:13px 20px;text-decoration:none;font-weight:650;border:1px solid var(--teal)}.button:hover{background:#104b47;color:#fff}.text-link{font-size:.92rem;font-weight:650}.hero-art{width:100%;height:auto;aspect-ratio:2/1;object-fit:cover;border:1px solid var(--ink);border-radius:3px}.caption{display:flex;justify-content:space-between;gap:20px;padding-block:14px;font:500 .72rem/1.5 var(--mono);color:var(--muted)}.section{padding-block:86px;border-bottom:1px solid var(--line)}.section-intro{display:grid;grid-template-columns:1fr 1fr;gap:80px;margin-bottom:40px;align-items:end}.section-intro p{max-width:490px;color:var(--muted)}.section-intro .eyebrow{color:var(--teal)}.review-layout{display:grid;grid-template-columns:.8fr 1.2fr;gap:70px;align-items:start}.review-copy p{margin-top:22px;color:var(--muted)}.review-copy .eyebrow{margin-top:0}.review{background:#fff;border:1px solid #d1d9e0;border-radius:6px;overflow:hidden;font-size:14px;line-height:1.5}.review-head{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#f6f8fa;border-bottom:1px solid #d1d9e0;font-size:14px}.review-head img{width:38px;height:38px;border-radius:50%}.review-head strong{display:block}.review-head small{color:var(--muted)}.review-body{padding:16px;overflow-wrap:anywhere}.review-body>*+*{margin-top:16px}.review-body ul{padding-left:24px}.review-body li+li{margin-top:7px}.review-body p{font-size:14px}.review-file{padding:10px 16px;border-bottom:1px solid #d1d9e0;color:#59636e;font-size:12px;overflow-wrap:anywhere}.bot-badge{font-size:12px;font-weight:400;border:1px solid #d1d9e0;border-radius:12px;padding:0 6px;color:#59636e}.review h3{font-size:18px;line-height:1.4}.review p{font-size:.93rem}.review code{font:85% var(--mono);padding:2px 4px;background:#eff1f3;border-radius:4px}.install{background:var(--ink);color:var(--paper);margin-top:76px;padding-block:70px}.install .eyebrow{color:#b7d6c7}.install-layout{display:grid;grid-template-columns:1fr 1fr;gap:70px}.install h2{max-width:430px}.install p{color:#d0d2c8;margin-top:22px}.install a:hover{color:#b7d6c7}.install .button{background:#c1d9c9;color:var(--ink);border-color:#c1d9c9}.custom-install{padding-top:52px}.custom-install h2{font-size:1.6rem;letter-spacing:-.02em;margin-bottom:12px}.custom-install p{color:var(--muted)}.limits{display:grid;grid-template-columns:1fr 1fr;gap:70px;padding-block:70px}.limits p{font-size:.93rem;color:var(--muted)}.footer{border-top:1px solid var(--ink);padding-block:28px 40px;display:flex;justify-content:space-between;align-items:center;gap:30px;font-size:.83rem}.footer p{color:var(--muted)}.footer-links{display:flex;gap:25px}
@media(min-width:1600px){.wrap{width:min(1300px,calc(100% - 100px))}}
@media(max-width:850px){.hero-intro,.section-intro,.review-layout,.install-layout,.limits{gap:32px}.hero-intro{grid-template-columns:1.15fr 1fr}.hero-copy p{font-size:1rem}.nav{gap:18px}.review-layout{grid-template-columns:1fr 1.15fr}.review-body{padding:20px}}
@media(max-width:640px){body{font-size:16px}.wrap{width:calc(100% - 36px)}.masthead{padding-block:18px;gap:16px}.brand{font-size:1.06rem;gap:8px}.brand img{width:34px;height:34px}.nav{gap:17px;font-size:.8rem}.nav .desktop-link{display:none}.hero{padding-top:36px}.hero-intro,.section-intro,.review-layout,.install-layout,.limits{grid-template-columns:1fr;gap:27px}.hero-intro{margin-bottom:29px}.hero h1{font-size:clamp(3.05rem,11vw,4.4rem)}.hero-copy{max-width:none}.hero-copy p{font-size:1.05rem}.eyebrow{margin-bottom:16px}.actions{margin-top:23px}.caption{font-size:.63rem;gap:12px}.caption span:last-child{text-align:right}.section{padding-block:53px}.section-intro{margin-bottom:28px}.review-copy p{margin-top:17px}.install{margin-top:48px;padding-block:48px}.install-layout{gap:37px}.limits{padding-block:48px;gap:34px}.footer{align-items:flex-start;flex-direction:column;gap:15px;padding-bottom:28px}.footer-links{gap:24px}}
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
<div class="hero-copy"><p>Your pull request rides in. A robot cowboy checks the claims, follows the evidence, and leaves concise findings.</p><div class="actions"><a class="button" href="#install">Put the Sheriff to work <span aria-hidden="true">↗</span></a><a class="text-link" href="#review">See a review ↓</a></div></div>
</div>
<img class="hero-art" src="/assets/slop-sheriff-hero.webp" width="1774" height="887" alt="Slop Sheriff, a robot cowboy carrying review notes and following code tracks toward a Clean code sign" fetchpriority="high">
<div class="caption"><span>GitHub pull requests. A little frontier spirit.</span><span>Self-hosted · Review-only · Advisory by default</span></div>
</section>
<section class="section wrap" id="lanes" aria-labelledby="lanes-title">
<div class="section-intro"><div><p class="eyebrow">01 / A posse with a purpose</p><h2 id="lanes-title">Different trails.<br>One review.</h2></div><p>Focused lanes check requirements, correctness, tests, and documentation. Add project-specific lanes through repository configuration.</p></div>
</section>
<section class="section wrap" id="review" aria-labelledby="review-title">
<div class="review-layout"><div class="review-copy"><p class="eyebrow">02 / Show your work, partner</p><h2 id="review-title">A real catch.<br>A short comment.</h2><p>From our own <a href="${exampleFindingSource}">PR #42</a>, condensed into today’s comment format. The alias indexing issue was subsequently fixed.</p><p>A short explanation, visible Impact and Risk, and expandable evidence. Choose theatrical, understated, or plain technical language.</p></div>
<article class="review" aria-label="Historical review finding from pull request 42"><header class="review-head"><img src="/assets/slop-sheriff-icon.png" alt="" width="38" height="38" loading="lazy"><div><strong>Slop Sheriff <span class="bot-badge">bot</span></strong><small><a href="${exampleFindingSource}">PR #42 · View original comment</a></small></div></header><div class="review-file"><code>src/landing/routes.ts</code> · original line 31</div><div class="review-body">${findingBodyHtml(exampleFinding)}</div></article>
</div>
</section>
<section class="install" id="install" aria-labelledby="install-title"><div class="wrap">
<div class="install-layout"><div><p class="eyebrow">03 / Your ranch. Your rules.</p><h2 id="install-title">Give the Sheriff<br>a place to hang<br>its hat.</h2></div><div><p>Deploy with your own GitHub App, Vercel, Convex, and AI Gateway access. Choose the repositories; pay the services you use.</p><div class="actions"><a class="button" href="${installGuideUrl}">Follow the setup guide <span aria-hidden="true">↗</span></a></div></div></div>
</div></section>
<section class="custom-install wrap" aria-labelledby="custom-title"><h2 id="custom-title">Custom installations and integrations</h2><p>Custom setup, deployment support, and tailored integrations for your team’s workflow.</p></section>
<section class="limits wrap" aria-label="Permissions and limitations"><p>Review-only and advisory by default. The Sheriff writes comments and Checks. It never pushes branches or merges pull requests.</p><p>Models can miss bugs or raise false positives. Humans make the decisions. Incomplete reviews never give merge clearance.</p></section>
</main>
<footer class="footer wrap"><p><span class="star" aria-hidden="true">★</span> Slop Sheriff. Follow the evidence.</p><div class="footer-links"><a href="${repositoryUrl}">Source on GitHub ↗</a><a href="${installGuideUrl}">Self-hosting guide ↗</a></div></footer>
</body>
</html>`;
}
