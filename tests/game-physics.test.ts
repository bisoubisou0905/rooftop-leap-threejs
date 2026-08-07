import assert from "node:assert/strict";
import test from "node:test";
import {
  chargeToLaunch,
  dragDistanceToCharge,
  footSweepContact,
  pointOnPlatformSurface,
  resolveWeightedPlayerCollision,
  sweepBodyAgainstProfile,
  type FootSweepPoint,
  type PlatformSurface,
} from "../app/game-physics.ts";

const roundedRoof: PlatformSurface = {
  x: 0,
  z: 0,
  width: 1.4,
  depth: 1.2,
  shape: "rect",
  cornerRadius: 0.055,
};

test("rounded rectangular roofs reject points beyond the visible corner", () => {
  assert.equal(pointOnPlatformSurface(roundedRoof, 0, 0), true);
  assert.equal(pointOnPlatformSurface(roundedRoof, 0.699, 0), true);
  assert.equal(pointOnPlatformSurface(roundedRoof, 0.699, 0.599), false);
});

test("hex roofs use their polygon instead of an oversized circle", () => {
  const hex: PlatformSurface = {
    x: 0,
    z: 0,
    width: 1.4,
    depth: 1.4,
    shape: "hex",
  };
  assert.equal(pointOnPlatformSurface(hex, 0, 0.67), true);
  assert.equal(pointOnPlatformSurface(hex, 0.66, 0.3), false);
});

test("a descending sole center creates a valid one-foot landing", () => {
  const previous: FootSweepPoint[] = [
    { x: 0.64, y: 0.08, z: 0 },
    { x: 0.58, y: 0.08, z: 0 },
    { x: 0.7, y: 0.08, z: 0 },
  ];
  const current = previous.map((point) => ({ ...point, y: -0.06 }));
  const contact = footSweepContact(roundedRoof, 0, previous, current);
  assert.equal(contact.valid, true);
  assert.equal(contact.centerSupported, true);
});

test("an unsupported center still lands when two parts of the visible sole overlap", () => {
  const previous: FootSweepPoint[] = [
    { x: 0.74, y: 0.06, z: 0 },
    { x: 0.67, y: 0.06, z: -0.08 },
    { x: 0.67, y: 0.06, z: 0.08 },
  ];
  const current = previous.map((point) => ({ ...point, y: -0.05 }));
  const contact = footSweepContact(roundedRoof, 0, previous, current);
  assert.equal(contact.centerSupported, false);
  assert.equal(contact.supportCount, 2);
  assert.equal(contact.valid, true);
});

test("one unsupported toe corner is not enough to claim an edge landing", () => {
  const previous: FootSweepPoint[] = [
    { x: 0.79, y: 0.06, z: 0 },
    { x: 0.79, y: 0.06, z: -0.08 },
    { x: 0.69, y: 0.06, z: 0.08 },
  ];
  const current = previous.map((point) => ({ ...point, y: -0.05 }));
  const contact = footSweepContact(roundedRoof, 0, previous, current);
  assert.equal(contact.centerSupported, false);
  assert.equal(contact.supportCount, 1);
  assert.equal(contact.valid, false);
});

test("a sole that completely misses the visible roof cannot land", () => {
  const previous: FootSweepPoint[] = [
    { x: 0.9, y: 0.06, z: 0 },
    { x: 0.84, y: 0.06, z: -0.08 },
    { x: 0.84, y: 0.06, z: 0.08 },
  ];
  const current = previous.map((point) => ({ ...point, y: -0.05 }));
  assert.equal(footSweepContact(roundedRoof, 0, previous, current).valid, false);
});

test("an angled shoe evaluates its whole projected footprint at first contact", () => {
  const previous: FootSweepPoint[] = [
    { x: 0.1, y: 0.04, z: 0 },
    { x: 0.02, y: 0.12, z: -0.1 },
    { x: 0.18, y: 0.12, z: 0.1 },
  ];
  const current: FootSweepPoint[] = [
    { x: 0.1, y: -0.03, z: 0 },
    { x: 0.02, y: 0.05, z: -0.1 },
    { x: 0.18, y: 0.05, z: 0.1 },
  ];
  const contact = footSweepContact(roundedRoof, 0, previous, current);
  assert.equal(contact.supportCount, 3);
  assert.equal(contact.valid, true);
});

test("a dense sole requires roughly one third of its footprint to be supported", () => {
  const makeFrame = (insideCount: number, y: number) =>
    Array.from({ length: 25 }, (_, index) => ({
      x: index < insideCount ? 0.62 : 0.86,
      y,
      z: ((index % 5) - 2) * 0.04,
    }));

  assert.equal(
    footSweepContact(roundedRoof, 0, makeFrame(7, 0.05), makeFrame(7, -0.04))
      .valid,
    false,
  );
  assert.equal(
    footSweepContact(roundedRoof, 0, makeFrame(8, 0.05), makeFrame(8, -0.04))
      .valid,
    true,
  );
});

test("a fast fall sweep cannot tunnel through a thin city mast", () => {
  const contact = sweepBodyAgainstProfile(
    {
      x: 0,
      z: 0,
      width: 0.12,
      depth: 0.12,
      shape: "rect",
      topY: 0,
      bottomY: -5,
    },
    { x: 0, y: -0.7, z: -0.48 },
    { x: 0, y: -0.92, z: 0.48 },
  );
  assert.ok(contact);
  assert.ok(contact.time > 0 && contact.time < 1);
  assert.ok(contact.normalZ < 0);
});

test("a body outside a platform's vertical span does not collide", () => {
  const contact = sweepBodyAgainstProfile(
    {
      x: 0,
      z: 0,
      width: 1,
      depth: 1,
      shape: "rect",
      topY: 0,
      bottomY: -2,
    },
    { x: 0, y: -4, z: -1 },
    { x: 0, y: -4.2, z: 1 },
  );
  assert.equal(contact, null);
});

test("moving away from an overlapping edge does not snag the player", () => {
  const contact = sweepBodyAgainstProfile(
    {
      x: 0,
      z: 0,
      width: 1,
      depth: 1,
      shape: "rect",
      topY: 0,
      bottomY: -3,
    },
    { x: 0, y: -0.8, z: -0.67 },
    { x: 0, y: -0.9, z: -1.1 },
  );
  assert.equal(contact, null);
});

test("the drag curve preserves tiny hops without making mid-range input jumpy", () => {
  const tiny = dragDistanceToCharge(4);
  const quarter = dragDistanceToCharge(50);
  const middle = dragDistanceToCharge(100);
  const full = dragDistanceToCharge(196);
  assert.ok(tiny > 0 && tiny < 0.01);
  assert.ok(quarter > tiny && quarter < middle);
  assert.ok(middle < full);
  assert.equal(full, 1);

  const tinyLaunch = chargeToLaunch(tiny);
  const fullLaunch = chargeToLaunch(full);
  assert.ok(tinyLaunch.speed < 0.3);
  assert.ok(tinyLaunch.lift < 2);
  assert.ok(fullLaunch.speed > 6);
  assert.ok(fullLaunch.lift > 6);
});

test("player collision is noticeable but capped to a gentle velocity change", () => {
  const collision = resolveWeightedPlayerCollision(
    { x: 0, z: 0, velocityX: 2.4, velocityZ: 0, radius: 0.28, mass: 1 },
    { x: 0.5, z: 0, velocityX: 0, velocityZ: 0, radius: 0.3, mass: 1 },
  );
  assert.ok(collision);
  assert.ok(collision.impactSpeed > 2);
  assert.ok(Math.abs(collision.localVelocityX - 2.4) <= 0.721);
  assert.ok(Math.abs(collision.remoteVelocityX) <= 0.721);
});

test("the heavyweight receives less speed change than the light runner", () => {
  const collision = resolveWeightedPlayerCollision(
    { x: 0, z: 0, velocityX: 1.2, velocityZ: 0, radius: 0.34, mass: 1.65 },
    { x: 0.58, z: 0, velocityX: -1.2, velocityZ: 0, radius: 0.28, mass: 1 },
  );
  assert.ok(collision);
  const heavyChange = Math.abs(collision.localVelocityX - 1.2);
  const lightChange = Math.abs(collision.remoteVelocityX + 1.2);
  assert.ok(heavyChange < lightChange);
  assert.ok(collision.localPositionX < 0);
  assert.ok(collision.remotePositionX > 0.58);
});
