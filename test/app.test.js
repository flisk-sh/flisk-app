import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TOOL_COMMANDS, commonProjectScanRoots, discoverProjectRoot, discoverProjects, findClaudeDesktopApp, normalizeState, probeCli, resolveProjects, startAppServer } from "../src/app.js";

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function projectFixture(name) {
  const root = mkdtempSync(join(tmpdir(), "tdk-app-test-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".tdk"), { recursive: true });
  writeFileSync(join(root, ".tdk", "project.json"), JSON.stringify({ project: { name } }));
  return root;
}

async function serverFor(options) {
  const started = await startAppServer({ port: 0, token: "test-session-token", dockerCheck: async () => true, ...options });
  servers.push(started.server);
  return started;
}

const supported = { state: "supported", lifecycle: true, version: "1.3.145", minVersion: "1.3.145", installUrl: "https://example.test", message: null };

function fakeCli({ version = "1.3.145", commands = ["up", "down"], versionStatus = 0, versionStderr = "" } = {}) {
  const calls = [];
  const execute = async (_project, args) => {
    calls.push(args);
    if (args[0] === "--version") return { status: versionStatus, stdout: versionStatus ? "" : `${version}\n`, stderr: versionStderr };
    const known = commands.includes(args[0]);
    return { status: 0, stderr: "", stdout: known ? `Usage: tdk ${args[0]} [options]\n` : "Usage: tdk [options] [command]\n" };
  };
  return { execute, calls };
}

describe("TDK CLI capability probe", () => {
  it("reports lifecycle support for a capable CLI", async () => {
    const { execute } = fakeCli();
    const result = await probeCli(execute);
    assert.equal(result.state, "supported");
    assert.equal(result.lifecycle, true);
    assert.equal(result.version, "1.3.145");
  });

  it("accepts 1.3.144 because it has tdk up and tdk down", async () => {
    const result = await probeCli(fakeCli({ version: "1.3.144" }).execute);
    assert.equal(result.lifecycle, true);
  });

  it("reports stable 1.3.140 as unsupported with an actionable message", async () => {
    const { execute } = fakeCli({ version: "1.3.140", commands: [] });
    const result = await probeCli(execute);
    assert.equal(result.state, "unsupported");
    assert.equal(result.lifecycle, false);
    assert.match(result.message, /1\.3\.140.*Update the CLI/);
  });

  it("reports a missing binary and a failing version check separately", async () => {
    const missing = await probeCli(fakeCli({ versionStatus: 1, versionStderr: "spawn tdk ENOENT" }).execute);
    assert.equal(missing.state, "missing");
    assert.match(missing.message, /TDK_BIN/);
    const failing = await probeCli(fakeCli({ versionStatus: 1 }).execute);
    assert.equal(failing.state, "failed");
    assert.equal(failing.lifecycle, false);
  });

  it("only runs read-only probe commands", async () => {
    const { execute, calls } = fakeCli();
    await probeCli(execute);
    assert(calls.every((args) => args.includes("--version") || args.includes("--help")));
  });
});

describe("TDK App local server", () => {
  it("rejects lifecycle actions without spawning a mutating command when unsupported", async () => {
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      if (args[0] === "--version") return { status: 0, stdout: "1.3.140\n", stderr: "" };
      return { status: 0, stderr: "", stdout: "Usage: tdk [options] [command]\n" };
    };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand });
    const origin = new URL(started.url).origin;
    const headers = { "content-type": "application/json", origin, "x-tdk-token": started.token };
    const cliState = await (await fetch(`${origin}/api/cli`, { headers })).json();
    assert.equal(cliState.lifecycle, false);
    const response = await fetch(`${origin}/api/actions`, { method: "POST", headers, body: JSON.stringify({ project: "a", operation: "start" }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "cli_unsupported");
    assert.match(body.error, /Update the CLI/);
    assert(!calls.some((args) => args.includes("--json")));
  });

  it("refuses non-loopback binds", async () => {
    assert.throws(() => startAppServer({ projects: [], host: "0.0.0.0" }), /only bind to 127\.0\.0\.1/);
  });

  it("discovers the nearest project and validates explicitly selected roots", () => {
    const root = projectFixture("shop");
    const nested = join(root, "src", "api");
    mkdirSync(nested, { recursive: true });
    assert.equal(discoverProjectRoot(nested), root);
    assert.equal(resolveProjects(root, [root]).length, 1);
    assert.throws(() => resolveProjects(null, [join(root, "missing")]), /Not a TDK project directory/);
  });

  it("finds projects below scan roots and skips dependency folders", () => {
    const root = mkdtempSync(join(tmpdir(), "tdk-app-scan-"));
    tempDirs.push(root);
    const project = join(root, "workspace", "project");
    mkdirSync(join(project, ".tdk"), { recursive: true });
    writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "workspace-project" } }));
    const ignored = join(root, "node_modules", "example");
    mkdirSync(join(ignored, ".tdk"), { recursive: true });
    writeFileSync(join(ignored, ".tdk", "project.json"), JSON.stringify({ project: { name: "ignored" } }));

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root] });
    assert.deepEqual(projects.map((entry) => entry.root), [project]);
    assert(commonProjectScanRoots("/Users/example").includes("/var/www"));
  });

  it("reaches shallow projects before a large sibling tree exhausts the directory cap", () => {
    const root = mkdtempSync(join(tmpdir(), "tdk-app-scan-"));
    tempDirs.push(root);
    const project = join(root, "a-project");
    mkdirSync(join(project, ".tdk"), { recursive: true });
    writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "shallow" } }));
    for (let index = 0; index < 20; index += 1) mkdirSync(join(root, "z-large", `dir-${index}`), { recursive: true });

    const projects = discoverProjects({ currentRoot: null, scanRoots: [root], maxDirectoriesPerRoot: 10 });
    assert.deepEqual(projects.map((entry) => entry.root), [project]);
  });

  it("returns project status and port conflicts from CLI JSON", async () => {
    const projects = [
      { id: "a", name: "a", root: "/projects/a" },
      { id: "b", name: "b", root: "/projects/b" },
    ];
    const runCommand = async (project, args) => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        data: args[0] === "status"
          ? { resources: [{ name: "api", stack: "shop", type: "backend", status: "ready" }], stacks: [{ name: "shop" }], ports: [{ name: "api", hostPort: 8080 }], tilt: { resources: { items: [{ metadata: { name: "api" } }] } } }
          : { services: [{ name: "api", url: "http://localhost:8080" }] },
      }),
    });
    const started = await serverFor({ projects, runCommand });
    const pageResponse = await fetch(started.url);
    assert.equal(pageResponse.status, 200);
    const pageText = await pageResponse.text();
    assert.match(pageText, /<script src="\/app\.js" defer><\/script>/);
    assert.match(pageText, /<script src="\/inspect\.js" defer><\/script>/);
    const scriptResponse = await fetch(new URL("/app.js", started.url));
    assert.equal(scriptResponse.status, 200);
    assert.match(await scriptResponse.text(), /function refreshData/);
    const inspectResponse = await fetch(new URL("/inspect.js", started.url));
    assert.equal(inspectResponse.status, 200);
    assert.match(inspectResponse.headers.get("content-type"), /text\/javascript/);
    assert.match(await inspectResponse.text(), /const TDK_INSPECT/);
    const response = await fetch(new URL("/api/projects", started.url), {
      headers: { "x-tdk-token": started.token },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projects[0].resources[0].url, "http://localhost:8080/");
    assert.deepEqual(body.projects[0].conflicts, [{ port: 8080, claimants: ["a (api)", "b (api)"] }]);
  });

  it("routes scoped actions through the installed TDK CLI", async () => {
    const project = { id: "a", name: "a", root: "/projects/a" };
    const calls = [];
    const runCommand = async (_project, args) => {
      calls.push(args);
      return { status: 0, stderr: "", stdout: JSON.stringify({ data: { operation: "restart" } }) };
    };
    const started = await serverFor({ projects: [project], runCommand, probe: async () => supported });
    const origin = new URL(started.url).origin;
    const response = await fetch(`${origin}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-tdk-token": started.token },
      body: JSON.stringify({ project: "a", operation: "start", stack: "shop", resources: ["api"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["up", "--json", "shop", "--only", "api"]]);
  });

  it("maps whole-project stop and restart to tdk down / tdk up and refuses scoped ones", async () => {
    const calls = [];
    const runCommand = async (_project, args) => { calls.push(args); return { status: 0, stderr: "", stdout: JSON.stringify({ data: {} }) }; };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand, probe: async () => supported });
    const origin = new URL(started.url).origin;
    const send = (body) => fetch(`${origin}/api/actions`, { method: "POST", headers: { "content-type": "application/json", origin, "x-tdk-token": started.token }, body: JSON.stringify(body) });
    assert.equal((await send({ project: "a", operation: "stop" })).status, 200);
    assert.deepEqual(calls.splice(0), [["down", "--json", "--force"]]);
    assert.equal((await send({ project: "a", operation: "restart" })).status, 200);
    assert.deepEqual(calls.splice(0), [["down", "--json", "--force"], ["up", "--json"]]);
    assert.equal((await send({ project: "a", operation: "stop", stack: "shop" })).status, 400);
    assert.equal((await send({ project: "a", operation: "restart", resources: ["api"] })).status, 400);
    assert.equal(calls.length, 0);
  });
});

describe("tools panel", () => {
  it("runs only the fixed argv for each allowlisted tool and rejects anything else", async () => {
    const calls = [];
    const runCommand = async (_project, args) => { calls.push(args); return { status: 0, stderr: "", stdout: "ok" }; };
    const started = await serverFor({ projects: [{ id: "a", name: "a", root: "/projects/a" }], runCommand });
    const origin = new URL(started.url).origin;
    const send = (body) => fetch(`${origin}/api/tools`, { method: "POST", headers: { "content-type": "application/json", origin, "x-tdk-token": started.token }, body: JSON.stringify(body) });
    assert.equal((await send({ project: "a", tool: "doctor-fix-preview" })).status, 200);
    assert.equal((await send({ project: "a", tool: "doctor-fix-apply" })).status, 200);
    assert.equal((await send({ project: "a", tool: "up-preview" })).status, 200);
    assert.equal((await send({ project: "a", tool: "down-preview" })).status, 200);
    assert.equal((await send({ project: "a", tool: "runtime-check-assets" })).status, 200);
    assert.deepEqual(calls.splice(0), [
      ["doctor", "--fix", "--dry-run"],
      ["doctor", "--fix", "--yes"],
      ["up", "--dry-run"],
      ["down", "--dry-run"],
      ["runtime", "--check-assets"],
    ]);
    assert.equal((await send({ project: "a", tool: "infra-enable", service: "elk" })).status, 200);
    assert.equal((await send({ project: "a", tool: "infra-disable", service: "verdaccio" })).status, 200);
    assert.deepEqual(calls.splice(0), [["config", "enable-infra", "elk"], ["config", "disable-infra", "verdaccio"]]);
    assert.equal((await send({ project: "a", tool: "rm -rf" })).status, 400);
    assert.equal((await send({ project: "a", tool: "infra-enable", service: "--force" })).status, 400);
    assert.equal((await send({ project: "missing", tool: "up-preview" })).status, 400);
    assert.equal(calls.length, 0);
    assert.ok(Object.keys(TOOL_COMMANDS).every((key) => Array.isArray(TOOL_COMMANDS[key].argv)));
  });
});

describe("persistent UI state", () => {
  it("keeps closed stacks across launches", () => {
    const state = normalizeState({ closedStacks: ["proj/core", 42, "proj/jobs"] });
    assert.deepEqual(state.closedStacks, ["proj/core", "proj/jobs"]);
  });
});

describe("Build with AI", () => {
  it("finds the Claude app only on macOS, in /Applications or ~/Applications", () => {
    const home = "/Users/someone";
    assert.equal(findClaudeDesktopApp("linux", () => true, home), null);
    assert.equal(findClaudeDesktopApp("darwin", () => false, home), null);
    assert.equal(findClaudeDesktopApp("darwin", (path) => path === "/Applications/Claude.app", home), "/Applications/Claude.app");
    assert.equal(findClaudeDesktopApp("darwin", (path) => path === "/Users/someone/Applications/Claude.app", home), "/Users/someone/Applications/Claude.app");
  });

  it("opens the starter prompt in the Claude app when it is installed", async () => {
    const opened = [];
    const started = await serverFor({ projects: [], claudeDesktopApp: () => "/Applications/Claude.app", openAiApp: async (app, prompt) => { opened.push([app, prompt]); } });
    const response = await fetch(new URL("/api/ai/build", started.url), {
      method: "POST",
      headers: { "x-tdk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build an app with TDK" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, opened: "claude-desktop" });
    assert.deepEqual(opened, [["/Applications/Claude.app", "Build an app with TDK"]]);
  });

  it("reports no desktop app, so the client shows the web chats, and opens nothing", async () => {
    const opened = [];
    const started = await serverFor({ projects: [], claudeDesktopApp: () => null, openAiApp: async () => { opened.push(true); } });
    const response = await fetch(new URL("/api/ai/build", started.url), {
      method: "POST",
      headers: { "x-tdk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build an app with TDK" }),
    });
    assert.deepEqual(await response.json(), { ok: true, opened: null });
    assert.equal(opened.length, 0);
  });

  it("refuses an empty or oversized prompt", async () => {
    const started = await serverFor({ projects: [], claudeDesktopApp: () => "/Applications/Claude.app", openAiApp: async () => {} });
    for (const body of [{ prompt: "" }, { prompt: "x".repeat(14_337) }]) {
      const response = await fetch(new URL("/api/ai/build", started.url), {
        method: "POST",
        headers: { "x-tdk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  });
});

describe("Build with AI failures and token savings in the projects API", () => {
  it("returns an error when the Claude app fails to open, so the client falls back to the web chats", async () => {
    const started = await serverFor({ projects: [], claudeDesktopApp: () => "/Applications/Claude.app", openAiApp: async () => { throw new Error("open exited with code 1"); } });
    const response = await fetch(new URL("/api/ai/build", started.url), {
      method: "POST",
      headers: { "x-tdk-token": started.token, origin: new URL(started.url).origin, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build an app with TDK" }),
    });
    assert.equal(response.status, 500);
  });

  it("adds tokens to a project once measured, and leaves them out while the status is pending", async () => {
    const root = projectFixture("shop");
    writeFileSync(join(root, "Tiltfile"), "x".repeat(40));
    const runCommand = async (_project, args) => ({ status: 0, stderr: "", stdout: JSON.stringify({ data: args[0] === "status" ? { resources: [], stacks: [], ports: [], tilt: {} } : { services: [] } }) });
    const started = await serverFor({ projects: [{ id: "shop", name: "shop", root }], runCommand, dockerCheck: async () => true });
    const headers = { "x-tdk-token": started.token };
    const pending = await (await fetch(new URL("/api/projects?fast=1", started.url), { headers })).json();
    assert.equal(pending.projects[0].pending, true);
    assert.equal("tokens" in pending.projects[0], false);
    let tokens;
    for (let attempt = 0; attempt < 50 && !tokens; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tokens = (await (await fetch(new URL("/api/projects", started.url), { headers })).json()).projects[0].tokens;
    }
    assert.ok(tokens, "tokens never appeared");
    assert.equal(tokens.generatedTokens, 10);
    assert.ok(tokens.authoredTokens > 0);
    assert.equal(tokens.truncated, false);
  });
});

describe("Open project", () => {
  it("adds an existing TDK project once, and refuses folders without .tdk/project.json", async () => {
    const started = await serverFor({ projects: [], probe: async () => supported });
    const origin = new URL(started.url).origin;
    const add = (path) => fetch(`${origin}/api/projects/add`, { method: "POST", headers: { "content-type": "application/json", origin, "x-tdk-token": started.token }, body: JSON.stringify({ path }) });
    const root = projectFixture("shop");

    const first = await add(root);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.alreadyListed, false);
    assert.equal(firstBody.project.name, "shop");
    assert.equal((await (await add(root)).json()).alreadyListed, true);

    const empty = mkdtempSync(join(tmpdir(), "tdk-app-test-"));
    tempDirs.push(empty);
    assert.equal((await add(empty)).status, 400);
    assert.equal((await add("/etc")).status, 400);
    assert.equal((await add(join(root, "missing"))).status, 400);
  });
});
