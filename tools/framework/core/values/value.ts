// Parsers for one argument's value: the text a user types becomes the typed value, or a
// ValueError that `bind` (core/command/parse.ts) turns into an ArgumentError naming the argument.

import { UserError } from "#src/core/io/log.ts";
import { safeName } from "#src/core/values/names.ts";

/** A refused value. `clause` is the text after the argument's label (`--tail`, `<name>`):
 *  `takes a number of lines, not "abc"`. A clause starting with ":" attaches to the label
 *  without a space (`--image: "x" is not …`). */
export class ValueError extends UserError {
  name = "ValueError";
  readonly clause: string;
  constructor(clause: string) {
    super(clause);
    this.clause = clause;
  }
}

/** `example` parses, `invalidExample` is refused: the property check (and value.check.ts)
 *  derive their argv from them instead of guessing a value per argument. */
export interface ValueParser<T> {
  readonly expected: string;
  readonly example: string;
  readonly invalidExample: string;
  parse(raw: string): T;
}

/** The refusal text for a raw value; defaults to `takes <expected>, not "<raw>"`. */
export type Refusal = (raw: string) => string;

const takesNot = (expected: string): Refusal => (raw) => `takes ${expected}, not "${raw}"`;

/** A whole number >= 0 (digits only). */
export function countValue(expected = "a non-negative integer", refusal: Refusal = takesNot(expected)): ValueParser<number> {
  return {
    expected, example: "5", invalidExample: "abc",
    parse(raw) {
      if (!/^\d+$/.test(raw)) throw new ValueError(refusal(raw));
      return Number(raw);
    },
  };
}

/** A TCP port, 1-65535. Empty is its own refusal, as `--local-port` has always had. */
export const PORT_RANGE = "must be a port number between 1 and 65535";

export function portRefusal(raw: string): string {
  return raw === "" ? "needs a port number" : `${PORT_RANGE}, got: ${raw}`;
}

export function portValue(refusal: Refusal = portRefusal): ValueParser<number> {
  return {
    expected: "a port number between 1 and 65535", example: "8080", invalidExample: "70000",
    parse(raw) {
      if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 65535) throw new ValueError(refusal(raw));
      return Number(raw);
    },
  };
}

/** A regular expression; the empty pattern is valid. */
export function regexValue(expected = "a valid regular expression"): ValueParser<RegExp> {
  return {
    expected, example: "error|warn", invalidExample: "(",
    parse(raw) {
      try {
        return new RegExp(raw);
      } catch (error) {
        throw new ValueError(`takes ${expected}: ${(error as Error).message}`);
      }
    },
  };
}

/** A name that becomes a path segment (safeName): the refusal is safeName's own sentence. */
export function nameValue(kind: string): ValueParser<string> {
  return {
    expected: `a ${kind} name`, example: "local", invalidExample: "Bad_Name",
    parse(raw) {
      try {
        return safeName(kind, raw);
      } catch (error) {
        throw new ValueError(`: ${(error as Error).message}`);
      }
    },
  };
}

/** Any non-empty text — what an option with no parser means. */
export function nonEmptyValue(expected = "a value"): ValueParser<string> {
  return {
    expected, example: "x", invalidExample: "",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      return raw;
    },
  };
}
