/** Form controls shared by settings, theme editor, module settings and the animation editor. */
import { h } from '../core/util';
import { isColor, type SettingDef, type SettingValue } from '../../shared/settings';
import { parseColor, toHex } from '../../shared/theme';
import type { ParamSpec } from '../../shared/manifest';

/** Color picker with alpha (supports #rrggbb, #rrggbbaa and rgba()). Empty allowed when `optional`. */
export function colorInput(value: string, onChange: (v: string) => void, optional = false): HTMLElement {
  const picker = h('input', { type: 'color' });
  const alpha = h('input', { type: 'range', min: '0', max: '1', step: '0.01', title: 'Alpha', class: 'alpha' });
  const text = h('input', { type: 'text', spellcheck: 'false', class: 'color-text', placeholder: optional ? 'theme default' : '#rrggbb' });
  const sync = (v: string) => {
    text.value = v;
    if (v && isColor(v)) {
      const c = parseColor(v);
      picker.value = toHex(c);
      alpha.value = String(c.a);
    }
  };
  sync(value);
  const emit = () => {
    const c = parseColor(picker.value);
    const a = Number(alpha.value);
    const v = a >= 0.999 ? picker.value : `rgba(${c.r},${c.g},${c.b},${a.toFixed(2)})`;
    text.value = v;
    onChange(v);
  };
  picker.addEventListener('input', emit);
  alpha.addEventListener('input', emit);
  text.addEventListener('change', () => {
    const v = text.value.trim();
    if ((optional && v === '') || isColor(v)) {
      sync(v);
      onChange(v);
    } else {
      text.classList.add('invalid');
      setTimeout(() => text.classList.remove('invalid'), 900);
    }
  });
  return h('span.color-input', picker, alpha, text);
}

export interface FieldOptions {
  dynamic?: { value: string; label: string }[];
  onReset?: () => void;
  isDefault?: boolean;
}

/** Build an input for a settings-registry entry. */
export function settingInput(def: SettingDef, value: SettingValue, onChange: (v: SettingValue) => void, opts: FieldOptions = {}): HTMLElement {
  const t = def.type;
  switch (t.kind) {
    case 'bool': {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = value === true;
      cb.addEventListener('change', () => onChange(cb.checked));
      return h('label.switch', cb, h('span.track'));
    }
    case 'number': {
      const range = h('input', { type: 'range', min: String(t.min), max: String(t.max), step: String(t.step ?? 0.01) });
      const num = h('input', { type: 'number', min: String(t.min), max: String(t.max), step: String(t.step ?? 0.01), class: 'num' });
      range.value = num.value = String(value);
      const span = t.max - t.min;
      if (span > 1000 && !t.int) range.hidden = true;
      if (span > 5000) range.hidden = true;
      range.addEventListener('input', () => { num.value = range.value; onChange(Number(range.value)); });
      num.addEventListener('change', () => {
        let v = Number(num.value);
        if (!Number.isFinite(v)) v = Number(value);
        v = Math.max(t.min, Math.min(t.max, t.int ? Math.round(v) : v));
        num.value = range.value = String(v);
        onChange(v);
      });
      return h('span.number-input', range, num, t.unit ? h('span.unit', t.unit) : '');
    }
    case 'enum': {
      const sel = h('select');
      for (const o of t.options) sel.append(h('option', { value: o.value }, o.label));
      sel.value = String(value);
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    }
    case 'string': {
      if (opts.dynamic) {
        const sel = h('select');
        const list = [...opts.dynamic];
        if (!list.some((o) => o.value === value)) list.unshift({ value: String(value), label: `${value} (custom)` });
        for (const o of list) sel.append(h('option', { value: o.value }, o.label));
        sel.value = String(value);
        sel.addEventListener('change', () => onChange(sel.value));
        return sel;
      }
      const inp = h('input', { type: 'text', spellcheck: 'false', placeholder: t.placeholder ?? '' });
      inp.value = String(value);
      inp.addEventListener('change', () => onChange(inp.value));
      return inp;
    }
    case 'color':
      return colorInput(String(value), (v) => onChange(v), t.optional);
    case 'string-list': {
      const inp = h('input', { type: 'text', spellcheck: 'false', placeholder: 'space-separated' });
      inp.value = (value as string[]).join(' ');
      inp.addEventListener('change', () => onChange(inp.value.trim() ? inp.value.trim().split(/\s+/) : []));
      return inp;
    }
    case 'string-map': {
      const ta = h('textarea', { rows: '3', spellcheck: 'false', placeholder: 'KEY=value, one per line' });
      ta.value = Object.entries(value as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n');
      ta.addEventListener('change', () => {
        const out: Record<string, string> = {};
        for (const line of ta.value.split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
        }
        onChange(out);
      });
      return ta;
    }
  }
}

/** Build an input for a module/engine parameter spec. */
export function paramInput(spec: ParamSpec, value: unknown, onChange: (v: number | boolean | string) => void): HTMLElement {
  switch (spec.type) {
    case 'bool': {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = value === true;
      cb.addEventListener('change', () => onChange(cb.checked));
      return h('label.switch', cb, h('span.track'));
    }
    case 'number':
    case 'int': {
      const min = spec.min ?? 0, max = spec.max ?? 1;
      const step = spec.step ?? (spec.type === 'int' ? 1 : 0.01);
      const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
      const num = h('input', { type: 'number', min: String(min), max: String(max), step: String(step), class: 'num' });
      range.value = num.value = String(value ?? spec.default);
      if (max - min > 5000 && spec.type === 'int') range.hidden = true;
      range.addEventListener('input', () => { num.value = range.value; onChange(Number(range.value)); });
      num.addEventListener('change', () => {
        let v = Number(num.value);
        if (!Number.isFinite(v)) v = Number(spec.default);
        v = Math.max(min, Math.min(max, spec.type === 'int' ? Math.round(v) : v));
        num.value = range.value = String(v);
        onChange(v);
      });
      return h('span.number-input', range, num);
    }
    case 'select': {
      const sel = h('select');
      for (const o of spec.options ?? []) sel.append(h('option', { value: o.value }, o.label));
      sel.value = String(value ?? spec.default);
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    }
    case 'color':
      return colorInput(String(value ?? ''), (v) => onChange(v), true);
    case 'string': {
      const inp = h('input', { type: 'text', spellcheck: 'false' });
      inp.value = String(value ?? spec.default ?? '');
      inp.addEventListener('change', () => onChange(inp.value));
      return inp;
    }
  }
}

export function field(label: string, control: HTMLElement, opts: { description?: string; badge?: string; onReset?: () => void; modified?: boolean } = {}): HTMLElement {
  return h('div.field-row', { class: opts.modified ? 'modified' : '' },
    h('div.field-label', h('span', label), opts.badge ? h('span.field-badge', opts.badge) : '', opts.description ? h('small', opts.description) : ''),
    h('div.field-control', control, opts.onReset ? h('button.ghost.reset', { title: 'Reset to default', onclick: opts.onReset }, '↺') : ''),
  );
}

/** Group param specs by their `group`, preserving order. */
export function groupParams<T extends { group?: string }>(specs: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const s of specs) {
    const g = s.group ?? 'General';
    let l = out.get(g);
    if (!l) out.set(g, (l = []));
    l.push(s);
  }
  return [...out.entries()];
}
