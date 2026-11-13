/**
 * GLSL ES 3.00 shaders. Conventions:
 *  - geometry is given in target pixels with a top-left origin;
 *  - texture coordinates have (0,0) at the image's top-left;
 *  - fragment outputs are premultiplied (blend ONE, ONE_MINUS_SRC_ALPHA).
 */

export const QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;     // x, y, w, h in target pixels
uniform vec2 uTarget;   // target size in pixels
uniform float uFlipY;   // 1 for the canvas, 0 for offscreen targets
out vec2 vLocal;        // pixels from the rect's top-left
out vec2 vUnit;         // 0..1 inside the rect
void main() {
  vec2 p = uRect.xy + aPos * uRect.zw;
  vLocal = aPos * uRect.zw;
  vUnit = aPos;
  vec2 clip = (p / uTarget) * 2.0 - 1.0;
  clip.y = mix(clip.y, -clip.y, uFlipY);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const COMMON = /* glsl */ `
float sdRoundBox(vec2 p, vec2 b, float r, float n) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  vec2 qq = max(q, 0.0);
  float corner = qq.x + qq.y > 0.0 ? pow(pow(qq.x, n) + pow(qq.y, n), 1.0 / n) : 0.0;
  return corner + min(max(q.x, q.y), 0.0) - r;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Abramowitz–Stegun style erf approximation.
float erfApprox(float x) {
  float s = sign(x);
  float a = 0.147;
  float x2 = x * x;
  return s * sqrt(1.0 - exp(-x2 * (1.2732395 + a * x2) / (1.0 + a * x2)));
}
`;

export const LAYER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vUnit;
uniform sampler2D uTex;
uniform vec4 uUV;          // u0, v0, du, dv (du < 0 mirrors)
uniform vec2 uSize;
uniform float uRadius;
uniform float uExp;
uniform float uBorder;
uniform vec4 uBorderColor; // premultiplied
uniform float uOpacity;
out vec4 outColor;
${COMMON}
void main() {
  vec2 halfSize = uSize * 0.5;
  float d = sdRoundBox(vLocal - halfSize, halfSize, uRadius, uExp);
  float mask = 1.0 - smoothstep(-0.75, 0.75, d);
  vec2 uv = uUV.xy + vUnit * uUV.zw;
  vec4 c = texture(uTex, uv);
  c = vec4(c.rgb * c.a, c.a);
  if (uBorder > 0.0) {
    float inner = 1.0 - smoothstep(-uBorder - 0.75, -uBorder + 0.75, d);
    c = mix(uBorderColor, c, inner);
  }
  outColor = c * mask * uOpacity;
}`;

export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
uniform vec4 uShape;       // shape rect inside the drawn rect: x, y, w, h
uniform float uRadius;
uniform float uExp;
uniform float uBlur;
uniform float uOpacity;
out vec4 outColor;
${COMMON}
void main() {
  vec2 halfSize = uShape.zw * 0.5;
  float d = sdRoundBox(vLocal - uShape.xy - halfSize, halfSize, uRadius, uExp);
  float sigma = max(uBlur * 0.5, 0.5);
  float a = 0.5 * (1.0 - erfApprox(d / (sigma * 1.41421356)));
  outColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
}`;

export const SHAPE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
uniform vec2 uSize;
uniform float uRadius;
uniform vec4 uColor;       // premultiplied
uniform float uRing;       // > 0: draw a ring of this thickness instead of a fill
out vec4 outColor;
${COMMON}
void main() {
  vec2 halfSize = uSize * 0.5;
  float d = sdRoundBox(vLocal - halfSize, halfSize, uRadius, 2.0);
  float a = uRing > 0.0
    ? 1.0 - smoothstep(uRing * 0.5 - 0.75, uRing * 0.5 + 0.75, abs(d + uRing * 0.5))
    : 1.0 - smoothstep(-0.75, 0.75, d);
  outColor = uColor * a;
}`;

export const BACKGROUND_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vUnit;
uniform int uKind;         // 0 solid, 1 gradient, 2 aurora, 3 image
uniform vec2 uSize;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform float uAngle;      // degrees
uniform float uSeed;
uniform float uGrain;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform float uLod;
out vec4 outColor;
${COMMON}
vec2 blobCenter(float i) {
  return vec2(hash12(vec2(uSeed * 7.13, i * 3.7)), hash12(vec2(i * 5.1, uSeed * 1.91))) * 1.2 - 0.1;
}
void main() {
  vec3 col = uC0;
  if (uKind == 1) {
    float a = radians(uAngle);
    vec2 dir = vec2(sin(a), -cos(a));
    vec2 p = vUnit - 0.5;
    p.x *= uSize.x / uSize.y;
    float t = clamp(dot(p, dir) / (0.5 * (abs(dir.x) * uSize.x / uSize.y + abs(dir.y))) * 0.5 + 0.5, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    col = mix(uC0, uC1, t);
  } else if (uKind == 2) {
    float aspect = uSize.x / uSize.y;
    vec2 p = vec2(vUnit.x * aspect, vUnit.y);
    col = uC0;
    vec3 tints[3] = vec3[3](uC1, uC2, uC3);
    float radii[3] = float[3](0.85, 0.6, 0.42);
    for (int i = 0; i < 3; i++) {
      vec2 c = blobCenter(float(i));
      c.x *= aspect;
      vec2 d = p - c;
      float w = exp(-dot(d, d) / (radii[i] * radii[i]));
      col = mix(col, tints[i], w * (i == 2 ? 0.55 : 0.8));
    }
    // Soft light falloff from the top for depth.
    col *= mix(0.82, 1.06, 1.0 - vUnit.y * 0.7);
    col += (hash12(vLocal * 0.5 + uSeed) - 0.5) * uGrain;
  } else if (uKind == 3) {
    float canvasAspect = uSize.x / uSize.y;
    float texAspect = uTexSize.x / max(uTexSize.y, 1.0);
    vec2 uv = vUnit;
    if (texAspect > canvasAspect) {
      float s = canvasAspect / texAspect;
      uv.x = 0.5 + (uv.x - 0.5) * s;
    } else {
      float s = texAspect / canvasAspect;
      uv.y = 0.5 + (uv.y - 0.5) * s;
    }
    col = textureLod(uTex, uv, uLod).rgb;
  }
  // Triangular dither (±1 LSB) keeps gradients free of banding after encoding.
  float n = hash12(vLocal + 17.0) + hash12(vLocal.yx + 41.0) - 1.0;
  col += n / 255.0;
  outColor = vec4(col, 1.0);
}`;

/**
 * Magnifier lens. Reads the (already privacy-filtered) screen texture with a magnified uv
 * mapping, never outside the recorded area, and adds a faint rim shade and a border.
 */
export const MAGNIFIER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
uniform sampler2D uTex;
uniform vec2 uUV0;         // texture uv at the lens's top-left pixel
uniform vec2 uUVPerPx;     // texture uv step per canvas pixel
uniform vec4 uBounds;      // readable uv range: u0, v0, u1, v1
uniform vec2 uSize;
uniform float uRadius;
uniform float uBorder;
uniform vec4 uBorderColor; // premultiplied
uniform float uOpacity;
out vec4 outColor;
${COMMON}
void main() {
  vec2 halfSize = uSize * 0.5;
  float d = sdRoundBox(vLocal - halfSize, halfSize, uRadius, 2.0);
  float mask = 1.0 - smoothstep(-0.75, 0.75, d);
  vec2 uv = clamp(uUV0 + vLocal * uUVPerPx, uBounds.xy, uBounds.zw);
  vec4 c = texture(uTex, uv);
  c = vec4(c.rgb * c.a, c.a);
  float rim = smoothstep(-0.3 * min(halfSize.x, halfSize.y), 0.0, d);
  c.rgb *= 1.0 - 0.12 * rim;
  if (uBorder > 0.0) {
    float inner = 1.0 - smoothstep(-uBorder - 0.75, -uBorder + 0.75, d);
    c = mix(uBorderColor, c, inner);
  }
  outColor = c * mask * uOpacity;
}`;

/** Separable Gaussian blur (one direction per pass) using linear-filtered taps. */
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUnit;
uniform sampler2D uTex;
uniform vec2 uDir;         // texel step in uv units, already scaled by radius
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUnit) * 0.2270270270;
  c += texture(uTex, vUnit + uDir * 1.3846153846) * 0.3162162162;
  c += texture(uTex, vUnit - uDir * 1.3846153846) * 0.3162162162;
  c += texture(uTex, vUnit + uDir * 3.2307692308) * 0.0702702703;
  c += texture(uTex, vUnit - uDir * 3.2307692308) * 0.0702702703;
  outColor = c;
}`;

/**
 * Privacy effects applied in screen-source space. For 'frosted' only pixels OUTSIDE
 * the region are sampled, so the output carries no information from inside it.
 */
export const PRIVACY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vUnit;
uniform int uMode;          // 1 solid, 2 pixelate, 3 blur, 4 frosted
uniform sampler2D uSrc;     // full-resolution source
uniform sampler2D uBlur;    // blurred low-resolution source
uniform vec2 uSrcSize;      // pixels
uniform vec4 uRegion;       // region rect in source pixels
uniform float uRadius;
uniform vec4 uColor;        // premultiplied, for solid
uniform float uBlock;       // pixelate block size in pixels
out vec4 outColor;
${COMMON}
vec3 srcAt(vec2 px) { return texture(uSrc, px / uSrcSize).rgb; }
void main() {
  vec2 halfSize = uRegion.zw * 0.5;
  float d = sdRoundBox(vLocal - halfSize, halfSize, uRadius, 2.0);
  float mask = 1.0 - smoothstep(-0.75, 0.75, d);
  vec2 px = uRegion.xy + vLocal;
  vec3 col;
  if (uMode == 1) {
    outColor = uColor * mask;
    return;
  } else if (uMode == 2) {
    vec2 cell = floor((px - uRegion.xy) / uBlock);
    vec2 origin = uRegion.xy + cell * uBlock;
    vec2 cellSize = min(vec2(uBlock), uRegion.xy + uRegion.zw - origin);
    vec3 acc = vec3(0.0);
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 4; x++) {
        acc += srcAt(origin + (vec2(float(x), float(y)) + 0.5) * cellSize / 4.0);
      }
    }
    col = acc / 16.0;
  } else if (uMode == 3) {
    col = texture(uBlur, px / uSrcSize).rgb;
  } else {
    // Frosted glass. The fill is a smooth colour field interpolated from many points on a
    // ring just OUTSIDE the region; every sample is itself averaged along the ring so
    // outside text does not streak inwards. No pixel inside the region is ever read.
    float m = 6.0 + 0.04 * max(uRegion.z, uRegion.w);
    float soft = 0.45 * min(uRegion.z, uRegion.w) + 8.0;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int side = 0; side < 4; side++) {
      // side 0: top, 1: bottom, 2: left, 3: right
      bool horizontal = side < 2;
      float len = horizontal ? uRegion.z : uRegion.w;
      vec2 outward = side == 0 ? vec2(0.0, -1.0) : side == 1 ? vec2(0.0, 1.0) : side == 2 ? vec2(-1.0, 0.0) : vec2(1.0, 0.0);
      vec2 tangent = horizontal ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec2 origin = side == 0 ? vec2(uRegion.x, uRegion.y - m)
        : side == 1 ? vec2(uRegion.x, uRegion.y + uRegion.w + m)
        : side == 2 ? vec2(uRegion.x - m, uRegion.y)
        : vec2(uRegion.x + uRegion.z + m, uRegion.y);
      // Skip a side that would fall outside the frame (clamping could read inside pixels).
      vec2 far = origin + outward * 6.0;
      if (far.x < 0.0 || far.y < 0.0 || far.x > uSrcSize.x || far.y > uSrcSize.y) continue;
      float stepT = len / 14.0;
      for (int i = 0; i < 14; i++) {
        vec2 p = origin + tangent * (float(i) + 0.5) * stepT;
        vec3 c = vec3(0.0);
        for (int k = -1; k <= 1; k++) {
          for (int j = 0; j < 2; j++) {
            c += srcAt(p + tangent * float(k) * stepT * 0.33 + outward * float(j) * 4.0);
          }
        }
        c /= 6.0;
        float d = distance(px, p);
        float w = 1.0 / (d * d + soft * soft);
        acc += c * w;
        wsum += w;
      }
    }
    col = wsum > 0.0 ? acc / wsum : vec3(0.55);
    // Glass look: slightly desaturated, lifted, with a soft top light, fine grain and a hairline rim.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(luma), 0.18);
    col = mix(col, vec3(1.0), 0.12 + 0.06 * (1.0 - vUnit.y));
    col += (hash12(px) - 0.5) * 0.018;
    float rim = 1.0 - smoothstep(-2.0, -0.5, d);
    col = mix(col, vec3(1.0), (1.0 - rim) * 0.22);
  }
  outColor = vec4(col, 1.0) * mask;
}`;
