import { createHash } from "node:crypto";
import bundledAssets from "./assets.json";
import { landingPage, siteOrigin } from "./page";
import { findingReactions } from "../branding";

function imageAsset(type: string, base64: string) {
  const bytes = Buffer.from(base64, "base64");
  return { type, bytes, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
}

// A fixed allowlist serves compiled bytes without exposing repository files.
const assets = new Map([
  ["/assets/slop-sheriff-hero.webp", imageAsset("image/webp", bundledAssets["slop-sheriff-hero.webp"])],
  ["/assets/slop-sheriff-icon.png", imageAsset("image/png", bundledAssets["slop-sheriff-icon.png"])],
  ["/assets/slop-sheriff-social.jpg", imageAsset("image/jpeg", bundledAssets["slop-sheriff-social.jpg"])],
  ...Object.values(findingReactions).map(({ filename }) => [
    `/assets/${filename}`, imageAsset("image/png", bundledAssets[filename]),
  ] as const),
]);

export const landingPaths = ["/", "/robots.txt", "/sitemap.xml", ...assets.keys()];

export function landingResponse(request: Request, environment = process.env.VERCEL_ENV): Response {
  const url = new URL(request.url);
  const pathname = url.pathname;
  // Deployment metadata and an exact canonical hostname are both required.
  // The request never supplies the canonical URL or an allowed hostname.
  const indexable = environment === "production" && url.hostname === new URL(siteOrigin).hostname;
  const headers = new Headers({
    "cache-control": "public, max-age=0, must-revalidate",
    "x-content-type-options": "nosniff",
    "x-robots-tag": indexable ? "index, follow" : "noindex, nofollow",
  });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  let body: string | Uint8Array<ArrayBuffer>;
  if (pathname === "/") {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    body = landingPage(indexable, process.env.VERCEL_GIT_COMMIT_SHA);
  } else if (pathname === "/robots.txt") {
    headers.set("content-type", "text/plain; charset=utf-8");
    // Crawlers must fetch public aliases to observe their noindex directives.
    body = `User-agent: *\nAllow: /$\nAllow: /assets/\nDisallow: /eve/\n${indexable ? `Sitemap: ${siteOrigin}/sitemap.xml\n` : ""}`;
  } else if (pathname === "/sitemap.xml") {
    headers.set("content-type", "application/xml; charset=utf-8");
    body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexable ? `<url><loc>${siteOrigin}/</loc></url>` : ""}</urlset>`;
  } else {
    const asset = assets.get(pathname);
    if (!asset) return new Response(null, { status: 404, headers });
    headers.set("content-type", asset.type);
    headers.set("cache-control", "public, max-age=3600, must-revalidate");
    headers.set("etag", asset.etag);
    const validators = request.headers.get("if-none-match")?.split(",") ?? [];
    if (validators.some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === asset.etag)) {
      return new Response(null, { status: 304, headers });
    }
    body = Uint8Array.from(asset.bytes);
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
