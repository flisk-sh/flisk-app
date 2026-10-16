import assert from "node:assert/strict";
import test from "node:test";
import { isOwnTiltRunning } from "../src/app.js";

const own = [{ name: "dashboard-api" }, { name: "billing-api" }];
const tiltOf = (...names) => ({ resources: { items: names.map((name) => ({ metadata: { name } })) } });

test("a project is not running when the Tilt on the port belongs to another project", () => {
  assert.equal(isOwnTiltRunning(tiltOf("kitchen-api", "floor-app", "postgres", "traefik"), own), false);
});

test("a project is running when its own resource is in the Tilt that answers", () => {
  assert.equal(isOwnTiltRunning(tiltOf("postgres", "billing-api"), own), true);
});

test("shared infrastructure names alone do not make a project running", () => {
  assert.equal(isOwnTiltRunning(tiltOf("postgres", "traefik", "init-networks"), own), false);
});

test("resource names must match exactly", () => {
  assert.equal(isOwnTiltRunning(tiltOf("billing-api-run-only", "dashboard-api-migrator"), own), false);
});

test("an array of Tilt resources with a top-level name is accepted", () => {
  assert.equal(isOwnTiltRunning({ resources: [{ name: "dashboard-api" }] }, own), true);
});

test("no Tilt, an unqueried Tilt, or a project without resources is not running", () => {
  assert.equal(isOwnTiltRunning(null, own), false);
  assert.equal(isOwnTiltRunning({ available: true, resources: null }, own), false);
  assert.equal(isOwnTiltRunning({ resources: { items: [] } }, own), false);
  assert.equal(isOwnTiltRunning(tiltOf("dashboard-api"), []), false);
});
