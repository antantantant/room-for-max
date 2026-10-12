// Rendering pipeline: an HDR, post-processed WebGL setup tuned for integrated GPUs.
//
//   scene -> MSAA half-float target -> GTAO (half res) -> bloom (half res)
//         -> ACES tone mapping -> SMAA -> screen
//
// What keeps it light on a MacBook Air:
//   - the canvas never exceeds a fixed pixel budget, whatever the display density
//   - the shadow map is rendered once (the scene is static)
//   - frames are drawn only while the camera is moving
//   - if frames run slow anyway, quality steps down on its own
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

const PIXEL_BUDGET = 2.5e6;   // most pixels the canvas may have
const SLOW_FRAME_MS = 26;     // sustained frame time that triggers a quality step down

// Renders the scene into its own multisampled HDR target (with a stencil buffer,
// which the window "portals" need), then copies the result into the composer chain.
class ScenePass extends Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true, stencilBuffer: true });
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { t: { value: this.rt.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      // clamp runaway highlights so one hot pixel cannot smear across the bloom
      fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ vec4 c = texture2D(t, vUv); gl_FragColor = vec4(min(c.rgb, vec3(24.)), 1.); }',
      depthTest: false, depthWrite: false,
    }));
  }
  setSize(w, h) { this.rt.setSize(w, h); }
  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(readBuffer);
    this.copy.render(renderer);
  }
  dispose() { this.rt.dispose(); this.copy.dispose(); }
}

export function createPipeline(scene, camera) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;        // static scene: bake the shadow map once
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.transmissionResolutionScale = 0.5;   // the glass refraction buffer can be coarse
  document.body.appendChild(renderer.domElement);

  let ratioCap = 2;
  const pickRatio = () => THREE.MathUtils.clamp(
    Math.min(devicePixelRatio, ratioCap, Math.sqrt(PIXEL_BUDGET / (innerWidth * innerHeight))), 1, 2);
  let ratio = pickRatio();

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  composer.addPass(new ScenePass(scene, camera, ratio >= 1.5 ? 2 : 4));

  // Ambient occlusion at half resolution. Some objects (glass, the view outside,
  // light shafts) must not occlude, so they are hidden while it gathers depth.
  const hideFromAO = [];
  const ao = new GTAOPass(scene, camera, 1, 1);
  ao.updateGtaoMaterial({ radius: 0.4, distanceExponent: 1.4, thickness: 1.1, distanceFallOff: 1, scale: 1.15, samples: 12 });
  ao.updatePdMaterial({ radius: 6, rings: 2, samples: 12, lumaPhi: 10, depthPhi: 2, normalPhi: 3 });
  const aoSetSize = ao.setSize.bind(ao), aoRender = ao.render.bind(ao);
  ao.setSize = (w, h) => aoSetSize(Math.ceil(w / 2), Math.ceil(h / 2));
  ao.render = (...args) => {
    const was = hideFromAO.map(o => o.visible);
    hideFromAO.forEach(o => { o.visible = false; });
    try { aoRender(...args); } finally { hideFromAO.forEach((o, i) => { o.visible = was[i]; }); }
  };
  composer.addPass(ao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.38, 0.6, 1.0);
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.ceil(w / 2), Math.ceil(h / 2));
  composer.addPass(bloom);

  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass());

  function resize() {
    ratio = pickRatio();
    renderer.setPixelRatio(ratio);
    renderer.setSize(innerWidth, innerHeight);
    composer.setPixelRatio(ratio);
    composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    invalidate();
  }

  // Quality ladder, taken one rung at a time when frames stay slow.
  function stepDown() {
    if (ratio > 1) { ratioCap = Math.max(1, ratio - 0.25); resize(); }
    else if (ao.enabled) { ao.enabled = false; invalidate(); }
    else if (renderer.transmissionResolutionScale > 0.25) { renderer.transmissionResolutionScale = 0.25; invalidate(); }
  }

  // Render on demand: `invalidate()` asks for a few frames, then the loop idles.
  let pending = 4, streak = 0, last = 0, ema = 16;
  function invalidate(frames = 2) { pending = Math.max(pending, frames); }

  function start(update) {
    const frame = t => {
      requestAnimationFrame(frame);
      update();
      if (pending <= 0) { streak = 0; return; }
      pending--;
      renderer.info.reset();
      composer.render();
      if (streak++ > 0 && t - last < 250) {     // ignore gaps from a hidden or sleeping tab
        ema += (t - last - ema) * 0.1;
        if (streak > 40 && ema > SLOW_FRAME_MS) { stepDown(); streak = 0; ema = 16; }
      }
      last = t;
    };
    requestAnimationFrame(frame);
  }

  addEventListener('resize', resize);
  resize();

  // handy when checking performance from the console
  window.__stats = () => ({ ratio, ao: ao.enabled, frameMs: +ema.toFixed(1), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });

  // __bench(60) draws 60 frames back to back and returns the average cost of one, in ms
  window.__bench = (frames = 60) => {
    const gl = renderer.getContext(), t0 = performance.now();
    for (let i = 0; i < frames; i++) { renderer.info.reset(); composer.render(); }
    gl.finish();
    return +((performance.now() - t0) / frames).toFixed(2);
  };

  return { renderer, hideFromAO, invalidate, start };
}
