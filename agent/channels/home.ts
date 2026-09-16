import { defineChannel, GET, HEAD } from "eve/channels";
import { landingPaths, landingResponse } from "../../src/landing/routes";

// Eve 0.52.5 names virtual handlers after their URL. Nitro loads a handler
// ending in .txt as text. Rou3's literal group keeps the exact public URL
// while giving the virtual module a name that is not treated as a text asset.
const routePaths = landingPaths.map((path) => {
  if (path === "/robots.txt") return "/robots{.txt}";
  if (path === "/llms.txt") return "/llms{.txt}";
  return path;
});

export default defineChannel({
  routes: routePaths.flatMap((path) => [
    GET(path, async (request) => landingResponse(request)),
    HEAD(path, async (request) => landingResponse(request)),
  ]),
});
