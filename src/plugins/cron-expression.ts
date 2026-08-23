/**
 * Standard five-field cron parsing, plus the `@hourly`/`@daily`/... aliases.
 *
 * Deliberately hand-rolled rather than pulled in as a dependency: izi-queue
 * has no runtime dependencies at all, and the grammar below is the whole of
 * what a scheduler needs. Timezone handling is `Intl`'s, which is where the
 * genuinely hard part (DST) already lives.
 */

/** A parsed expression: which values each field admits. */
export interface CronSchedule {
  /** The expression this was parsed from, normalised. */
  expression: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /**
   * Whether each day field was narrowed from `*`. Cron's oddest rule: when
   * *both* day-of-month and day-of-week are restricted, a date matches if
   * *either* does -- `0 0 13 * 5` is "the 13th, and every Friday", not "Friday
   * the 13th". When only one is restricted it must match.
   */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/** The calendar fields of an instant, in some timezone. */
export interface CronFields {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
};

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Maps an out-of-range but legal alias onto its canonical value (Sunday as 7). */
  normalise?: (value: number) => number;
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES },
  // 7 is a second spelling of Sunday, accepted by every cron implementation.
  { label: 'day-of-week', min: 0, max: 7, names: DAY_NAMES, normalise: value => value % 7 }
];

function fail(expression: string, reason: string): never {
  throw new Error(`izi-queue: invalid cron expression "${expression}" -- ${reason}`);
}

function parseValue(token: string, spec: FieldSpec, expression: string): number {
  const named = spec.names?.[token.toLowerCase()];
  if (named !== undefined) return named;

  if (!/^\d+$/.test(token)) {
    fail(expression, `"${token}" is not a valid ${spec.label}`);
  }

  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    fail(expression, `${spec.label} ${value} is outside ${spec.min}-${spec.max}`);
  }

  return value;
}

function parseStep(token: string, spec: FieldSpec, expression: string): number {
  if (!/^\d+$/.test(token) || Number(token) === 0) {
    fail(expression, `"${token}" is not a valid ${spec.label} step`);
  }
  return Number(token);
}

/** One comma-separated term: `*`, `a`, `a-b`, and any of those with `/step`. */
function parseTerm(term: string, spec: FieldSpec, expression: string, into: Set<number>): void {
  const [range, stepToken, ...extra] = term.split('/');
  if (extra.length > 0) {
    fail(expression, `"${term}" has more than one step in a ${spec.label}`);
  }

  const step = stepToken === undefined ? 1 : parseStep(stepToken, spec, expression);

  let from: number;
  let to: number;

  if (range === '*') {
    from = spec.min;
    to = spec.max;
  } else if (range.includes('-')) {
    const [startToken, endToken, ...rest] = range.split('-');
    if (rest.length > 0) {
      fail(expression, `"${term}" is not a valid ${spec.label} range`);
    }
    from = parseValue(startToken, spec, expression);
    to = parseValue(endToken, spec, expression);
    if (to < from) {
      fail(expression, `${spec.label} range ${range} runs backwards`);
    }
  } else {
    from = parseValue(range, spec, expression);
    // `a/n` means "from a to the end of the field, every n" -- a bare `a`
    // with no step is just itself.
    to = stepToken === undefined ? from : spec.max;
  }

  for (let value = from; value <= to; value += step) {
    into.add(spec.normalise ? spec.normalise(value) : value);
  }
}

function parseField(field: string, spec: FieldSpec, expression: string): Set<number> {
  const values = new Set<number>();

  for (const term of field.split(',')) {
    if (term === '') {
      fail(expression, `${spec.label} has an empty term`);
    }
    parseTerm(term, spec, expression, values);
  }

  return values;
}

/**
 * Parses a five-field expression or a supported alias. Throws with the field
 * and token at fault, so a typo in a crontab surfaces at configuration time
 * rather than as a job that silently never runs.
 */
export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim();

  if (trimmed === '') {
    fail(expression, 'it is empty');
  }

  if (trimmed.startsWith('@')) {
    const alias = ALIASES[trimmed.toLowerCase()];
    if (!alias) {
      fail(
        expression,
        `"${trimmed}" is not a supported alias (${Object.keys(ALIASES).join(', ')})`
      );
    }
    return { ...parseCron(alias), expression: trimmed.toLowerCase() };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    fail(
      expression,
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`
    );
  }

  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((field, i) =>
    parseField(field, FIELDS[i], expression)
  );

  return {
    expression: fields.join(' '),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*'
  };
}

/** Whether `fields` -- an instant's calendar values -- satisfy `schedule`. */
export function matchesCron(schedule: CronSchedule, fields: CronFields): boolean {
  if (!schedule.minutes.has(fields.minute)) return false;
  if (!schedule.hours.has(fields.hour)) return false;
  if (!schedule.months.has(fields.month)) return false;

  const dayOfMonth = schedule.daysOfMonth.has(fields.dayOfMonth);
  const dayOfWeek = schedule.daysOfWeek.has(fields.dayOfWeek);

  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
    return dayOfMonth || dayOfWeek;
  }

  return dayOfMonth && dayOfWeek;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short'
  });

  formatters.set(timezone, formatter);
  return formatter;
}

/**
 * The calendar fields of `instant` as seen in `timezone`.
 *
 * `Intl` is doing the work deliberately: it carries the IANA database, so DST
 * transitions and historical offset changes are already right. A schedule is
 * evaluated by asking "does this instant's local time match", which gives the
 * conventional cron behaviour on both transitions -- a local hour that does
 * not occur is skipped, and one that occurs twice matches twice (the second
 * being deduplicated by the cron plugin's per-minute unique key).
 */
export function fieldsInTimezone(instant: Date, timezone: string): CronFields {
  const parts = formatterFor(timezone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? '';

  return {
    minute: Number(lookup('minute')),
    hour: Number(lookup('hour')),
    dayOfMonth: Number(lookup('day')),
    month: Number(lookup('month')),
    dayOfWeek: WEEKDAY_INDEX[lookup('weekday')] ?? 0
  };
}

/** Throws unless `timezone` is an IANA zone this runtime knows. */
export function assertTimezone(timezone: string): void {
  try {
    formatterFor(timezone);
  } catch {
    throw new Error(`izi-queue: unknown timezone "${timezone}"`);
  }
}
