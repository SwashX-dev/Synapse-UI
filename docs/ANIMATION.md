# Animation and capture

Select a visualization module before opening Ctrl+Shift+A. Choose a preset, edit engine-specific parameters, camera, seed and playback. Save a new preset or duplicate one, and import/export JSON. Presets select an engine and parameter map; `src/shared/manifest.ts` defines the format.

Optional timeline: duration, loop, tracks with param and keys `{t,v,ease}`. Easing supports linear, smooth, step, in, out. Bindings map numeric metric sources using inMin/inMax/outMin/outMax and optional smoothing. Expressions use the safe parser in `src/shared/expression.ts`, never eval. Validate expressions in the editor; not every structural parameter can animate without a rebuild.

Audio uses user-selected files or explicitly enabled microphone capture; permission denial is surfaced. Bands/amplitude/beat can drive bindings. System audio is platform-dependent and may be unavailable.

Capture selects resolution, rate, duration and quality. PNG screenshots, image sequences, WebM and GIF are supported; offline MP4/WebM encoding needs ffmpeg on PATH. A failed encoder preserves PNG frames and reports the error. Long high-resolution sequences can use substantial disk and RAM. Capture records the visualization, not terminal credentials or the whole desktop.
