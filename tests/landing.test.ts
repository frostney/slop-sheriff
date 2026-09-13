import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { findingBodyHtml } from "../src/github/review-presentation";
import { findingReactions } from "../src/branding";
import { exampleFinding, exampleFindingSource } from "../src/landing/example-finding";
import { landingPage } from "../src/landing/page";
import { landingPaths, landingResponse } from "../src/landing/routes";

const canonicalOrigin = "https://slop-sheriff.dev";

function request(path: string, method = "GET"): Request {
  return new Request(`${canonicalOrigin}${path}`, {
    method,
    headers: { "x-forwarded-host": "injected.example" },
  });
}

describe("public landing routes", () => {
  test("production exposes crawlable self-hosting content with a fixed canonical origin", async () => {
    const response = landingResponse(request("/"), "production");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("index, follow");
    expect(html).toContain(`<link rel="canonical" href="${canonicalOrigin}/">`);
    expect(html).toContain(`<meta property="og:image" content="${canonicalOrigin}/assets/slop-sheriff-social.jpg">`);
    expect(html).toContain('id="install"');
    expect(html).toContain("/docs/install.md");
    expect(html).toContain(exampleFindingSource);
    expect(html).toContain(findingBodyHtml(exampleFinding));
    expect(html).toContain("subsequently fixed");
    expect(html).not.toContain("Synthetic example");
    expect(html).not.toContain("invoice");
    expect(html).toContain("<summary>Evidence and recommended change</summary>");
    const visibleText = html.split("<body>")[1]!.replace(/<details>[\s\S]*?<\/details>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[^;]+;/g, " ");
    expect(visibleText.trim().split(/\s+/u).length).toBeGreaterThanOrEqual(310);
    expect(visibleText.trim().split(/\s+/u).length).toBeLessThanOrEqual(350);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("untrusted-preview.example");
    expect(html).not.toContain("injected.example");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const robots = await landingResponse(request("/robots.txt"), "production").text();
    expect(robots).toContain(`Sitemap: ${canonicalOrigin}/sitemap.xml`);
    expect(robots).toContain("Disallow: /eve/");
    expect(await landingResponse(request("/sitemap.xml"), "production").text()).toContain(`<loc>${canonicalOrigin}/</loc>`);
  });

  test("setup links resolve against a validated deployment revision", () => {
    const revision = "1234567890abcdef1234567890abcdef12345678";
    expect(landingPage(true, revision)).toContain(`/blob/${revision}/docs/install.md`);
    for (const invalid of [undefined, "", "feature/landing", '\" onclick=\"alert(1)']) {
      expect(landingPage(true, invalid)).toContain("/blob/main/docs/install.md");
    }
  });

  test("preview and local remain noindex regardless of request host", async () => {
    for (const environment of ["preview", "development", ""]) {
      for (const path of landingPaths) {
        const response = landingResponse(new Request(`${canonicalOrigin}${path}`), environment);
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
      expect(await landingResponse(request("/"), environment).text()).toContain('name="robots" content="noindex, nofollow"');
      const robots = await landingResponse(request("/robots.txt"), environment).text();
      expect(robots).toContain("Allow: /$\nAllow: /assets/\nDisallow: /eve/\n");
      expect(robots).not.toContain("Sitemap:");
      expect(await landingResponse(request("/sitemap.xml"), environment).text()).not.toContain("<loc>");
    }
  });

  test("production aliases stay noindex and forwarded hosts cannot grant indexing", async () => {
    for (const hostname of ["slop-sheriff.vercel.app", "www.slop-sheriff.dev", "known-good-review.vercel.app", "candidate.vercel.app", "127.0.0.1", "slop-sheriff.dev.attacker.example"]) {
      const response = landingResponse(new Request(`https://${hostname}/`, {
        headers: { "x-forwarded-host": "slop-sheriff.dev" },
      }), "production");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html = await response.text();
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(html).toContain(`<link rel="canonical" href="${canonicalOrigin}/">`);
      const robots = await landingResponse(new Request(`https://${hostname}/robots.txt`), "production").text();
      expect(robots).toContain("Allow: /$\nAllow: /assets/\nDisallow: /eve/\n");
      expect(robots).not.toContain("Sitemap:");
      expect(await landingResponse(new Request(`https://${hostname}/sitemap.xml`), "production").text()).not.toContain("<loc>");
    }
  });

  test("HEAD returns GET headers and an empty body for every public route", async () => {
    for (const path of landingPaths) {
      const get = landingResponse(request(path), "production");
      const head = landingResponse(request(path, "HEAD"), "production");
      expect(head.status).toBe(get.status);
      expect([...head.headers]).toEqual([...get.headers]);
      expect(await head.text()).toBe("");
    }
  });

  test("only the named public resources are served", () => {
    for (const path of ["/assets/secrets.json", "/docs/assets/slop-sheriff-brand.png", "/eve/v1", "/.env"]) {
      expect(landingResponse(request(path), "production").status).toBe(404);
    }
    const post = landingResponse(request("/", "POST"), "production");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  test("bundled image bytes exactly match the published brand exports", async () => {
    for (const [filename, contentType] of [
      ["slop-sheriff-hero.webp", "image/webp"],
      ["slop-sheriff-icon.png", "image/png"],
      ["slop-sheriff-social.jpg", "image/jpeg"],
      ...Object.values(findingReactions).map(({ filename }) => [filename, "image/png"] as const),
    ] as const) {
      const source = await readFile(new URL(`../docs/assets/${filename}`, import.meta.url));
      const response = landingResponse(request(`/assets/${filename}`), "production");
      expect(response.headers.get("content-type")).toBe(contentType);
      // Fail the offline gate when an image changes without regenerating its bundle.
      expect(Buffer.from(await response.arrayBuffer()).equals(source)).toBe(true);
    }
  });

  test("unversioned images expire within an hour and revalidate for GET and HEAD", async () => {
    const path = "/assets/slop-sheriff-hero.webp";
    const response = landingResponse(request(path), "production");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600, must-revalidate");
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("Expected an image ETag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(landingResponse(request(path), "production").headers.get("etag")).toBe(etag);
    expect(landingResponse(request("/assets/slop-sheriff-icon.png"), "production").headers.get("etag")).not.toBe(etag);
    for (const method of ["GET", "HEAD"]) {
      for (const validator of [etag, `W/${etag}`, `"old-image", W/${etag}`, "*"]) {
        const cached = landingResponse(new Request(`${canonicalOrigin}${path}`, { method, headers: { "if-none-match": validator } }), "production");
        expect(cached.status).toBe(304);
        expect(cached.headers.get("etag")).toBe(etag);
        expect(cached.headers.get("cache-control")).toBe(response.headers.get("cache-control"));
        expect(await cached.text()).toBe("");
      }
      const stale = landingResponse(new Request(`${canonicalOrigin}${path}`, { method, headers: { "if-none-match": '"old-image"' } }), "production");
      expect(stale.status).toBe(200);
      expect(stale.headers.get("etag")).toBe(etag);
      expect((await stale.arrayBuffer()).byteLength > 0).toBe(method === "GET");
    }
  });
});
