// Secret redaction for text that leaves this process: continuation/handoff
// prompts, reviewed diffs, and verify_edit command output.

/**
 * Redact secret-looking values so continuation/handoff prompts never echo
 * credentials. Handoffs must reference where credentials live, never values.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, // OpenAI-style keys
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
];
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|secret|token|password|passwd|credentials?|authorization))\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const AUTH_SCHEME_PATTERN = /\b(bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/**
 * Length at which an all-lowercase-letters run stops being plausible English.
 * Below it the run must carry some non-word evidence to count as a credential.
 */
const UNAMBIGUOUS_CREDENTIAL_LENGTH = 16;

/**
 * Does the run after an auth scheme actually look like a credential?
 *
 * `AUTH_SCHEME_PATTERN` alone accepted any eight-plus characters from the
 * credential alphabet — which includes every lowercase letter, so an ordinary
 * English word qualified. That mangled diagnostic output rather than protecting
 * anything:
 *
 *   error TS2304: Cannot find name 'token expected here'
 *     -> error TS2304: Cannot find name 'token [redacted-secret] here'
 *
 * That is the redactor's own failure mode inverted — it damaged exactly the
 * text an agent needs to read to repair a build, and `verify_edit` now routes
 * compiler and test-runner output through this pass, so the blast radius is
 * every failing build. The discriminator is deliberately weak: one digit, one
 * uppercase letter, or one of `._~+/=-` is enough, because real credentials
 * essentially always carry at least one, while lowercase prose carries none.
 * `_` is NOT evidence — `some_identifier` is far likelier to be source text
 * than a credential, and any real token with an underscore has digits too.
 * A long enough run is accepted on length alone.
 *
 * Nothing this rejects was protecting a credential: every previously-covered
 * leak case (JWTs, base64 basic auth, `sk-`/`tok_live_` vendor tokens, long
 * hex) satisfies it.
 */
function looksLikeCredential(candidate: string): boolean {
  if (candidate.length >= UNAMBIGUOUS_CREDENTIAL_LENGTH) return true;
  return /[0-9A-Z._~+/=-]/.test(candidate);
}

/**
 * Credentials embedded in a URL's userinfo — `scheme://user:pass@host`.
 *
 * None of the passes above catch these. The value patterns enumerate vendor
 * key formats; the key-name pass needs a secret-ish noun and `DATABASE_URL`
 * has none; the auth-scheme pass needs a literal `Bearer`/`Basic` token. So
 * `postgres://admin:hunter2@db.internal/prod` survived all three verbatim.
 *
 * The structural dotenv pass DOES catch it — but only when the caller names a
 * dotenv path, and the production callers do not: handoff and continuation
 * prompt lines and reviewed diffs all call `redactSecrets(text)` with no path.
 * So a model that writes a connection URL into an open-work item leaked the
 * password into a prompt the supervisor then sends to another lane.
 *
 * Greedy up to the LAST `@` before a `/`, `?`, `#` or whitespace, so a password
 * containing `@` is covered rather than half-redacted. The username is kept
 * when there is a colon — same rule as the dotenv pass keeping key names: a
 * handoff must still be able to say which user on which host, never the
 * secret. With no colon the whole userinfo goes, since a bare userinfo is as
 * likely to be a token as a name.
 */
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)@/gi;

/** The single redaction marker. Every pass writes this one — never a second. */
const REDACTION_MARKER = "[redacted-secret]";

// --- Redaction by file shape -----------------------------------------------
//
// The value-pattern and key-name passes above are unbounded-by-construction:
// they only catch formats somebody enumerated, and every vendor invents
// another. Three real leaks that survived them verbatim:
//
//   DATABASE_URL=postgres://admin:hunter2@db.internal:5432/prod
//   STRIPE_KEY=sk_live_51ABCdefGHI     (`sk_`, not the enumerated `sk-`)
//   SMTP_PASS=hunter2                  (the key list has `password`, not `pass`)
//
// So when the text is known to come from a dotenv-shaped FILE, redaction stops
// guessing at values and redacts every assignment's value regardless of how the
// key or value looks. Key names deliberately survive: a handoff must still be
// able to say "DATABASE_URL is set in .env.production" without carrying the
// value — that is the whole point of "reference where credentials live".

/** `.env`, `.env.production`, `.env.test.local`, `.envrc`. Basename only. */
const DOTENV_BASENAME_PATTERN = /^(\.env(\.[^/\\]+)*|\.envrc)$/i;

/**
 * Is this path a dotenv-shaped file? Basename test only — deliberately no
 * directory heuristics, because "somewhere under config/" is not a fact about
 * the file's contents and guessing there produces both misses and false hits.
 */
export function isDotenvPath(path: string): boolean {
  const basename = path.split(/[/\\]/).pop() ?? "";
  return DOTENV_BASENAME_PATTERN.test(basename);
}

/** `KEY=`, `  export KEY =`, `KEY:` — the prefix is kept, the value is not. */
const DOTENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?[\w.-]+\s*[=:]\s*)(.*)$/;

/**
 * Index just past the closing quote of a quoted run starting at `start`,
 * honoring backslash escapes; -1 when the run never closes on this line.
 */
function findClosingQuote(text: string, quote: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

/** Where the value ends inside an assignment's right-hand side. */
function splitDotenvValue(region: string): { valueEnd: number; openQuote: string | null } {
  const first = region[0];
  if (first === '"' || first === "'") {
    const close = findClosingQuote(region, first, 1);
    // An unterminated quote means the value continues onto the next line.
    if (close < 0) return { valueEnd: region.length, openQuote: first };
    return { valueEnd: close + 1, openQuote: null };
  }
  // Bare value: a `#` at the start or preceded by whitespace opens a comment.
  let end = region.length;
  for (let i = 0; i < region.length; i++) {
    if (region[i] !== "#") continue;
    if (i === 0 || /\s/.test(region[i - 1]!)) {
      end = i;
      break;
    }
  }
  while (end > 0 && /\s/.test(region[end - 1]!)) end -= 1;
  return { valueEnd: end, openQuote: null };
}

/**
 * Redact every assignment's value in dotenv-shaped text.
 *
 * Preserved on purpose: the key name, any trailing `# comment`, blank lines,
 * comment lines, and — critically — the LINE COUNT. Line-based reads keep their
 * coordinates, and a multi-line quoted value collapses to one redaction per
 * line instead of leaking its continuation lines. Already-empty values are left
 * alone rather than gaining a marker that implies a secret was there.
 */
export function redactDotenvAssignments(text: string): string {
  const lines = text.split("\n");
  let openQuote: string | null = null;

  const out = lines.map((line) => {
    if (openQuote !== null) {
      // Continuation of a multi-line quoted value: the whole line is value.
      const close = findClosingQuote(line, openQuote, 0);
      if (close < 0) return REDACTION_MARKER;
      openQuote = null;
      return `${REDACTION_MARKER}${line.slice(close + 1)}`;
    }

    const match = DOTENV_ASSIGNMENT_PATTERN.exec(line);
    if (!match) return line;

    const prefix = match[1]!;
    const region = match[2]!;
    if (region.trim().length === 0) return line;

    const { valueEnd, openQuote: stillOpen } = splitDotenvValue(region);
    if (valueEnd === 0) return line;
    openQuote = stillOpen;
    return `${prefix}${REDACTION_MARKER}${region.slice(valueEnd)}`;
  });

  return out.join("\n");
}

/**
 * Redact secrets from text.
 *
 * With no `opts.path` the output is byte-identical to the historical
 * value-and-key-pattern behavior — prompt-shape tests and drift checks pin it.
 * When `opts.path` names a dotenv-shaped file, a structural pass runs after it
 * and redacts every assignment's value by file shape rather than by guessing at
 * the value's format.
 */
export function redactSecrets(text: string, opts?: { path?: string }): string {
  // Auth schemes are matched FIRST. `SECRET_ASSIGNMENT_PATTERN` treats
  // `authorization` as a secret-bearing key and its `\S+` value capture stops
  // at the first space — so on `Authorization: Bearer <token>` it consumed only
  // the literal word "Bearer" and left the token in the clear, which is exactly
  // the value a handoff prompt must never carry. Redacting the scheme+token
  // pair before the assignment pass closes that hole; the assignment pass then
  // harmlessly re-redacts the placeholder.
  let out = text.replace(AUTH_SCHEME_PATTERN, (match: string, scheme: string, candidate: string) =>
    looksLikeCredential(candidate) ? `${scheme} ${REDACTION_MARKER}` : match
  );
  out = out.replace(URL_USERINFO_PATTERN, (_m, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(":");
    // Keep the user, drop the secret. No colon means the whole userinfo is
    // opaque and could be a token, so none of it survives.
    return colon > 0
      ? `${scheme}${userinfo.slice(0, colon)}:${REDACTION_MARKER}@`
      : `${scheme}${REDACTION_MARKER}@`;
  });
  out = out.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string, sep: string, value: string) => {
      // The bare-value alternative is `\S+`, which swallows a quote that was
      // opened BEFORE the key and only closes after the value — so a diff line
      // `+ 'password: hunter2'` came back missing its closing quote. The value
      // is still fully redacted; the delimiter is punctuation belonging to the
      // surrounding text, and a reviewer reading a diff needs its structure to
      // survive. Quoted values keep their own quotes inside the redaction, so
      // only the unquoted alternative is trimmed.
      const startsQuoted = value.startsWith('"') || value.startsWith("'");
      const trailingQuotes = startsQuoted ? "" : (/['"]+$/.exec(value)?.[0] ?? "");
      return `${key}${sep}${REDACTION_MARKER}${trailingQuotes}`;
    }
  );
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTION_MARKER);
  }
  // The structural pass runs last so it is the final word on a dotenv file:
  // whatever the value passes left behind, every value ends up redacted.
  if (opts?.path !== undefined && isDotenvPath(opts.path)) {
    out = redactDotenvAssignments(out);
  }
  return out;
}
