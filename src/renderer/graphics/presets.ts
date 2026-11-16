/**
 * Built-in animation presets, distributed across 15 rendering engines.
 * Presets on the same engine differ in algorithm/mode, not just colors.
 */
import type { Preset } from '../../shared/manifest';

type P = Omit<Preset, 'builtin' | 'description'> & { description: string };
const p = (x: P): Preset => ({ ...x, builtin: true });

export const BUILTIN_PRESETS: Preset[] = [
  // ───────────────────────── neural ─────────────────────────
  p({ id: 'neural-sphere', name: 'Neural Sphere', engine: 'neural-sphere', category: 'neural', camera: 'orbital', description: 'Flagship: tens of thousands of fine strands on a small-world spherical network with propagating impulses.', params: {} }),
  p({ id: 'neural-cortex', name: 'Neural Sphere · Cortex', engine: 'neural-sphere', category: 'neural', camera: 'microscopic', description: 'Dense, thin cortical shell explored from inside: extreme close-up of the strand structure.', params: { algorithm: 'knn', shell: 0.04, degree: 8, clustering: 0.8, curvature: 0.28, lineAlpha: 0.075, streaks: 0.35, particles: 0.35, rate: 0.008 } }),
  p({ id: 'synaptic-storm', name: 'Synaptic Storm', engine: 'neural-sphere', category: 'neural', camera: 'orbital', description: 'High-frequency activity: scale-free hubs, fast impulses and long trails sweeping an enormous web.', params: { algorithm: 'scale-free', degree: 8, rate: 0.025, propagation: 0.7, pulseSpeed: 1.35, bursts: 2.2, refractory: 0.8, trails: 0.75, streaks: 0.9, particles: 0.8, lineAlpha: 0.04, brightness: 0.75 } }),
  p({ id: 'artificial-consciousness', name: 'Artificial Consciousness', engine: 'neural-sphere', category: 'neural', camera: 'cinematic', description: 'ARTISTIC simulation of an interconnected processing network: modular communities, slow global waves, constant reorganisation. It does not model or imply a conscious system.', params: { algorithm: 'modular', clustering: 0.92, shell: 0.65, wave: 0.22, rate: 0.006, propagation: 0.6, breathing: 0.65, curvature: 0.95, streaks: 0.45 } }),
  p({ id: 'neural-pulse', name: 'Neural Pulse', engine: 'neural-sphere', category: 'neural', camera: 'macro', description: 'Synchronised plane waves of activity sweep through a great-circle network.', params: { algorithm: 'great-circle', degree: 5, shell: 0, wave: 0.9, rate: 0.0008, propagation: 0.15, pulseSpeed: 0.9, trails: 0.75, streaks: 0.9 } }),
  p({ id: 'audio-neural', name: 'Audio-Reactive Neural Network', engine: 'neural-sphere', category: 'neural', camera: 'orbital', description: 'Bass drives firing, mids drive propagation, treble drives impulse speed; beats ignite hub cascades. Select an audio source in Settings → Audio.', params: { audioReactive: true, audioGain: 2, rate: 0.004, propagation: 0.45, streaks: 1.0 } }),
  p({ id: 'neural-genesis', name: 'Neural Genesis', engine: 'neural-graph', category: 'neural', camera: 'orbital', description: 'Procedurally growing neural arbours that branch, extend and interconnect, regrowing with a new seed each cycle.', params: { mode: 'genesis' } }),
  p({ id: 'neural-galaxy', name: 'Neural Galaxy', engine: 'neural-graph', category: 'neural', camera: 'macro', description: 'Interconnected clusters arranged along logarithmic spiral arms with a dense core.', params: { mode: 'galaxy' } }),
  p({ id: 'network-evolution', name: 'Network Evolution', engine: 'neural-graph', category: 'neural', camera: 'orbital', description: 'A force-directed graph that rewires itself by preferential attachment and triadic closure.', params: { mode: 'evolution' } }),

  // ───────────────────────── scientific ─────────────────────────
  p({ id: 'quantum-field', name: 'Quantum Field', engine: 'particles', category: 'scientific', camera: 'orbital', description: 'ARTISTIC particle field advected by divergence-free curl noise with configurable frequency and turbulence.', params: { mode: 'quantum' } }),
  p({ id: 'particle-singularity', name: 'Particle Singularity', engine: 'particles', category: 'scientific', camera: 'orbital', description: 'Particles on decaying Keplerian orbits spiral into a gravitational centre and are re-emitted.', params: { mode: 'singularity' } }),
  p({ id: 'fractal-universe', name: 'Fractal Universe', engine: 'raymarch', category: 'scientific', camera: 'orbital', description: 'Ray-marched Mandelbulb (power-n triplex fractal) with orbit-trap shading.', params: { scene: 'mandelbulb' } }),
  p({ id: 'molecular-lab', name: 'Molecular Laboratory', engine: 'molecule', category: 'scientific', camera: 'orbital', description: 'Ball-and-stick models from standard bond lengths/angles, or load any XYZ file.', params: { molecule: 'benzene' } }),
  p({ id: 'dna-helix', name: 'DNA Helix', engine: 'helix', category: 'scientific', camera: 'orbital', description: 'B-DNA double helix: 10.5 bp per turn, 3.4 Å rise, major/minor grooves.', params: {} }),
  p({ id: 'wave-lab', name: 'Wave Laboratory', engine: 'waves', category: 'scientific', camera: 'orbital', description: 'Oscilloscope with Fourier synthesis, Lissajous figures, beats, AM/FM and live audio.', params: {} }),
  p({ id: 'electromagnetic-field', name: 'Electromagnetic Field', engine: 'field-lines', category: 'scientific', camera: 'orbital', description: 'Electric field lines of point charges traced with RK4 (Coulomb’s law), with test particles flowing along them.', params: {} }),
  p({ id: 'lorenz-attractor', name: 'Mathematical Chaos · Lorenz', engine: 'attractor', category: 'scientific', camera: 'orbital', description: 'Lorenz system (σ=10, ρ=28, β=8/3) integrated with RK4: thousands of nearby trajectories diverge.', params: { system: 'lorenz' } }),
  p({ id: 'aizawa-attractor', name: 'Mathematical Chaos · Aizawa', engine: 'attractor', category: 'scientific', camera: 'orbital', description: 'Aizawa attractor (a=0.95, b=0.7, c=0.6, d=3.5, e=0.25, f=0.1).', params: { system: 'aizawa' } }),
  p({ id: 'thomas-attractor', name: 'Mathematical Chaos · Thomas', engine: 'attractor', category: 'scientific', camera: 'orbital', description: 'Thomas’ cyclically symmetric attractor (b=0.208186).', params: { system: 'thomas' } }),
  p({ id: 'halvorsen-attractor', name: 'Mathematical Chaos · Halvorsen', engine: 'attractor', category: 'scientific', camera: 'orbital', description: 'Halvorsen attractor (a=1.89).', params: { system: 'halvorsen' } }),
  p({ id: 'orbital-mechanics', name: 'Orbital Mechanics', engine: 'orbital', category: 'scientific', camera: 'orbital', description: 'N-body gravity with velocity-Verlet integration and orbital trails.', params: {} }),

  // ───────────────────────── cybernetic ─────────────────────────
  p({ id: 'encom-globe', name: 'ENCOM Globe+', engine: 'encom-globe', category: 'cybernetic', camera: 'orbital', description: 'The eDEX-UI ENCOM globe rebuilt: hexagonal land tiles, satellites, pins and traffic arcs driven by live network throughput.', params: {} }),
  p({ id: 'network-topology', name: 'Network Topology', engine: 'neural-graph', category: 'cybernetic', camera: 'orbital', description: 'LIVE: this host, its remote subnets and peers from active connections; traffic drives pulses.', params: { mode: 'topology' } }),
  p({ id: 'digital-matrix', name: 'Digital Matrix', engine: 'matrix', category: 'cybernetic', camera: 'orbital', description: 'Two-dimensional cascading glyph streams.', params: { mode: '2d' } }),
  p({ id: 'digital-matrix-3d', name: 'Digital Matrix · Volumetric', engine: 'matrix', category: 'cybernetic', camera: 'orbital', description: 'Glyph streams on a cylindrical volume around the camera.', params: { mode: '3d' } }),
  p({ id: 'cybernetic-circuit', name: 'Cybernetic Circuit', engine: 'circuit', category: 'cybernetic', camera: 'orbital', description: 'Procedurally routed 45° circuit traces with pads, vias and travelling signals.', params: {} }),
  p({ id: 'data-constellation', name: 'Data Constellation', engine: 'neural-graph', category: 'cybernetic', camera: 'orbital', description: 'A large starfield of interconnected data points with labelled hubs.', params: { mode: 'constellation' } }),
  p({ id: 'information-vortex', name: 'Information Vortex', engine: 'particles', category: 'cybernetic', camera: 'orbital', description: 'Streams of particles forming a twisting columnar vortex.', params: { mode: 'vortex' } }),
  p({ id: 'holographic-geometry', name: 'Holographic Geometry', engine: 'holo', category: 'cybernetic', camera: 'orbital', description: 'Nested, counter-rotating wireframe polyhedra with scanline holography.', params: { shape: 'polyhedra' } }),

  // ───────────────────────── abstract ─────────────────────────
  p({ id: 'infinite-tunnel', name: 'Infinite Tunnel', engine: 'raymarch', category: 'abstract', camera: 'orbital', description: 'An endless procedurally generated geometric tunnel.', params: { scene: 'tunnel' } }),
  p({ id: 'particle-ocean', name: 'Particle Ocean', engine: 'particles', category: 'abstract', camera: 'orbital', description: 'A dense particle surface moved by superposed Gerstner waves.', params: { mode: 'ocean' } }),
  p({ id: 'recursive-sphere', name: 'Recursive Sphere', engine: 'holo', category: 'abstract', camera: 'orbital', description: 'Spheres within spheres, each generation rotating on its own axis.', params: { shape: 'recursive' } }),
  p({ id: 'energy-reactor', name: 'Energy Reactor', engine: 'particles', category: 'abstract', camera: 'orbital', description: 'Concentric rotating rings with plasma particles flowing from the core.', params: { mode: 'reactor' } }),
  p({ id: 'data-singularity', name: 'Data Singularity', engine: 'neural-graph', category: 'abstract', camera: 'orbital', description: 'A dense, centrally concentrated network that breathes in and out.', params: { mode: 'singularity' } }),
  p({ id: 'procedural-grid', name: 'Procedural Grid', engine: 'grid-surface', category: 'abstract', camera: 'orbital', description: 'An animated wireframe grid deformed by travelling ripples and noise.', params: {} }),
  p({ id: 'wireframe-universe', name: 'Wireframe Universe', engine: 'neural-graph', category: 'abstract', camera: 'cinematic', description: 'A vast lattice of connected nodes the camera flies through.', params: { mode: 'lattice' } }),
];
