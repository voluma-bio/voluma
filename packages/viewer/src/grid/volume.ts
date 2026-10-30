/**
 * The 3D pane's volume rendering of the grid's image: one whole level as a 3D texture, ray-marched
 * front to back with gradient lighting. Rays stop at the depth of the opaque meshes, rendered
 * first into `meshDepth`, so a structure inside the bone shows where it is.
 */
import {
  BackSide,
  BoxGeometry,
  Color,
  CustomBlending,
  Data3DTexture,
  type DepthTexture,
  GLSL3,
  LinearFilter,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
} from "three";
import type { Contrast } from "./compose";
import type { AssetLevel, Zyx } from "./scene";

/** About 16 M voxels: a level the browser fetches and uploads in a few seconds. */
const MAX_VOXELS = 2 ** 24;

/** The finest level small enough to hold whole, else the coarsest. */
export function volumeLevel(levels: readonly AssetLevel[]): number {
  const fits = levels.findIndex((l) => l.shapeZyx[0] * l.shapeZyx[1] * l.shapeZyx[2] <= MAX_VOXELS);
  return fits < 0 ? levels.length - 1 : fits;
}

/** The level's values between the contrast limits as bytes, C order (x fastest). */
export function volumeBytes(values: ArrayLike<number>, contrast: Contrast): Uint8Array {
  const out = new Uint8Array(values.length);
  const span = contrast.high - contrast.low || 1;
  for (let i = 0; i < values.length; i++) {
    const v = ((values[i]! - contrast.low) / span) * 255;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/**
 * A box over the level's extent in the grid's mm (source voxel i centred on i, level voxel j
 * spanning [j·s − ½, (j+1)·s − ½)), drawing `bytes`.
 */
export function volumeMesh(
  bytes: Uint8Array,
  level: AssetLevel,
  spacingZyx: Zyx,
  color: string,
  meshDepth: DepthTexture,
): Mesh<BoxGeometry, ShaderMaterial> {
  const [nz, ny, nx] = level.shapeZyx;
  const texture = new Data3DTexture(bytes, nx, ny, nz);
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      volume: { value: texture },
      meshDepth: { value: meshDepth },
      resolution: { value: new Vector2(1, 1) },
      near: { value: 0.01 },
      far: { value: 1000 },
      cameraLocal: { value: new Vector3() },
      localToView: { value: new Matrix4() },
      texelSize: { value: new Vector3(1 / nx, 1 / ny, 1 / nz) },
      steps: { value: Math.min(768, Math.ceil(Math.hypot(nx, ny, nz) * 1.5)) },
      tint: { value: new Color(color) },
    },
    vertexShader,
    fragmentShader,
    side: BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  const [sz, sy, sx] = spacingZyx;
  const [kz, ky, kx] = level.scaleZyx;
  const size = new Vector3(nx * kx * sx, ny * ky * sy, nz * kz * sz);
  mesh.scale.copy(size);
  mesh.position.set(-0.5 * sx, -0.5 * sy, -0.5 * sz).addScaledVector(size, 0.5);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

const vertexShader = /* glsl */ `
out vec3 vPosition;
void main() {
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Positions are in the unit box's own space, [-0.5, 0.5]; texture coordinates are position + 0.5.
const fragmentShader = /* glsl */ `
#include <packing>
precision highp float;
precision highp sampler3D;
in vec3 vPosition;
out vec4 outColor;
uniform sampler3D volume;
uniform sampler2D meshDepth;
uniform vec2 resolution;
uniform float near;
uniform float far;
uniform vec3 cameraLocal;
uniform mat4 localToView;
uniform vec3 texelSize;
uniform int steps;
uniform vec3 tint;

float density(vec3 p) { return texture(volume, p + 0.5).r; }

void main() {
  vec3 dir = normalize(vPosition - cameraLocal);
  vec3 inv = 1.0 / dir;
  vec3 t0 = (vec3(-0.5) - cameraLocal) * inv;
  vec3 t1 = (vec3(0.5) - cameraLocal) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tnear = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
  float tfar = min(min(tmax.x, tmax.y), tmax.z);
  if (tfar <= tnear) discard;

  // Stop where an opaque mesh is: compare view-space depths, linear along the ray.
  float meshZ = perspectiveDepthToViewZ(texture(meshDepth, gl_FragCoord.xy / resolution).r, near, far);
  float zNear = (localToView * vec4(cameraLocal + dir * tnear, 1.0)).z;
  float zFar = (localToView * vec4(cameraLocal + dir * tfar, 1.0)).z;
  // A mesh in front of the box hides all of it here.
  if (meshZ >= zNear) discard;
  if (meshZ > zFar) tfar = tnear + (tfar - tnear) * (zNear - meshZ) / (zNear - zFar);

  float dt = (tfar - tnear) / float(steps);
  // Opacity per step is for a step of one texel across the box.
  float unit = length(texelSize);
  vec3 lightDir = normalize(-dir + vec3(0.2, 0.3, 0.0));
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 1024; i++) {
    if (i >= steps || acc.a > 0.97) break;
    vec3 p = cameraLocal + dir * (tnear + (float(i) + 0.5) * dt);
    float v = density(p);
    float a = smoothstep(0.22, 0.6, v);
    if (a <= 0.0) continue;
    vec3 g = vec3(
      density(p + vec3(texelSize.x, 0, 0)) - density(p - vec3(texelSize.x, 0, 0)),
      density(p + vec3(0, texelSize.y, 0)) - density(p - vec3(0, texelSize.y, 0)),
      density(p + vec3(0, 0, texelSize.z)) - density(p - vec3(0, 0, texelSize.z))
    );
    float light = 0.45;
    if (length(g) > 1e-4) light += 0.75 * abs(dot(normalize(g), lightDir));
    a = 1.0 - pow(1.0 - a * 0.6, dt / unit);
    acc.rgb += (1.0 - acc.a) * a * tint * light;
    acc.a += (1.0 - acc.a) * a;
  }
  if (acc.a <= 0.0) discard;
  // The canvas is sRGB and this shader writes it directly; premultiplied in and out.
  outColor = vec4(pow(acc.rgb / acc.a, vec3(1.0 / 2.2)) * acc.a, acc.a);
}`;
