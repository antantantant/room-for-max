# Apartment Room for Max

A 3D model of a Tuscan-styled bedroom, built from a pencil sketch with [three.js](https://threejs.org). Press **Begin the sunrise** and the room goes from dark, one minute before the sun comes up, to full morning light, with a breeze through the open window and music.

The sun follows the path it takes at Tuscany's latitude (about 0.18° a minute upwards, drifting south). Real time is slow, so it plays at 20× by default; the buttons at the bottom left switch between real time, 20× and 60×, pause, restart, and mute.

The room sits high in a building on the cliff edge of a hilltop town. The east windows look out over the valley far below, under drifting clouds; the south window looks across a lane at the neighbours' roofs and the bell tower.

Furniture positions are measured off the floor plan in the sketch and scaled by assuming the bed is 2.0 m long, which makes the room about 4.2 m × 2.6 m. The wall with two windows faces east. Colours and materials are a Tuscan interpretation, since the sketch is in pencil.

## Running it

Serve the folder with any static server (for example `python3 -m http.server`) and open `index.html`. Drag to rotate, scroll to zoom. There is no build step; three.js loads from a CDN.

## How it renders

- `index.html` — page, camera and orbit controls.
- `src/scene.js` — the room: geometry, procedural textures, sunrise lighting and the landscape outside.
- `src/pipeline.js` — the renderer and post-processing chain.
- `src/audio.js` — the music, birdsong and wind, synthesised live with Web Audio (no audio files).

The pipeline is HDR throughout: the scene is drawn into a multisampled half-float target, then passes through ambient occlusion (GTAO, half resolution), volumetric sunbeams (half resolution), bloom (half resolution), ACES tone mapping and SMAA.

The sunbeams are computed, not painted: each view ray is walked through the room and tested against a depth map rendered once from the sun, so the beams take the shape of the window bars and whatever stands in them.

Soft things (duvet, pillows, sofa, the stuffed hippo) wear a coat of fibres drawn as stacked shells, one draw call per material. The duvet is a generated quilted surface draped over the bed.

The low sun is the only shadow-casting light. Walls and ceiling block it, so it enters through the windows alone. Window panes are bevelled glass with real transmission, so the landscape bends at the bevels.

To stay smooth on integrated GPUs such as a MacBook Air:

- the canvas is capped at 2.5 million pixels regardless of display density;
- the shadow map and the beams' depth map are redrawn on alternate frames while the sunrise plays, and not at all while paused;
- meshes that share a material are merged into one, and leaves are instanced;
- while paused, frames are drawn only when the camera moves;
- if frames still run slow, resolution and then ambient occlusion step down automatically.

In the browser console, `__stats()` reports the current quality level and draw calls, `__bench(60)` times 60 frames, `__look([x, y, z], [x, y, z])` aims the camera, and `__at(12)` jumps to twelve minutes after sunrise.
