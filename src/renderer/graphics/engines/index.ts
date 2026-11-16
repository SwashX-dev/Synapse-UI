/** Registry of rendering engines (each engine hosts several presets). */
import type { EngineDef } from '../types';
import { neuralSphere } from './neural-sphere';
import { neuralGraph } from './graph';
import { particles } from './particles';
import { attractor } from './attractor';
import { fieldLines } from './fields';
import { raymarch } from './raymarch';
import { helix, molecule } from './bio';
import { waves } from './waves';
import { orbital } from './orbital';
import { matrix, circuit } from './cyber';
import { holo, gridSurface } from './abstract';
import { encomGlobe } from './globe';

export const ENGINES: Record<string, EngineDef> = Object.fromEntries(
  [neuralSphere, neuralGraph, particles, attractor, fieldLines, raymarch, helix, molecule, waves, orbital, matrix, circuit, holo, gridSurface, encomGlobe].map((e) => [e.id, e]),
);
