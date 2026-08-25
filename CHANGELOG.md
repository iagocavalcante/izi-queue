# Changelog

All notable changes to izi-queue are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, breaking changes are released as minor versions.

## [Unreleased]

## [0.9.0] - 2026-08-25

### Added

- **Leader election.** One node per cluster is elected leader, and only the
  leader stages jobs and runs the built-in plugins. Previously every node ran
  every plugin and its own stager, so N nodes issued N copies of the same
  `UPDATE`/`DELETE` against `izi_jobs` on every tick -- wasted work at small
  scale, row-lock contention and deadlock risk at larger ones. The lease lives
  in a new `izi_peers` table (one row per scope) and is renewed with a single
  renew-or-take-over statement that the database arbitrates; a leader that
  stops renewing is replaced `ttl` seconds later, and a clean shutdown hands
  the lease back immediately. Configure with `leadership: { name?, interval?,
  ttl? }`, inspect with `IziQueue.isLeader()` / `getLeader()` (and a new
  `isLeader` field on `getQueueStatus`), and observe with the new
  `peer:elected`, `peer:lost` and `peer:error` telemetry events. Followers
  keep polling, fetching and executing jobs exactly as before, and `drain()`
  still stages regardless of leadership. Set `leadership: false` for the old
  behavior; adapters that do not implement `acquireLeadership` get it
  automatically. ([#26])
- **Cron plugin.** `CronPlugin({ crontab, timezone?, interval?,
  maxCatchUpMinutes? })` runs jobs on a schedule, the equivalent of
  `Oban.Plugins.Cron`. Standard five-field expressions with ranges, lists,
  steps and names, plus the `@hourly`/`@daily`/`@midnight`/`@weekly`/
  `@monthly`/`@yearly`/`@annually` aliases; per-entry `args`, `queue`,
  `priority`, `maxAttempts`, `tags` and IANA `timezone`. Evaluation is
  leader-only *and* every insert is unique on `(entry, minute)`, so a
  leadership handover cannot duplicate a run and a fast-finishing job cannot
  be reinserted by the next node to evaluate that minute. A tick delayed past
  its minute catches up on what it skipped, bounded by `maxCatchUpMinutes`.
  Invalid expressions and timezones are rejected when the queue is
  constructed, naming the entry at fault. The parser is also exported on its
  own as `parseCron`/`matchesCron`/`fieldsInTimezone`. No new dependencies.
  ([#27])
- **`unique.scope`**, an opaque discriminator folded into the uniqueness
  digest, so two otherwise identical jobs are only "the same" within the same
  scope -- a tenant, a billing period, a scheduled minute. Exact where a
  `period` window is approximate. Digests computed without a scope are
  unchanged, so unique jobs already in the database keep deduplicating.
- `DatabaseAdapter.acquireLeadership`, `releaseLeadership` and `getLeader`,
  all optional so third-party adapters keep compiling.
- `PluginContext.isLeader` and `BasePlugin.isLeader()`, for gating a custom
  plugin's cluster-wide work the way `LifelinePlugin` and `PrunerPlugin` now
  gate theirs.
- `PluginContext.insert`, so a plugin can enqueue jobs through the owning
  queue's own insert path -- worker defaults, uniqueness and queue wake-up
  included -- rather than reaching past it to `database.insertJob`.
- `PluginContext.logger` and `BasePlugin.log`, so a plugin reports through the
  same sink as the rest of izi-queue instead of `console`.

### Changed

- `getQueueStatus`/`getAllQueueStatus` gained an `isLeader` field. Code
  comparing the returned object with `toEqual` needs updating; property
  access is unaffected.

### Migrations

- PostgreSQL v8, MySQL v7, SQLite v7 create `izi_peers`. They run
  automatically on `migrate()`.

## [0.8.0] - 2026-08-17

### Changed

- **The default retry backoff curve changed** (the reason this is a minor
  version). The old default plateaued at ~17 minutes (`15 + 2^min(attempt, 10)`
  seconds), so the default `maxAttempts: 20` was exhausted within ~3 hours --
  too short to survive a real outage. The default is now Oban's polynomial
  curve, `attempt^4 + 15 + rand(0..10) * attempt` seconds: attempt 20 waits
  ~44.5 hours and the full 20-attempt horizon spans ~8.4 days. Anyone relying
  on the old fast-exhausting timeline can opt back in per worker with
  `backoff: { strategy: 'exponential' }`, and a `maxDelay` cap (seconds)
  applies to either curve. Custom `backoff` functions are unaffected. See the
  README's "Retry horizon" table. ([#34])

### Added

- **Cancelling a job now interrupts it mid-flight.** In-process workers
  receive an `AbortSignal` as a second `perform` argument --
  `perform(job, { signal })` -- which fires on local cancellation and on the
  job's own timeout; isolated (worker-thread) jobs are pre-emptively
  terminated and settle as cancelled without burning a retry. Interruption is
  local to the executing node; the state-transition guard still keeps a job
  cancelled elsewhere from being resurrected. Existing single-argument
  workers are unaffected. ([#30])
- **Job querying API.** `listJobs({ ids?, queue?, worker?, state?, tags?,
  limit?, offset?, orderBy? })` and `countJobs(criteria)` (counts grouped by
  state, every state always present) on `IziQueue` and `DatabaseAdapter`,
  with a whitelisted ordering surface and stable pagination. Tags filtering
  is match-any and works on all three databases; `tags` also became a
  criterion for `cancelJobs`/`retryJobs`. Optional on custom adapters, which
  keep compiling without it. ([#31])
- **`insertAll` is now a real bulk insert.** One chunked multi-row `INSERT`
  per batch inside a single transaction (joining your `tx` when supplied),
  in-batch deduplication of unique jobs, at most one wake-up notification
  per queue, and a new `insertAllWithResult` returning per-entry
  `{ job, conflict }`. A failure rolls the whole batch back. Third-party
  adapters without `insertJobs` fall back to the previous per-row behavior.
  ([#32])
- **Injectable logger.** Pass `logger` (minimal `debug/info/warn/error`
  interface, pino/winston-compatible) to `IziQueueConfig` and to the adapter
  factories. The default preserves the previous console output; reconnect
  progress now logs at `debug`. Staging and fetch failures additionally emit
  `queue:stage_error`/`queue:fetch_error` telemetry. ([#40])

## [0.7.1] - 2026-08-17

### Fixed

- **`drain()` corrupted attempt counts and raced the poller.** It fetched jobs
  (which marks them `executing` and consumes an attempt), forced them back to
  `available`, kicked off an extra poll loop per pass, and could return while
  jobs were still running -- so drained jobs reached `maxAttempts` early and
  nothing was actually guaranteed drained. Modeled on `Oban.drain_queue/2`,
  `drain()` now pauses the queue's poller, executes each job inline through the
  same path the poller uses, and returns a `DrainResult` tally of
  `success`/`failure`/`snoozed`/`discarded`/`cancelled` (previously the return
  carried no information). Drained jobs also record `attemptedBy`, matching
  poller-fetched jobs. ([#36])
- **`pruneJobs` and `stageJobs` ran as single unbounded statements.** The first
  prune after a long stretch of traffic was one `DELETE` over the whole
  backlog -- a long, heavily-locking transaction -- and a large batch of jobs
  all becoming due at once was one `UPDATE` blocking every concurrent fetch.
  Both now work in bounded batches (default 5000 rows per statement), looping
  until caught up and yielding to the event loop between batches, with the
  MySQL batch query written to avoid `ERROR 1093`. Tune with
  `PrunerConfig.batchSize` and `stageBatchSize` on `IziQueue`'s config. Custom
  adapters implementing the previous `pruneJobs`/`stageJobs` signatures keep
  working unchanged. ([#29])

## [0.7.0] - 2026-08-04

### Fixed

- **Isolated jobs failed when the thread pool was full.** A job arriving while
  every thread was busy came back with `No available worker threads`, which the
  queue recorded as a failure and charged one of the job's retry attempts --
  for something the job had no part in. Any queue whose concurrency exceeded
  `maxThreads` hit this routinely. Jobs now wait for a thread. The job's
  `timeout` covers the wait as well as the execution, so a saturated pool
  cannot leave work outstanding indefinitely, and giving up while queued
  reports a distinct error rather than looking like an execution failure.
  ([#22])
- **`resourceLimits` were never applied.** They were typed, documented and
  passed in, but the pool created every thread with no limits, so isolated
  workers ran without the memory cap that is the main reason to isolate them at
  all. Limits are now applied when the thread is created, and the pool is
  partitioned by them so a job never lands on a thread with the wrong caps.
  ([#23])
- **The PostgreSQL notification listener never recovered from a dropped
  connection.** After a failover, an idle-connection reaper or a network blip,
  the listener stopped receiving notifications permanently and the queue
  degraded to poll-only with nothing to indicate it. The listener now
  re-subscribes with backoff, and reports the disconnect through telemetry.
  Verified by terminating its backend mid-test and asserting notifications
  resume. ([#24])

## [0.6.0] - 2026-08-04

### Fixed

- **Worker isolation never worked outside the test runner.** The published
  package is ESM-only, and the worker path resolver called `require('fs')`
  unconditionally, so every isolated job failed with `require is not defined`.
  The unit tests stayed green because Jest transpiles to CommonJS, where
  `require` exists -- they never exercised the shipped artifact. Resolution now
  uses `import.meta.url`, and CI runs a real isolated job through the packed
  tarball in an ESM project, which is the only place this class of breakage is
  visible.

### Added

- **Transactional inserts.** Pass your open transaction as `tx` and the job is
  committed or discarded atomically with your business write:

  ```typescript
  await client.query('BEGIN');
  const { rows } = await client.query('INSERT INTO orders ... RETURNING id');
  await queue.insert('send_receipt', { args: { orderId: rows[0].id }, tx: client });
  await client.query('COMMIT');
  ```

  This closes the gap that made the README's original "ACID guarantees" claim
  false: every insert previously committed on its own connection, so a job could
  outlive a rolled-back write, or become visible to a worker before the row it
  referred to. ([#21])

  On PostgreSQL the wake-up notification is issued on the caller's connection,
  so `NOTIFY` inherits the transaction's fate -- deferred until commit, dropped
  on rollback. Unique inserts also participate: the advisory lock is
  transaction-scoped, so it is held until the caller commits.

  MySQL **refuses** `unique` inside a caller-managed transaction rather than
  silently weakening it. `GET_LOCK` is connection-scoped and cannot be held
  across the caller's commit, which would reopen the duplicate-insert race that
  atomic insertion exists to close.

### Changed

- `DatabaseAdapter.insertJob`, `insertUnique` and `notify` accept an optional
  transaction handle. All three parameters are optional, so existing adapters
  continue to compile.

## [0.5.0] - 2026-08-04

### Fixed

- **`stop()` left its grace-period timer pending.** The shutdown races running
  jobs against a timer, and when the jobs won -- the normal case -- the timer
  was never cleared. A process that drained in a second still kept the event
  loop alive for the full grace period, 15 seconds by default, before it could
  exit. Found while removing `forceExit` from the test runner.
- **Snoozing consumed a retry attempt.** The attempt is claimed at fetch time,
  and snoozing did not compensate, so a job that snoozed while waiting on an
  external condition was eventually discarded having never failed once. Snooze
  now raises `max_attempts` to match, as Oban does. ([#28])
- **A finishing worker could resurrect a cancelled job.** Result writes went
  straight to `updateJob` with no check on the job's current state, so a job
  cancelled while executing was silently marked completed when its worker
  returned. Transitions are now arbitrated by the database -- the update only
  lands if the job is still in a state the transition is legal from, and a
  refusal emits `job:transition_refused`. The state machine was already declared
  and unit-tested; it was simply never consulted. ([#35])
- **Jobs with an unregistered worker were retried for hours.** The outcome is
  deterministic, so they are now discarded immediately with a
  `job:unknown_worker` event instead of occupying fetch slots through 20
  backoffs. ([#33])
- **The pruner reported deleted rows as completed jobs.** It emitted
  `job:complete` with no job attached, corrupting any metric counting
  completions. It now emits `jobs:pruned`. ([#39])
- **Unique job keys could alter the SQL they were looked up with.** `unique.keys`
  entries were interpolated straight into the query in all three adapters. Keys
  are now hashed in JavaScript and never reach a query, so the injection vector
  is gone rather than merely parameterised. ([#18])
- **Unique jobs were not actually unique.** The check and the insert were
  separate statements with no lock, so concurrent callers all saw "no conflict"
  and all inserted. Measured on PostgreSQL: 20 simultaneous inserts of the same
  unique job produced **3 rows**. They now produce exactly one, guarded by an
  advisory lock on PostgreSQL, `GET_LOCK` on MySQL, and an immediate transaction
  on SQLite. ([#19])
- **Jobs with payloads over roughly 2.7KB could not be inserted on PostgreSQL.**
  A btree index covered the raw `args` column, and a JSONB value that does not
  compress below the btree entry limit fails the insert outright with
  `index row size N exceeds btree version 4 maximum 2704`. The index is now on a
  fixed-width digest. ([#20])
- **Duplicate detection disagreed between adapters.** SQLite compared serialized
  JSON, so `{a:1,b:2}` and `{b:2,a:1}` were different jobs; PostgreSQL compared
  JSONB and considered them the same. All adapters now agree, because the
  comparison happens on a canonicalized digest computed before the query.
  ([#45])
- **Concurrent boots could crash on migrations.** Two instances starting at once
  both saw the same version missing, both applied it, and the second failed on
  the primary key -- so a rolling deploy could kill a fresh node. Migrations now
  hold an advisory lock. Verified with 6 simultaneous migrators. ([#25])
- **Migration SQL is no longer split on `;`.** Statements are declared as
  arrays, so a future migration containing a function body, trigger, or a
  semicolon inside a string literal will not be silently torn in half. ([#25])

### Added

- **Continuous integration.** Build, lint and typecheck, plus the full suite on
  Node 18, 20, 22 and 24 against real PostgreSQL and MySQL service containers,
  a matrix over the supported `better-sqlite3` majors, and a job that packs the
  tarball and installs it into a clean project. Nothing enforced any of this
  before, which is how retries stayed broken across two releases, how MySQL
  shipped untested, and how the peer range drifted out of date. ([#42])
- `pretest` builds before running the suite, so `npm test` works on a clean
  checkout. The isolation tests load the compiled worker thread and previously
  failed with 16 opaque errors until someone thought to build first. ([#42])
- `cancelJob(id)` and `retryJob(id)`, plus `retryJobs(criteria)`. Retrying a job
  that had exhausted its attempts raises `max_attempts` so it can actually run
  rather than being discarded again on its next fetch. ([#30])
- Bulk operations accept `ids` and require at least one criterion. `cancelJobs({})`
  previously cancelled every non-terminal job in the database, which a handler
  forwarding optional filters would do when called with none of them. Acting on
  everything now requires an explicit `{ all: true }`. ([#30])
- `updateJob` accepts an optional list of expected source states.
- Telemetry: `job:retry`, `job:unknown_worker`, `job:transition_refused`,
  `jobs:pruned`.
- `computeUniqueKey` and `advisoryLockKey` are exported for adapter authors.
- `DatabaseAdapter.insertUnique`, an atomic insert-if-absent. Optional, so
  existing adapters keep working; those that do not implement it fall back to
  the previous non-atomic path.
- `Job.uniqueKey` records the digest a unique job was inserted under.

### Changed

- **Tests wait on conditions instead of sleeping.** Fixed-duration sleeps were
  betting that work finished inside a guessed window, which fails intermittently
  on a loaded machine and makes every run pay the full duration regardless. The
  retry and lifecycle suites went from about nine seconds to 1.6, and no longer
  depend on wall-clock timing. ([#41])
- `forceExit` is gone from the Jest config, so a leaked handle now fails loudly
  instead of being papered over. Two were found and fixed in the process: the
  grace-period timer above, and a test that abandoned a running job without
  releasing it. ([#41])

### Breaking

- `cancelJobs({})` now throws instead of cancelling every job. Pass
  `{ all: true }` for the old behaviour.
- The pruner no longer emits `job:complete`. Anything counting prune runs
  through that event should move to `jobs:pruned`.
- **Uniqueness now only considers jobs that were themselves inserted with
  `unique` options.** Previously a job enqueued without `unique` could block a
  later unique insert, because the comparison was made against raw args. A
  plain insert now carries no unique key and does not participate. Two unique
  inserts still deduplicate, and now do so atomically. This matches Oban, where
  uniqueness is a property of how a job was enqueued.
- `Job.uniqueKey` is a required field on the `Job` interface. Code constructing
  `Job` literals must add it; use `uniqueKey: null`.
- `Migration.up` and `Migration.down` are `string[]` rather than `string`. Only
  affects code importing the migration definitions directly.

### Migrations

- PostgreSQL 7, SQLite 6, MySQL 6 -- add `unique_key`, index it, and drop the
  index over raw `args`.

## [0.4.1] - 2026-08-04

### Fixed

- **`npm install izi-queue better-sqlite3` failed.** The `better-sqlite3` peer
  range was `^9.0.0` while the library is developed and tested against v12, so
  npm either resolved a version with no prebuilt binary for current Node (which
  fails to compile) or refused the install with `ERESOLVE`. The range is now
  `>=9.0.0 <14.0.0`. Verified against 11.10.0, 12.11.1 and 13.0.2; v9 and v10
  cannot be built on Node 24 to test, but remain within the declared range so
  that existing installs on older Node are not broken. ([#50])
- **Claimed jobs were handed to the executor in arbitrary order** on PostgreSQL
  and MySQL, so a high-priority job could start after a low-priority one from
  the same batch. Priority still governed which jobs were claimed, but not the
  order they ran. PostgreSQL `RETURNING` follows physical update order rather
  than the subquery's `ORDER BY`, and the MySQL adapter's post-claim `SELECT`
  had no `ORDER BY` at all. Both now order by priority, schedule and id, which
  is what SQLite already did. Found by the new MySQL coverage below.
- Worker execution timeout timers are now cleared when a job settles, instead
  of being retained for the full timeout. Thanks to @gentosai404. ([#38], [#47])

### Added

- Test coverage for the MySQL adapter against a real server, enabled by setting
  `IZI_TEST_MYSQL_URL`. MySQL previously had no automated tests at all despite
  being listed as production ready.

## [0.4.0] - 2026-08-04

Three defects in this release could each cause data loss or an outage in
production. Anyone running 0.3.0 or earlier should upgrade.

### Fixed

- **Retries never ran.** Failed jobs were moved to `retryable`, but the stager
  only ever promoted `scheduled`, so no job was retried and `maxAttempts` was
  effectively 1. Every job that failed once was lost. ([#15])
- **Poll loops accumulated without bound.** Each `dispatch()` started another
  self-perpetuating poll loop instead of replacing the pending one. With
  PostgreSQL `LISTEN`/`NOTIFY` that is one extra loop per insert, per node, so
  the query rate grew with every job ever enqueued until the database
  saturated. ([#16])
- **Concurrency limits were not enforced under load.** Concurrent polls each
  sized their fetch from a stale in-flight count, so a queue configured with
  `limit: 3` could run 60 jobs at once. ([#16])
- **Healthy long-running jobs were executed twice.** The Lifeline plugin
  returned any job executing for longer than `rescueAfter` to the queue,
  with no way to distinguish an orphan left by a crashed node from a job
  still running on a live one. Any worker whose `timeout` exceeded
  `rescueAfter` was guaranteed to double-execute. ([#17])
- **A failure while persisting a job result crashed the process.** The
  rejection escaped `execute()` with nothing to await it, so a transient
  database error took the node down. ([#16])
- **Jobs could start after shutdown.** A poll in flight when `stop()` was
  called handed its claimed jobs off after shutdown had resolved, escaping
  the grace period and running against a closing connection. ([#16])

### Added

- Job ownership: jobs record the node that claimed them in `attempted_by`,
  and each running instance maintains a row in a new `izi_nodes` table.
  Orphan rescue uses this to leave jobs on live nodes alone.
- `IziQueueConfig.heartbeatInterval` (default 15000ms) controls how often a
  node refreshes its liveness record. A node is presumed dead after four
  missed beats, minimum 60 seconds.
- `DatabaseAdapter.heartbeat(node)` and `DatabaseAdapter.removeNode(node)`,
  both optional.
- Test coverage for the PostgreSQL adapter against a real server, enabled by
  setting `IZI_TEST_POSTGRES_URL`. `pg` was previously only an optional peer
  dependency and no test had ever executed this adapter.

### Changed

- Orphaned jobs whose attempts are exhausted are now discarded rather than
  returned to the queue, matching what happens when a worker fails normally.
- `DatabaseAdapter.fetchJobs` accepts an optional `node` argument, and
  `rescueStuckJobs` an optional `nodeTtl`. Both are optional, so existing
  adapter implementations continue to compile.

### Migrations

`migrate()` applies these automatically on upgrade:

- PostgreSQL 5 — widen the stager index to cover `retryable`
- PostgreSQL 6 — add `attempted_by` and the `izi_nodes` table
- SQLite 5, MySQL 5 — add `attempted_by` and the `izi_nodes` table

### Breaking

- `Job.attemptedBy` is a required field. Code that constructs `Job` object
  literals — custom adapters, test fixtures — must add it. Add
  `attemptedBy: null` for jobs that have not been attempted.

### Known limitations

- The MySQL adapter is not covered by automated tests. Its SQL mirrors the
  tested PostgreSQL and SQLite implementations but has not been executed
  against a MySQL server.
- A worker that blocks the event loop for longer than the node TTL stops the
  heartbeat and can still be treated as dead. Use isolated workers for
  CPU-bound work.

[#15]: https://github.com/iagocavalcante/izi-queue/issues/15
[#16]: https://github.com/iagocavalcante/izi-queue/issues/16
[#17]: https://github.com/iagocavalcante/izi-queue/issues/17
[#18]: https://github.com/iagocavalcante/izi-queue/issues/18
[#19]: https://github.com/iagocavalcante/izi-queue/issues/19
[#20]: https://github.com/iagocavalcante/izi-queue/issues/20
[#25]: https://github.com/iagocavalcante/izi-queue/issues/25
[#21]: https://github.com/iagocavalcante/izi-queue/issues/21
[#22]: https://github.com/iagocavalcante/izi-queue/issues/22
[#23]: https://github.com/iagocavalcante/izi-queue/issues/23
[#24]: https://github.com/iagocavalcante/izi-queue/issues/24
[#28]: https://github.com/iagocavalcante/izi-queue/issues/28
[#41]: https://github.com/iagocavalcante/izi-queue/issues/41
[#42]: https://github.com/iagocavalcante/izi-queue/issues/42
[#30]: https://github.com/iagocavalcante/izi-queue/issues/30
[#33]: https://github.com/iagocavalcante/izi-queue/issues/33
[#35]: https://github.com/iagocavalcante/izi-queue/issues/35
[#38]: https://github.com/iagocavalcante/izi-queue/issues/38
[#39]: https://github.com/iagocavalcante/izi-queue/issues/39
[#45]: https://github.com/iagocavalcante/izi-queue/issues/45
[#47]: https://github.com/iagocavalcante/izi-queue/pull/47
[#50]: https://github.com/iagocavalcante/izi-queue/issues/50
[#29]: https://github.com/iagocavalcante/izi-queue/issues/29
[#36]: https://github.com/iagocavalcante/izi-queue/issues/36
[#31]: https://github.com/iagocavalcante/izi-queue/issues/31
[#32]: https://github.com/iagocavalcante/izi-queue/issues/32
[#34]: https://github.com/iagocavalcante/izi-queue/issues/34
[#40]: https://github.com/iagocavalcante/izi-queue/issues/40
[#26]: https://github.com/iagocavalcante/izi-queue/issues/26
[#27]: https://github.com/iagocavalcante/izi-queue/issues/27
[0.4.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.3.0...v0.4.0
[0.4.1]: https://github.com/iagocavalcante/izi-queue/compare/v0.4.0...v0.4.1
[0.5.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.4.1...v0.5.0
[0.6.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.5.0...v0.6.0
[0.7.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.6.0...v0.7.0
[0.7.1]: https://github.com/iagocavalcante/izi-queue/compare/v0.7.0...v0.7.1
[0.9.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.7.1...v0.8.0
