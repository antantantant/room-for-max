# Apartment Room for Max

A 3D model of a Tuscan-styled bedroom at sunrise, built from a pencil sketch with [three.js](https://threejs.org).

Furniture positions are measured off the floor plan in the sketch and scaled by assuming the bed is 2.0 m long, which makes the room about 4.2 m × 2.6 m. The wall with two windows faces east. Colours and materials are a Tuscan interpretation, since the sketch is in pencil.

## Running it

Serve the folder with any static server (for example `python3 -m http.server`) and open `index.html`. Drag to rotate, scroll to zoom. There is no build step; three.js loads from a CDN.

## How it renders

- `index.html` — page, camera and orbit controls.
- `src/scene.js` — the room: geometry, procedural textures, sunrise lighting and the landscape outside.
- `src/pipeline.js` — the renderer and post-processing chain.

The pipeline is HDR throughout: the scene is drawn into a multisampled half-float target, then passes through ambient occlusion (GTAO, half resolution), bloom (half resolution), ACES tone mapping and SMAA.

The low sun is the only shadow-casting light. Walls and ceiling block it, so it enters through the windows alone. Window panes are bevelled glass with real transmission, so the landscape bends at the bevels.

To stay smooth on integrated GPUs such as a MacBook Air:

- the canvas is capped at 2.5 million pixels regardless of display density;
- the shadow map is rendered once, because nothing moves;
- meshes that share a material are merged into one, and leaves are instanced;
- frames are drawn only while the camera is moving;
- if frames still run slow, resolution and then ambient occlusion step down automatically.

In the browser console, `__stats()` reports the current quality level and draw calls, and `__bench(60)` times 60 frames.
