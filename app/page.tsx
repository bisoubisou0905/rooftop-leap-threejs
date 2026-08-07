"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

type GamePhase = "idle" | "charging" | "flying" | "falling" | "failed";
type PlatformShape = "rect" | "circle" | "hex";
type AppScreen = "home" | "game" | "settings";
type BackgroundTheme = "night" | "dawn" | "violet" | "teal";

type Platform = {
  id: number;
  group: THREE.Group;
  x: number;
  z: number;
  topY: number;
  width: number;
  depth: number;
  shaftWidth: number;
  shaftDepth: number;
  shape: PlatformShape;
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

function createRunner(gradientMap: THREE.Texture) {
  const runner = new THREE.Group();
  const visual = new THREE.Group();
  visual.name = "runner-visual";
  runner.add(visual);

  const coral = new THREE.MeshToonMaterial({
    color: 0xff5d3b,
    gradientMap,
  });
  const coralLight = new THREE.MeshToonMaterial({
    color: 0xff8562,
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
    new THREE.CapsuleGeometry(0.205, 0.43, 6, 12),
    coral,
  );
  torso.position.y = 1.0;
  torso.scale.set(0.96, 1, 0.78);
  torso.castShadow = true;
  visual.add(torso);
  outlinedMeshes.push(torso);

  const jacketHem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.225, 0.205, 0.15, 10),
    coralLight,
  );
  jacketHem.position.y = 0.69;
  jacketHem.castShadow = true;
  visual.add(jacketHem);
  outlinedMeshes.push(jacketHem);

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.15, 0.235), ink);
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
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), cream);
    tip.position.set(side * 0.061, 1.175, 0.184);
    visual.add(tip);
  });

  const makeArm = (
    name: string,
    forearmName: string,
    side: -1 | 1,
  ) => {
    const arm = new THREE.Group();
    arm.name = name;
    arm.position.set(side * 0.225, 1.2, 0);
    arm.rotation.z = side * 0.14;
    const upperSleeve = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.052, 0.22, 5, 9),
      coral,
    );
    upperSleeve.position.y = -0.135;

    const forearm = new THREE.Group();
    forearm.name = forearmName;
    forearm.position.y = -0.27;
    const lowerSleeve = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.047, 0.18, 5, 9),
      coral,
    );
    lowerSleeve.position.y = -0.115;
    const cuff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.052, 0.07, 8),
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
    leg.position.set(side * 0.095, 0.66, 0);
    const thigh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.058, 0.22, 5, 9),
      ink,
    );
    thigh.position.y = -0.13;

    const calf = new THREE.Group();
    calf.name = calfName;
    calf.position.y = -0.28;
    const shin = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.052, 0.21, 5, 9),
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

  const plasticShine = new THREE.MeshBasicMaterial({
    color: 0xffd2ba,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  });
  const hoodShine = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 10, 8),
    plasticShine,
  );
  hoodShine.position.set(-0.1, 0.055, -0.258);
  hoodShine.scale.set(0.55, 1.05, 0.14);
  headRig.add(hoodShine);
  const jacketShine = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, 0.26, 0.016),
    plasticShine,
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
  spec: Omit<Platform, "group" | "shaftWidth" | "shaftDepth">,
  scene: THREE.Scene,
  gradientMap: THREE.Texture,
) {
  const color = palette[spec.id % palette.length];
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

  const shaftHeight = 12 + seededNoise(spec.id + 44) * 7;
  const shaftWidth = spec.width * (spec.shape === "rect" ? 0.88 : 0.91);
  const shaftDepth = spec.depth * (spec.shape === "rect" ? 0.88 : 0.91);
  let roof: THREE.Mesh;
  let rim: THREE.Mesh;
  let shaft: THREE.Mesh;

  if (spec.shape === "circle" || spec.shape === "hex") {
    const segments = spec.shape === "circle" ? 28 : 6;
    const radius = spec.width / 2;
    shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(
        radius * 0.91,
        radius * 0.98,
        shaftHeight,
        segments,
      ),
      sideMaterial,
    );
    roof = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.16, segments),
      roofMaterial,
    );
    rim = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.045, radius * 1.045, 0.08, segments),
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

  const edgeTrim = new THREE.Group();
  if (spec.shape === "rect") {
    const edgeDepth = 0.018;
    const edgeHeight = 0.014;
    const horizontal = new THREE.BoxGeometry(spec.width * 0.78, edgeHeight, edgeDepth);
    const vertical = new THREE.BoxGeometry(edgeDepth, edgeHeight, spec.depth * 0.74);
    [-1, 1].forEach((side) => {
      const frontBack = new THREE.Mesh(horizontal, seamMaterial);
      frontBack.position.set(0, 0.008, side * spec.depth * 0.38);
      edgeTrim.add(frontBack);
      const leftRight = new THREE.Mesh(vertical, seamMaterial);
      leftRight.position.set(side * spec.width * 0.39, 0.008, 0);
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
    ring.position.y = 0.008;
    ring.rotation.x = Math.PI / 2;
    edgeTrim.add(ring);
  }
  group.add(edgeTrim);

  const roofInset = new THREE.Mesh(
    spec.shape === "rect"
      ? new THREE.PlaneGeometry(spec.width * 0.62, spec.depth * 0.58)
      : new THREE.CircleGeometry(spec.width * 0.3, spec.shape === "hex" ? 6 : 24),
    new THREE.MeshBasicMaterial({
      color: color.rim,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  roofInset.rotation.x = -Math.PI / 2;
  roofInset.position.y = 0.004;
  group.add(roofInset);

  const bandCount = 2;
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

  const panelCount = spec.shape === "rect" ? 3 : 2;
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
  halo.position.y = 0.012;
  group.add(halo);

  group.visible = true;

  scene.add(group);
  return { ...spec, group, shaftWidth, shaftDepth } satisfies Platform;
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
      const buildingTop = -4.15 + seededNoise(seed + 8) * 0.72;
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
  return group;
}

function pointOnPlatform(platform: Platform, x: number, z: number) {
  const dx = x - platform.x;
  const dz = z - platform.z;
  // A small invisible forgiveness margin makes edge landings feel intentional
  // without changing the visible rooftop size.
  const inset = -0.07;
  if (platform.shape === "rect") {
    return (
      Math.abs(dx) <= platform.width / 2 - inset &&
      Math.abs(dz) <= platform.depth / 2 - inset
    );
  }
  const radius = platform.width / 2 - inset;
  return dx * dx + dz * dz <= radius * radius;
}

type SideCollision = {
  x: number;
  z: number;
  normalX: number;
  normalZ: number;
};

function resolveFootprintCollision(
  platform: Platform,
  x: number,
  z: number,
  radius: number,
  velocityX: number,
  velocityZ: number,
  width = platform.shaftWidth,
  depth = platform.shaftDepth,
): SideCollision | null {
  const dx = x - platform.x;
  const dz = z - platform.z;

  if (platform.shape !== "rect") {
    const solidRadius = width / 2;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance >= solidRadius + radius) return null;
    let normalX = distance > 0.0001 ? dx / distance : -Math.sign(velocityX);
    let normalZ = distance > 0.0001 ? dz / distance : -Math.sign(velocityZ);
    if (Math.abs(normalX) + Math.abs(normalZ) < 0.001) normalZ = -1;
    const normalLength = Math.sqrt(normalX * normalX + normalZ * normalZ);
    normalX /= normalLength;
    normalZ /= normalLength;
    return {
      x: platform.x + normalX * (solidRadius + radius),
      z: platform.z + normalZ * (solidRadius + radius),
      normalX,
      normalZ,
    };
  }

  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const closestX = clamp(dx, -halfWidth, halfWidth);
  const closestZ = clamp(dz, -halfDepth, halfDepth);
  const cornerX = dx - closestX;
  const cornerZ = dz - closestZ;
  const cornerDistance = Math.sqrt(cornerX * cornerX + cornerZ * cornerZ);

  if (cornerDistance > 0.0001) {
    if (cornerDistance >= radius) return null;
    const normalX = cornerX / cornerDistance;
    const normalZ = cornerZ / cornerDistance;
    return {
      x: platform.x + closestX + normalX * radius,
      z: platform.z + closestZ + normalZ * radius,
      normalX,
      normalZ,
    };
  }

  const exitX = halfWidth - Math.abs(dx);
  const exitZ = halfDepth - Math.abs(dz);
  if (exitX < exitZ) {
    const normalX = Math.sign(dx) || (velocityX >= 0 ? -1 : 1);
    return {
      x: platform.x + normalX * (halfWidth + radius),
      z,
      normalX,
      normalZ: 0,
    };
  }
  const normalZ = Math.sign(dz) || (velocityZ >= 0 ? -1 : 1);
  return {
    x,
    z: platform.z + normalZ * (halfDepth + radius),
    normalX: 0,
    normalZ,
  };
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null);
  const restartRef = useRef<() => void>(() => undefined);
  const soundRef = useRef(true);
  const screenRef = useRef<AppScreen>("home");
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [notice, setNotice] = useState("");
  const [hasJumped, setHasJumped] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [backgroundTheme, setBackgroundTheme] =
    useState<BackgroundTheme>("night");

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("rooftop-leap-theme");
    if (isBackgroundTheme(savedTheme)) setBackgroundTheme(savedTheme);
  }, []);

  const selectBackground = useCallback((theme: BackgroundTheme) => {
    setBackgroundTheme(theme);
    window.localStorage.setItem("rooftop-leap-theme", theme);
  }, []);

  const startGame = useCallback(() => {
    restartRef.current();
    setHasJumped(false);
    setScreen("game");
  }, []);

  const returnHome = useCallback(() => {
    restartRef.current();
    setHasJumped(false);
    setScreen("home");
  }, []);

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
    let charge = 0;
    let targetDirection = new THREE.Vector3(0, 0, 1);
    let launchPlatformId = 0;
    let platforms: Platform[] = [];
    let currentPlatform!: Platform;
    let particles: Particle[] = [];
    let landingSquash = 0;
    let cameraKick = 0;
    let elapsed = 0;
    let fallElapsed = 0;
    let fallReferenceY = 0;
    let fallSpin = 1;
    let fallPlatform: Platform | null = null;
    let fallHasWallContact = false;

    setBest(bestValue);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b2137, 0.036);

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
    const city = createCity(scene);
    const runner = createRunner(toonGradient);
    scene.add(runner);
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

    const makeNextPlatform = (from: Platform, id: number) => {
      const difficulty = Math.min(id / 30, 1);
      const shapeRoll = seededNoise(id * 4.31);
      const shape: PlatformShape =
        id < 2 ? "rect" : shapeRoll > 0.72 ? "circle" : shapeRoll > 0.5 ? "hex" : "rect";
      const size = 1.52 - difficulty * 0.18 + seededNoise(id + 8) * 0.2;
      const width = shape === "rect" ? size : size * 0.96;
      const depth = shape === "rect" ? size * (0.84 + seededNoise(id + 12) * 0.16) : width;
      const distanceRoll = seededNoise(id * 8.73 + 18);
      let gap: number;
      if (id === 1) {
        gap = 1.08;
      } else if (id === 2) {
        gap = 1.46;
      } else {
        const distanceTier = id % 6;
        if (distanceTier === 0 || distanceTier === 3) {
          gap = 0.9 + distanceRoll * 0.42;
        } else if (distanceTier === 1 || distanceTier === 5) {
          gap = 1.68 + distanceRoll * 0.58 + difficulty * 0.12;
        } else {
          gap = 2.72 + distanceRoll * 0.78 + difficulty * 0.22;
        }
      }
      const z = from.z + from.depth / 2 + gap + depth / 2;
      const lateralRoll = seededNoise(id * 5.17 + 30);
      let x: number;
      if (id === 1) {
        x = 0.2;
      } else {
        const lanePattern = [0, 0.2, -0.95, 0.45, 1.25, 0.15, -1.15, -0.35, 1.05];
        const laneTarget =
          lanePattern[((id - 1) % (lanePattern.length - 1)) + 1] +
          (lateralRoll - 0.5) * 0.16;
        const maxStep = gap > 2.5 ? 1.72 : gap > 1.5 ? 1.5 : 1.35;
        x = clamp(
          from.x + clamp(laneTarget - from.x, -maxStep, maxStep),
          -2.05,
          2.05,
        );
      }
      const topY = clamp(
        from.topY + (seededNoise(id + 60) - 0.5) * 0.34,
        -0.36,
        0.52,
      );
      return createPlatform(
        { id, x, z, topY, width, depth, shape },
        scene,
        toonGradient,
      );
    };

    const spawnLandingParticles = (platform: Platform, perfect: boolean) => {
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
        mesh.position.set(runner.position.x, platform.topY + 0.05, runner.position.z);
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
      let tail = platforms.reduce(
        (furthest, platform) => platform.id > furthest.id ? platform : furthest,
        from,
      );
      while (
        tail.id < from.id + lookAheadCount ||
        tail.z < from.z + lookAheadDistance
      ) {
        const next = makeNextPlatform(tail, tail.id + 1);
        platforms.push(next);
        tail = next;
      }
      return platforms
        .filter((platform) => platform.id > from.id)
        .sort((a, b) => a.id - b.id);
    };

    const updatePathFocus = (snap = false) => {
      const upcoming = platforms
        .filter((platform) => platform.id > currentPlatform.id)
        .sort((a, b) => a.id - b.id);
      const next = upcoming[0];
      if (!next) return;
      const second = upcoming[1] ?? next;
      const third = upcoming[2] ?? second;
      const routeX = next.x * 0.62 + second.x * 0.26 + third.x * 0.12;
      const cameraLookAhead = clamp(
        (second.z - currentPlatform.z) * 0.34,
        2.05,
        3.55,
      );
      desiredFocus.set(
        THREE.MathUtils.lerp(currentPlatform.x, routeX, 0.38),
        0,
        currentPlatform.z + cameraLookAhead,
      );
      if (snap) focus.copy(desiredFocus);
    };

    const setInternalPhase = (next: GamePhase) => {
      gamePhase = next;
      setPhase(next);
    };

    const resetPlatforms = () => {
      platforms.forEach((platform) => {
        scene.remove(platform.group);
        disposeObject(platform.group);
      });
      platforms = [];
      currentPlatform = createPlatform(
        {
          id: 0,
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
      ensurePathAhead(currentPlatform);
    };

    const restart = () => {
      resetPlatforms();
      scoreValue = 0;
      setScore(0);
      setNotice("");
      runner.position.set(currentPlatform.x, currentPlatform.topY + 0.01, currentPlatform.z);
      runner.rotation.set(0, 0, 0);
      runner.visible = true;
      runnerVisual.position.set(0, 0, 0);
      runnerVisual.rotation.set(0, 0, 0);
      runnerVisual.scale.set(1, 1, 1);
      headRig.rotation.set(0, 0, 0);
      leftArm.position.set(-0.225, 1.2, 0);
      leftArm.rotation.set(0, 0, -0.14);
      rightArm.position.set(0.225, 1.2, 0);
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
      velocity.set(0, 0, 0);
      launchPlatformId = currentPlatform.id;
      charge = 0;
      fallElapsed = 0;
      fallPlatform = null;
      fallHasWallContact = false;
      chargeMaterial.opacity = 0;
      updatePathFocus(true);
      setInternalPhase("idle");
    };
    restartRef.current = restart;

    const fail = () => {
      if (gamePhase === "failed") return;
      setInternalPhase("failed");
      bestValue = Math.max(bestValue, scoreValue);
      setBest(bestValue);
      window.localStorage.setItem("rooftop-leap-best", String(bestValue));
      playSound("fail");
      if (navigator.vibrate) navigator.vibrate([35, 40, 80]);
    };

    const applySideCollision = (
      collision: SideCollision,
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
      fallSpin =
        Math.abs(collision.normalX) > 0.16
          ? -Math.sign(collision.normalX)
          : Math.sign(collision.normalZ) || 1;
    };

    const beginFall = (platform: Platform) => {
      if (gamePhase !== "flying") return;
      setInternalPhase("falling");
      fallElapsed = 0;
      fallReferenceY = platform.topY;
      fallPlatform = platform;
      fallHasWallContact = false;
      fallSpin = velocity.x >= 0 ? -1 : 1;

      const edgeCollision = resolveFootprintCollision(
        platform,
        runner.position.x,
        runner.position.z,
        0.19,
        velocity.x,
        velocity.z,
        platform.width,
        platform.depth,
      );
      if (edgeCollision) {
        applySideCollision(edgeCollision, 0.38, 1.05);
        runner.position.y = platform.topY + 0.015;
        velocity.y = -1.35;
        runnerVisual.rotation.z = -fallSpin * 0.42;
        cameraKick = 0.2;
        spawnMissParticles(platform);
        playSound("scrape");
        if (navigator.vibrate) navigator.vibrate([28, 24, 38]);
      } else {
        velocity.y = Math.min(velocity.y, -1.8);
        playSound("miss");
      }
    };

    const landBack = (platform: Platform) => {
      runner.position.y = platform.topY + 0.01;
      velocity.set(0, 0, 0);
      fallPlatform = null;
      landingSquash = 0.62;
      cameraKick = 0.08;
      flashNotice("差一点，再来");
      playSound("land");
      setInternalPhase("idle");
    };

    const land = (platform: Platform) => {
      runner.position.y = platform.topY + 0.01;
      velocity.set(0, 0, 0);
      fallPlatform = null;
      const dx = runner.position.x - platform.x;
      const dz = runner.position.z - platform.z;
      const normalizedDistance =
        Math.sqrt(dx * dx + dz * dz) / Math.max(0.5, platform.width / 2);
      const perfect = normalizedDistance < 0.24;
      scoreValue += perfect ? 2 : 1;
      setScore(scoreValue);
      bestValue = Math.max(bestValue, scoreValue);
      setBest(bestValue);
      window.localStorage.setItem("rooftop-leap-best", String(bestValue));
      flashNotice(perfect ? "完美落点  +2" : "+1");
      spawnLandingParticles(platform, perfect);
      landingSquash = 1;
      cameraKick = perfect ? 0.24 : 0.13;
      playSound(perfect ? "perfect" : "land");
      if (navigator.vibrate) navigator.vibrate(perfect ? [18, 28, 20] : 18);

      currentPlatform = platform;
      launchPlatformId = platform.id;
      setInternalPhase("idle");
      ensurePathAhead(currentPlatform);
      updatePathFocus();
      const landedPlatformId = currentPlatform.id;
      window.setTimeout(() => {
        if (destroyed) return;
        platforms
          .filter((candidate) => candidate.id < landedPlatformId)
          .forEach(removePlatform);
      }, 220);
    };

    const startJump = () => {
      if (charge < 0.025) {
        charge = 0;
        chargeMaterial.opacity = 0;
        runnerVisual.scale.set(1, 1, 1);
        runnerVisual.position.z = 0;
        setInternalPhase("idle");
        return;
      }
      const speed = 2.85 + charge * 3.45;
      const lift = 4.65 + charge * 1.35;
      velocity.set(targetDirection.x * speed, lift, targetDirection.z * speed);
      fallPlatform = null;
      launchPlatformId = currentPlatform.id;
      setInternalPhase("flying");
      setHasJumped(true);
      chargeMaterial.opacity = 0;
      runnerVisual.scale.set(1, 1, 1);
      runnerVisual.position.z = 0;
      playSound("jump", charge);
    };

    const updateCharge = () => {
      // Camera screen-right maps to world -X. Using the drag delta here keeps
      // the visible jump direction opposite to the player's pull direction.
      const pullX = dragCurrent.x - dragStart.x;
      const actualPullForward = Math.max(0, dragCurrent.y - dragStart.y);
      const pullForward = Math.max(22, actualPullForward);
      const rawDistance = Math.sqrt(
        pullX * pullX + actualPullForward * actualPullForward,
      );
      const linearCharge = clamp((rawDistance - 18) / 170, 0, 1);
      const easedCharge =
        linearCharge * linearCharge * (3 - 2 * linearCharge);
      charge = Math.pow(easedCharge, 1.15);
      targetDirection.set(pullX * 0.66, 0, pullForward).normalize();
      runner.rotation.y = Math.atan2(targetDirection.x, targetDirection.z);
      runnerVisual.scale.set(1 + charge * 0.035, 1 - charge * 0.17, 1 + charge * 0.035);
      runnerVisual.position.z = -charge * 0.14;
      runnerVisual.rotation.x = charge * 0.16;
      runnerVisual.rotation.z = -targetDirection.x * charge * 0.11;
      headRig.rotation.x = -charge * 0.1;
      headRig.rotation.z = targetDirection.x * charge * 0.08;
      leftArm.rotation.x = -charge * 0.56;
      rightArm.rotation.x = -charge * 0.56;
      leftForearm.rotation.x = charge * 0.48;
      rightForearm.rotation.x = charge * 0.48;
      leftLeg.rotation.z = -charge * 0.18;
      rightLeg.rotation.z = charge * 0.18;
      leftCalf.rotation.x = charge * 0.24;
      rightCalf.rotation.x = charge * 0.24;
      chargeMaterial.opacity = 0.12 + charge * 0.42;
      chargeGlow.scale.set(0.82 + charge * 0.34, 1 + charge * 1.3, 1);
      chargeGlow.position.z = charge * 0.18;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (screenRef.current !== "game" || gamePhase !== "idle") return;
      event.preventDefault();
      activePointer = event.pointerId;
      dragStart = { x: event.clientX, y: event.clientY };
      dragCurrent = { ...dragStart };
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
    runner.position.set(currentPlatform.x, currentPlatform.topY + 0.01, currentPlatform.z);

    const clock = new THREE.Clock();
    let animationFrame = 0;
    const animate = () => {
      if (destroyed) return;
      animationFrame = window.requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.035);
      elapsed += dt;

      if (gamePhase === "flying") {
        const previousY = runner.position.y;
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

        if (velocity.y <= 0) {
          const landingPlatform = platforms.find(
            (platform) =>
              previousY >= platform.topY &&
              runner.position.y <= platform.topY &&
              pointOnPlatform(platform, runner.position.x, runner.position.z),
          );
          if (landingPlatform) {
            if (landingPlatform.id === launchPlatformId) landBack(landingPlatform);
            else land(landingPlatform);
          } else {
            const missedPlatform = platforms.find(
              (platform) =>
                platform.id === launchPlatformId + 1 &&
                previousY >= platform.topY &&
                runner.position.y <= platform.topY,
            );
            if (missedPlatform) beginFall(missedPlatform);
          }
        }
        if (gamePhase === "flying" && (
          runner.position.y < currentPlatform.topY - 6.5 ||
          runner.position.z < currentPlatform.z - 4
        )) {
          const targetPlatform = platforms.find(
            (platform) => platform.id === launchPlatformId + 1,
          );
          if (targetPlatform) beginFall(targetPlatform);
          else fail();
        }
      } else if (gamePhase === "falling") {
        fallElapsed += dt;
        velocity.y -= 14.8 * dt;
        runner.position.addScaledVector(velocity, dt);
        if (
          fallPlatform &&
          !fallHasWallContact &&
          runner.position.y < fallPlatform.topY - 0.08 &&
          runner.position.y > fallPlatform.topY - 5.4
        ) {
          const wallCollision = resolveFootprintCollision(
            fallPlatform,
            runner.position.x,
            runner.position.z,
            0.18,
            velocity.x,
            velocity.z,
          );
          if (wallCollision) {
            applySideCollision(wallCollision, 0.44, 0.82);
            velocity.y = Math.min(velocity.y, -1.55);
            fallHasWallContact = true;
            cameraKick = Math.max(cameraKick, 0.16);
            spawnMissParticles(fallPlatform, runner.position.y + 0.34);
            playSound("scrape");
            if (navigator.vibrate) navigator.vibrate(24);
          }
        }
        const tumble = elapsed * 15.5;
        runnerVisual.position.y = Math.sin(tumble * 0.7) * 0.025;
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
        runnerVisual.position.y = Math.sin(elapsed * 2.8) * 0.018;
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
        runnerVisual.position.y -= bounce * 0.055;
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
      camera.position.set(focus.x + kick * 0.1, 8.9 + kick * 0.055, focus.z - 7.1);
      camera.lookAt(focus.x, -0.1, focus.z + 2.15);
      sun.position.set(focus.x - 5, 12, focus.z - 5);
      sunTarget.position.set(focus.x, 0, focus.z + 2.2);
      rimLight.position.set(focus.x + 2, 4.5, focus.z + 1.5);
      coolRim.position.set(focus.x - 2.4, 3.8, focus.z + 3.2);
      // The city is an atmospheric backdrop, so it follows the camera
      // continuously. Snapping it by one block made the whole skyline jump
      // after every landing.
      city.position.x = focus.x;
      city.position.z = focus.z;

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      destroyed = true;
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
  }, []);

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
        <div className="skyline-layer" aria-hidden="true">
          <span className="skyline-far" />
          <span className="skyline-near" />
        </div>
        <div className="cloud-layer" aria-hidden="true" />
        <div className="top-haze" />

        {screen === "game" && (
          <header className="hud">
            <div className="hud-brand">
              <span className="hud-mark">纵跃</span>
              <span className="hud-sub">ROOFTOP RUN</span>
            </div>
            <div className="score-block" aria-label={`当前分数 ${score}`}>
              <span className="score-label">高度</span>
              <strong>{String(score).padStart(2, "0")}</strong>
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

        {screen === "game" && (
          <div
            className={`gesture-hint ${!hasJumped && phase !== "failed" ? "hint-visible" : ""}`}
          >
            <span className="gesture-dot" />
            <div>
              <strong>按住，向后拖</strong>
              <span>松手起跳</span>
            </div>
          </div>
        )}

        {screen === "game" && (
          <div className="best-chip">最佳 {String(best).padStart(2, "0")}</div>
        )}

        {screen === "game" && phase === "failed" && (
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

        {screen === "home" && (
          <div className="menu-screen" aria-label="游戏主页">
            <div className="menu-kicker">ABOVE THE CITY</div>
            <div className="menu-title-block">
              <h2>纵跃</h2>
              <p>把城市留在脚下，向前跳。</p>
            </div>
            <div className="menu-stats" aria-label={`最佳成绩 ${best}`}>
              <span>最佳高度</span>
              <strong>{String(best).padStart(2, "0")}</strong>
            </div>
            <div className="menu-actions">
              <button className="primary-button" type="button" onClick={startGame}>
                开始游戏
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setScreen("settings")}
              >
                设置与背景
              </button>
            </div>
            <span className="menu-footnote">反向拖拽 · 松手起跳</span>
          </div>
        )}

        {screen === "settings" && (
          <div className="settings-screen" aria-label="游戏设置">
            <div className="settings-header">
              <button
                className="back-button"
                type="button"
                onClick={() => setScreen("home")}
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
