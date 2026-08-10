# Date and Time Handling in Quereus

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

## SQL Date/Time Functions

The built-in SQL functions (`date`, `time`, `datetime`, `julianday`, `strftime`) are analogues to SQLite's functions. The `epoch_s`, `epoch_ms`, and `epoch_s_frac` functions provide first-class Unix epoch support.

## Internal Implementation

Quereus internally utilizes the [Temporal API](https://tc39.es/proposal-temporal/docs/index.html) (via the [`temporal-polyfill`](https://github.com/fullcalendar/temporal-polyfill)) for all internal date and time operations and for implementing SQL date/time functions. Internal processing relies on `Temporal` objects like `Temporal.Instant`, `Temporal.ZonedDateTime`, `Temporal.PlainDate`, `Temporal.PlainTime`, and `Temporal.PlainDateTime`.  This provides a modern, robust, and unambiguous way to handle dates and times, avoiding the pitfalls of the legacy JavaScript `Date` object.

## Internal Representation

Quereus functions return dates/times formatted as ISO strings (e.g., `YYYY-MM-DD`) or numbers (e.g., Julian day, Unix epoch seconds/milliseconds).

### Input Parsing

The functions attempt to parse the initial time string argument (`timestring`) leniently, similar to SQLite, accepting various formats:

*   **ISO 8601 Formats:**
    *   `YYYY-MM-DD`
    *   `YYYY-MM-DDTHH:MM`
    *   `YYYY-MM-DD HH:MM` (Space separator is accepted)
    *   `YYYY-MM-DDTHH:MM:SS`
    *   `YYYY-MM-DD HH:MM:SS`
    *   `YYYY-MM-DDTHH:MM:SS.sss` (Fractional seconds)
    *   `YYYY-MM-DD HH:MM:SS.sss`
    *   Formats with explicit UTC ('Z') or timezone offsets (`±HH:MM`)
*   **Time Only:**
    *   `HH:MM`
    *   `HH:MM:SS`
    *   `HH:MM:SS.sss`
    (If only time is provided, the date defaults to `2000-01-01` for internal calculations.)
*   **Other Formats:**
    *   `YYYYMMDD`
*   **Special Strings:**
    *   `'now'`: Represents the current date and time in the system's local timezone.
*   **Numeric Formats:**
    *   **Julian Day Number:** Numbers generally between 1,000,000 and 4,000,000 are interpreted as Julian days.
    *   **Unix Epoch:** Other numbers are typically interpreted as seconds since the Unix epoch (1970-01-01 00:00:00 UTC). If the `unixepoch` modifier is used, the number *must* be interpreted as Unix epoch seconds. Ambiguity between large millisecond timestamps and seconds is resolved by prioritizing seconds if the value falls within a reasonable range (approx. 1900-3000 AD).

If parsing fails for any reason, the function generally returns `NULL`.

**Canonicalization for stored column values** (separate from the lenient
SQL-function parsing above): when a value is written into a `DATE`, `TIME`, or
`DATETIME` column, the column's logical type normalizes the input to a single
canonical shape so that equal instants compare equal regardless of how they
were written. For `DATETIME` the canonical form is the bare PlainDateTime
string (`YYYY-MM-DDTHH:MM:SS[.sss]`) in **UTC** — an input with `Z`, a `±HH:MM`
offset, a `[zone]` annotation, or a numeric Unix-millisecond value is
converted to UTC before the zone information is discarded. The SQL functions
listed above retain their existing lenient behavior; only the column-type
`parse` performs this canonicalization.

Canonicalization applies **only to the stored value**, not to a comparison
literal on the read/filter path. A literal in a predicate (`WHERE ts = '…'`) is
compared **raw** (BINARY, byte-for-byte) against the stored canonical value — it
is not parsed or canonicalized first. So a non-canonical literal that denotes the
*same instant* as a stored row does **not** match: `WHERE ts = '2017-07-14T02:40:00Z'`
returns nothing against a row stored as the bare `'2017-07-14T02:40:00'`, even
though both name the same time; only the bare canonical literal
`'2017-07-14T02:40:00'` matches. Range predicates likewise order raw, so the bare
form (a strict prefix of the `Z`-suffixed form) sorts below it. To match reliably,
write the literal in the column's canonical shape (or wrap it so it is stored/cast
first). This raw-comparison contract is pinned by the `dt_filter` / `d_filter` /
`t_filter` cases in `test/logic/98-temporal-edge-cases.sqllogic`.

### Strict Parsing (Epoch Functions)

The `epoch_s`, `epoch_ms`, and `epoch_s_frac` functions use **strict parsing** to avoid the ambiguity inherent in lenient numeric parsing. They accept only:

*   ISO 8601 date/time strings (e.g., `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`, with optional timezone)
*   `'now'`

Bare numbers, time-only strings, and compact formats like `YYYYMMDD` are **rejected** (return `NULL`). To convert a Unix timestamp to a datetime, use `datetime(N, 'unixepoch')` instead.

### Modifiers

The functions support various modifiers (applied sequentially) to adjust the parsed date/time value:

*   **Relative Time:**
    *   `+/- NNN days`
    *   `+/- NNN hours`
    *   `+/- NNN minutes`
    *   `+/- NNN seconds` (Fractional seconds supported)
    *   `+/- NNN months`
    *   `+/- NNN years`
*   **Start/End of Unit:**
    *   `start of day`
    *   `start of month`
    *   `start of year`
*   **Weekday Adjustment:**
    *   `weekday N`: Moves the date *backward* to the last occurrence of weekday N (where N=0 for Sunday, 1 for Monday, ..., 6 for Saturday). If the date is already weekday N, it remains unchanged.
*   **Timezone Control:**
    *   `localtime`: Interprets the `timestring` and performs calculations relative to the system's local timezone. Subsequent formatting (e.g., via `strftime`) will also use the local time.
    *   `utc`: Interprets the `timestring` and performs calculations relative to UTC. Subsequent formatting will use UTC. (This is the default if neither `localtime` nor `utc` is specified).
*   **Special Modifiers:**
    *   `unixepoch`: When present, forces the initial numeric `timestring` value to be interpreted as seconds since the Unix epoch.
    *   `subsec`: When present, `datetime()` and `time()` include fractional seconds (milliseconds) in their output (e.g., `12:30:45.123`). Without this modifier, output is truncated to whole seconds.

Unrecognized modifiers are typically ignored. If applying a modifier causes an error (e.g., invalid numeric value), the function returns `NULL`.

### Return Values

*   `date()`: Returns `YYYY-MM-DD` string.
*   `time()`: Returns `HH:MM:SS` string (or `HH:MM:SS.sss` with `'subsec'` modifier).
*   `datetime()`: Returns `YYYY-MM-DD HH:MM:SS` string (or `YYYY-MM-DD HH:MM:SS.sss` with `'subsec'` modifier).
*   `julianday()`: Returns a floating-point number representing the Julian day.
*   `epoch_s()`: Returns an INTEGER representing Unix epoch seconds.
*   `epoch_ms()`: Returns an INTEGER representing Unix epoch milliseconds.
*   `epoch_s_frac()`: Returns a REAL representing Unix epoch seconds with fractional (millisecond) precision.
*   `strftime(format, ...)`: Returns a string formatted according to the `format` string specifiers (see below).

### `strftime` Formats

The `strftime` function supports the following common format specifiers:

*   `%Y`: Year (e.g., 2023)
*   `%m`: Month (01-12)
*   `%d`: Day of month (01-31)
*   `%H`: Hour (00-23)
*   `%M`: Minute (00-59)
*   `%S`: Second (00-59)
*   `%f`: Fractional seconds (e.g., `.123`) - Currently outputs milliseconds.
*   `%j`: Day of year (001-366)
*   `%w`: Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
*   `%W`: Week of year (ISO 8601 week number, 01-53)
*   `%s`: Seconds since Unix epoch (integer, same as `%E`)
*   `%E`: Seconds since Unix epoch (integer)
*   `%Q`: Milliseconds since Unix epoch (integer)
*   `%%`: Literal `%`

Unsupported specifiers are outputted literally.

## Unix Epoch Functions

The `epoch_s`, `epoch_ms`, and `epoch_s_frac` functions provide clean, unambiguous conversion from datetimes to numeric epoch values. They return numeric types ready for arithmetic — unlike `strftime('%s', ...)` which returns a string.

```sql
-- Seconds (INTEGER)
select epoch_s('2024-01-01 00:00:00');        -- → 1704067200

-- Milliseconds (INTEGER)
select epoch_ms('2024-01-01 00:00:00');       -- → 1704067200000

-- Fractional seconds (REAL)
select epoch_s_frac('2024-07-26 12:30:45.5'); -- → 1721997045.5

-- Duration arithmetic
select epoch_ms('now') - epoch_ms(created_at); -- → elapsed ms

-- Round-trip
select datetime(epoch_s('2024-07-26 12:30:45'), 'unixepoch');
  -- → '2024-07-26 12:30:45'
```

### UTC Caveat

Epoch values are **always relative to UTC**, regardless of timezone modifiers. The `localtime` modifier affects how the timestring is *interpreted* and how arithmetic modifiers are *applied* (e.g., `start of day` in local time), but the final epoch value always represents the absolute instant in UTC. This is correct behavior — Unix epoch is defined as seconds since 1970-01-01 00:00:00 **UTC**.

```sql
-- These return the same value (same absolute instant):
select epoch_s('2024-01-01T00:00:00Z');
select epoch_s('2024-01-01T01:00:00+01:00');
-- Both → 1704067200
```

## Timezones

Calculations involving modifiers are performed using the timezone determined by the `localtime` or `utc` modifiers (defaulting to UTC). `Temporal.ZonedDateTime` handles DST transitions correctly during arithmetic. Formatting via `strftime` respects the determined timezone. `'now'` always uses the system's local time zone.
