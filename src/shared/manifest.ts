/**
 * Module manifests and the permission model.
 *
 * Built-in modules are part of the trusted application bundle but still
 * declare the capabilities they use (shown in the Module Manager).
 * Third-party modules live in <config>/modules/<id>/manifest.json and only
 * ever receive capabilities they declare AND the user approves.
 */
import { z } from 'zod';

export const MODULE_CATEGORIES = ['terminal', 'visualization', 'monitoring', 'graph', 'information', 'utility', 'extension'] as const;
export type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

export interface PermissionInfo { label: string; risk: 'low' | 'medium' | 'high'; description: string }

export const PERMISSIONS: Record<string, PermissionInfo> = {
  'monitor.cpu': { label: 'CPU statistics', risk: 'low', description: 'Utilisation, clock speed and temperature.' },
  'monitor.memory': { label: 'Memory statistics', risk: 'low', description: 'RAM and swap usage.' },
  'monitor.gpu': { label: 'GPU statistics', risk: 'low', description: 'GPU model, utilisation, VRAM and temperature.' },
  'monitor.network': { label: 'Network throughput', risk: 'low', description: 'Transfer rates of the selected interface.' },
  'monitor.storage': { label: 'Storage statistics', risk: 'low', description: 'Mounted filesystems, sizes and disk activity.' },
  'monitor.processes': { label: 'Process list', risk: 'medium', description: 'Names, ids and resource use of running processes.' },
  'monitor.connections': { label: 'Network connections', risk: 'medium', description: 'Local and remote addresses of active connections.' },
  'audio.analysis': { label: 'Audio analysis', risk: 'low', description: 'Frequency bands and beat events of the active audio source (never raw audio).' },
  'data.files': { label: 'User data files', risk: 'medium', description: 'Contents of JSON/CSV files you explicitly choose.' },
  script: { label: 'Run JavaScript', risk: 'high', description: 'Executes the module\'s own JavaScript inside an isolated, network-less sandboxed frame. Requires "Allow extension scripts".' },
  'terminal.write': { label: 'Type into terminals', risk: 'high', description: 'Send keystrokes to the focused terminal. This can run commands as you.' },
  'filesystem.read': { label: 'Read files', risk: 'high', description: 'Read files and list directories under your home directory.' },
  'process.kill': { label: 'Terminate processes', risk: 'high', description: 'Send signals to processes after you confirm.' },
  'pty.spawn': { label: 'Start shells', risk: 'high', description: 'Start interactive shell sessions.' },
};

export const PermissionSchema = z.enum(Object.keys(PERMISSIONS) as [string, ...string[]]);

/** Permissions a third-party module may request at all. */
export const EXTENSION_ALLOWED_PERMISSIONS = new Set([
  'monitor.cpu', 'monitor.memory', 'monitor.gpu', 'monitor.network', 'monitor.storage', 'monitor.processes', 'monitor.connections', 'audio.analysis', 'data.files', 'script',
]);

const idRe = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export const ParamSpecSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  label: z.string().max(64),
  type: z.enum(['number', 'int', 'bool', 'color', 'select', 'string']),
  default: z.union([z.number(), z.boolean(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(64).optional(),
  group: z.string().max(32).optional(),
  description: z.string().max(256).optional(),
});
export type ParamSpec = z.infer<typeof ParamSpecSchema> & { rebuild?: boolean; advanced?: boolean };

export const PresetSchema = z.object({
  id: z.string().regex(idRe),
  name: z.string().min(1).max(64),
  engine: z.string().regex(idRe),
  category: z.enum(['neural', 'scientific', 'cybernetic', 'abstract', 'custom']).default('custom'),
  description: z.string().max(512).default(''),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  camera: z.string().max(32).optional(),
  /** Keyframed parameter automation (see animation editor). */
  timeline: z
    .object({
      duration: z.number().min(0.5).max(3600),
      loop: z.boolean().default(true),
      tracks: z
        .array(
          z.object({
            param: z.string().max(64),
            keys: z.array(z.object({ t: z.number().min(0), v: z.union([z.number(), z.string()]), ease: z.enum(['linear', 'smooth', 'step', 'in', 'out']).default('smooth') })).max(256),
          }),
        )
        .max(64),
    })
    .optional(),
  bindings: z
    .array(z.object({ param: z.string().max(64), source: z.string().max(64), inMin: z.number(), inMax: z.number(), outMin: z.number(), outMax: z.number(), smoothing: z.number().min(0).max(0.999).optional() }))
    .max(32)
    .optional(),
  expressions: z.record(z.string(), z.string().max(1024)).optional(),
  builtin: z.boolean().optional(),
});
export type Preset = z.infer<typeof PresetSchema>;

export const PanelWidgetSchema = z.object({
  kind: z.enum(['value', 'bar', 'sparkline', 'label']),
  label: z.string().max(48),
  source: z.string().max(64).optional(),
  expression: z.string().max(512).optional(),
  unit: z.string().max(12).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const ExtensionManifestSchema = z.object({
  manifest_version: z.literal(1),
  id: z.string().regex(idRe),
  name: z.string().min(1).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/),
  description: z.string().max(512).default(''),
  author: z.string().max(128).default('unknown'),
  category: z.enum(MODULE_CATEGORIES).default('extension'),
  kind: z.enum(['presets', 'themes', 'panel', 'script']),
  permissions: z.array(PermissionSchema).max(16).default([]),
  defaultSize: z.object({ colSpan: z.number().int().min(1).max(12), rowSpan: z.number().int().min(1).max(12), w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) }).optional(),
  /** kind = presets: animation presets contributed by this module. */
  presets: z.array(PresetSchema).max(64).optional(),
  /** kind = themes: relative paths of theme TOML files. */
  themes: z.array(z.string().regex(/^[A-Za-z0-9._-]+\.toml$/)).max(32).optional(),
  /** kind = panel: declarative widgets bound to data sources. */
  panel: z.object({ title: z.string().max(64), widgets: z.array(PanelWidgetSchema).min(1).max(32) }).optional(),
  /** kind = script: HTML entry file rendered in an isolated sandboxed frame. */
  entry: z.string().regex(/^[A-Za-z0-9._/-]+\.html$/).refine((p) => !p.split('/').includes('..'), 'entry must stay inside the module directory').optional(),
  configSchema: z.array(ParamSpecSchema).max(64).optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

export interface ManifestCheck { ok: boolean; errors: string[]; warnings: string[]; manifest?: ExtensionManifest }

/** Validate a third-party manifest and its permission requests. */
export function checkExtensionManifest(raw: unknown): ManifestCheck {
  const r = ExtensionManifestSchema.safeParse(raw);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`), warnings: [] };
  const m = r.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const p of m.permissions) {
    if (!EXTENSION_ALLOWED_PERMISSIONS.has(p)) errors.push(`permission "${p}" cannot be granted to third-party modules`);
    else if (PERMISSIONS[p].risk !== 'low') warnings.push(`requests ${PERMISSIONS[p].risk}-risk permission "${p}" (${PERMISSIONS[p].label})`);
  }
  if (m.kind === 'script') {
    if (!m.entry) errors.push('script modules must declare an "entry" HTML file');
    if (!m.permissions.includes('script')) errors.push('script modules must declare the "script" permission');
  } else if (m.permissions.includes('script')) {
    errors.push('only kind = "script" modules may request the "script" permission');
  }
  if (m.kind === 'presets' && !m.presets?.length) errors.push('kind = "presets" requires a non-empty "presets" array');
  if (m.kind === 'themes' && !m.themes?.length) errors.push('kind = "themes" requires a non-empty "themes" array');
  if (m.kind === 'panel' && !m.panel) errors.push('kind = "panel" requires a "panel" definition');
  if (m.kind === 'panel' && m.panel) {
    const needs = new Set<string>();
    for (const w of m.panel.widgets) if (w.source) needs.add(sourcePermission(w.source));
    for (const p of needs) if (p && !m.permissions.includes(p)) errors.push(`panel reads "${p}" data but does not declare that permission`);
  }
  return { ok: errors.length === 0, errors, warnings, manifest: m };
}

/** Which permission a data source id requires (e.g. "cpu.load" → monitor.cpu). */
export function sourcePermission(source: string): string {
  const head = source.split('.')[0];
  switch (head) {
    case 'cpu': return 'monitor.cpu';
    case 'mem': return 'monitor.memory';
    case 'gpu': return 'monitor.gpu';
    case 'net': return 'monitor.network';
    case 'disk': return 'monitor.storage';
    case 'proc': return 'monitor.processes';
    case 'conn': return 'monitor.connections';
    case 'audio': return 'audio.analysis';
    case 'file': return 'data.files';
    default: return '';
  }
}
