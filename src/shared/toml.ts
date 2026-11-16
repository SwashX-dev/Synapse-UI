/**
 * Minimal, dependency-free TOML *emitter* used to write human-readable,
 * commented configuration files. Parsing is done with `smol-toml`.
 *
 * Only the value types SYNAPSE-UI stores are supported: strings, finite
 * numbers, booleans, arrays of those, and flat string maps (inline tables).
 */

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

export function tomlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot encode non-finite number ${value} as TOML`);
  if (Number.isInteger(value)) return String(value);
  // Keep a stable, short representation (avoid 0.30000000000000004).
  const s = Number(value.toPrecision(12)).toString();
  return s.includes('.') || s.includes('e') ? s : s + '.0';
}

export type TomlPrimitive = string | number | boolean;
export type TomlValue = TomlPrimitive | TomlPrimitive[] | Record<string, TomlPrimitive>;

export function tomlValue(value: TomlValue): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number') return tomlNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map((v) => tomlValue(v)).join(', ') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return '{ ' + entries.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(', ') + ' }';
  }
  throw new Error(`Unsupported TOML value: ${String(value)}`);
}

/** Wrap a description into `# ` comment lines no wider than `width`. */
export function tomlComment(text: string, width = 78): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '#';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length + word.length + 1 > width && line !== '#') {
        lines.push(line);
        line = '#';
      }
      line += ' ' + word;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Generic emitter for nested plain objects (used for themes and keybindings).
 * Top-level primitives first, then one [table] per nested object, recursively.
 */
export function emitTomlDocument(doc: Record<string, unknown>, header?: string[]): string {
  const out: string[] = [];
  if (header) out.push(...header, '');
  const emitTable = (obj: Record<string, unknown>, path: string[]) => {
    const prims: [string, TomlValue][] = [];
    const tables: [string, Record<string, unknown>][] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).some((x) => typeof x === 'object' && x !== null && !Array.isArray(x))) {
        tables.push([k, v as Record<string, unknown>]);
      } else if (typeof v === 'object' && !Array.isArray(v) && path.length < 3 && Object.keys(v as object).length > 0 && !isFlatMapHint(k)) {
        tables.push([k, v as Record<string, unknown>]);
      } else {
        prims.push([k, v as TomlValue]);
      }
    }
    if (path.length && prims.length) out.push(`[${path.map(tomlKey).join('.')}]`);
    for (const [k, v] of prims) out.push(`${tomlKey(k)} = ${tomlValue(v)}`);
    if (prims.length) out.push('');
    for (const [k, v] of tables) emitTable(v, [...path, k]);
  };
  emitTable(doc, []);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Keys whose object values are emitted as inline tables rather than [sections]. */
function isFlatMapHint(key: string): boolean {
  return key === 'env' || key === 'vars';
}
