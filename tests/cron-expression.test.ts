import {
  fieldsInTimezone,
  matchesCron,
  parseCron,
  assertTimezone
} from '../src/plugins/cron-expression.js';

/** `2026-08-23T14:05Z` and friends, as instants. */
function utc(iso: string): Date {
  return new Date(iso);
}

function matchesAt(expression: string, iso: string, timezone = 'UTC'): boolean {
  return matchesCron(parseCron(expression), fieldsInTimezone(utc(iso), timezone));
}

describe('cron expressions', () => {
  describe('parsing fields', () => {
    it('expands a wildcard to the whole range', () => {
      const schedule = parseCron('* * * * *');
      expect(schedule.minutes.size).toBe(60);
      expect(schedule.hours.size).toBe(24);
      expect(schedule.daysOfMonth.size).toBe(31);
      expect(schedule.months.size).toBe(12);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('parses a single value', () => {
      expect([...parseCron('30 * * * *').minutes]).toEqual([30]);
    });

    it('parses a list', () => {
      expect([...parseCron('0,15,30,45 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    });

    it('parses a range', () => {
      expect([...parseCron('* 9-12 * * *').hours]).toEqual([9, 10, 11, 12]);
    });

    it('parses a step over a wildcard', () => {
      expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    });

    it('parses a step over a range', () => {
      expect([...parseCron('0-30/10 * * * *').minutes]).toEqual([0, 10, 20, 30]);
    });

    it('reads a bare value with a step as running to the end of the field', () => {
      expect([...parseCron('5/10 * * * *').minutes]).toEqual([5, 15, 25, 35, 45, 55]);
    });

    it('parses month names', () => {
      expect([...parseCron('0 0 1 jan,jul *').months]).toEqual([1, 7]);
      expect([...parseCron('0 0 1 MAR-MAY *').months]).toEqual([3, 4, 5]);
    });

    it('parses day names', () => {
      expect([...parseCron('0 0 * * mon-fri').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    });

    it('accepts 7 as a second spelling of Sunday', () => {
      expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
      expect([...parseCron('0 0 * * 0').daysOfWeek]).toEqual([0]);
    });

    it('normalises whitespace in the stored expression', () => {
      expect(parseCron('  0   9  *  *  1  ').expression).toBe('0 9 * * 1');
    });
  });

  describe('aliases', () => {
    it.each([
      ['@hourly', '0 * * * *'],
      ['@daily', '0 0 * * *'],
      ['@midnight', '0 0 * * *'],
      ['@weekly', '0 0 * * 0'],
      ['@monthly', '0 0 1 * *'],
      ['@yearly', '0 0 1 1 *'],
      ['@annually', '0 0 1 1 *']
    ])('%s expands like %s', (alias, equivalent) => {
      const aliased = parseCron(alias);
      const spelled = parseCron(equivalent);

      expect([...aliased.minutes]).toEqual([...spelled.minutes]);
      expect([...aliased.hours]).toEqual([...spelled.hours]);
      expect([...aliased.daysOfMonth]).toEqual([...spelled.daysOfMonth]);
      expect([...aliased.months]).toEqual([...spelled.months]);
      expect([...aliased.daysOfWeek]).toEqual([...spelled.daysOfWeek]);
      expect(aliased.expression).toBe(alias);
    });

    it('is case-insensitive', () => {
      expect(parseCron('@DAILY').expression).toBe('@daily');
    });
  });

  describe('rejecting bad expressions', () => {
    it.each([
      ['', /is empty/],
      ['* * * *', /expected 5 fields/],
      ['* * * * * *', /expected 5 fields/],
      ['60 * * * *', /minute 60 is outside 0-59/],
      ['* 24 * * *', /hour 24 is outside 0-23/],
      ['* * 0 * *', /day-of-month 0 is outside 1-31/],
      ['* * * 13 *', /month 13 is outside 1-12/],
      ['* * * * 8', /day-of-week 8 is outside 0-7/],
      ['30-10 * * * *', /runs backwards/],
      ['*/0 * * * *', /not a valid minute step/],
      ['*/a * * * *', /not a valid minute step/],
      ['abc * * * *', /"abc" is not a valid minute/],
      ['0,,30 * * * *', /empty term/],
      ['*/2/3 * * * *', /more than one step/],
      ['@reboot', /not a supported alias/],
      ['@nope', /not a supported alias/]
    ])('rejects %p', (expression, message) => {
      expect(() => parseCron(expression)).toThrow(message);
    });

    it('names the expression it rejected', () => {
      expect(() => parseCron('99 * * * *')).toThrow(/invalid cron expression "99 \* \* \* \*"/);
    });
  });

  describe('matching', () => {
    it('matches every minute for a full wildcard', () => {
      expect(matchesAt('* * * * *', '2026-08-23T14:05:00Z')).toBe(true);
    });

    it('matches only on the hour for @hourly', () => {
      expect(matchesAt('@hourly', '2026-08-23T14:00:00Z')).toBe(true);
      expect(matchesAt('@hourly', '2026-08-23T14:01:00Z')).toBe(false);
    });

    it('matches a weekday business-hours schedule', () => {
      // 2026-08-24 is a Monday, 2026-08-23 a Sunday.
      expect(matchesAt('0 9-17 * * 1-5', '2026-08-24T09:00:00Z')).toBe(true);
      expect(matchesAt('0 9-17 * * 1-5', '2026-08-24T18:00:00Z')).toBe(false);
      expect(matchesAt('0 9-17 * * 1-5', '2026-08-23T09:00:00Z')).toBe(false);
    });

    describe('the day-of-month / day-of-week rule', () => {
      // Cron's oddest corner: with both day fields restricted, either one
      // matching is enough. `0 0 13 * 5` is "the 13th, and every Friday".
      it('ORs the two when both are restricted', () => {
        expect(matchesAt('0 0 13 * 5', '2026-01-13T00:00:00Z')).toBe(true); // a Tuesday
        expect(matchesAt('0 0 13 * 5', '2026-01-16T00:00:00Z')).toBe(true); // a Friday
        expect(matchesAt('0 0 13 * 5', '2026-01-14T00:00:00Z')).toBe(false);
      });

      it('requires the day of month when only it is restricted', () => {
        expect(matchesAt('0 0 13 * *', '2026-01-13T00:00:00Z')).toBe(true);
        expect(matchesAt('0 0 13 * *', '2026-01-16T00:00:00Z')).toBe(false);
      });

      it('requires the day of week when only it is restricted', () => {
        expect(matchesAt('0 0 * * 5', '2026-01-16T00:00:00Z')).toBe(true);
        expect(matchesAt('0 0 * * 5', '2026-01-13T00:00:00Z')).toBe(false);
      });
    });
  });

  describe('timezones', () => {
    it('evaluates in the given zone, not UTC', () => {
      // 09:00 in São Paulo (UTC-3) is 12:00 UTC.
      expect(matchesAt('0 9 * * *', '2026-08-24T12:00:00Z', 'America/Sao_Paulo')).toBe(true);
      expect(matchesAt('0 9 * * *', '2026-08-24T12:00:00Z', 'UTC')).toBe(false);
      expect(matchesAt('0 12 * * *', '2026-08-24T12:00:00Z', 'UTC')).toBe(true);
    });

    it('crosses the date line into the previous local day', () => {
      // 2026-08-24T02:00Z is still 2026-08-23, 23:00, in São Paulo.
      const fields = fieldsInTimezone(utc('2026-08-24T02:00:00Z'), 'America/Sao_Paulo');
      expect(fields).toMatchObject({ hour: 23, dayOfMonth: 23, month: 8, dayOfWeek: 0 });
    });

    it('reports midnight as hour 0, not 24', () => {
      expect(fieldsInTimezone(utc('2026-08-24T00:00:00Z'), 'UTC').hour).toBe(0);
    });

    it('skips a local hour that a spring-forward removes', () => {
      // New York jumps 02:00 EST -> 03:00 EDT on 2026-03-08, so `0 2 * * *`
      // simply does not occur that day.
      expect(fieldsInTimezone(utc('2026-03-08T06:59:00Z'), 'America/New_York').hour).toBe(1);
      expect(fieldsInTimezone(utc('2026-03-08T07:00:00Z'), 'America/New_York').hour).toBe(3);
    });

    it('sees a repeated local hour twice on a fall-back', () => {
      // 01:00 happens once as EDT and once as EST on 2026-11-01. Both are
      // genuine matches; the cron plugin's per-minute unique key is what keeps
      // them from being conflated.
      expect(fieldsInTimezone(utc('2026-11-01T05:00:00Z'), 'America/New_York').hour).toBe(1);
      expect(fieldsInTimezone(utc('2026-11-01T06:00:00Z'), 'America/New_York').hour).toBe(1);
    });

    it('rejects a zone this runtime does not know', () => {
      expect(() => assertTimezone('Mars/Olympus_Mons')).toThrow(/unknown timezone/);
    });

    it('accepts a real IANA zone', () => {
      expect(() => assertTimezone('Europe/Lisbon')).not.toThrow();
    });
  });
});
