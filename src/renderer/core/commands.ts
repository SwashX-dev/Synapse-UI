/**
 * Application actions (palette entries + keybinding targets) and the executor
 * for `synapse …` commands. Every command maps onto real application
 * functionality; none of them run shell commands.
 */
import type { App } from './app';
import { bridge } from './bridge';
import { CAMERA_MODES, COMMANDS, helpText, parseCommand, type CameraMode } from '../../shared/commands';
import { SETTINGS_BY_KEY, defaultConfig } from '../../shared/settings';
import { parse as parseToml } from 'smol-toml';
import { moduleType, moduleTypes } from '../workspace/module';
import type { VisualizationModule } from '../modules/visualization';
import { parseSeed } from '../../shared/random';

export interface Action {
  id: string;
  label: string;
  category: string;
  run: () => void | Promise<void>;
  keywords?: string;
}

export interface CommandResult { ok: boolean; output: string }

export class CommandRegistry {
  private actions = new Map<string, Action>();

  constructor(private app: App) {}

  register(a: Action): void {
    this.actions.set(a.id, a);
    this.app.keys?.register(a.id, () => void a.run());
  }

  list(): Action[] {
    return [...this.actions.values()];
  }

  run(id: string): boolean {
    const a = this.actions.get(id);
    if (!a) return false;
    void a.run();
    return true;
  }

  private viz(): { id: string; module: VisualizationModule } | null {
    return this.app.workspace.preferred<VisualizationModule>('visualization');
  }

  /** Execute a `synapse` command line (from the palette or a terminal). */
  async execute(input: string | string[]): Promise<CommandResult> {
    const parsed = parseCommand(input);
    if (!parsed.ok) return { ok: false, output: parsed.error };
    const { spec, args } = parsed.cmd;
    const path = spec.path.join(' ');
    const app = this.app;
    const ws = app.workspace;
    const needViz = () => {
      const v = this.viz();
      if (!v) throw new Error('no visualization module in this workspace (add one with `synapse module add visualization`)');
      return v;
    };
    try {
      switch (path) {
        case 'help':
          return { ok: true, output: `SYNAPSE-UI application commands (they never run shell commands):\n${helpText()}` };
        case 'version':
          return { ok: true, output: `SYNAPSE-UI ${app.info.version}  Electron ${app.info.electron}  Chromium ${app.info.chrome}  Node ${app.info.node}  (${app.info.platform}/${app.info.arch}${app.info.sessionType ? `, ${app.info.sessionType}` : ''})` };
        case 'animation list':
          return { ok: true, output: app.presets().map((p) => `  ${p.id.padEnd(26)} ${p.name}${p.builtin ? '' : ' (user)'}`).join('\n') };
        case 'animation load': {
          const preset = app.preset(args.preset);
          if (!preset) return { ok: false, output: `unknown preset "${args.preset}" — see \`synapse animation list\`` };
          const v = needViz();
          v.module.loadPreset(preset.id);
          return { ok: true, output: `loaded ${preset.name} into ${v.id}` };
        }
        case 'animation pause':
          app.graphics.setPaused(true);
          return { ok: true, output: 'visualizations paused' };
        case 'animation resume':
          app.graphics.setPaused(false);
          return { ok: true, output: 'visualizations resumed' };
        case 'animation restart':
          needViz().module.view?.restart();
          return { ok: true, output: 'restarted' };
        case 'animation set': {
          const v = needViz();
          const out = v.module.setParamFromText(args.param, args.value);
          return { ok: out.ok, output: out.message };
        }
        case 'animation seed': {
          const v = needViz();
          const seed = parseSeed(args.seed);
          v.module.setSeed(seed);
          return { ok: true, output: `seed set to ${seed} (0x${seed.toString(16)})` };
        }
        case 'animation editor':
          app.overlays.openAnimationEditor(this.viz()?.id);
          return { ok: true, output: 'animation editor opened' };
        case 'camera': {
          const mode = args.mode as CameraMode;
          const v = needViz();
          v.module.setCamera(mode);
          return { ok: true, output: `camera → ${mode}` };
        }
        case 'workspace list':
          return { ok: true, output: ws.list().map((w) => `  ${w.id === ws.current?.id ? '*' : ' '} ${w.id.padEnd(18)} ${w.name} [${w.mode}]`).join('\n') };
        case 'workspace switch': {
          const id = args.workspace === 'neural-laboratory' ? 'neural-lab' : args.workspace;
          const ok = await ws.switchTo(id);
          return ok ? { ok, output: `switched to ${ws.current?.name}` } : { ok, output: `unknown workspace "${args.workspace}"` };
        }
        case 'workspace save': {
          if (args.name) {
            const id = args.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
            await ws.saveNow({ id, name: args.name.slice(0, 64) });
            return { ok: true, output: `saved as ${id}` };
          }
          await ws.saveNow();
          return { ok: true, output: `saved ${ws.current?.id}` };
        }
        case 'workspace edit':
          app.overlays.toggleEditor();
          return { ok: true, output: 'workspace editor toggled' };
        case 'workspace mode': {
          if (!['grid', 'freeform', 'hybrid'].includes(args.mode) || !ws.current) return { ok: false, output: 'expected grid | freeform | hybrid' };
          ws.apply({ ...ws.current, mode: args.mode as 'grid' | 'freeform' | 'hybrid' });
          return { ok: true, output: `layout mode → ${args.mode}` };
        }
        case 'module list':
          return { ok: true, output: moduleTypes().map((t) => `  ${t.manifest.id.padEnd(16)} ${t.manifest.name} — ${t.manifest.description}`).join('\n') };
        case 'module add': {
          const t = moduleType(args.type);
          if (!t || !ws.current) return { ok: false, output: `unknown module type "${args.type}" — see \`synapse module list\`` };
          const { addModule } = await import('../../shared/workspace');
          const config: Record<string, unknown> = {};
          if (args.type === 'visualization') config.preset = args.preset && app.preset(args.preset) ? args.preset : app.get<string>('visualization.default_animation');
          const r = addModule(ws.current, args.type, { config, defaultSize: t.manifest.defaultSize });
          ws.apply(r.ws);
          return { ok: true, output: `added ${t.manifest.name} (${r.id})` };
        }
        case 'theme list':
          return { ok: true, output: app.themes.map((t) => `  ${t.id === app.activeTheme.id ? '*' : ' '} ${t.id.padEnd(20)} ${t.name}`).join('\n') };
        case 'theme set': {
          if (!app.theme(args.theme)) return { ok: false, output: `unknown theme "${args.theme}" — see \`synapse theme list\`` };
          await app.set({ 'application.theme': args.theme });
          if (ws.current?.theme && ws.current.theme !== args.theme) ws.apply({ ...ws.current, theme: undefined });
          app.applyTheme();
          app.sounds.play('theme');
          return { ok: true, output: `theme → ${args.theme}` };
        }
        case 'theme editor':
          app.overlays.openThemeEditor();
          return { ok: true, output: 'theme editor opened' };
        case 'performance':
          await app.set({ 'performance.mode': args.mode });
          return { ok: true, output: `performance profile → ${args.mode}` };
        case 'config get': {
          if (!SETTINGS_BY_KEY.has(args.key)) return { ok: false, output: `unknown setting "${args.key}"` };
          return { ok: true, output: `${args.key} = ${JSON.stringify(app.get(args.key))}` };
        }
        case 'config set': {
          const def = SETTINGS_BY_KEY.get(args.key);
          if (!def) return { ok: false, output: `unknown setting "${args.key}"` };
          let value: unknown;
          try {
            value = (parseToml(`v = ${args.value}`) as { v: unknown }).v;
          } catch {
            value = args.value;
          }
          const ok = await app.set({ [args.key]: value });
          return { ok, output: ok ? `${args.key} = ${JSON.stringify(app.get(args.key))}${def.restart ? ' (takes effect after restart)' : ''}` : `invalid value for ${args.key}` };
        }
        case 'config reset': {
          if (!SETTINGS_BY_KEY.has(args.key)) return { ok: false, output: `unknown setting "${args.key}"` };
          await bridge.config.reset([args.key]);
          return { ok: true, output: `${args.key} reset to ${JSON.stringify(defaultConfig()[args.key])}` };
        }
        case 'settings':
          app.overlays.openSettings(args.category?.toUpperCase());
          return { ok: true, output: 'settings opened' };
        case 'fullscreen': {
          const state = args.state ?? 'toggle';
          if (state === 'toggle') await bridge.app.toggleFullscreen();
          else await bridge.app.setFullscreen(state === 'on');
          return { ok: true, output: `fullscreen ${state}` };
        }
        case 'screenshot': {
          const path2 = await needViz().module.screenshot();
          return { ok: true, output: `saved ${path2}` };
        }
        case 'record': {
          const v = needViz();
          const msg = await v.module.toggleRecording((args.format as never) ?? undefined);
          return { ok: true, output: msg };
        }
        case 'diagnostics':
          app.overlays.toggleDiagnostics();
          return { ok: true, output: 'diagnostics toggled' };
        case 'setup':
          app.overlays.openFirstRun();
          return { ok: true, output: 'first-run setup opened' };
      }
      return { ok: false, output: `unhandled command ${path}` };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }

  /** Completion candidates for the palette's command mode. */
  completions(prefix: string): string[] {
    const words = prefix.replace(/^synapse\s+/, '').split(/\s+/);
    const out = new Set<string>();
    for (const c of COMMANDS) {
      const base = c.path.join(' ');
      if (base.startsWith(words.slice(0, c.path.length).join(' ')) || words.join(' ').startsWith(base)) {
        const arg = c.args[0];
        if (arg && words.length > c.path.length - 1 && words.slice(0, c.path.length).join(' ') === base) {
          const pool = arg.kind === 'preset' ? this.app.presets().map((p) => p.id) : arg.kind === 'workspace' ? this.app.workspace.list().map((w) => w.id) : arg.kind === 'theme' ? this.app.themes.map((t) => t.id) : arg.kind === 'camera' ? [...CAMERA_MODES] : arg.kind === 'perf' ? ['eco', 'balanced', 'high', 'cinematic', 'adaptive'] : arg.kind === 'module-type' ? moduleTypes().map((t) => t.manifest.id) : [];
          for (const v of pool) out.add(`${base} ${v}`);
        } else out.add(base);
      }
    }
    return [...out].slice(0, 200);
  }
}
