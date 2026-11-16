# Graphics

Three.js/WebGL2, custom GLSL, instanced points/lines, worker network generation and shared resources form the renderer. WebGPU is not implemented. Neural activity, particle movement, matrix glyphs and globe arcs are visual simulations. System metrics displayed by monitoring panels come from the actual host; the two are distinct.

One shared drawing buffer is copied into module canvases for correct DOM overlap. Each view owns camera and postprocessing (bloom/afterimage/output). Visibility, view limits, throttling and profile caps constrain work. Adaptive quality changes resolution/geometry; diagnostics show effective quality, draw counts and timings. CPU-side render time is not a GPU timer measurement.

Camera modes include orbit/manual/close-up/fly-through where supported. Drag to rotate and wheel to zoom; the editor exposes camera settings. High connection density and postprocessing can dominate frame time even on discrete GPUs. Prefer fewer simultaneous views, lower resolution and bloom before lowering terminal responsiveness.

Context loss triggers rebuilding. Without WebGL2, terminal and DOM monitoring remain available and visualization modules report the failure. No fake animation substitutes for a failed graphics context. ENCOM Globe+ retains the original land grid and wire aesthetic; no external geolocation request is made.
