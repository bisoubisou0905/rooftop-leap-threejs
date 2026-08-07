"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  chargeToLaunch,
  dragDistanceToCharge,
  footSweepContact,
  pointOnPlatformSurface,
  resolveWeightedPlayerCollision,
  sweepBodyAgainstProfile,
  type FootSweepPoint,
  type PlatformSurface,
  type SideSweepContact,
  type VerticalCollisionProfile,
} from "./game-physics";
import { normalizeDuelRoom } from "./duel-room";
import {
  consumeDuelLife,
  DUEL_STARTING_LIVES,
  DUEL_WATER_START_LEVEL,
  duelWaterProgressAt,
  isPlayerCaughtByWater,
} from "./duel-rules";
import type {
  DuelCharacter,
  DuelEliminationReason,
  DuelNetworkController,
  DuelNetworkStatus,
  DuelPose,
} from "./duel-network";

type GamePhase = "idle" | "charging" | "flying" | "falling" | "failed";
type PlatformShape = "rect" | "circle" | "hex";
type PlatformKind = "roof" | "city-light" | "signal-mast";
type AppScreen = "home" | "game" | "settings" | "characters";
type BackgroundTheme = "night" | "dawn" | "violet" | "teal";
type GameMode = "solo" | "duel";
type CharacterType = DuelCharacter;

type Platform = {
  id: number;
  step: number;
  kind: PlatformKind;
  group: THREE.Group;
  x: number;
  z: number;
  topY: number;
  width: number;
  depth: number;
  shaftWidth: number;
  shaftDepth: number;
  shape: PlatformShape;
  surface: PlatformSurface;
  collisionProfiles: VerticalCollisionProfile[];
};

type FootContactFrame = [THREE.Vector3[], THREE.Vector3[]];

type LandingContact = {
  platform: Platform;
  footIndex: number;
  supportCount: number;
  coverage: number;
  time: number;
  x: number;
  z: number;
  soleCenterX: number;
  soleCenterZ: number;
};

type Particle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
};

const palette = [
  { roof: 0xc9896f, rim: 0xffc294, side: 0x172c42, accent: 0xff6747 },
  { roof: 0xb97f70, rim: 0xf4af87, side: 0x153448, accent: 0xff8d54 },
  { roof: 0xd09a78, rim: 0xffc99c, side: 0x202e49, accent: 0xff7055 },
  { roof: 0xb98978, rim: 0xf5b891, side: 0x253248, accent: 0xff9b55 },
];

const backgroundOptions: Array<{
  id: BackgroundTheme;
  label: string;
  caption: string;
}> = [
  { id: "night", label: "深蓝夜城", caption: "安静、深邃的城市夜色" },
  { id: "dawn", label: "霞光云海", caption: "云层上方的一线暖光" },
  { id: "violet", label: "靛紫夜航", caption: "克制的霓虹与暮色" },
  { id: "teal", label: "冷青黎明", caption: "清透、微亮的高空清晨" },
];

function isBackgroundTheme(value: string | null): value is BackgroundTheme {
  return backgroundOptions.some((option) => option.id === value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const normalized = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

// The runner root is placed so the neutral shoe sole is 2.5 mm above it.
// Keeping this as one explicit contract prevents platform-specific magic offsets.
const RUNNER_GROUND_OFFSET = 0.0025;

// Sample the visible sole instead of the character's body/root. Index 0 is the
// sole center; the others cover toe, heel and both edges for stable edge landings.
const FOOT_SOLE_LOCAL_SAMPLES = (() => {
  const samples = [new THREE.Vector3(0, -0.0875, 0.02)];
  const xSamples = [-0.07, -0.035, 0, 0.035, 0.07];
  const zSamples = [-0.1, -0.04, 0.02, 0.08, 0.14];
  zSamples.forEach((z) => {
    xSamples.forEach((x) => {
      if (x === 0 && z === 0.02) return;
      samples.push(new THREE.Vector3(x, -0.0875, z));
    });
  });
  return samples;
})();

function seededNoise(value: number) {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function createRoundedBoxGeometry(
  width: number,
  height: number,
  depth: number,
  segments = 2,
  requestedRadius = 0.05,
) {
  const totalSegments = segments * 2 + 1;
  const radius = Math.min(
    width / 2,
    height / 2,
    depth / 2,
    requestedRadius,
  );
  const geometry = new THREE.BoxGeometry(
    1,
    1,
    1,
    totalSegments,
    totalSegments,
    totalSegments,
  ).toNonIndexed();
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const innerBox = new THREE.Vector3(width, height, depth)
    .divideScalar(2)
    .subScalar(radius);
  const halfSegment = 0.5 / totalSegments;

  for (let index = 0; index < positions.count; index += 1) {
    position.fromBufferAttribute(positions, index);
    normal.copy(position);
    normal.x -= Math.sign(normal.x) * halfSegment;
    normal.y -= Math.sign(normal.y) * halfSegment;
    normal.z -= Math.sign(normal.z) * halfSegment;
    normal.normalize();
    positions.setXYZ(
      index,
      innerBox.x * Math.sign(position.x) + normal.x * radius,
      innerBox.y * Math.sign(position.y) + normal.y * radius,
      innerBox.z * Math.sign(position.z) + normal.z * radius,
    );
    normals.setXYZ(index, normal.x, normal.y, normal.z);
  }

  positions.needsUpdate = true;
  normals.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createToonGradient() {
  const gradient = new THREE.DataTexture(
    new Uint8Array([48, 118, 188, 255]),
    4,
    1,
    THREE.RedFormat,
  );
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function createRunner(
  gradientMap: THREE.Texture,
  character: CharacterType = "runner",
) {
  const isHeavy = character === "heavy";
  const runner = new THREE.Group();
  runner.userData.character = character;
  runner.userData.mass = isHeavy ? 1.65 : 1;
  runner.userData.radius = isHeavy ? 0.34 : 0.28;
  const visual = new THREE.Group();
  visual.name = "runner-visual";
  runner.add(visual);

  const coral = new THREE.MeshToonMaterial({
    color: isHeavy ? 0x276f78 : 0xff5d3b,
    gradientMap,
  });
  const coralLight = new THREE.MeshToonMaterial({
    color: isHeavy ? 0x6eb1ad : 0xff8562,
    gradientMap,
  });
  const ink = new THREE.MeshToonMaterial({
    color: 0x111c2d,
    gradientMap,
  });
  const skin = new THREE.MeshToonMaterial({
    color: 0xf1aa7e,
    gradientMap,
  });
  const cream = new THREE.MeshToonMaterial({
    color: 0xffe8cd,
    gradientMap,
  });
  const white = new THREE.MeshToonMaterial({
    color: 0xfffbf4,
    gradientMap,
  });
  const outlinedMeshes: THREE.Mesh[] = [];

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(isHeavy ? 0.275 : 0.205, isHeavy ? 0.35 : 0.43, 6, 12),
    coral,
  );
  torso.position.y = isHeavy ? 0.99 : 1.0;
  torso.scale.set(isHeavy ? 1.17 : 0.96, isHeavy ? 0.96 : 1, isHeavy ? 0.84 : 0.78);
  torso.castShadow = true;
  visual.add(torso);
  outlinedMeshes.push(torso);

  const jacketHem = new THREE.Mesh(
    new THREE.CylinderGeometry(
      isHeavy ? 0.29 : 0.225,
      isHeavy ? 0.255 : 0.205,
      isHeavy ? 0.18 : 0.15,
      10,
    ),
    coralLight,
  );
  jacketHem.position.y = isHeavy ? 0.68 : 0.69;
  jacketHem.castShadow = true;
  visual.add(jacketHem);
  outlinedMeshes.push(jacketHem);

  const hips = new THREE.Mesh(
    new THREE.BoxGeometry(isHeavy ? 0.39 : 0.31, 0.15, isHeavy ? 0.27 : 0.235),
    ink,
  );
  hips.position.set(0, 0.61, -0.01);
  hips.rotation.y = Math.PI / 4;
  hips.castShadow = true;
  visual.add(hips);
  outlinedMeshes.push(hips);

  const headRig = new THREE.Group();
  headRig.name = "head-rig";
  headRig.position.y = 1.57;
  visual.add(headRig);

  const hoodShell = new THREE.Mesh(
    new THREE.SphereGeometry(0.275, 16, 12),
    coral,
  );
  hoodShell.position.set(0, -0.015, -0.03);
  hoodShell.scale.set(0.98, 1.06, 0.88);
  hoodShell.castShadow = true;
  hoodShell.visible = !isHeavy;
  headRig.add(hoodShell);
  outlinedMeshes.push(hoodShell);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.215, 18, 14), skin);
  head.position.set(0, -0.015, 0.09);
  head.scale.set(0.94, 1.02, 0.82);
  head.castShadow = true;
  headRig.add(head);
  outlinedMeshes.push(head);

  const hoodRim = new THREE.Mesh(
    new THREE.TorusGeometry(0.225, 0.035, 7, 18, Math.PI * 1.58),
    coralLight,
  );
  hoodRim.position.set(0, -0.015, 0.205);
  hoodRim.rotation.z = Math.PI * 0.21;
  hoodRim.castShadow = true;
  hoodRim.visible = !isHeavy;
  headRig.add(hoodRim);
  outlinedMeshes.push(hoodRim);

  const hair = new THREE.Group();
  hair.position.set(0, 0.17, 0.08);
  [-0.11, -0.037, 0.043, 0.115].forEach((x, index) => {
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.055, 0.205 + (index % 2) * 0.045, 6),
      ink,
    );
    spike.position.set(x, index % 2 ? 0.028 : 0, 0);
    spike.rotation.z = (x * -1.9) + (index % 2 ? 0.08 : -0.05);
    spike.rotation.x = -0.18;
    spike.castShadow = true;
    hair.add(spike);
    outlinedMeshes.push(spike);
  });
  headRig.add(hair);

  [-1, 1].forEach((side) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), white);
    eye.position.set(side * 0.065, 0.005, 0.252);
    eye.scale.set(0.82, side < 0 ? 1.12 : 1.02, 0.45);
    headRig.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), ink);
    pupil.position.set(side * 0.065, 0.005, 0.283);
    pupil.scale.set(0.8, 1, 0.45);
    headRig.add(pupil);

    const brow = new THREE.Mesh(
      new THREE.BoxGeometry(0.082, 0.021, 0.016),
      ink,
    );
    brow.position.set(side * 0.063, 0.077, 0.274);
    brow.rotation.z = side * -0.22;
    headRig.add(brow);
  });

  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 9), ink);
  mouth.position.set(0, -0.105, 0.265);
  mouth.scale.set(0.72, 1.15, 0.2);
  headRig.add(mouth);

  const tongue = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 10, 7),
    coralLight,
  );
  tongue.position.set(0, -0.132, 0.281);
  tongue.scale.set(0.78, 0.5, 0.22);
  headRig.add(tongue);

  const scarf = new THREE.Mesh(
    new THREE.BoxGeometry(0.085, 0.052, 0.43),
    coralLight,
  );
  scarf.name = "scarf";
  scarf.position.set(0, 1.31, -0.21);
  scarf.rotation.x = -0.28;
  scarf.castShadow = true;
  scarf.visible = !isHeavy;
  visual.add(scarf);
  outlinedMeshes.push(scarf);

  [-1, 1].forEach((side) => {
    const cord = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.012, 0.15, 3, 6),
      cream,
    );
    cord.position.set(side * 0.052, 1.265, 0.18);
    cord.rotation.z = side * -0.08;
    visual.add(cord);
    cord.visible = !isHeavy;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), cream);
    tip.position.set(side * 0.061, 1.175, 0.184);
    visual.add(tip);
    tip.visible = !isHeavy;
  });

  if (isHeavy) {
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.13, 0.18, 10),
      skin,
    );
    neck.position.y = 1.39;
    neck.castShadow = true;
    visual.add(neck);
    outlinedMeshes.push(neck);

    const tankRim = new THREE.Mesh(
      new THREE.TorusGeometry(0.16, 0.026, 6, 16, Math.PI),
      coralLight,
    );
    tankRim.position.set(0, 1.25, 0.22);
    tankRim.rotation.z = Math.PI;
    tankRim.rotation.x = -0.12;
    visual.add(tankRim);
    outlinedMeshes.push(tankRim);

    [-1, 1].forEach((side) => {
      const shoulder = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 12, 9),
        skin,
      );
      shoulder.position.set(side * 0.31, 1.22, 0);
      shoulder.scale.set(1.08, 0.94, 0.92);
      visual.add(shoulder);
      outlinedMeshes.push(shoulder);
    });
  }

  const makeArm = (
    name: string,
    forearmName: string,
    side: -1 | 1,
  ) => {
    const arm = new THREE.Group();
    arm.name = name;
    arm.position.set(side * (isHeavy ? 0.315 : 0.225), 1.2, 0);
    arm.rotation.z = side * 0.14;
    const upperSleeve = new THREE.Mesh(
      new THREE.CapsuleGeometry(isHeavy ? 0.077 : 0.052, isHeavy ? 0.19 : 0.22, 5, 9),
      isHeavy ? skin : coral,
    );
    upperSleeve.position.y = -0.135;

    const forearm = new THREE.Group();
    forearm.name = forearmName;
    forearm.position.y = -0.27;
    const lowerSleeve = new THREE.Mesh(
      new THREE.CapsuleGeometry(isHeavy ? 0.062 : 0.047, isHeavy ? 0.17 : 0.18, 5, 9),
      isHeavy ? skin : coral,
    );
    lowerSleeve.position.y = -0.115;
    const cuff = new THREE.Mesh(
      new THREE.CylinderGeometry(
        isHeavy ? 0.07 : 0.06,
        isHeavy ? 0.062 : 0.052,
        0.07,
        8,
      ),
      coralLight,
    );
    cuff.position.y = -0.235;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.067, 12, 9), skin);
    hand.position.y = -0.29;
    hand.scale.set(0.9, 1.05, 0.82);
    forearm.add(lowerSleeve, cuff, hand);
    arm.add(upperSleeve, forearm);
    outlinedMeshes.push(upperSleeve, lowerSleeve, cuff, hand);
    visual.add(arm);
    return arm;
  };
  makeArm("left-arm", "left-forearm", -1);
  makeArm("right-arm", "right-forearm", 1);

  const makeLeg = (
    name: string,
    calfName: string,
    shoeName: string,
    side: -1 | 1,
  ) => {
    const leg = new THREE.Group();
    leg.name = name;
    leg.position.set(side * (isHeavy ? 0.115 : 0.095), 0.66, 0);
    const thigh = new THREE.Mesh(
      new THREE.CapsuleGeometry(isHeavy ? 0.072 : 0.058, 0.22, 5, 9),
      ink,
    );
    thigh.position.y = -0.13;

    const calf = new THREE.Group();
    calf.name = calfName;
    calf.position.y = -0.28;
    const shin = new THREE.Mesh(
      new THREE.CapsuleGeometry(isHeavy ? 0.064 : 0.052, 0.21, 5, 9),
      ink,
    );
    shin.position.y = -0.125;
    calf.add(shin);

    const shoe = new THREE.Group();
    shoe.name = shoeName;
    shoe.position.set(0, -0.29, 0.085);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.095, 0.29), ink);
    upper.position.z = 0.02;
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.175, 0.045, 0.31), cream);
    sole.position.y = -0.065;
    sole.position.z = 0.02;
    const shoeAccent = new THREE.Mesh(
      new THREE.BoxGeometry(0.165, 0.04, 0.09),
      coral,
    );
    shoeAccent.position.set(0, 0.01, 0.125);
    shoe.add(upper, sole, shoeAccent);
    calf.add(shoe);
    leg.add(thigh, calf);
    outlinedMeshes.push(thigh, shin, upper, sole, shoeAccent);
    visual.add(leg);
    return leg;
  };
  makeLeg("left-leg", "left-calf", "left-shoe", -1);
  makeLeg("right-leg", "right-calf", "right-shoe", 1);

  const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.03), coralLight);
  pocket.position.set(0, 0.92, 0.18);
  pocket.rotation.x = -0.08;
  visual.add(pocket);
  outlinedMeshes.push(pocket);

  const outlineMaterial = new THREE.MeshBasicMaterial({
    color: 0x08111e,
    side: THREE.BackSide,
  });
  outlinedMeshes.forEach((mesh) => {
    const outline = new THREE.Mesh(mesh.geometry, outlineMaterial);
    outline.position.copy(mesh.position);
    outline.rotation.copy(mesh.rotation);
    outline.scale.copy(mesh.scale).multiplyScalar(1.027);
    outline.renderOrder = -1;
    outline.userData.noShadow = true;
    mesh.parent?.add(outline);
  });

  const softHighlight = new THREE.MeshBasicMaterial({
    color: isHeavy ? 0xa7d5cf : 0xffd2ba,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });
  const hoodShine = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 10, 8),
    softHighlight,
  );
  hoodShine.position.set(-0.1, 0.055, -0.258);
  hoodShine.scale.set(0.55, 1.05, 0.14);
  headRig.add(hoodShine);
  const jacketShine = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, 0.26, 0.016),
    softHighlight,
  );
  jacketShine.position.set(-0.13, 1.04, -0.166);
  jacketShine.rotation.z = -0.1;
  visual.add(jacketShine);

  const glow = new THREE.Mesh(
    new THREE.RingGeometry(0.25, 0.34, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffb46b,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glow.name = "charge-glow";
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.025;
  runner.add(glow);

  runner.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      // A lightweight contact shadow is used for landing readability. Keeping
      // the character out of the moving shadow map prevents projection pops.
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });

  return runner;
}

function createPlatform(
  spec: Omit<
    Platform,
    "group" | "shaftWidth" | "shaftDepth" | "surface" | "collisionProfiles"
  >,
  scene: THREE.Scene,
  gradientMap: THREE.Texture,
) {
  const color = palette[spec.step % palette.length];
  const isMicroPlatform = spec.kind !== "roof";
  const group = new THREE.Group();
  group.position.set(spec.x, spec.topY, spec.z);
  group.userData.platformId = spec.id;

  const roofMaterial = new THREE.MeshToonMaterial({
    color: color.roof,
    gradientMap,
  });
  const rimMaterial = new THREE.MeshToonMaterial({
    color: color.rim,
    gradientMap,
  });
  const sideMaterial = new THREE.MeshToonMaterial({
    color: color.side,
    gradientMap,
  });
  const accentMaterial = new THREE.MeshToonMaterial({
    color: color.accent,
    emissive: color.accent,
    emissiveIntensity: 0.07,
    gradientMap,
  });
  const facadeMaterial = new THREE.MeshToonMaterial({
    color: 0x0a1d2d,
    emissive: 0x1d5264,
    emissiveIntensity: 0.16,
    gradientMap,
  });
  const seamMaterial = new THREE.MeshBasicMaterial({
    color: color.rim,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });

  const shaftHeight = isMicroPlatform
    ? 7.2 + seededNoise(spec.id + 44) * 2.4
    : 12 + seededNoise(spec.id + 44) * 7;
  const shaftWidth = isMicroPlatform
    ? spec.kind === "city-light" ? 0.12 : 0.16
    : spec.width * (spec.shape === "rect" ? 0.88 : 0.91);
  const shaftDepth = isMicroPlatform
    ? spec.kind === "city-light" ? 0.12 : 0.14
    : spec.depth * (spec.shape === "rect" ? 0.88 : 0.91);
  let roof: THREE.Mesh;
  let rim: THREE.Mesh;
  let shaft: THREE.Mesh;

  if (spec.shape === "circle" || spec.shape === "hex") {
    const segments = spec.shape === "circle" ? 28 : 6;
    const radius = spec.width / 2;
    // CylinderGeometry's X/Z vertex convention puts a six-sided roof at the
    // same 30-degree polygon rotation used by the collision surface.
    const thetaStart = 0;
    shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(
        radius * 0.91,
        radius * 0.98,
        shaftHeight,
        segments,
        1,
        false,
        thetaStart,
      ),
      sideMaterial,
    );
    roof = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.16, segments, 1, false, thetaStart),
      roofMaterial,
    );
    rim = new THREE.Mesh(
      new THREE.CylinderGeometry(
        radius * 1.045,
        radius * 1.045,
        0.08,
        segments,
        1,
        false,
        thetaStart,
      ),
      rimMaterial,
    );
    rim.position.y = -0.17;
  } else {
    shaft = new THREE.Mesh(
      createRoundedBoxGeometry(
        shaftWidth,
        shaftHeight,
        shaftDepth,
        2,
        0.06,
      ),
      sideMaterial,
    );
    roof = new THREE.Mesh(
      createRoundedBoxGeometry(spec.width, 0.16, spec.depth, 3, 0.055),
      roofMaterial,
    );
    rim = new THREE.Mesh(
      createRoundedBoxGeometry(
        spec.width + 0.13,
        0.08,
        spec.depth + 0.13,
        2,
        0.028,
      ),
      rimMaterial,
    );
    rim.position.y = -0.17;
  }

  shaft.position.y = -shaftHeight / 2 - 0.21;
  shaft.receiveShadow = true;
  shaft.castShadow = false;
  roof.position.y = -0.08;
  roof.receiveShadow = true;
  roof.castShadow = false;
  rim.receiveShadow = true;
  rim.castShadow = false;
  group.add(shaft, rim, roof);

  if (isMicroPlatform) {
    const fixtureMaterial = new THREE.MeshToonMaterial({
      color: spec.kind === "city-light" ? 0x203a4e : 0x26384d,
      gradientMap,
    });
    const lightMaterial = new THREE.MeshBasicMaterial({
      color: spec.kind === "city-light" ? 0xffa164 : 0x74c6d4,
      transparent: true,
      opacity: 0.68,
    });
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width * 0.72, 0.065, 0.075),
      fixtureMaterial,
    );
    arm.position.set(
      spec.kind === "city-light" ? spec.width * 0.13 : 0,
      -0.29,
      0,
    );
    const light = new THREE.Mesh(
      new THREE.BoxGeometry(
        spec.kind === "city-light" ? 0.2 : spec.width * 0.42,
        0.055,
        spec.kind === "city-light" ? 0.13 : 0.07,
      ),
      lightMaterial,
    );
    light.position.set(
      spec.kind === "city-light" ? spec.width * 0.28 : 0,
      -0.34,
      spec.kind === "city-light" ? -0.015 : -0.055,
    );
    group.add(arm, light);
  }

  const edgeTrim = new THREE.Group();
  if (spec.shape === "rect") {
    const edgeDepth = 0.018;
    const edgeHeight = 0.014;
    const horizontal = new THREE.BoxGeometry(spec.width * 0.78, edgeHeight, edgeDepth);
    const vertical = new THREE.BoxGeometry(edgeDepth, edgeHeight, spec.depth * 0.74);
    [-1, 1].forEach((side) => {
      const frontBack = new THREE.Mesh(horizontal, seamMaterial);
      frontBack.position.set(0, -0.006, side * spec.depth * 0.38);
      edgeTrim.add(frontBack);
      const leftRight = new THREE.Mesh(vertical, seamMaterial);
      leftRight.position.set(side * spec.width * 0.39, -0.006, 0);
      edgeTrim.add(leftRight);
    });
  } else {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(
        spec.width * 0.385,
        0.014,
        4,
        spec.shape === "hex" ? 6 : 28,
      ),
      seamMaterial,
    );
    ring.position.y = -0.013;
    ring.rotation.x = Math.PI / 2;
    edgeTrim.add(ring);
  }
  group.add(edgeTrim);

  const roofInset = new THREE.Mesh(
    spec.shape === "rect"
      ? new THREE.PlaneGeometry(spec.width * 0.62, spec.depth * 0.58)
      : new THREE.CircleGeometry(
          spec.width * 0.3,
          spec.shape === "hex" ? 6 : 24,
          spec.shape === "hex" ? Math.PI / 6 : 0,
        ),
    new THREE.MeshBasicMaterial({
      color: color.rim,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  roofInset.rotation.x = -Math.PI / 2;
  roofInset.position.y = 0.001;
  group.add(roofInset);

  const bandCount = isMicroPlatform ? 0 : 2;
  for (let i = 0; i < bandCount; i += 1) {
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(0.036, shaftHeight * 0.34, 0.026),
      accentMaterial,
    );
    band.position.set(
      (i - 0.5) * spec.width * 0.28,
      -shaftHeight * 0.2 - 0.34,
      -shaftDepth / 2 - 0.02,
    );
    band.castShadow = false;
    group.add(band);
  }

  const panelCount = isMicroPlatform ? 0 : spec.shape === "rect" ? 3 : 2;
  for (let i = 0; i < panelCount; i += 1) {
    const panelWidth = spec.width * (spec.shape === "rect" ? 0.14 : 0.12);
    const panel = new THREE.Mesh(
      createRoundedBoxGeometry(panelWidth, 0.25, 0.04, 2, 0.015),
      facadeMaterial,
    );
    panel.position.set(
      (i - (panelCount - 1) / 2) * spec.width * 0.23,
      -0.53 - seededNoise(spec.id + i * 8) * 0.11,
      -shaftDepth / 2 - 0.024,
    );
    panel.rotation.x = -0.03;
    panel.castShadow = false;
    group.add(panel);
  }

  const halo = new THREE.Mesh(
    spec.shape === "rect"
      ? new THREE.PlaneGeometry(spec.width * 0.58, spec.depth * 0.58)
      : new THREE.CircleGeometry(spec.width * 0.28, 32),
    new THREE.MeshBasicMaterial({
      color: color.rim,
      transparent: true,
      opacity: 0.035,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  halo.name = "platform-breathe";
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.0015;
  group.add(halo);

  group.visible = true;

  scene.add(group);
  const slabBottom = spec.topY - (isMicroPlatform ? 0.4 : 0.29);
  const collisionProfiles: VerticalCollisionProfile[] = [
    {
      ...spec,
      topY: spec.topY,
      bottomY: slabBottom,
    },
    {
      x: spec.x,
      z: spec.z,
      width: shaftWidth,
      depth: shaftDepth,
      shape: spec.shape,
      cornerRadius: spec.shape === "rect" ? 0.035 : undefined,
      topY: slabBottom,
      bottomY: spec.topY - shaftHeight - 0.24,
    },
  ];
  return {
    ...spec,
    group,
    shaftWidth,
    shaftDepth,
    surface: {
      x: spec.x,
      z: spec.z,
      width: spec.width,
      depth: spec.depth,
      shape: spec.shape,
      cornerRadius: spec.shape === "rect" ? 0.055 : undefined,
    },
    collisionProfiles,
  } satisfies Platform;
}

function addDuelFinishGate(platform: Platform, gradientMap: THREE.Texture) {
  const gate = new THREE.Group();
  gate.name = "duel-finish-gate";
  const dark = new THREE.MeshToonMaterial({ color: 0x173248, gradientMap });
  const finish = new THREE.MeshToonMaterial({
    color: 0xff815d,
    emissive: 0x7e231b,
    emissiveIntensity: 0.2,
    gradientMap,
  });
  const halfSpan = Math.min(platform.width * 0.38, 0.56);
  [-1, 1].forEach((side) => {
    const post = new THREE.Mesh(
      createRoundedBoxGeometry(0.075, 0.78, 0.075, 2, 0.025),
      dark,
    );
    post.position.set(side * halfSpan, 0.39, 0.08);
    gate.add(post);
  });
  const lintel = new THREE.Mesh(
    createRoundedBoxGeometry(halfSpan * 2 + 0.18, 0.12, 0.09, 2, 0.028),
    finish,
  );
  lintel.position.set(0, 0.75, 0.08);
  gate.add(lintel);
  for (let index = -2; index <= 2; index += 1) {
    const marker = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.125, 0.012),
      index % 2 === 0 ? dark : finish,
    );
    marker.position.set(index * halfSpan * 0.32, 0.75, 0.132);
    marker.rotation.z = -0.35;
    gate.add(marker);
  }
  platform.group.add(gate);
}

function createRisingWater(scene: THREE.Scene) {
  const group = new THREE.Group();
  const waterMaterial = new THREE.MeshBasicMaterial({
    color: 0x48aebc,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(28, 84), waterMaterial);
  surface.rotation.x = -Math.PI / 2;
  surface.position.z = 26;
  group.add(surface);

  const lineMaterial = new THREE.MeshBasicMaterial({
    color: 0xa4e5e6,
    transparent: true,
    opacity: 0.11,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ripples: THREE.Mesh[] = [];
  for (let index = 0; index < 7; index += 1) {
    const ripple = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.67, 32),
      lineMaterial.clone(),
    );
    ripple.rotation.x = -Math.PI / 2;
    ripple.position.set((index % 3 - 1) * 3.1, 0.018, 4 + index * 6.3);
    group.add(ripple);
    ripples.push(ripple);
  }
  group.visible = false;
  scene.add(group);
  return { group, waterMaterial, ripples };
}

function createCity(scene: THREE.Scene) {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0x0b2740,
    roughness: 0.92,
    transparent: true,
    opacity: 0.22,
  });
  const count = 150;
  const buildings = new THREE.InstancedMesh(geometry, material, count);
  const windowGeometry = new THREE.BoxGeometry(0.18, 0.12, 0.035);
  const windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x78d9ea,
    emissive: 0x3ba9c6,
    emissiveIntensity: 1.25,
    roughness: 0.45,
    transparent: true,
    opacity: 0.25,
  });
  const windows = new THREE.InstancedMesh(windowGeometry, windowMaterial, count * 3);
  const beaconMaterial = new THREE.MeshBasicMaterial({
    color: 0xff5f52,
    transparent: true,
    opacity: 0.2,
  });
  const beacons = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.055, 0.24, 0.055),
    beaconMaterial,
    Math.ceil(count / 5),
  );
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  let index = 0;
  let windowIndex = 0;
  let beaconIndex = 0;
  for (let row = -4; row < 26; row += 1) {
    for (let col = -2; col <= 2; col += 1) {
      const seed = row * 11 + col * 7 + 90;
      const height = 2.5 + seededNoise(seed) * 7;
      const buildingX = col * 5.2 + (seededNoise(seed + 1) - 0.5) * 1.5;
      // Keep the skyline inside the lower quarter of the portrait camera.
      // The old value placed most roofs below the visible frame.
      const buildingTop = -3.25 + seededNoise(seed + 8) * 0.82;
      const buildingY = buildingTop - height / 2;
      const buildingZ = row * 5.2 + (seededNoise(seed + 2) - 0.5) * 1.4;
      const buildingWidth = 1.8 + seededNoise(seed + 3) * 1.7;
      const buildingDepth = 1.8 + seededNoise(seed + 4) * 1.7;
      position.set(buildingX, buildingY, buildingZ);
      scale.set(buildingWidth, height, buildingDepth);
      matrix.compose(position, rotation, scale);
      buildings.setMatrixAt(index, matrix);

      for (let lightIndex = 0; lightIndex < 3; lightIndex += 1) {
        position.set(
          buildingX + (seededNoise(seed + lightIndex * 13) - 0.5) * buildingWidth * 0.52,
          buildingY + height * (0.18 + lightIndex * 0.2),
          buildingZ - buildingDepth / 2 - 0.025,
        );
        scale.set(
          0.72 + seededNoise(seed + lightIndex * 17) * 0.75,
          0.75,
          1,
        );
        matrix.compose(position, rotation, scale);
        windows.setMatrixAt(windowIndex, matrix);
        windowIndex += 1;
      }
      if (index % 5 === 0) {
        position.set(buildingX, buildingTop + 0.12, buildingZ);
        scale.set(1, 1, 1);
        matrix.compose(position, rotation, scale);
        beacons.setMatrixAt(beaconIndex, matrix);
        beaconIndex += 1;
      }
      index += 1;
    }
  }
  buildings.count = index;
  buildings.instanceMatrix.needsUpdate = true;
  windows.count = windowIndex;
  windows.instanceMatrix.needsUpdate = true;
  beacons.count = beaconIndex;
  beacons.instanceMatrix.needsUpdate = true;
  group.add(buildings, windows, beacons);
  scene.add(group);
  return {
    group,
    buildingMaterial: material,
    windowMaterial,
    beaconMaterial,
  };
}

function createGroundReference(scene: THREE.Scene) {
  const group = new THREE.Group();
  const groundMaterial = new THREE.MeshBasicMaterial({
    color: 0x071827,
    transparent: true,
    opacity: 0.78,
    side: THREE.DoubleSide,
  });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(72, 190),
    groundMaterial,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -4.35, 55);
  ground.renderOrder = -2;
  group.add(ground);

  const grid = new THREE.GridHelper(190, 76, 0x2f7c8f, 0x17475c);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.18;
  gridMaterial.depthWrite = false;
  grid.position.set(0, -4.32, 55);
  grid.scale.x = 0.38;
  group.add(grid);

  scene.add(group);
  return { group, groundMaterial, gridMaterial };
}

function createAltitudeAtmosphere(scene: THREE.Scene) {
  const cloudGeometry = new THREE.IcosahedronGeometry(1, 1);
  const passageMaterial = new THREE.MeshLambertMaterial({
    color: 0xa9cbd2,
    flatShading: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const cloudSeaMaterial = passageMaterial.clone();
  const passageGroup = new THREE.Group();
  const cloudSeaGroup = new THREE.Group();

  const addCloudCluster = (
    parent: THREE.Group,
    seed: number,
    x: number,
    y: number,
    z: number,
    scale: number,
    material: THREE.Material,
  ) => {
    const cluster = new THREE.Group();
    cluster.position.set(x, y, z);
    cluster.rotation.y = (seededNoise(seed + 19) - 0.5) * 0.42;
    const lobeCount = 3 + Math.floor(seededNoise(seed + 7) * 3);
    for (let index = 0; index < lobeCount; index += 1) {
      const lobe = new THREE.Mesh(cloudGeometry, material);
      const spread = (index - (lobeCount - 1) / 2) * 0.72;
      lobe.position.set(
        spread + (seededNoise(seed + index * 5) - 0.5) * 0.42,
        (seededNoise(seed + index * 11) - 0.45) * 0.38,
        (seededNoise(seed + index * 17) - 0.5) * 0.62,
      );
      lobe.scale.set(
        scale * (0.72 + seededNoise(seed + index * 23) * 0.55),
        scale * (0.27 + seededNoise(seed + index * 29) * 0.17),
        scale * (0.55 + seededNoise(seed + index * 31) * 0.38),
      );
      lobe.renderOrder = -1;
      cluster.add(lobe);
    }
    parent.add(cluster);
  };

  // Leave the route corridor open. The cloud forms live mostly at the sides,
  // so they describe height without becoming landing obstacles or UI noise.
  for (let index = 0; index < 10; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const seed = 410 + index * 37;
    addCloudCluster(
      passageGroup,
      seed,
      side * (3.6 + seededNoise(seed) * 2.1),
      (seededNoise(seed + 3) - 0.5) * 1.25,
      2 + index * 3.5,
      0.82 + seededNoise(seed + 5) * 0.62,
      passageMaterial,
    );
  }

  for (let index = 0; index < 14; index += 1) {
    const seed = 820 + index * 43;
    const sideBias = index % 3 === 0 ? 0 : index % 2 === 0 ? -1 : 1;
    addCloudCluster(
      cloudSeaGroup,
      seed,
      sideBias * (2.1 + seededNoise(seed) * 4.6),
      (seededNoise(seed + 2) - 0.5) * 0.72,
      1 + index * 2.45,
      0.9 + seededNoise(seed + 9) * 0.78,
      cloudSeaMaterial,
    );
  }

  scene.add(passageGroup, cloudSeaGroup);
  return {
    passageGroup,
    cloudSeaGroup,
    passageMaterial,
    cloudSeaMaterial,
  };
}

function pointOnPlatform(platform: Platform, x: number, z: number, margin = 0) {
  return pointOnPlatformSurface(platform.surface, x, z, margin);
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null);
  const restartRef = useRef<() => void>(() => undefined);
  const duelNetworkRef = useRef<DuelNetworkController | null>(null);
  const soundRef = useRef(true);
  const screenRef = useRef<AppScreen>("home");
  const modeRef = useRef<GameMode>("solo");
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [notice, setNotice] = useState("");
  const [hasJumped, setHasJumped] = useState(false);
  const [chargeLevel, setChargeLevel] = useState(0);
  const [altitudeMeters, setAltitudeMeters] = useState(0);
  const [altitudeZone, setAltitudeZone] = useState("近地楼群");
  const [soundOn, setSoundOn] = useState(true);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [gameMode, setGameMode] = useState<GameMode>(() => {
    if (typeof window === "undefined") return "solo";
    return new URLSearchParams(window.location.search).get("mode") === "duel"
      ? "duel"
      : "solo";
  });
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterType>(() => {
    if (typeof window === "undefined") return "runner";
    return window.localStorage.getItem("rooftop-leap-character") === "heavy"
      ? "heavy"
      : "runner";
  });
  const [duelRoom, setDuelRoom] = useState(() => {
    if (typeof window === "undefined") return normalizeDuelRoom(null);
    return normalizeDuelRoom(new URLSearchParams(window.location.search).get("room"));
  });
  const [duelLobbyJoined, setDuelLobbyJoined] = useState(() => {
    if (typeof window === "undefined") return false;
    const search = new URLSearchParams(window.location.search);
    return search.get("mode") === "duel" && Boolean(search.get("room"));
  });
  const [duelStatus, setDuelStatus] = useState<DuelNetworkStatus | "idle">("idle");
  const [duelInviteCopied, setDuelInviteCopied] = useState(false);
  const [duelRematchWaiting, setDuelRematchWaiting] = useState(false);
  const [duelRemoteRematchReady, setDuelRemoteRematchReady] = useState(false);
  const [duelCountdown, setDuelCountdown] = useState(0);
  const [duelElapsedMs, setDuelElapsedMs] = useState(0);
  const [duelProgress, setDuelProgress] = useState({ local: 0, remote: 0 });
  const [duelLives, setDuelLives] = useState({
    local: DUEL_STARTING_LIVES,
    remote: DUEL_STARTING_LIVES,
  });
  const [duelWaterGap, setDuelWaterGap] = useState(3);
  const [duelWaterStep, setDuelWaterStep] = useState(0);
  const [duelResult, setDuelResult] = useState("");
  const [backgroundTheme, setBackgroundTheme] =
    useState<BackgroundTheme>(() => {
      if (typeof window === "undefined") return "night";
      const savedTheme = window.localStorage.getItem("rooftop-leap-theme");
      return isBackgroundTheme(savedTheme) ? savedTheme : "night";
    });

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    modeRef.current = gameMode;
  }, [gameMode]);

  const selectBackground = useCallback((theme: BackgroundTheme) => {
    setBackgroundTheme(theme);
    window.localStorage.setItem("rooftop-leap-theme", theme);
  }, []);

  const returnHome = useCallback(() => {
    restartRef.current();
    setHasJumped(false);
    if (modeRef.current === "duel") {
      const url = new URL(window.location.href);
      url.searchParams.delete("mode");
      url.searchParams.delete("room");
      window.history.replaceState(null, "", url);
      modeRef.current = "solo";
      setGameMode("solo");
      setDuelLobbyJoined(false);
    }
    screenRef.current = "home";
    setScreen("home");
  }, []);

  const openSettings = useCallback(() => {
    screenRef.current = "settings";
    setScreen("settings");
  }, []);

  const closeSettings = useCallback(() => {
    screenRef.current = "home";
    setScreen("home");
  }, []);

  const openCharacters = useCallback(() => {
    screenRef.current = "characters";
    setScreen("characters");
  }, []);

  const closeCharacters = useCallback(() => {
    screenRef.current = "home";
    setScreen("home");
  }, []);

  const chooseCharacter = useCallback((character: CharacterType) => {
    window.localStorage.setItem("rooftop-leap-character", character);
    setSelectedCharacter(character);
    screenRef.current = "home";
    setScreen("home");
  }, []);

  const chooseMode = useCallback((mode: GameMode) => {
    const url = new URL(window.location.href);
    if (mode === "duel") {
      url.searchParams.set("mode", "duel");
      url.searchParams.delete("room");
      setDuelLobbyJoined(false);
    } else {
      url.searchParams.delete("mode");
      url.searchParams.delete("room");
    }
    window.history.replaceState(null, "", url);
    modeRef.current = mode;
    setGameMode(mode);
    setDuelStatus(mode === "duel" ? "loading" : "idle");
    setDuelCountdown(0);
    setDuelElapsedMs(0);
    setDuelProgress({ local: 0, remote: 0 });
    setDuelLives({ local: DUEL_STARTING_LIVES, remote: DUEL_STARTING_LIVES });
    setDuelWaterGap(3);
    setDuelWaterStep(0);
    setDuelResult("");
    setDuelRematchWaiting(false);
    setDuelRemoteRematchReady(false);
    screenRef.current = "home";
    setScreen("home");
  }, []);

  const enterDuelRoom = useCallback((roomValue: string) => {
    const room = normalizeDuelRoom(roomValue);
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "duel");
    url.searchParams.set("room", room);
    window.history.replaceState(null, "", url);
    setDuelRoom(room);
    setDuelStatus("loading");
    setDuelLobbyJoined(true);
  }, []);

  const writeDuelInvite = useCallback(async (room: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "duel");
    url.searchParams.set("room", room);
    try {
      await navigator.clipboard.writeText(url.toString());
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = url.toString();
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setDuelInviteCopied(true);
    window.setTimeout(() => setDuelInviteCopied(false), 1800);
  }, []);

  const createDuelRoom = useCallback(async () => {
    const random = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
    const room = `roof-${random}`;
    enterDuelRoom(room);
    await writeDuelInvite(room);
  }, [enterDuelRoom, writeDuelInvite]);

  const copyDuelInvite = useCallback(async () => {
    await writeDuelInvite(duelRoom);
  }, [duelRoom, writeDuelInvite]);

  const requestDuelRematch = useCallback(() => {
    if (!duelNetworkRef.current || duelRematchWaiting) return;
    setDuelRematchWaiting(true);
    duelNetworkRef.current.requestRematch();
  }, [duelRematchWaiting]);

  const retry = useCallback(() => {
    restartRef.current();
    setHasJumped(false);
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((current) => {
      soundRef.current = !current;
      return !current;
    });
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let destroyed = false;
    let gamePhase: GamePhase = "idle";
    let scoreValue = 0;
    let bestValue = Number(window.localStorage.getItem("rooftop-leap-best") || 0);
    let noticeTimer: number | undefined;
    let audioContext: AudioContext | null = null;
    let activePointer: number | null = null;
    let dragStart = { x: 0, y: 0 };
    let dragCurrent = { x: 0, y: 0 };
    let dragDistance = 0;
    let charge = 0;
    let launchCharge = 0;
    let chargeFeedbackBand = 0;
    const targetDirection = new THREE.Vector3(0, 0, 1);
    let launchPlatformStep = 0;
    let platforms: Platform[] = [];
    let nextPlatformId = 0;
    let generatedThroughStep = 0;
    let generatedRow: Platform[] = [];
    let lastChoiceStep = -10;
    let currentPlatform!: Platform;
    let particles: Particle[] = [];
    let landingSquash = 0;
    let cameraKick = 0;
    let elapsed = 0;
    let fallElapsed = 0;
    let fallReferenceY = 0;
    let fallSpin = 1;
    let fallCollisionCooldown = 0;
    let fallImpactReaction = 0;
    const fallImpactNormal = new THREE.Vector2();
    const duelFinishStep = 18;
    let duelNetwork: DuelNetworkController | null = null;
    let duelConnected = false;
    let duelRaceStartAt = Number.POSITIVE_INFINITY;
    let duelOutcomeArmedAt = Number.POSITIVE_INFINITY;
    let duelRaceActive = false;
    let duelFinishedAt: number | null = null;
    let remoteFinishedAt: number | null = null;
    let duelMatchEnded = false;
    let localEliminated = false;
    let remoteEliminated = false;
    let localEliminationReason: DuelEliminationReason | null = null;
    let localLives = DUEL_STARTING_LIVES;
    let remoteLives = DUEL_STARTING_LIVES;
    let duelPenaltyMs = 0;
    let duelWaterLevel = DUEL_WATER_START_LEVEL;
    let duelWaterFrozenElapsed: number | null = null;
    let lastDuelUiUpdate = 0;
    let playerCollisionCooldown = 0;
    let remoteCharacter: CharacterType = "heavy";
    let remoteStep = 0;
    let remotePoseReceived = false;
    const remoteTargetPosition = new THREE.Vector3();
    const remoteVelocity = new THREE.Vector3();
    let remoteRotationY = 0;
    let remotePhase: GamePhase = "idle";

    setBest(bestValue);

    const scene = new THREE.Scene();
    const sceneFog = new THREE.FogExp2(0x0b2137, 0.036);
    scene.fog = sceneFog;
    const lowAltitudeFog = new THREE.Color(0x0b2137);
    const highAltitudeFog = new THREE.Color(0x315f78);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    renderer.shadowMap.enabled = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.domElement.className = "game-canvas";
    renderer.domElement.setAttribute("aria-label", "纵跃 Three.js 游戏画面");
    mount.appendChild(renderer.domElement);

    const camera = new THREE.OrthographicCamera(-3, 3, 5.5, -5.5, 0.1, 80);
    const focus = new THREE.Vector3(0, 0, 1.7);
    const desiredFocus = focus.clone();

    const hemisphere = new THREE.HemisphereLight(0x8ed8ff, 0x101a2a, 1.8);
    scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffd0ad, 4.7);
    sun.position.set(-5, 12, -5);
    const sunTarget = new THREE.Object3D();
    sunTarget.position.set(0, 0, 2.2);
    scene.add(sunTarget);
    sun.target = sunTarget;
    sun.castShadow = false;
    scene.add(sun);
    const rimLight = new THREE.PointLight(0xff6848, 11, 17, 2);
    rimLight.position.set(2, 5, 2);
    scene.add(rimLight);
    const coolRim = new THREE.PointLight(0x62d5ff, 5.2, 15, 2);
    coolRim.position.set(-2.4, 3.8, 3.2);
    scene.add(coolRim);

    const toonGradient = createToonGradient();
    const groundReference = createGroundReference(scene);
    const cityBackdrop = createCity(scene);
    const city = cityBackdrop.group;
    const altitudeAtmosphere = createAltitudeAtmosphere(scene);
    const runner = createRunner(toonGradient, selectedCharacter);
    scene.add(runner);
    const remoteRunners = {
      runner: createRunner(toonGradient, "runner"),
      heavy: createRunner(toonGradient, "heavy"),
    } satisfies Record<CharacterType, THREE.Group>;
    Object.values(remoteRunners).forEach((remoteRunner) => {
      remoteRunner.visible = false;
      remoteRunner.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const tintMaterial = (material: THREE.Material) => {
          const clone = material.clone();
          if ("color" in clone && clone.color instanceof THREE.Color) {
            clone.color.lerp(new THREE.Color(0x69c6d0), 0.22);
          }
          return clone;
        };
        child.material = Array.isArray(child.material)
          ? child.material.map(tintMaterial)
          : tintMaterial(child.material);
      });
      scene.add(remoteRunner);
    });
    const risingWater = createRisingWater(scene);
    const contactShadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x07111d,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 28),
      contactShadowMaterial,
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.renderOrder = 3;
    scene.add(contactShadow);
    const runnerVisual = runner.getObjectByName("runner-visual") as THREE.Group;
    const chargeGlow = runner.getObjectByName("charge-glow") as THREE.Mesh;
    const chargeMaterial = chargeGlow.material as THREE.MeshBasicMaterial;
    const tensionGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.13, 0.07, 0),
      new THREE.Vector3(-0.13, 0.07, 0),
      new THREE.Vector3(0.13, 0.07, 0),
      new THREE.Vector3(0.13, 0.07, 0),
    ]);
    const tensionMaterial = new THREE.LineBasicMaterial({
      color: 0xffc08b,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const tensionLines = new THREE.LineSegments(tensionGeometry, tensionMaterial);
    tensionLines.visible = false;
    tensionLines.renderOrder = 5;
    runner.add(tensionLines);
    const leftArm = runnerVisual.getObjectByName("left-arm") as THREE.Group;
    const rightArm = runnerVisual.getObjectByName("right-arm") as THREE.Group;
    const leftForearm = runnerVisual.getObjectByName("left-forearm") as THREE.Group;
    const rightForearm = runnerVisual.getObjectByName("right-forearm") as THREE.Group;
    const leftLeg = runnerVisual.getObjectByName("left-leg") as THREE.Group;
    const rightLeg = runnerVisual.getObjectByName("right-leg") as THREE.Group;
    const leftCalf = runnerVisual.getObjectByName("left-calf") as THREE.Group;
    const rightCalf = runnerVisual.getObjectByName("right-calf") as THREE.Group;
    const leftShoe = runnerVisual.getObjectByName("left-shoe") as THREE.Group;
    const rightShoe = runnerVisual.getObjectByName("right-shoe") as THREE.Group;
    const headRig = runnerVisual.getObjectByName("head-rig") as THREE.Group;
    const scarf = runnerVisual.getObjectByName("scarf") as THREE.Mesh;
    const velocity = new THREE.Vector3();
    const movementStart = new THREE.Vector3();

    const createFootFrame = (): FootContactFrame => [
      FOOT_SOLE_LOCAL_SAMPLES.map(() => new THREE.Vector3()),
      FOOT_SOLE_LOCAL_SAMPLES.map(() => new THREE.Vector3()),
    ];
    let previousFootFrame = createFootFrame();
    let currentFootFrame = createFootFrame();
    const shoes = [leftShoe, rightShoe] as const;

    const captureFootFrame = (frame: FootContactFrame) => {
      runner.updateMatrixWorld(true);
      shoes.forEach((shoe, footIndex) => {
        FOOT_SOLE_LOCAL_SAMPLES.forEach((localPoint, sampleIndex) => {
          frame[footIndex][sampleIndex]
            .copy(localPoint)
            .applyMatrix4(shoe.matrixWorld);
        });
      });
    };

    const findLandingContact = (): LandingContact | null => {
      let bestContact: LandingContact | null = null;
      platforms.forEach((platform) => {
        previousFootFrame.forEach((previousPoints, footIndex) => {
          const contact = footSweepContact(
            platform.surface,
            platform.topY,
            previousPoints as readonly FootSweepPoint[],
            currentFootFrame[footIndex] as readonly FootSweepPoint[],
          );
          if (!contact.valid) return;
          const candidate: LandingContact = {
            platform,
            footIndex,
            supportCount: contact.supportCount,
            coverage: contact.coverage,
            time: contact.time,
            x: contact.x,
            z: contact.z,
            soleCenterX: contact.soleCenterX,
            soleCenterZ: contact.soleCenterZ,
          };
          if (
            !bestContact ||
            candidate.time < bestContact.time - 0.0001 ||
            (Math.abs(candidate.time - bestContact.time) < 0.0001 &&
              platform.topY > bestContact.platform.topY)
          ) {
            bestContact = candidate;
          }
        });
      });
      return bestContact;
    };

    const footFrameClearedPlatform = (platform: Platform) => {
      const aSampleCrossedThisFrame = previousFootFrame.some(
        (previousPoints, footIndex) =>
          previousPoints.some((previousPoint, sampleIndex) => {
            const currentPoint = currentFootFrame[footIndex][sampleIndex];
            return previousPoint.y >= platform.topY && currentPoint.y <= platform.topY;
          }),
      );
      // Do not fail on the first unsupported toe corner: the other foot may
      // still be descending onto the roof. A miss is final only after both
      // visible soles have cleared the surface without a valid contact.
      const bothSolesBelow = currentFootFrame.every((points) =>
        points.every((point) => point.y < platform.topY - 0.012),
      );
      return aSampleCrossedThisFrame && bothSolesBelow;
    };

    const ensureAudio = () => {
      if (!soundRef.current) return null;
      if (!audioContext) audioContext = new AudioContext();
      if (audioContext.state === "suspended") void audioContext.resume();
      return audioContext;
    };

    const tone = (
      startFrequency: number,
      endFrequency: number,
      duration: number,
      volume: number,
      type: OscillatorType = "sine",
    ) => {
      const context = ensureAudio();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(startFrequency, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(30, endFrequency),
        context.currentTime + duration,
      );
      gain.gain.setValueAtTime(volume, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + duration);
    };

    const softNoise = (
      duration: number,
      volume: number,
      cutoff: number,
    ) => {
      const context = ensureAudio();
      if (!context) return;
      const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
      const buffer = context.createBuffer(1, frameCount, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < frameCount; index += 1) {
        data[index] = Math.random() * 2 - 1;
      }
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      source.buffer = buffer;
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(cutoff, context.currentTime);
      gain.gain.setValueAtTime(volume, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + duration,
      );
      source.connect(filter).connect(gain).connect(context.destination);
      source.start();
      source.stop(context.currentTime + duration);
    };

    const playSound = (
      kind: "grab" | "jump" | "land" | "perfect" | "scrape" | "miss" | "fail",
      strength = 0.5,
    ) => {
      if (kind === "grab") {
        tone(125, 185, 0.055, 0.009, "sine");
      } else if (kind === "jump") {
        tone(155, 390 + strength * 190, 0.16, 0.024, "sine");
        tone(265, 470 + strength * 150, 0.105, 0.009, "triangle");
        softNoise(0.11, 0.007, 1200);
      } else if (kind === "land") {
        tone(145, 92, 0.1, 0.018, "sine");
        softNoise(0.055, 0.009, 520);
      } else if (kind === "perfect") {
        tone(420, 720, 0.18, 0.026, "sine");
        tone(630, 980, 0.2, 0.014, "sine");
        softNoise(0.045, 0.006, 1400);
      } else if (kind === "scrape") {
        tone(120, 70, 0.16, 0.02, "triangle");
        softNoise(0.12, 0.012, 650);
      } else if (kind === "miss") {
        tone(110, 55, 0.3, 0.022, "sine");
        softNoise(0.22, 0.009, 900);
      } else {
        tone(140, 48, 0.48, 0.028, "triangle");
        softNoise(0.32, 0.01, 700);
      }
    };

    const flashNotice = (text: string) => {
      setNotice(text);
      if (noticeTimer) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setNotice(""), 700);
    };

    const formatDuelTime = (milliseconds: number) => {
      const seconds = Math.max(0, milliseconds) / 1000;
      return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
    };

    const updateDuelResult = () => {
      if (duelFinishedAt === null) {
        if (remoteFinishedAt !== null) setDuelResult("对手已到达终点，继续追上去");
        return;
      }
      if (remoteFinishedAt === null) {
        setDuelResult(`已完成 ${formatDuelTime(duelFinishedAt)} · 等待对手`);
        return;
      }
      const difference = Math.abs(duelFinishedAt - remoteFinishedAt);
      if (difference < 35) {
        setDuelResult(`同时抵达 · ${formatDuelTime(duelFinishedAt)}`);
      } else if (duelFinishedAt < remoteFinishedAt) {
        setDuelResult(`你领先 ${(difference / 1000).toFixed(2)} 秒`);
      } else {
        setDuelResult(`差 ${(difference / 1000).toFixed(2)} 秒 · 再来一局`);
      }
    };

    const makeRouteRow = (previousRow: Platform[], step: number) => {
      const difficulty = Math.min(step / 30, 1);
      const shapeRoll = seededNoise(step * 4.31);
      const shape: PlatformShape =
        step < 2
          ? "rect"
          : shapeRoll > 0.72
            ? "circle"
            : shapeRoll > 0.5
              ? "hex"
              : "rect";
      const size = 1.52 - difficulty * 0.18 + seededNoise(step + 8) * 0.2;
      const width = shape === "rect" ? size : size * 0.96;
      const depth = shape === "rect"
        ? size * (0.84 + seededNoise(step + 12) * 0.16)
        : width;
      const distanceRoll = seededNoise(step * 8.73 + 18);
      let gap: number;
      if (step === 1) {
        gap = 1.08;
      } else if (step === 2) {
        gap = 1.46;
      } else {
        const distanceTier = step % 6;
        if (distanceTier === 0 || distanceTier === 3) {
          gap = 0.9 + distanceRoll * 0.42;
        } else if (distanceTier === 1 || distanceTier === 5) {
          gap = 1.68 + distanceRoll * 0.58 + difficulty * 0.12;
        } else {
          gap = 2.72 + distanceRoll * 0.78 + difficulty * 0.22;
        }
      }
      const anchorX = previousRow.reduce((sum, platform) => sum + platform.x, 0) /
        previousRow.length;
      const previousFront = Math.max(
        ...previousRow.map((platform) => platform.z + platform.depth / 2),
      );
      const previousTopY = Math.max(...previousRow.map((platform) => platform.topY));
      const z = previousFront + gap + depth / 2;
      const lateralRoll = seededNoise(step * 5.17 + 30);
      let x: number;
      if (step === 1) {
        x = 0.2;
      } else {
        const lanePattern = [0, 0.2, -0.95, 0.45, 1.25, 0.15, -1.15, -0.35, 1.05];
        const laneTarget =
          lanePattern[((step - 1) % (lanePattern.length - 1)) + 1] +
          (lateralRoll - 0.5) * 0.16;
        const maxStep = gap > 2.5 ? 1.72 : gap > 1.5 ? 1.5 : 1.35;
        x = clamp(
          anchorX + clamp(laneTarget - anchorX, -maxStep, maxStep),
          -2.05,
          2.05,
        );
      }
      // Every roof is a small but real step upward. The camera follows this
      // world-space rise, so the skyline and cloud deck sink below the player
      // instead of the route feeling like a flat conveyor belt.
      const rise =
        0.14 +
        seededNoise(step + 60) * 0.14 +
        difficulty * 0.035 +
        (step % 7 === 0 ? 0.055 : 0);
      const topY = previousTopY + rise;
      const createRoutePlatform = (
        platformX: number,
        platformZ: number,
        platformWidth: number,
        platformDepth: number,
        platformShape: PlatformShape,
        kind: PlatformKind,
      ) => createPlatform(
        {
          id: nextPlatformId++,
          step,
          kind,
          x: platformX,
          z: platformZ,
          topY,
          width: platformWidth,
          depth: platformDepth,
          shape: platformShape,
        },
        scene,
        toonGradient,
      );

      // Choices are punctuation, not the default rhythm. A split appears only
      // once every ten steps and immediately merges back into one route row.
      const canIntroduceChoice = step - lastChoiceStep >= 5;
      const isSplitRow = canIntroduceChoice && step >= 6 && step % 10 === 6;
      if (isSplitRow) {
        lastChoiceStep = step;
        const centerX = clamp(x, -0.62, 0.62);
        const branchWidth = clamp(width * 0.82, 1.08, 1.26);
        const branchDepth = clamp(depth * 0.88, 1.02, 1.3);
        return [
          createRoutePlatform(
            centerX - 0.92,
            z,
            branchWidth,
            branchDepth,
            "rect",
            "roof",
          ),
          createRoutePlatform(
            centerX + 0.92,
            z + 0.04,
            branchWidth,
            branchDepth,
            "rect",
            "roof",
          ),
        ];
      }

      // Even rarer rows pair a safe roof with a genuinely landable narrow
      // urban fixture. It reads as scenery first but obeys the same sole test.
      const isMicroChoiceRow =
        canIntroduceChoice && step >= 9 && step % 13 === 9;
      if (isMicroChoiceRow) {
        lastChoiceStep = step;
        const side = x > 0.15 ? -1 : 1;
        let microX = clamp(x + side * 1.24, -2.05, 2.05);
        if (Math.abs(microX - x) < 0.82) {
          microX = clamp(x - side * 1.24, -2.05, 2.05);
        }
        const kind: PlatformKind = step % 2 === 0 ? "signal-mast" : "city-light";
        return [
          createRoutePlatform(x, z, width, depth, shape, "roof"),
          createRoutePlatform(
            microX,
            z + 0.08,
            kind === "city-light" ? 0.62 : 0.56,
            kind === "city-light" ? 0.48 : 0.52,
            "rect",
            kind,
          ),
        ];
      }

      return [createRoutePlatform(x, z, width, depth, shape, "roof")];
    };

    const spawnLandingParticles = (
      platform: Platform,
      perfect: boolean,
      contactX = runner.position.x,
      contactZ = runner.position.z,
    ) => {
      const count = perfect ? 20 : 10;
      const color = perfect ? 0xffd28a : 0xd8f3ed;
      for (let i = 0; i < count; i += 1) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.055, 0.055, 0.055),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.9,
          }),
        );
        const angle = (i / count) * Math.PI * 2 + seededNoise(i + scoreValue) * 0.4;
        mesh.position.set(contactX, platform.topY + 0.05, contactZ);
        scene.add(mesh);
        particles.push({
          mesh,
          velocity: new THREE.Vector3(
            Math.cos(angle) * (0.6 + seededNoise(i + 1) * 1.2),
            0.9 + seededNoise(i + 2) * 1.6,
            Math.sin(angle) * (0.6 + seededNoise(i + 3) * 1.2),
          ),
          life: 0.5 + seededNoise(i + 4) * 0.35,
          maxLife: 0.85,
        });
      }
    };

    const spawnMissParticles = (
      platform: Platform,
      contactY = platform.topY + 0.025,
    ) => {
      for (let i = 0; i < 9; i += 1) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.045, 0.045, 0.045),
          new THREE.MeshBasicMaterial({
            color: 0xffb083,
            transparent: true,
            opacity: 0.86,
          }),
        );
        const angle = seededNoise(i + scoreValue * 3.1) * Math.PI * 2;
        mesh.position.set(runner.position.x, contactY, runner.position.z);
        scene.add(mesh);
        particles.push({
          mesh,
          velocity: new THREE.Vector3(
            Math.cos(angle) * (0.45 + seededNoise(i + 20) * 0.75),
            0.35 + seededNoise(i + 30) * 0.75,
            Math.sin(angle) * (0.45 + seededNoise(i + 40) * 0.75),
          ),
          life: 0.38 + seededNoise(i + 50) * 0.25,
          maxLife: 0.63,
        });
      }
    };

    const removePlatform = (platform: Platform) => {
      scene.remove(platform.group);
      disposeObject(platform.group);
      platforms = platforms.filter((item) => item !== platform);
    };

    const ensurePathAhead = (from: Platform) => {
      // Keep the generation frontier well beyond the visible route. New
      // rooftops are created in fog instead of popping into the upper frame.
      const lookAheadCount = 14;
      const lookAheadDistance = 52;
      while (gameMode === "duel"
        ? generatedThroughStep < duelFinishStep
        : generatedThroughStep < from.step + lookAheadCount ||
          Math.max(...generatedRow.map((platform) => platform.z)) <
            from.z + lookAheadDistance
      ) {
        const nextStep = generatedThroughStep + 1;
        const nextRow = makeRouteRow(generatedRow, nextStep);
        platforms.push(...nextRow);
        if (gameMode === "duel" && nextStep === duelFinishStep) {
          const finishPlatform = [...nextRow]
            .filter((platform) => platform.kind === "roof")
            .sort((a, b) => b.width * b.depth - a.width * a.depth)[0];
          if (finishPlatform) addDuelFinishGate(finishPlatform, toonGradient);
        }
        generatedRow = nextRow;
        generatedThroughStep = nextStep;
      }
      return platforms
        .filter((platform) => platform.step > from.step)
        .sort((a, b) => a.step - b.step || a.id - b.id);
    };

    const updatePathFocus = (snap = false) => {
      const upcomingSteps = Array.from(new Set(
        platforms
          .filter((platform) => platform.step > currentPlatform.step)
          .map((platform) => platform.step),
      )).sort((a, b) => a - b);
      const rowCenter = (step: number) => {
        const row = platforms.filter((platform) => platform.step === step);
        return {
          x: row.reduce((sum, platform) => sum + platform.x, 0) / row.length,
          z: row.reduce((sum, platform) => sum + platform.z, 0) / row.length,
          topY: Math.max(...row.map((platform) => platform.topY)),
        };
      };
      const next = upcomingSteps[0] === undefined ? null : rowCenter(upcomingSteps[0]);
      if (!next) return;
      const second = upcomingSteps[1] === undefined ? next : rowCenter(upcomingSteps[1]);
      const third = upcomingSteps[2] === undefined ? second : rowCenter(upcomingSteps[2]);
      const routeX = next.x * 0.62 + second.x * 0.26 + third.x * 0.12;
      const cameraLookAhead = clamp(
        (second.z - currentPlatform.z) * 0.34,
        2.05,
        3.55,
      );
      desiredFocus.set(
        THREE.MathUtils.lerp(currentPlatform.x, routeX, 0.38),
        currentPlatform.topY * 0.55 +
          next.topY * 0.28 +
          second.topY * 0.12 +
          third.topY * 0.05 -
          0.05,
        currentPlatform.z + cameraLookAhead,
      );
      if (snap) focus.copy(desiredFocus);
    };

    const setInternalPhase = (next: GamePhase) => {
      gamePhase = next;
      setPhase(next);
    };

    const settleGroundedPose = () => {
      runnerVisual.position.set(0, 0, 0);
      runnerVisual.rotation.set(0, 0, 0);
      runnerVisual.scale.set(1, 1, 1);
      headRig.rotation.set(0, 0, 0);
      const shoulderOffset = selectedCharacter === "heavy" ? 0.315 : 0.225;
      leftArm.position.set(-shoulderOffset, 1.2, 0);
      leftArm.rotation.set(0, 0, -0.14);
      rightArm.position.set(shoulderOffset, 1.2, 0);
      rightArm.rotation.set(0, 0, 0.14);
      leftForearm.rotation.set(0, 0, 0);
      rightForearm.rotation.set(0, 0, 0);
      leftLeg.rotation.set(0, 0, 0);
      rightLeg.rotation.set(0, 0, 0);
      leftCalf.rotation.set(0, 0, 0);
      rightCalf.rotation.set(0, 0, 0);
      leftShoe.position.z = 0.085;
      leftShoe.rotation.set(0, 0, 0);
      rightShoe.position.z = 0.085;
      rightShoe.rotation.set(0, 0, 0);
      scarf.rotation.set(-0.28, 0, 0);
    };

    const minimumFootSupport = Math.max(
      2,
      Math.ceil(FOOT_SOLE_LOCAL_SAMPLES.length * 0.32),
    );

    const placeGroundedRunner = (
      platform: Platform,
      contact: LandingContact,
    ) => {
      runner.position.y = platform.topY + RUNNER_GROUND_OFFSET;
      settleGroundedPose();
      captureFootFrame(currentFootFrame);

      // Preserve the actual foot that made contact when the flailing pose is
      // folded back into the neutral standing pose.
      const neutralCenter = currentFootFrame[contact.footIndex][0];
      const correctionX = contact.soleCenterX - neutralCenter.x;
      const correctionZ = contact.soleCenterZ - neutralCenter.z;
      const correctionLength = Math.hypot(correctionX, correctionZ);
      const correctionScale = correctionLength > 0.24 ? 0.24 / correctionLength : 1;
      runner.position.x += correctionX * correctionScale;
      runner.position.z += correctionZ * correctionScale;

      // If pose normalization leaves too little of that sole supported, make a
      // tiny inward adjustment until the visible standing pose and collider
      // agree. The maximum movement is deliberately below one shoe length.
      for (let iteration = 0; iteration < 16; iteration += 1) {
        captureFootFrame(currentFootFrame);
        const supportedSamples = currentFootFrame[contact.footIndex].filter((point) =>
          pointOnPlatformSurface(platform.surface, point.x, point.z, 0.002),
        ).length;
        if (supportedSamples >= minimumFootSupport) break;
        const footCenter = currentFootFrame[contact.footIndex][0];
        const inwardX = platform.x - footCenter.x;
        const inwardZ = platform.z - footCenter.z;
        const inwardLength = Math.hypot(inwardX, inwardZ);
        if (inwardLength < 0.0001) break;
        runner.position.x += (inwardX / inwardLength) * 0.012;
        runner.position.z += (inwardZ / inwardLength) * 0.012;
      }
    };

    const resetPlatforms = () => {
      platforms.forEach((platform) => {
        scene.remove(platform.group);
        disposeObject(platform.group);
      });
      platforms = [];
      nextPlatformId = 0;
      generatedThroughStep = 0;
      generatedRow = [];
      lastChoiceStep = -10;
      currentPlatform = createPlatform(
        {
          id: nextPlatformId++,
          step: 0,
          kind: "roof",
          x: 0,
          z: 0,
          topY: 0,
          width: 1.82,
          depth: 1.62,
          shape: "rect",
        },
        scene,
        toonGradient,
      );
      platforms.push(currentPlatform);
      generatedRow = [currentPlatform];
      ensurePathAhead(currentPlatform);
    };

    const restart = () => {
      resetPlatforms();
      scoreValue = 0;
      setScore(0);
      setAltitudeMeters(0);
      setAltitudeZone("近地楼群");
      setChargeLevel(0);
      setNotice("");
      runner.position.set(
        currentPlatform.x,
        currentPlatform.topY + RUNNER_GROUND_OFFSET,
        currentPlatform.z,
      );
      runner.rotation.set(0, 0, 0);
      runner.visible = true;
      settleGroundedPose();
      velocity.set(0, 0, 0);
      launchPlatformStep = currentPlatform.step;
      charge = 0;
      launchCharge = 0;
      dragDistance = 0;
      chargeFeedbackBand = 0;
      fallElapsed = 0;
      fallCollisionCooldown = 0;
      fallImpactReaction = 0;
      fallImpactNormal.set(0, 0);
      duelFinishedAt = null;
      remoteFinishedAt = null;
      duelMatchEnded = false;
      localEliminated = false;
      remoteEliminated = false;
      localEliminationReason = null;
      localLives = DUEL_STARTING_LIVES;
      remoteLives = DUEL_STARTING_LIVES;
      duelPenaltyMs = 0;
      duelWaterLevel = DUEL_WATER_START_LEVEL;
      duelWaterFrozenElapsed = null;
      duelRaceActive = false;
      duelOutcomeArmedAt = Number.POSITIVE_INFINITY;
      remoteStep = 0;
      remotePoseReceived = false;
      setDuelElapsedMs(0);
      setDuelProgress({ local: 0, remote: 0 });
      setDuelLives({ local: DUEL_STARTING_LIVES, remote: DUEL_STARTING_LIVES });
      setDuelWaterGap(3);
      setDuelWaterStep(0);
      setDuelResult("");
      chargeMaterial.opacity = 0;
      tensionLines.visible = false;
      tensionMaterial.opacity = 0;
      updatePathFocus(true);
      captureFootFrame(previousFootFrame);
      setInternalPhase("idle");
    };
    restartRef.current = restart;

    const endDuelByElimination = (
      loser: "local" | "remote",
      reason: DuelEliminationReason,
    ) => {
      if (loser === "local") {
        if (localEliminated) return;
        localEliminated = true;
        localEliminationReason = reason;
        localLives = 0;
        setDuelLives((current) => ({ ...current, local: 0 }));
        setInternalPhase("failed");
        duelNetwork?.sendElimination(reason);
        window.setTimeout(() => {
          if (!destroyed && localEliminated) runner.visible = false;
        }, 320);
      } else {
        if (remoteEliminated) return;
        remoteEliminated = true;
        remoteLives = 0;
        remotePhase = "failed";
        setDuelLives((current) => ({ ...current, remote: 0 }));
      }

      duelRaceActive = false;
      setDuelCountdown(0);
      const stoppedAt = Number.isFinite(duelRaceStartAt)
        ? Math.max(0, performance.now() - duelRaceStartAt + duelPenaltyMs)
        : 0;
      duelWaterFrozenElapsed = Number.isFinite(duelRaceStartAt)
        ? Math.max(0, performance.now() - duelRaceStartAt) / 1000
        : 0;
      setDuelElapsedMs(stoppedAt);

      if (localEliminated && remoteEliminated) {
        duelMatchEnded = true;
        setDuelResult("双方同时出局");
        flashNotice("双方出局");
        return;
      }
      if (duelMatchEnded) return;
      duelMatchEnded = true;
      const waterReason = reason === "water" ? "被水追上" : "三次失误";
      if (loser === "local") {
        setDuelResult(`${waterReason} · 对手获胜`);
        flashNotice("你已出局");
      } else {
        setDuelResult(`对手${waterReason} · 你获胜`);
        flashNotice("对手出局");
      }
    };

    const respawnDuel = () => {
      if (
        destroyed ||
        gameMode !== "duel" ||
        duelFinishedAt !== null ||
        duelMatchEnded ||
        localEliminated
      ) return;
      runner.position.set(
        currentPlatform.x,
        currentPlatform.topY + RUNNER_GROUND_OFFSET,
        currentPlatform.z,
      );
      runner.rotation.set(0, 0, 0);
      runner.visible = true;
      velocity.set(0, 0, 0);
      settleGroundedPose();
      captureFootFrame(previousFootFrame);
      duelPenaltyMs += 1200;
      setInternalPhase("idle");
      flashNotice(`回到上一个落点 · 还剩 ${localLives} 命`);
    };

    const fail = () => {
      if (gamePhase === "failed") return;
      setInternalPhase("failed");
      bestValue = Math.max(bestValue, scoreValue);
      setBest(bestValue);
      window.localStorage.setItem("rooftop-leap-best", String(bestValue));
      playSound("fail");
      if (navigator.vibrate) navigator.vibrate([35, 40, 80]);
      if (gameMode === "duel") {
        const lifeLoss = consumeDuelLife(localLives);
        localLives = lifeLoss.lives;
        setDuelLives((current) => ({ ...current, local: localLives }));
        if (lifeLoss.eliminated) {
          endDuelByElimination("local", "lives");
        } else {
          window.setTimeout(respawnDuel, 760);
        }
      }
    };

    const applySideCollision = (
      collision: SideSweepContact,
      damping: number,
      outwardPush: number,
    ) => {
      runner.position.x = collision.x;
      runner.position.z = collision.z;
      const normalSpeed =
        velocity.x * collision.normalX + velocity.z * collision.normalZ;
      let nextX = velocity.x;
      let nextZ = velocity.z;
      if (normalSpeed < 0) {
        nextX -= collision.normalX * normalSpeed * 1.32;
        nextZ -= collision.normalZ * normalSpeed * 1.32;
      }
      velocity.x = nextX * damping + collision.normalX * outwardPush;
      velocity.z = nextZ * damping + collision.normalZ * outwardPush;
      fallImpactReaction = 1;
      fallImpactNormal.set(collision.normalX, collision.normalZ);
      fallSpin =
        Math.abs(collision.normalX) > 0.16
          ? -Math.sign(collision.normalX)
          : Math.sign(collision.normalZ) || 1;
    };

    const findSideCollision = (
      previousPosition: THREE.Vector3,
      currentPosition: THREE.Vector3,
    ): { platform: Platform; collision: SideSweepContact } | null => {
      let bestHit: { platform: Platform; collision: SideSweepContact } | null = null;
      platforms.forEach((platform) => {
        platform.collisionProfiles.forEach((profile) => {
          const collision = sweepBodyAgainstProfile(
            profile,
            previousPosition,
            currentPosition,
          );
          if (!collision) return;
          if (!bestHit || collision.time < bestHit.collision.time) {
            bestHit = { platform, collision };
          }
        });
      });
      return bestHit;
    };

    const beginFall = (
      platform: Platform,
      previousPosition: THREE.Vector3 = runner.position,
    ) => {
      if (gamePhase !== "flying") return;
      setInternalPhase("falling");
      fallElapsed = 0;
      fallReferenceY = platform.topY;
      fallCollisionCooldown = 0;
      fallSpin = velocity.x >= 0 ? -1 : 1;

      const edgeHit = findSideCollision(previousPosition, runner.position);
      if (edgeHit) {
        applySideCollision(edgeHit.collision, 0.38, 1.05);
        velocity.y = -1.35;
        runnerVisual.rotation.z = -fallSpin * 0.42;
        cameraKick = 0.2;
        spawnMissParticles(edgeHit.platform, runner.position.y + 0.34);
        playSound("scrape");
        if (navigator.vibrate) navigator.vibrate([28, 24, 38]);
      } else {
        velocity.y = Math.min(velocity.y, -1.8);
        playSound("miss");
      }
    };

    const landBack = (platform: Platform, contact: LandingContact) => {
      placeGroundedRunner(platform, contact);
      velocity.set(0, 0, 0);
      landingSquash = 0.62;
      cameraKick = 0.08;
      setChargeLevel(0);
      flashNotice(launchCharge < 0.16 ? "轻跳" : "差一点，再来");
      playSound("land");
      spawnLandingParticles(platform, false, contact.x, contact.z);
      captureFootFrame(previousFootFrame);
      setInternalPhase("idle");
    };

    const land = (platform: Platform, contact: LandingContact) => {
      placeGroundedRunner(platform, contact);
      velocity.set(0, 0, 0);
      const dx = contact.x - platform.x;
      const dz = contact.z - platform.z;
      const normalizedDistance =
        Math.sqrt(dx * dx + dz * dz) / Math.max(0.5, platform.width / 2);
      const perfect = normalizedDistance < 0.24;
      scoreValue += perfect ? 2 : 1;
      setScore(scoreValue);
      setAltitudeMeters(Math.round(platform.step * 5.5 + platform.topY * 4));
      setAltitudeZone(
        platform.step < 6
          ? "近地楼群"
          : platform.step < 12
            ? "城市上空"
            : platform.step < 19
              ? "穿越云层"
              : "云海高空",
      );
      bestValue = Math.max(bestValue, scoreValue);
      setBest(bestValue);
      window.localStorage.setItem("rooftop-leap-best", String(bestValue));
      flashNotice(perfect ? "完美落点  +2" : "+1");
      spawnLandingParticles(platform, perfect, contact.x, contact.z);
      landingSquash = 1;
      cameraKick = perfect ? 0.24 : 0.13;
      playSound(perfect ? "perfect" : "land");
      if (navigator.vibrate) navigator.vibrate(perfect ? [18, 28, 20] : 18);

      currentPlatform = platform;
      launchPlatformStep = platform.step;
      if (gameMode === "duel") {
        setDuelProgress((current) => ({ ...current, local: platform.step }));
      }
      setInternalPhase("idle");
      ensurePathAhead(currentPlatform);
      updatePathFocus();
      captureFootFrame(previousFootFrame);
      if (
        gameMode === "duel" &&
        platform.step >= duelFinishStep &&
        duelFinishedAt === null &&
        !duelMatchEnded
      ) {
        duelFinishedAt = Math.max(
          0,
          performance.now() - duelRaceStartAt + duelPenaltyMs,
        );
        duelNetwork?.sendFinish(duelFinishedAt);
        duelRaceActive = false;
        setDuelElapsedMs(duelFinishedAt);
        flashNotice("抵达终点");
        updateDuelResult();
      }
      if (gameMode !== "duel") {
        const landedPlatformStep = currentPlatform.step;
        window.setTimeout(() => {
          if (destroyed) return;
          platforms
            .filter((candidate) => candidate.step < landedPlatformStep)
            .forEach(removePlatform);
        }, 220);
      }
    };

    const startJump = () => {
      if (dragDistance < 3) {
        charge = 0;
        launchCharge = 0;
        chargeMaterial.opacity = 0;
        tensionLines.visible = false;
        tensionMaterial.opacity = 0;
        runnerVisual.scale.set(1, 1, 1);
        runnerVisual.position.set(0, 0, 0);
        setChargeLevel(0);
        setInternalPhase("idle");
        return;
      }
      const effectiveCharge = Math.max(0.004, charge);
      // Horizontal reach grows more slowly through the first half of the pull,
      // while lift begins gently and remains predictable. Tiny gestures now
      // produce a real hop instead of snapping into a medium-distance jump.
      const { speed, lift } = chargeToLaunch(effectiveCharge);
      velocity.set(targetDirection.x * speed, lift, targetDirection.z * speed);
      launchCharge = effectiveCharge;
      launchPlatformStep = currentPlatform.step;
      setInternalPhase("flying");
      setHasJumped(true);
      chargeMaterial.opacity = 0;
      tensionLines.visible = false;
      tensionMaterial.opacity = 0;
      runnerVisual.scale.set(1, 1, 1);
      runnerVisual.position.set(0, 0, 0);
      setChargeLevel(0);
      captureFootFrame(previousFootFrame);
      playSound("jump", effectiveCharge);
    };

    const updateCharge = () => {
      // Camera screen-right maps to world -X. Using the drag delta here keeps
      // the visible jump direction opposite to the player's pull direction.
      const pullX = dragCurrent.x - dragStart.x;
      const actualPullForward = Math.max(0, dragCurrent.y - dragStart.y);
      const pullForward = 14 + actualPullForward;
      const rawDistance = Math.sqrt(
        pullX * pullX + actualPullForward * actualPullForward,
      );
      dragDistance = rawDistance;
      charge = dragDistanceToCharge(rawDistance);
      const touchIntent = clamp((rawDistance - 1.5) / 13.5, 0, 1);
      const poseAmount = Math.max(charge, touchIntent * 0.1);
      targetDirection.set(pullX * 0.7, 0, pullForward).normalize();
      runner.rotation.y = Math.atan2(targetDirection.x, targetDirection.z);
      runnerVisual.scale.set(
        1 + poseAmount * 0.055,
        1 - poseAmount * 0.24,
        1 + poseAmount * 0.055,
      );
      runnerVisual.position.x = -targetDirection.x * poseAmount * 0.24;
      // Crouch around the sole anchor. Lowering the whole rig pushed the shoes
      // through the roof and made the charge pose contradict the collider.
      runnerVisual.position.y = 0;
      runnerVisual.position.z = -targetDirection.z * poseAmount * 0.26;
      runnerVisual.rotation.x = poseAmount * 0.23;
      runnerVisual.rotation.z = -targetDirection.x * poseAmount * 0.17;
      headRig.rotation.x = -poseAmount * 0.14;
      headRig.rotation.z = targetDirection.x * poseAmount * 0.11;
      leftArm.rotation.x = -poseAmount * 0.72;
      rightArm.rotation.x = -poseAmount * 0.72;
      leftForearm.rotation.x = poseAmount * 0.58;
      rightForearm.rotation.x = poseAmount * 0.58;
      leftLeg.rotation.z = -poseAmount * 0.24;
      rightLeg.rotation.z = poseAmount * 0.24;
      leftCalf.rotation.x = poseAmount * 0.34;
      rightCalf.rotation.x = poseAmount * 0.34;
      chargeMaterial.opacity = touchIntent * 0.16 + charge * 0.5;
      chargeGlow.scale.set(0.8 + charge * 0.48, 1 + charge * 1.6, 1);
      chargeGlow.position.x = runnerVisual.position.x * 0.38;
      chargeGlow.position.z = -0.02 + charge * 0.24;

      const tensionPositions = tensionGeometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      tensionPositions.setXYZ(0, -0.13, 0.07, 0);
      tensionPositions.setXYZ(
        1,
        -0.13 + runnerVisual.position.x,
        0.07 + runnerVisual.position.y,
        runnerVisual.position.z,
      );
      tensionPositions.setXYZ(2, 0.13, 0.07, 0);
      tensionPositions.setXYZ(
        3,
        0.13 + runnerVisual.position.x,
        0.07 + runnerVisual.position.y,
        runnerVisual.position.z,
      );
      tensionPositions.needsUpdate = true;
      tensionLines.visible = rawDistance >= 3;
      tensionMaterial.opacity = touchIntent * (0.28 + charge * 0.64);
      setChargeLevel(Math.max(charge, touchIntent * 0.035));

      const nextBand =
        rawDistance < 3 ? 0 : charge >= 0.72 ? 3 : charge >= 0.3 ? 2 : 1;
      if (nextBand > chargeFeedbackBand && navigator.vibrate) {
        navigator.vibrate(nextBand === 1 ? 5 : 8);
      }
      chargeFeedbackBand = nextBand;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        screenRef.current === "settings" ||
        screenRef.current === "characters" ||
        gamePhase !== "idle"
      ) return;
      if (gameMode === "duel" && (
        !duelConnected ||
        !duelRaceActive ||
        duelFinishedAt !== null ||
        duelMatchEnded ||
        localEliminated
      )) {
        flashNotice(duelConnected ? "等待倒计时" : "正在寻找对手");
        return;
      }
      event.preventDefault();
      if (screenRef.current === "home") {
        // The playable world is the lobby: the first drag dismisses the edge
        // navigation and becomes the first charge gesture without an extra tap.
        screenRef.current = "game";
        setScreen("game");
        setHasJumped(false);
      }
      activePointer = event.pointerId;
      dragStart = { x: event.clientX, y: event.clientY };
      dragCurrent = { ...dragStart };
      dragDistance = 0;
      charge = 0;
      chargeFeedbackBand = 0;
      setChargeLevel(0);
      renderer.domElement.setPointerCapture(event.pointerId);
      ensureAudio();
      playSound("grab");
      setInternalPhase("charging");
    };

    const onPointerMove = (event: PointerEvent) => {
      if (gamePhase !== "charging" || event.pointerId !== activePointer) return;
      event.preventDefault();
      dragCurrent = { x: event.clientX, y: event.clientY };
      updateCharge();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (gamePhase !== "charging" || event.pointerId !== activePointer) return;
      event.preventDefault();
      dragCurrent = { x: event.clientX, y: event.clientY };
      updateCharge();
      activePointer = null;
      startJump();
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      renderer.setSize(width, height, false);
      const aspect = Math.max(0.35, width / Math.max(1, height));
      const viewHeight = 10.6;
      camera.left = (-viewHeight * aspect) / 2;
      camera.right = (viewHeight * aspect) / 2;
      camera.top = viewHeight / 2;
      camera.bottom = -viewHeight / 2;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    resetPlatforms();
    updatePathFocus(true);
    runner.position.set(
      currentPlatform.x,
      currentPlatform.topY + RUNNER_GROUND_OFFSET,
      currentPlatform.z,
    );
    captureFootFrame(previousFootFrame);

    if (gameMode === "duel" && duelLobbyJoined) {
      risingWater.group.visible = true;
      void import("./duel-network")
        .then(({ createDuelNetwork }) => createDuelNetwork(selectedCharacter, duelRoom, {
          onStatus(status) {
            if (destroyed) return;
            setDuelStatus(status);
            duelConnected = status === "connected";
          },
          onStart(delayMs, lane) {
            if (destroyed) return;
            restart();
            setDuelRematchWaiting(false);
            setDuelRemoteRematchReady(false);
            runner.position.x = currentPlatform.x + lane * 0.36;
            captureFootFrame(previousFootFrame);
            duelConnected = true;
            duelRaceStartAt = performance.now() + delayMs;
            duelOutcomeArmedAt = duelRaceStartAt + 750;
            duelRaceActive = false;
            setDuelCountdown(Math.ceil(delayMs / 1000));
            screenRef.current = "game";
            setScreen("game");
          },
          onPose(pose: DuelPose) {
            if (destroyed) return;
            if (pose.eliminated && performance.now() < duelOutcomeArmedAt) return;
            remoteTargetPosition.fromArray(pose.position);
            remoteVelocity.fromArray(pose.velocity);
            remoteRotationY = pose.rotationY;
            remotePhase = pose.phase;
            remoteStep = clamp(Math.round(pose.step), 0, duelFinishStep);
            remoteCharacter = pose.character;
            remoteLives = clamp(Math.round(pose.lives), 0, DUEL_STARTING_LIVES);
            setDuelLives((current) => ({ ...current, remote: remoteLives }));
            remotePoseReceived = true;
            setDuelProgress((current) => ({ ...current, remote: remoteStep }));
            if (pose.eliminated && pose.eliminationReason) {
              endDuelByElimination("remote", pose.eliminationReason);
            }
          },
          onBump(nextVelocity) {
            if (destroyed || duelFinishedAt !== null || duelMatchEnded) return;
            const received = new THREE.Vector3().fromArray(nextVelocity);
            const capped = Math.min(0.66, received.length());
            if (received.lengthSq() > 0.0001) received.setLength(capped);
            if (gamePhase === "flying" || gamePhase === "falling") {
              velocity.add(received);
            } else {
              runner.position.addScaledVector(received, 0.09);
            }
            cameraKick = Math.max(cameraKick, 0.11);
            runnerVisual.rotation.z = clamp(-received.x * 0.42, -0.22, 0.22);
            playSound("scrape");
            if (navigator.vibrate) navigator.vibrate(16);
          },
          onFinish(elapsedMs) {
            if (destroyed || duelMatchEnded) return;
            remoteFinishedAt = elapsedMs;
            updateDuelResult();
          },
          onElimination(reason) {
            if (!destroyed && performance.now() >= duelOutcomeArmedAt) {
              endDuelByElimination("remote", reason);
            }
          },
          onRematchReady(ready) {
            if (!destroyed) setDuelRemoteRematchReady(ready);
          },
          onRemoteCharacter(character) {
            remoteCharacter = character;
          },
        }))
        .then((controller) => {
          if (destroyed) controller.destroy();
          else {
            duelNetwork = controller;
            duelNetworkRef.current = controller;
          }
        })
        .catch(() => {
          if (!destroyed) setDuelStatus("error");
        });
    } else {
      risingWater.group.visible = false;
    }

    const clock = new THREE.Clock();
    let animationFrame = 0;
    const animate = () => {
      if (destroyed) return;
      animationFrame = window.requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.035);
      elapsed += dt;

      if (gamePhase === "flying") {
        movementStart.copy(runner.position);
        velocity.y -= 12.6 * dt;
        runner.position.addScaledVector(velocity, dt);
        const flail = elapsed * 13.5;
        const panic = clamp(Math.abs(velocity.y) / 5.5 + 0.45, 0.55, 1.2);
        runnerVisual.position.y = Math.sin(flail * 1.7) * 0.035;
        runnerVisual.rotation.x =
          clamp(-velocity.y * 0.032, -0.28, 0.3) + Math.sin(flail * 0.53) * 0.075;
        runnerVisual.rotation.z =
          Math.sin(flail * 0.41) * 0.13 + velocity.x * -0.022;
        headRig.rotation.x =
          clamp(-velocity.y * 0.042, -0.24, 0.22) + Math.sin(flail * 0.31) * 0.045;
        headRig.rotation.y = Math.sin(flail * 0.27) * 0.075;
        headRig.rotation.z = -runnerVisual.rotation.z * 0.34;

        leftArm.rotation.x = -0.45 + Math.sin(flail) * 1.08 * panic;
        leftArm.rotation.z = -0.3 + Math.cos(flail * 1.12) * 0.72;
        leftArm.position.y = 1.2 + Math.sin(flail * 1.3) * 0.055;
        leftArm.position.z = Math.cos(flail) * 0.065;
        leftForearm.rotation.x = -0.48 + Math.sin(flail * 1.23 + 0.65) * 0.82;
        leftForearm.rotation.z = Math.cos(flail * 0.77) * 0.24;

        rightArm.rotation.x = -0.45 + Math.sin(flail + Math.PI) * 1.08 * panic;
        rightArm.rotation.z = 0.3 + Math.cos(flail * 1.12 + Math.PI) * 0.72;
        rightArm.position.y = 1.2 + Math.sin(flail * 1.3 + Math.PI) * 0.055;
        rightArm.position.z = Math.cos(flail + Math.PI) * 0.065;
        rightForearm.rotation.x =
          -0.48 + Math.sin(flail * 1.23 + Math.PI + 0.65) * 0.82;
        rightForearm.rotation.z = Math.cos(flail * 0.77 + Math.PI) * 0.24;

        leftLeg.rotation.x = Math.sin(flail * 0.82 + 0.4) * 0.95;
        leftLeg.rotation.z = -0.12 + Math.cos(flail * 0.67) * 0.34;
        rightLeg.rotation.x = Math.sin(flail * 0.82 + Math.PI + 0.4) * 0.95;
        rightLeg.rotation.z = 0.12 + Math.cos(flail * 0.67 + Math.PI) * 0.34;
        leftCalf.rotation.x = 0.42 + Math.sin(flail * 0.91 + 1.2) * 0.48;
        leftCalf.rotation.z = Math.sin(flail * 0.54) * 0.12;
        rightCalf.rotation.x =
          0.42 + Math.sin(flail * 0.91 + Math.PI + 1.2) * 0.48;
        rightCalf.rotation.z = Math.sin(flail * 0.54 + Math.PI) * 0.12;

        leftShoe.position.z = 0.085 + Math.sin(flail * 0.82 + 0.4) * 0.07;
        leftShoe.rotation.x = Math.sin(flail * 0.82 + 1.1) * 0.38;
        rightShoe.position.z = 0.085 + Math.sin(flail * 0.82 + Math.PI + 0.4) * 0.07;
        rightShoe.rotation.x = Math.sin(flail * 0.82 + Math.PI + 1.1) * 0.38;
        scarf.rotation.x = -0.45 + Math.sin(flail * 1.45) * 0.22;
        scarf.rotation.y = Math.sin(flail * 0.76) * 0.24;

        captureFootFrame(currentFootFrame);
        if (velocity.y <= 0) {
          const landingContact = findLandingContact();
          if (landingContact) {
            if (landingContact.platform.step === launchPlatformStep) {
              landBack(landingContact.platform, landingContact);
            } else {
              land(landingContact.platform, landingContact);
            }
          } else {
            const missedPlatform = platforms
              .filter(
                (platform) =>
                  platform.step === launchPlatformStep + 1 &&
                  footFrameClearedPlatform(platform),
              )
              .sort((a, b) =>
                Math.hypot(runner.position.x - a.x, runner.position.z - a.z) -
                Math.hypot(runner.position.x - b.x, runner.position.z - b.z)
              )[0];
            if (missedPlatform) beginFall(missedPlatform, movementStart);
          }
        }
        if (gamePhase === "flying") {
          const completedFrame = previousFootFrame;
          previousFootFrame = currentFootFrame;
          currentFootFrame = completedFrame;
        }
        if (gamePhase === "flying" && (
          runner.position.y < currentPlatform.topY - 6.5 ||
          runner.position.z < currentPlatform.z - 4
        )) {
          const targetPlatform = platforms.find(
            (platform) => platform.step === launchPlatformStep + 1,
          );
          if (targetPlatform) beginFall(targetPlatform, movementStart);
          else fail();
        }
      } else if (gamePhase === "falling") {
        fallElapsed += dt;
        fallCollisionCooldown = Math.max(0, fallCollisionCooldown - dt);
        movementStart.copy(runner.position);
        velocity.y -= 14.8 * dt;
        runner.position.addScaledVector(velocity, dt);
        if (fallCollisionCooldown <= 0) {
          const wallHit = findSideCollision(movementStart, runner.position);
          if (wallHit) {
            applySideCollision(wallHit.collision, 0.44, 0.82);
            velocity.y = Math.min(velocity.y, -1.55);
            fallCollisionCooldown = 0.075;
            cameraKick = Math.max(cameraKick, 0.16);
            spawnMissParticles(wallHit.platform, runner.position.y + 0.34);
            playSound("scrape");
            if (navigator.vibrate) navigator.vibrate(24);
          }
        }
        const tumble = elapsed * 15.5;
        fallImpactReaction = Math.max(0, fallImpactReaction - dt * 4.6);
        runnerVisual.position.set(
          fallImpactNormal.x * fallImpactReaction * 0.075,
          Math.sin(tumble * 0.7) * 0.025 - fallImpactReaction * 0.035,
          fallImpactNormal.y * fallImpactReaction * 0.075,
        );
        runnerVisual.scale.set(
          1 + fallImpactReaction * 0.065,
          1 - fallImpactReaction * 0.11,
          1 + fallImpactReaction * 0.025,
        );
        runnerVisual.rotation.x += dt * (2.1 + fallElapsed * 2.4);
        runnerVisual.rotation.z += dt * fallSpin * (2.8 + fallElapsed * 3.2);
        headRig.rotation.x = THREE.MathUtils.lerp(headRig.rotation.x, -0.28, 0.1);
        headRig.rotation.y = Math.sin(tumble * 0.33) * 0.12;
        headRig.rotation.z = -runnerVisual.rotation.z * 0.08;
        leftArm.rotation.x = THREE.MathUtils.lerp(leftArm.rotation.x, -1.65, 0.12);
        leftArm.rotation.z = -0.65 + Math.sin(tumble) * 0.25;
        leftForearm.rotation.x = -0.72 + Math.sin(tumble * 0.74) * 0.34;
        rightArm.rotation.x = THREE.MathUtils.lerp(rightArm.rotation.x, -1.35, 0.12);
        rightArm.rotation.z = 0.65 + Math.sin(tumble + Math.PI) * 0.25;
        rightForearm.rotation.x = -0.72 + Math.sin(tumble * 0.74 + Math.PI) * 0.34;
        leftLeg.rotation.x = 0.85 + Math.sin(tumble * 0.63) * 0.3;
        leftLeg.rotation.z = -0.34;
        leftCalf.rotation.x = 1.05 + Math.sin(tumble * 0.58) * 0.22;
        rightLeg.rotation.x = -0.7 + Math.sin(tumble * 0.63 + Math.PI) * 0.3;
        rightLeg.rotation.z = 0.34;
        rightCalf.rotation.x = 0.92 + Math.sin(tumble * 0.58 + Math.PI) * 0.22;
        leftShoe.rotation.x += dt * 3.4;
        rightShoe.rotation.x -= dt * 3.1;
        scarf.rotation.x = -0.72 + Math.sin(tumble * 0.9) * 0.18;
        scarf.rotation.y = Math.sin(tumble * 0.55) * 0.36;

        if (fallElapsed > 0.9 || runner.position.y < fallReferenceY - 4.8) {
          fail();
        }
      } else if (gamePhase === "idle") {
        // Idle breathing may lift the model slightly, but never sink its soles
        // through the exact roof plane.
        runnerVisual.position.y = (Math.sin(elapsed * 2.8) + 1) * 0.004;
        runnerVisual.position.x *= Math.exp(-dt * 10);
        runnerVisual.position.z *= Math.exp(-dt * 10);
        runnerVisual.rotation.x *= Math.exp(-dt * 10);
        runnerVisual.rotation.z *= Math.exp(-dt * 10);
        headRig.rotation.x = Math.sin(elapsed * 1.7) * 0.018;
        headRig.rotation.y = Math.sin(elapsed * 1.15) * 0.035;
        headRig.rotation.z *= Math.exp(-dt * 9);
        leftArm.rotation.x = Math.sin(elapsed * 2.4) * 0.08;
        leftArm.rotation.z = THREE.MathUtils.lerp(leftArm.rotation.z, -0.14, 1 - Math.exp(-dt * 10));
        leftArm.position.y = THREE.MathUtils.lerp(leftArm.position.y, 1.2, 1 - Math.exp(-dt * 10));
        leftArm.position.z *= Math.exp(-dt * 10);
        leftForearm.rotation.x = THREE.MathUtils.lerp(leftForearm.rotation.x, 0.04, 1 - Math.exp(-dt * 9));
        leftForearm.rotation.z *= Math.exp(-dt * 9);
        rightArm.rotation.x = -Math.sin(elapsed * 2.4) * 0.08;
        rightArm.rotation.z = THREE.MathUtils.lerp(rightArm.rotation.z, 0.14, 1 - Math.exp(-dt * 10));
        rightArm.position.y = THREE.MathUtils.lerp(rightArm.position.y, 1.2, 1 - Math.exp(-dt * 10));
        rightArm.position.z *= Math.exp(-dt * 10);
        rightForearm.rotation.x = THREE.MathUtils.lerp(rightForearm.rotation.x, 0.04, 1 - Math.exp(-dt * 9));
        rightForearm.rotation.z *= Math.exp(-dt * 9);
        leftLeg.rotation.x *= Math.exp(-dt * 10);
        leftLeg.rotation.z *= Math.exp(-dt * 10);
        rightLeg.rotation.x *= Math.exp(-dt * 10);
        rightLeg.rotation.z *= Math.exp(-dt * 10);
        leftCalf.rotation.x *= Math.exp(-dt * 9);
        leftCalf.rotation.z *= Math.exp(-dt * 9);
        rightCalf.rotation.x *= Math.exp(-dt * 9);
        rightCalf.rotation.z *= Math.exp(-dt * 9);
        leftShoe.position.z = THREE.MathUtils.lerp(leftShoe.position.z, 0.085, 1 - Math.exp(-dt * 10));
        leftShoe.rotation.x *= Math.exp(-dt * 10);
        rightShoe.position.z = THREE.MathUtils.lerp(rightShoe.position.z, 0.085, 1 - Math.exp(-dt * 10));
        rightShoe.rotation.x *= Math.exp(-dt * 10);
        scarf.rotation.x = THREE.MathUtils.lerp(scarf.rotation.x, -0.28, 1 - Math.exp(-dt * 10));
        scarf.rotation.y *= Math.exp(-dt * 10);
      }

      if (gameMode === "duel") {
        const now = performance.now();
        playerCollisionCooldown = Math.max(0, playerCollisionCooldown - dt);

        if (
          duelConnected &&
          !duelRaceActive &&
          duelFinishedAt === null &&
          !duelMatchEnded &&
          Number.isFinite(duelRaceStartAt)
        ) {
          const remaining = duelRaceStartAt - now;
          if (remaining <= 0) {
            duelRaceActive = true;
            setDuelCountdown(0);
            flashNotice("开始");
          } else {
            setDuelCountdown(Math.ceil(remaining / 1000));
          }
        }

        const raceElapsed = Number.isFinite(duelRaceStartAt)
          ? Math.max(0, now - duelRaceStartAt + duelPenaltyMs)
          : 0;

        const routeTopAtStep = (step: number) => {
          const stepPlatforms = platforms.filter((platform) => platform.step === step);
          return stepPlatforms.length > 0
            ? Math.max(...stepPlatforms.map((platform) => platform.topY))
            : currentPlatform.topY;
        };
        const waterElapsed = duelWaterFrozenElapsed ??
          Math.max(0, now - duelRaceStartAt) / 1000;
        const waterProgress = duelWaterProgressAt(waterElapsed, duelFinishStep);
        let targetWaterLevel: number;
        if (waterProgress < 0) {
          targetWaterLevel = THREE.MathUtils.lerp(
            DUEL_WATER_START_LEVEL,
            routeTopAtStep(0) + 0.025,
            waterProgress + 1,
          );
        } else {
          const lowerStep = Math.floor(waterProgress);
          const upperStep = Math.min(duelFinishStep, lowerStep + 1);
          targetWaterLevel = THREE.MathUtils.lerp(
            routeTopAtStep(lowerStep) + 0.025,
            routeTopAtStep(upperStep) + 0.025,
            waterProgress - lowerStep,
          );
        }
        duelWaterLevel = THREE.MathUtils.damp(
          duelWaterLevel,
          targetWaterLevel,
          5.2,
          dt,
        );

        if (now - lastDuelUiUpdate > 100) {
          lastDuelUiUpdate = now;
          if (duelFinishedAt === null && !duelMatchEnded) setDuelElapsedMs(raceElapsed);
          const soleHeight = runner.position.y - RUNNER_GROUND_OFFSET;
          setDuelWaterGap(Math.max(0, soleHeight - duelWaterLevel));
          setDuelWaterStep(Math.floor(Math.max(0, waterProgress)));
        }

        risingWater.group.position.set(focus.x, duelWaterLevel, focus.z);
        risingWater.waterMaterial.opacity = 0.14 + Math.sin(elapsed * 0.72) * 0.025;
        risingWater.ripples.forEach((ripple, index) => {
          const cycle = (elapsed * (0.18 + index * 0.007) + index * 0.13) % 1;
          ripple.scale.setScalar(0.65 + cycle * 1.25);
          (ripple.material as THREE.MeshBasicMaterial).opacity = (1 - cycle) * 0.12;
        });

        if (
          duelRaceActive &&
          duelFinishedAt === null &&
          !duelMatchEnded &&
          !localEliminated &&
          gamePhase !== "failed" &&
          isPlayerCaughtByWater(
            runner.position.y - RUNNER_GROUND_OFFSET,
            duelWaterLevel,
          )
        ) {
          cameraKick = Math.max(cameraKick, 0.22);
          spawnMissParticles(currentPlatform, duelWaterLevel + 0.03);
          playSound("fail");
          if (navigator.vibrate) navigator.vibrate([55, 35, 100]);
          endDuelByElimination("local", "water");
        }

        const visibleRemote = remoteRunners[remoteCharacter];
        Object.entries(remoteRunners).forEach(([character, remoteRunner]) => {
          remoteRunner.visible =
            remotePoseReceived &&
            character === remoteCharacter &&
            remotePhase !== "failed";
        });
        if (remotePoseReceived) {
          const remoteFollow = 1 - Math.exp(-dt * 12);
          visibleRemote.position.lerp(remoteTargetPosition, remoteFollow);
          visibleRemote.rotation.y = THREE.MathUtils.lerp(
            visibleRemote.rotation.y,
            remoteRotationY,
            remoteFollow,
          );
          const remoteVisual = visibleRemote.getObjectByName("runner-visual") as THREE.Group;
          if (remoteVisual) {
            const remoteFlail = elapsed * 12.4;
            remoteVisual.position.y = remotePhase === "flying"
              ? Math.sin(remoteFlail * 1.3) * 0.025
              : (Math.sin(elapsed * 2.3) + 1) * 0.003;
            remoteVisual.rotation.x = remotePhase === "flying"
              ? Math.sin(remoteFlail * 0.42) * 0.12
              : 0;
            remoteVisual.rotation.z = remotePhase === "flying"
              ? Math.sin(remoteFlail * 0.61) * 0.16
              : 0;
          }

          const verticalDistance = Math.abs(runner.position.y - visibleRemote.position.y);
          if (
            duelRaceActive &&
            duelFinishedAt === null &&
            !duelMatchEnded &&
            !localEliminated &&
            !remoteEliminated &&
            remotePhase !== "failed" &&
            verticalDistance < 0.72 &&
            playerCollisionCooldown <= 0
          ) {
            const collision = resolveWeightedPlayerCollision(
              {
                x: runner.position.x,
                z: runner.position.z,
                velocityX: velocity.x,
                velocityZ: velocity.z,
                radius: Number(runner.userData.radius) || 0.28,
                mass: Number(runner.userData.mass) || 1,
              },
              {
                x: visibleRemote.position.x,
                z: visibleRemote.position.z,
                velocityX: remoteVelocity.x,
                velocityZ: remoteVelocity.z,
                radius: Number(visibleRemote.userData.radius) || 0.28,
                mass: Number(visibleRemote.userData.mass) || 1,
              },
            );
            if (collision) {
              runner.position.x = collision.localPositionX;
              runner.position.z = collision.localPositionZ;
              visibleRemote.position.x = collision.remotePositionX;
              visibleRemote.position.z = collision.remotePositionZ;
              const localDeltaX = collision.localVelocityX - velocity.x;
              const localDeltaZ = collision.localVelocityZ - velocity.z;
              velocity.x = collision.localVelocityX;
              velocity.z = collision.localVelocityZ;
              duelNetwork?.sendBump([
                collision.remoteVelocityX - remoteVelocity.x,
                0,
                collision.remoteVelocityZ - remoteVelocity.z,
              ]);
              if (Math.hypot(localDeltaX, localDeltaZ) > 0.04) {
                runnerVisual.rotation.z = clamp(-localDeltaX * 0.42, -0.23, 0.23);
                cameraKick = Math.max(cameraKick, 0.1);
                playSound("scrape");
                if (navigator.vibrate) navigator.vibrate(14);
              }
              playerCollisionCooldown = 0.18;
            }
          }
        }

        if (duelConnected) {
          duelNetwork?.sendPose({
            position: runner.position.toArray() as [number, number, number],
            velocity: velocity.toArray() as [number, number, number],
            rotationY: runner.rotation.y,
            phase: gamePhase,
            step: currentPlatform.step,
            elapsedMs: duelFinishedAt ?? raceElapsed,
            character: selectedCharacter,
            lives: localLives,
            eliminated: localEliminated,
            eliminationReason: localEliminationReason,
          });
        }
      }

      if (gamePhase === "charging") {
        const pulse = 1 + Math.sin(elapsed * (5 + charge * 7)) * 0.045;
        chargeGlow.scale.set(
          (0.82 + charge * 0.34) * pulse,
          (1 + charge * 1.3) * pulse,
          1,
        );
      }

      landingSquash = Math.max(0, landingSquash - dt * 4.7);
      if (landingSquash > 0 && gamePhase === "idle") {
        const bounce = Math.sin((1 - landingSquash) * Math.PI) * landingSquash;
        runnerVisual.scale.set(1 + bounce * 0.06, 1 - bounce * 0.17, 1 + bounce * 0.06);
        headRig.rotation.x += bounce * 0.11;
        leftArm.rotation.x -= bounce * 0.24;
        rightArm.rotation.x -= bounce * 0.24;
        leftCalf.rotation.x += bounce * 0.2;
        rightCalf.rotation.x += bounce * 0.2;
      } else if (gamePhase === "idle") {
        runnerVisual.scale.lerp(new THREE.Vector3(1, 1, 1), 1 - Math.exp(-dt * 10));
      }

      platforms.forEach((platform) => {
        const breathe = platform.group.getObjectByName("platform-breathe") as THREE.Mesh;
        if (!breathe) return;
        const material = breathe.material as THREE.MeshBasicMaterial;
        material.opacity = 0.025 + Math.sin(elapsed * 1.6 + platform.id) * 0.012;
      });

      const shadowPlatform =
        gamePhase === "idle" || gamePhase === "charging"
          ? currentPlatform
          : platforms
              .filter(
                (platform) =>
                  runner.position.y >= platform.topY - 0.05 &&
                  pointOnPlatform(
                    platform,
                    runner.position.x,
                    runner.position.z,
                  ),
              )
              .sort((a, b) => b.topY - a.topY)[0];
      if (shadowPlatform && gamePhase !== "failed" && runner.visible) {
        const height = Math.max(0, runner.position.y - shadowPlatform.topY);
        const opacity = 0.22 * (1 - clamp(height / 4.6, 0, 1));
        const shadowScale = 0.84 + clamp(height / 5, 0, 1) * 0.38;
        contactShadow.visible = opacity > 0.008;
        contactShadow.position.set(
          runner.position.x,
          shadowPlatform.topY + 0.014,
          runner.position.z,
        );
        contactShadow.scale.set(shadowScale, shadowScale * 0.78, 1);
        contactShadowMaterial.opacity = opacity;
      } else {
        contactShadow.visible = false;
      }

      particles.forEach((particle) => {
        particle.life -= dt;
        particle.velocity.y -= 4.5 * dt;
        particle.mesh.position.addScaledVector(particle.velocity, dt);
        particle.mesh.rotation.x += dt * 7;
        particle.mesh.rotation.z += dt * 5;
        const material = particle.mesh.material as THREE.MeshBasicMaterial;
        material.opacity = clamp(particle.life / particle.maxLife, 0, 1);
      });
      particles
        .filter((particle) => particle.life <= 0)
        .forEach((particle) => {
          scene.remove(particle.mesh);
          particle.mesh.geometry.dispose();
          (particle.mesh.material as THREE.Material).dispose();
        });
      particles = particles.filter((particle) => particle.life > 0);

      const followSpeed = 1 - Math.exp(-dt * 2.7);
      focus.lerp(desiredFocus, followSpeed);
      cameraKick = Math.max(0, cameraKick - dt * 2.3);
      const kick = Math.sin(elapsed * 44) * cameraKick;
      camera.position.set(
        focus.x + kick * 0.1,
        focus.y + 8.9 + kick * 0.055,
        focus.z - 7.1,
      );
      camera.lookAt(focus.x, focus.y - 0.1, focus.z + 2.15);
      sun.position.set(focus.x - 5, focus.y + 12, focus.z - 5);
      sunTarget.position.set(focus.x, focus.y, focus.z + 2.2);
      rimLight.position.set(focus.x + 2, focus.y + 4.5, focus.z + 1.5);
      coolRim.position.set(focus.x - 2.4, focus.y + 3.8, focus.z + 3.2);
      // The city is an atmospheric backdrop, so it follows the camera
      // continuously. Snapping it by one block made the whole skyline jump
      // after every landing.
      city.position.x = focus.x;
      const nextRoutePlatform = platforms.find(
        (platform) => platform.step === currentPlatform.step + 1,
      );
      const routeFraction = nextRoutePlatform
        ? clamp(
            (runner.position.z - currentPlatform.z) /
              Math.max(0.001, nextRoutePlatform.z - currentPlatform.z),
            0,
            1,
          )
        : 0;
      const altitudeProgress = clamp(
        (currentPlatform.step + routeFraction) / 24,
        0,
        1,
      );
      const cityFade = 1 - smoothstep(0.08, 0.62, altitudeProgress);
      const groundFade = 1 - smoothstep(0.05, 0.42, altitudeProgress);
      const cloudPass = smoothstep(0.3, 0.47, altitudeProgress) *
        (1 - smoothstep(0.64, 0.8, altitudeProgress));
      city.position.y = -altitudeProgress * 1.8;
      city.position.z = focus.z;
      cityBackdrop.buildingMaterial.opacity = 0.015 + cityFade * 0.255;
      cityBackdrop.windowMaterial.opacity = 0.012 + cityFade * 0.29;
      cityBackdrop.beaconMaterial.opacity = 0.01 + cityFade * 0.23;
      groundReference.groundMaterial.opacity = groundFade * 0.78;
      groundReference.gridMaterial.opacity = groundFade * 0.2;
      groundReference.group.visible = groundFade > 0.01;
      altitudeAtmosphere.passageGroup.position.set(
        focus.x,
        focus.y + THREE.MathUtils.lerp(5.6, -4.4, smoothstep(0.26, 0.78, altitudeProgress)),
        focus.z + 2.8,
      );
      altitudeAtmosphere.cloudSeaGroup.position.set(
        focus.x,
        focus.y - 3.2 - smoothstep(0.55, 1, altitudeProgress) * 0.7,
        focus.z + 2.4,
      );
      altitudeAtmosphere.passageMaterial.opacity = cloudPass * 0.3;
      altitudeAtmosphere.cloudSeaMaterial.opacity =
        0.015 + smoothstep(0.45, 0.82, altitudeProgress) * 0.22;
      altitudeAtmosphere.passageGroup.visible = cloudPass > 0.01;
      altitudeAtmosphere.cloudSeaGroup.visible = altitudeProgress > 0.34;
      sceneFog.color.copy(lowAltitudeFog).lerp(highAltitudeFog, altitudeProgress * 0.72);
      sceneFog.density = THREE.MathUtils.lerp(0.036, 0.025, altitudeProgress);

      const frameElement = mount.parentElement;
      if (frameElement) {
        frameElement.style.setProperty(
          "--ascent-cloud",
          `${altitudeProgress * 72}px`,
        );
        frameElement.style.setProperty(
          "--cloud-haze-opacity",
          String(cloudPass * 0.32),
        );
        frameElement.style.setProperty(
          "--high-air-opacity",
          String(smoothstep(0.63, 0.92, altitudeProgress) * 0.72),
        );
        frameElement.style.setProperty(
          "--high-sky-opacity",
          String(smoothstep(0.38, 0.92, altitudeProgress) * 0.72),
        );
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      destroyed = true;
      duelNetwork?.destroy();
      if (duelNetworkRef.current === duelNetwork) duelNetworkRef.current = null;
      window.cancelAnimationFrame(animationFrame);
      if (noticeTimer) window.clearTimeout(noticeTimer);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.dispose();
      toonGradient.dispose();
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material.dispose());
      });
      if (audioContext) void audioContext.close();
      mount.removeChild(renderer.domElement);
    };
  }, [duelLobbyJoined, duelRoom, gameMode, selectedCharacter]);

  const duelStatusLabel: Record<DuelNetworkStatus | "idle", string> = {
    idle: "未连接",
    loading: "载入免费联机模块",
    hosting: "等待另一位玩家",
    joining: "正在加入比赛",
    connected: "已匹配，准备开始",
    reconnecting: "连接中断，正在恢复",
    full: "当前房间已满",
    unsupported: "当前浏览器不支持安全联机",
    error: "连接失败，请刷新重试",
  };
  const duelSeconds = duelElapsedMs / 1000;
  const duelTimeLabel = `${Math.floor(duelSeconds / 60)}:${(duelSeconds % 60)
    .toFixed(2)
    .padStart(5, "0")}`;

  return (
    <main className="experience">
      <aside className="intro-panel" aria-label="游戏介绍">
        <div className="eyebrow">A THREE.JS MICRO GAME</div>
        <h1>纵跃</h1>
        <p className="intro-lede">一次蓄力，一次落点。前方的路始终在城市中延伸。</p>
        <div className="intro-rule" />
        <p className="intro-copy">
          单一路线不断改变方向、距离和形状。没有轨迹线，只有手感与判断。
        </p>
      </aside>

      <section
        className={`game-frame theme-${backgroundTheme}`}
        aria-label="纵跃试玩版"
      >
        <div className="game-mount" ref={mountRef} />
        <div className="high-sky-shift" aria-hidden="true" />
        <div className="atmosphere-wash" aria-hidden="true" />
        <div className="high-air-glint" aria-hidden="true" />
        <div className="top-haze" />
        <div
          className={`ascent-streaks ${phase === "flying" ? "ascent-active" : ""}`}
          aria-hidden="true"
        />

        {screen === "game" && (
          <header className="hud">
            <div className="hud-brand">
              <span className="hud-mark">{gameMode === "duel" ? "双人竞速" : "纵跃"}</span>
              <span className="hud-sub">
                {gameMode === "duel" ? "DUEL ASCENT" : "ROOFTOP RUN"}
              </span>
            </div>
            <div className="score-block" aria-label={`当前分数 ${score}`}>
              <span className="score-label">{gameMode === "duel" ? "赛段" : "进度"}</span>
              <strong>
                {gameMode === "duel"
                  ? `${String(duelProgress.local).padStart(2, "0")}/18`
                  : String(score).padStart(2, "0")}
              </strong>
            </div>
            <div className="hud-actions">
              <button
                className="home-button"
                type="button"
                onClick={returnHome}
                aria-label="返回主页"
              >
                主页
              </button>
              <button
                className="sound-button"
                type="button"
                onClick={toggleSound}
                aria-label={soundOn ? "关闭声音" : "打开声音"}
              >
                {soundOn ? "声" : "静"}
              </button>
            </div>
          </header>
        )}

        {screen === "game" && (
          <div className={`notice ${notice ? "notice-visible" : ""}`}>{notice}</div>
        )}

        {screen === "game" && gameMode === "duel" && (
          <div className="duel-timer" aria-label={`比赛计时 ${duelTimeLabel}`}>
            <span>TIME</span>
            <strong>{duelTimeLabel}</strong>
          </div>
        )}

        {screen === "game" && gameMode === "duel" && (
          <div className="duel-water-chip" aria-label="水面距离">
            <span className="water-wave-icon" aria-hidden="true" />
            <strong>
              {duelWaterGap < 0.65
                ? "水位逼近"
                : `已淹 ${duelWaterStep}/18 · ${duelWaterGap.toFixed(1)}m`}
            </strong>
          </div>
        )}

        {screen === "game" && gameMode === "duel" && (
          <div className="duel-lives" aria-label="双方剩余生命">
            {(["local", "remote"] as const).map((side) => (
              <div key={side}>
                <span>{side === "local" ? "你" : "对手"}</span>
                <i aria-hidden="true">
                  {Array.from({ length: DUEL_STARTING_LIVES }, (_, index) => (
                    <b
                      key={index}
                      className={index < duelLives[side] ? "life-active" : ""}
                    />
                  ))}
                </i>
              </div>
            ))}
          </div>
        )}

        {screen === "game" && gameMode === "duel" && (
          <div className="duel-position-rail" aria-label="双方地图位置">
            <span className="rail-finish">终</span>
            <span className="rail-line" />
            <span
              className="rail-player rail-player-local"
              style={{ bottom: `${8 + (duelProgress.local / 18) * 78}%` }}
              aria-label={`你在第 ${duelProgress.local} 段`}
            >
              你
            </span>
            <span
              className="rail-player rail-player-remote"
              style={{ bottom: `${8 + (duelProgress.remote / 18) * 78}%` }}
              aria-label={`对手在第 ${duelProgress.remote} 段`}
            >
              对
            </span>
            <span className="rail-start">起</span>
          </div>
        )}

        {screen === "game" && gameMode === "duel" && duelCountdown > 0 && (
          <div className="duel-countdown" aria-live="assertive">
            <span>比赛即将开始</span>
            <strong>{duelCountdown}</strong>
          </div>
        )}

        {screen === "game" && gameMode === "duel" && duelResult && (
          <div className="duel-result" role="status">
            <span>生存竞速</span>
            <strong>{duelResult}</strong>
            <div className="duel-result-actions">
              <button
                type="button"
                onClick={requestDuelRematch}
                disabled={duelRematchWaiting}
              >
                {duelRematchWaiting
                  ? "等待对手…"
                  : duelRemoteRematchReady
                    ? "对手已准备 · 再来一局"
                    : "再来一局"}
              </button>
              <button type="button" className="duel-exit-button" onClick={returnHome}>
                退出游戏
              </button>
            </div>
          </div>
        )}

        {screen === "game" && (
          <div
            className={`gesture-hint ${
              !hasJumped &&
              phase === "idle" &&
              (gameMode === "solo" || duelCountdown === 0)
                ? "hint-visible"
                : ""
            }`}
          >
            <span className="gesture-dot" />
            <div>
              <strong>按住，向后拖</strong>
              <span>松手起跳</span>
            </div>
          </div>
        )}

        {screen === "game" && (
          <div
            className={`charge-feedback ${phase === "charging" ? "charge-visible" : ""}`}
            aria-hidden="true"
          >
            <span className="charge-state">
              {chargeLevel < 0.01
                ? "拖动角色"
                : chargeLevel < 0.16
                  ? "短跳"
                  : chargeLevel < 0.62
                    ? "蓄力"
                    : "远跃"}
            </span>
            <span className="charge-track">
              <span style={{ transform: `scaleX(${chargeLevel})` }} />
            </span>
          </div>
        )}

        {screen === "game" && gameMode === "solo" && (
          <div className="best-chip">最佳 {String(best).padStart(2, "0")}</div>
        )}

        {screen === "game" && (
          <div className="altitude-chip">
            <span>{altitudeZone}</span>
            <strong>+{String(altitudeMeters).padStart(3, "0")}m</strong>
          </div>
        )}

        {screen === "game" && gameMode === "solo" && phase === "failed" && (
          <div className="game-over" role="dialog" aria-modal="true" aria-label="本局结束">
            <div className="game-over-card">
              <span className="game-over-kicker">落空了</span>
              <strong>{String(score).padStart(2, "0")}</strong>
              <span className="game-over-label">本次高度</span>
              <button type="button" onClick={retry}>
                再跳一次
              </button>
            </div>
          </div>
        )}

        <div
          className={`lobby-ui ${screen === "home" ? "lobby-visible" : "lobby-hidden"}`}
          aria-hidden={screen !== "home"}
        >
          <div className="lobby-topbar">
            <button
              className="lobby-square-button character-button"
              type="button"
              onClick={openCharacters}
              tabIndex={screen === "home" ? 0 : -1}
              aria-label="选择角色"
            >
              <span
                className={`character-mini ${selectedCharacter === "heavy" ? "character-mini-heavy" : ""}`}
                aria-hidden="true"
              >
                <i />
              </span>
              <span>角色</span>
              <small>{selectedCharacter === "heavy" ? "重装" : "跃者"}</small>
            </button>
            <button
              className="lobby-square-button settings-button"
              type="button"
              onClick={openSettings}
              tabIndex={screen === "home" ? 0 : -1}
              aria-label="打开设置"
            >
              <span className="ui-icon ui-icon-settings" aria-hidden="true" />
              <span>设置</span>
              <small>天空</small>
            </button>
          </div>

          <div className="lobby-brand" aria-label={`纵跃，最佳成绩 ${best}`}>
            <span>{gameMode === "duel" ? "TWO PLAYER RACE" : "ROOFTOP ASCENT"}</span>
            <h2>{gameMode === "duel" ? "双人竞速" : "纵跃"}</h2>
            <div>
              <small>最佳</small>
              <strong>{String(best).padStart(2, "0")}</strong>
            </div>
          </div>

          <div className="lobby-play-hint" aria-hidden="true">
            <span className="lobby-touch-dot" />
            <div>
              <strong>
                {gameMode === "duel"
                  ? duelLobbyJoined
                    ? duelStatusLabel[duelStatus]
                    : "创建一场双人比赛"
                  : "拖动角色直接开始"}
              </strong>
              <span>
                {gameMode === "duel"
                  ? duelLobbyJoined
                    ? "匹配成功后自动倒计时"
                    : "朋友点邀请链接即可加入"
                  : "向后拉 · 松手起跳"}
              </span>
            </div>
          </div>

          {gameMode === "duel" && !duelLobbyJoined && (
            <div className="duel-room-entry" aria-label="创建双人比赛">
              <span>PRIVATE DUEL</span>
              <strong>发一个链接，就能开赛</strong>
              <p>系统会自动创建独立比赛并复制邀请；朋友点开链接后直接加入。</p>
              <button type="button" onClick={createDuelRoom}>
                创建比赛并复制邀请
              </button>
              <small>无需账号 · 无需输入房间号</small>
            </div>
          )}

          {gameMode === "duel" && duelLobbyJoined && (
            <div className={`duel-lobby-status duel-status-${duelStatus}`} role="status">
              <span className="duel-status-dot" />
              <div>
                <strong>{duelStatusLabel[duelStatus]}</strong>
                <small>免费网页中继 · 跨 Wi-Fi / 蜂窝网络</small>
              </div>
              <span className="duel-room-code">私人邀请赛</span>
              <button type="button" onClick={copyDuelInvite}>
                {duelInviteCopied ? "已复制" : "复制邀请"}
              </button>
            </div>
          )}

          <nav className="mode-dock" aria-label="玩法选择">
            <button
              className={`mode-card ${gameMode === "solo" ? "mode-active" : ""}`}
              type="button"
              aria-current={gameMode === "solo" ? "page" : undefined}
              onClick={() => chooseMode("solo")}
            >
              <span className="ui-icon ui-icon-ascent" aria-hidden="true" />
              <strong>攀升</strong>
              <small>单人无尽</small>
            </button>
            <button
              className={`mode-card ${gameMode === "duel" ? "mode-active" : ""}`}
              type="button"
              aria-current={gameMode === "duel" ? "page" : undefined}
              onClick={() => chooseMode("duel")}
            >
              <span className="ui-icon ui-icon-duel" aria-hidden="true" />
              <strong>双人</strong>
              <small>生存竞速</small>
            </button>
            <button className="mode-card" type="button" disabled>
              <span className="ui-icon ui-icon-challenge" aria-hidden="true" />
              <strong>挑战</strong>
              <small>即将开放</small>
            </button>
          </nav>
        </div>

        {screen === "settings" && (
          <div className="settings-screen" aria-label="游戏设置">
            <div className="settings-header">
              <button
                className="back-button"
                type="button"
                onClick={closeSettings}
              >
                返回
              </button>
              <div>
                <span>SETTINGS</span>
                <h2>选择天空</h2>
              </div>
            </div>

            <div className="theme-grid" role="radiogroup" aria-label="背景主题">
              {backgroundOptions.map((option) => (
                <button
                  className={`theme-card ${backgroundTheme === option.id ? "theme-selected" : ""}`}
                  type="button"
                  role="radio"
                  aria-checked={backgroundTheme === option.id}
                  key={option.id}
                  onClick={() => selectBackground(option.id)}
                >
                  <span className={`theme-preview preview-${option.id}`} aria-hidden="true">
                    <span />
                  </span>
                  <strong>{option.label}</strong>
                  <small>{option.caption}</small>
                </button>
              ))}
            </div>

            <div className="settings-row">
              <div>
                <strong>舒适音效</strong>
                <span>蓄力、起跳与落点反馈</span>
              </div>
              <button
                className={`toggle-button ${soundOn ? "toggle-on" : ""}`}
                type="button"
                role="switch"
                aria-checked={soundOn}
                onClick={toggleSound}
              >
                <span />
              </button>
            </div>
          </div>
        )}

        {screen === "characters" && (
          <div className="character-screen" aria-label="角色选择">
            <div className="settings-header">
              <button className="back-button" type="button" onClick={closeCharacters}>
                返回
              </button>
              <div>
                <span>RUNNER SELECT</span>
                <h2>选择角色</h2>
              </div>
            </div>
            <div className="character-grid">
              <button
                className={`character-card ${selectedCharacter === "runner" ? "character-selected" : ""}`}
                type="button"
                onClick={() => chooseCharacter("runner")}
              >
                <span className="character-portrait portrait-runner" aria-hidden="true">
                  <i className="portrait-head" />
                  <i className="portrait-body" />
                </span>
                <span>
                  <strong>跃者</strong>
                  <small>质量 1.0 · 灵巧基准</small>
                </span>
              </button>
              <button
                className={`character-card ${selectedCharacter === "heavy" ? "character-selected" : ""}`}
                type="button"
                onClick={() => chooseCharacter("heavy")}
              >
                <span className="character-portrait portrait-heavy" aria-hidden="true">
                  <i className="portrait-head" />
                  <i className="portrait-body" />
                  <i className="portrait-shoulders" />
                </span>
                <span>
                  <strong>重装</strong>
                  <small>质量 1.65 · 宽肩抗撞</small>
                </span>
              </button>
            </div>
            <p className="character-note">
              体重只影响角色碰撞反应；跳跃曲线保持一致，避免角色强度破坏手感。
            </p>
          </div>
        )}

        <div className="frame-grain" />
      </section>

      <aside className="control-panel" aria-label="操作说明">
        <div className="control-index">01</div>
        <h2>反向拖拽</h2>
        <p>想往左前方跳，就向右后方拉。拖得越远，跳得越远。</p>
        <div className="control-divider" />
        <div className="control-index">02</div>
        <h2>前方有路</h2>
        <p>镜头始终保留连续路线，让你提前观察方向。中心落点可获得双倍分数。</p>
      </aside>
    </main>
  );
}
