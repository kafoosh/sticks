// What reaches the screen: the camera picture, with one flat "layer" laid onto the page in
// it. The layer is an ordinary 2D canvas drawn in page ("stage") coordinates; a shader
// bends it through the tracked camera motion so it sits on the paper in perspective.

import { MAX_STEP } from './paper.js';

const VERT = `#version 300 es
in vec2 aPos;
uniform vec2 uUV0, uUV1;
out vec2 vUV;
void main() {
  vUV = mix(uUV0, uUV1, aPos * 0.5 + 0.5);
  gl_Position = vec4(aPos.x, -aPos.y, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uVideo, uLayer, uOffsets, uCover;
uniform vec2 uVideoSize;
uniform mat3 uToStage;      // video pixels -> stage (homogeneous)
uniform mat3 uFromStage;    // stage -> video pixels
uniform vec2 uStageSize;
uniform vec4 uPatch;        // the erase map's rectangle on the stage: x, y, w, h
uniform float uCell;        // stage units per erase-map cell
uniform float uErase;       // 0 = leave the real drawing, 1 = cover it
uniform float uLayerOn;
out vec4 color;

vec3 paperAt(vec2 stage) {
  vec3 q = uFromStage * vec3(stage, 1.0);
  return texture(uVideo, q.xy / q.z / uVideoSize).rgb;
}

void main() {
  vec3 base = texture(uVideo, vUV).rgb;
  if (uLayerOn > 0.5) {
    vec3 q = uToStage * vec3(vUV * uVideoSize, 1.0);
    vec2 stage = q.xy / q.z;
    vec2 uv = stage / uStageSize;
    if (q.z > 0.0 && uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
      // Cover the real ink with real paper copied from either side of the line.
      vec2 pu = (stage - uPatch.xy) / uPatch.zw;
      if (uErase > 0.0 && pu.x > 0.0 && pu.y > 0.0 && pu.x < 1.0 && pu.y < 1.0) {
        vec4 cov = texture(uCover, pu);
        if (cov.r > 0.004) {
          vec4 off = (texture(uOffsets, pu) * 255.0 - 128.0) / 127.0 * ${MAX_STEP}.0 * uCell;
          vec3 fill = mix(paperAt(stage + off.zw), paperAt(stage + off.xy), cov.g);
          base = mix(base, fill, cov.r * uErase);
        }
      }
      vec4 over = texture(uLayer, uv);
      base = over.rgb + base * (1.0 - over.a);
    }
  }
  color = vec4(base, 1.0);
}`;

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const n of ['uUV0', 'uUV1', 'uVideo', 'uLayer', 'uOffsets', 'uCover', 'uVideoSize', 'uToStage', 'uFromStage', 'uStageSize', 'uPatch', 'uCell', 'uErase', 'uLayerOn']) this.u[n] = gl.getUniformLocation(prog, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit, mip, nearest = false) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      if (nearest) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      return t;
    };
    this.videoTex = tex(0, false);
    this.layerTex = tex(1, true);
    gl.uniform1i(this.u.uVideo, 0);
    this.offsetsTex = tex(2, false, true);          // offsets must not be blended between cells
    this.coverTex = tex(3, false);
    gl.uniform1i(this.u.uLayer, 1);
    gl.uniform1i(this.u.uOffsets, 2);
    gl.uniform1i(this.u.uCover, 3);
  }

  /// Size the canvas to its box. Returns the part of the video that is visible (the video
  /// fills the screen, cropped), as { x0, y0, x1, y1 } in 0…1 of the video.
  fit(videoW, videoH) {
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const s = Math.max(W / videoW, H / videoH);
    const fx = W / (videoW * s), fy = H / (videoH * s);
    this.view = { x0: (1 - fx) / 2, y0: (1 - fy) / 2, x1: (1 + fx) / 2, y1: (1 + fy) / 2, scale: s };
    return this.view;
  }

  /// Hand over the erase map (see paper.js) for the figure now on stage.
  setEraser(eraser) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.offsetsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, eraser.w, eraser.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, eraser.offsets);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.coverTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, eraser.w, eraser.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, eraser.cover);
    gl.uniform4f(this.u.uPatch, eraser.rect.x, eraser.rect.y, eraser.rect.w, eraser.rect.h);
    gl.uniform1f(this.u.uCell, eraser.cell);
  }

  /// `scene`: null draws the camera alone; otherwise { toStage, fromStage (3×3 row-major,
  /// between video pixels and stage units), stage: {w, h}, erase: 0…1 }.
  draw(video, videoW, videoH, layerCanvas, scene) {
    const gl = this.gl, v = this.fit(videoW, videoH);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    if (scene) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.layerTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layerCanvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      const cm = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];   // row-major → GL column-major
      gl.uniformMatrix3fv(this.u.uToStage, false, cm(scene.toStage));
      gl.uniformMatrix3fv(this.u.uFromStage, false, cm(scene.fromStage));
      gl.uniform2f(this.u.uStageSize, scene.stage.w, scene.stage.h);
      gl.uniform1f(this.u.uErase, scene.erase);
    }
    gl.uniform1f(this.u.uLayerOn, scene ? 1 : 0);
    gl.uniform2f(this.u.uVideoSize, videoW, videoH);
    gl.uniform2f(this.u.uUV0, v.x0, v.y0);
    gl.uniform2f(this.u.uUV1, v.x1, v.y1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
