# Changelog

All notable changes to izi-queue are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, breaking changes are released as minor versions.

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
[0.4.0]: https://github.com/iagocavalcante/izi-queue/compare/v0.3.0...v0.4.0
