/** Bounded JSON parser rejecting duplicate decoded keys at every object depth.
 * JSON.parse alone accepts ambiguous last-key-wins arguments. No prose recovery. */
export function parseNativeJSON(source: string, maxBytes = 1_100_000): unknown {
  const invalid = () => { throw new Error('Invalid or ambiguous native tool arguments'); };
  if (typeof source !== 'string' || Buffer.byteLength(source) > maxBytes) invalid();
  let i = 0;
  const ws = () => { while (i < source.length && /[\x20\t\r\n]/.test(source[i])) i++; };
  const string = (): string => {
    if (source[i++] !== '"') return invalid();
    const start = i - 1;
    while (i < source.length) {
      const c = source[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') { try { return JSON.parse(source.slice(start,i)); } catch { return invalid(); } }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 64) invalid();
    ws();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{' || source[i] === '[') {
      const object = source[i++] === '{', end = object ? '}' : ']';
      const keys = new Set<string>(); ws();
      if (source[i] === end) { i++; return; }
      while (i < source.length) {
        if (object) {
          ws(); const key = string(); if (keys.has(key)) invalid(); keys.add(key);
          ws(); if (source[i++] !== ':') invalid();
        }
        value(depth + 1); ws();
        if (source[i] === end) { i++; return; }
        if (source[i++] !== ',') invalid();
      }
      invalid();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
    if (!match) invalid(); else i += match[0].length;
  };
  value(0); ws(); if (i !== source.length) invalid();
  try { return JSON.parse(source); } catch { return invalid(); }
}
