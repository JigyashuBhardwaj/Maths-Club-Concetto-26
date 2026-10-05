/**
 * WebGL "liquid form" background — ported unchanged (shader, timings, scale) from the
 * supplied Mathematics Club Portal prototype.
 *
 *  - renders below native resolution (0.62, or 0.5 on screens ≤ 640px)
 *  - pointer parallax is exposed as --px / --py on `stage` (read by the logo layers)
 *  - pauses while the tab is hidden
 *  - prefers-reduced-motion: draws a single static frame (t = 14)
 *  - any WebGL failure calls `onFallback` so the CSS gradient takes over
 */

const VERTEX_SHADER = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.03+vec2(7.1,3.7); a*=.5; } return v; }
float H(vec2 p){
  float t = uTime;
  float w  = fbm(p*1.15 + vec2(t*.030, -t*.022));
  float w2 = fbm(p*1.5  - vec2(t*.040,  t*.028) + w*1.2);
  vec2 c = vec2(0., -1.08);
  float d = length((p-c)*vec2(.62, 1.));
  float dome = 1. - smoothstep(.12, 1.22, d + (w-.5)*.5);
  return dome*(.82 + .34*w2);
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - .5) * vec2(uRes.x/uRes.y, 1.) * 2.;
  float asp = uRes.x/uRes.y;
  p *= (asp < .8) ? 1.0 + (.8-asp)*.9 : 1.;       /* keep the form large on portrait screens */
  p += uMouse * vec2(.05, .035);

  float h = H(p);
  float e = .006;
  float gx = (H(p+vec2(e,0.)) - H(p-vec2(e,0.))) / (2.*e);
  float gy = (H(p+vec2(0.,e)) - H(p-vec2(0.,e))) / (2.*e);
  vec3 n = normalize(vec3(-gx*.42, -gy*.42, 1.));
  float mask = smoothstep(.012, .09, h);

  vec3 orange = vec3(1., .40, .09);
  vec3 col = vec3(.014,.014,.02);

  /* ambient haze behind the form */
  float hz = exp(-length((p-vec2(0.,-.55))*vec2(.55,.95))*2.1);
  col += vec3(.42,.13,.03)*hz*.28;
  col += vec3(.05,.07,.11)*exp(-length(p-vec2(-.9,.7))*1.6)*.55;

  /* body of the form: dark glass with rim + contour light */
  float fres = pow(1.-n.z, 2.3);
  float edge = smoothstep(.0,.2,h) * (1.-smoothstep(.2,.65,h));
  vec3 L = normalize(vec3(.55,.7,.55));
  float spec = pow(max(dot(n,L),0.), 22.);
  vec3 body = vec3(.012,.012,.018)
            + orange*(fres*2.1 + edge*.30)
            + vec3(1.,.82,.66)*spec*.30;
  float cl = 1. - smoothstep(0., .09, abs(sin(h*34. + fbm(p*2.)*3.)));
  body += orange*cl*.13*smoothstep(.04,.3,h);
  col = mix(col, body, mask);

  /* stars */
  vec2 sp = vec2(uv.x*asp, uv.y)*34.;
  vec2 id = floor(sp); float r = hash(id);
  if (r > .978) {
    vec2 q = fract(sp) - .5 - (vec2(hash(id+3.1), hash(id+7.7)) - .5)*.55;
    float tw = .55 + .45*sin(uTime*(.5+r*1.8) + r*60.);
    col += vec3(1.,.9,.8)*smoothstep(.07,0.,length(q))*tw*.55*(1.-mask)*smoothstep(.0,.4,uv.y);
  }

  float vg = smoothstep(1.7,.25,length(p*vec2(.78,1.)));
  col *= mix(.55, 1., vg);
  col += (hash(gl_FragCoord.xy + fract(uTime)) - .5)/180.;   /* dither: no banding */
  gl_FragColor = vec4(col, 1.);
}`;

const START_CLOCK = 14;

export interface LiquidBackgroundOptions {
  /** Element that receives the --px / --py parallax custom properties. */
  stage: HTMLElement;
  /** Called when WebGL is unavailable, fails to link, or the context is lost. */
  onFallback: () => void;
}

/** Starts the background. Returns a disposer that stops it and releases every listener. */
export function startLiquidBackground(
  canvas: HTMLCanvasElement,
  { stage, onFallback }: LiquidBackgroundOptions,
): () => void {
  const gl = canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    powerPreference: "low-power",
  });
  if (!gl) {
    onFallback();
    return () => {};
  }

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };

  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!program || !vs || !fs) {
    onFallback();
    return () => {};
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    onFallback();
    return () => {};
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(program, "uRes");
  const uTime = gl.getUniformLocation(program, "uTime");
  const uMouse = gl.getUniformLocation(program, "uMouse");

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const small = matchMedia("(max-width: 640px)");

  let mx = 0;
  let my = 0;
  let tx = 0;
  let ty = 0;
  let raf = 0;
  let last = performance.now();
  let clock = START_CLOCK;

  function draw(t: number) {
    gl!.uniform1f(uTime, t);
    gl!.uniform2f(uMouse, mx, my);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  function resize() {
    // Render below native resolution: smooth field, cheap on the GPU.
    const scale = small.matches ? 0.5 : 0.62;
    const w = Math.max(2, Math.round(innerWidth * scale));
    const h = Math.max(2, Math.round(innerHeight * scale));
    canvas.width = w;
    canvas.height = h;
    gl!.viewport(0, 0, w, h);
    gl!.uniform2f(uRes, w, h);
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    mx += (tx - mx) * Math.min(1, dt * 2.2);
    my += (ty - my) * Math.min(1, dt * 2.2);
    stage.style.setProperty("--px", mx.toFixed(3));
    stage.style.setProperty("--py", (-my).toFixed(3));
    draw(clock);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    cancelAnimationFrame(raf);
    last = performance.now();
    if (reduce.matches) draw(START_CLOCK);
    else raf = requestAnimationFrame(frame);
  }

  const onResize = () => {
    resize();
    if (reduce.matches) draw(START_CLOCK);
  };
  const onPointerMove = (e: PointerEvent) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = -((e.clientY / innerHeight) * 2 - 1);
  };
  const onVisibility = () => (document.hidden ? cancelAnimationFrame(raf) : start());
  const onContextLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    onFallback();
  };

  resize();
  addEventListener("resize", onResize);
  addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  reduce.addEventListener("change", start);
  canvas.addEventListener("webglcontextlost", onContextLost);
  start();

  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", onResize);
    removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("visibilitychange", onVisibility);
    reduce.removeEventListener("change", start);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    // The context is deliberately not force-lost: React StrictMode re-runs effects on the same
    // canvas in development, and a lost context cannot be reused. The browser reclaims it on GC.
  };
}
