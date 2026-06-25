/**
 * Line-buffered JSON parser for stream-json stdio.
 *
 * THE #1 BUG in every custom Claude Code UI: stream-json arrives in arbitrary
 * chunks across stdout reads. A single JSON object can be split across two
 * 'data' events, and one 'data' event can contain several objects plus a
 * partial trailing one. This buffer assembles complete newline-delimited lines
 * before parsing, and holds the incomplete tail until more data arrives.
 */
export class JsonLineBuffer {
  constructor() {
    this._buf = '';
  }

  /**
   * Push a raw chunk (string or Buffer). Returns an array of successfully
   * parsed JSON values. Malformed complete lines are reported via onError.
   *
   * @param {string|Buffer} chunk
   * @param {(err: Error, rawLine: string) => void} [onError]
   * @returns {any[]}
   */
  push(chunk, onError) {
    this._buf += chunk.toString('utf8');
    const out = [];
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch (err) {
        if (onError) onError(err, trimmed);
      }
    }
    return out;
  }

  /** Flush any trailing buffered text that has no newline (best-effort). */
  flush(onError) {
    const trimmed = this._buf.trim();
    this._buf = '';
    if (!trimmed) return [];
    try {
      return [JSON.parse(trimmed)];
    } catch (err) {
      if (onError) onError(err, trimmed);
      return [];
    }
  }

  /** Bytes currently held without a terminating newline. */
  get pending() {
    return this._buf.length;
  }
}
