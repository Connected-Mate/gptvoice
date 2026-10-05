// Errors carry a `kind` so callers can decide what to retry:
// auth | rate_limit | invalid | network | server | timeout | content
export class VoiceError extends Error {
  constructor(message, kind, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}
