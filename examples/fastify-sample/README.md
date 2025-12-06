# Fastify + izi-queue Sample

A sample Fastify application demonstrating izi-queue with SQLite for background job processing.

## Setup

```bash
# Install dependencies
npm install

# Build izi-queue (from root)
cd ../..
npm run build
cd examples/fastify-sample

# Start the server
npm start
```

## API Endpoints

### Health Check

```bash
curl http://localhost:3000/health
```

### Queue Jobs

**Send Email:**
```bash
curl -X POST http://localhost:3000/jobs/email \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "subject": "Hello", "body": "World"}'
```

**Generate Report:**
```bash
curl -X POST http://localhost:3000/jobs/report \
  -H "Content-Type: application/json" \
  -d '{"reportType": "monthly", "userId": 123}'
```

**Send Notification:**
```bash
curl -X POST http://localhost:3000/jobs/notification \
  -H "Content-Type: application/json" \
  -d '{"userId": 123, "message": "Your order shipped!", "type": "info"}'
```

**Unique Email (prevents duplicates):**
```bash
curl -X POST http://localhost:3000/jobs/unique-email \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "subject": "Welcome", "body": "Hello!"}'
```

**Schedule Future Job:**
```bash
curl -X POST http://localhost:3000/jobs/scheduled \
  -H "Content-Type: application/json" \
  -d '{"worker": "SendEmail", "args": {"to": "user@example.com", "subject": "Delayed"}, "delaySeconds": 60}'
```

### Job Management

**Get Job Status:**
```bash
curl http://localhost:3000/jobs/1
```

**Cancel Jobs:**
```bash
# Cancel all SendEmail jobs
curl -X DELETE "http://localhost:3000/jobs?worker=SendEmail"

# Cancel all jobs in email queue
curl -X DELETE "http://localhost:3000/jobs?queue=email"
```

### Queue Management

**Pause Queue:**
```bash
curl -X POST http://localhost:3000/queues/email/pause
```

**Resume Queue:**
```bash
curl -X POST http://localhost:3000/queues/email/resume
```

**Scale Queue:**
```bash
curl -X POST http://localhost:3000/queues/email/scale \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}'
```

## Features Demonstrated

- **Multiple Queues**: email, reports, notifications, default
- **Worker Results**: ok, error, snooze
- **Unique Jobs**: Prevent duplicate emails to same recipient
- **Scheduled Jobs**: Delay job execution
- **Telemetry**: Job lifecycle logging
- **Plugins**: Lifeline (rescue stuck jobs), Pruner (cleanup old jobs)
- **Queue Control**: Pause, resume, scale dynamically
- **Graceful Shutdown**: Proper cleanup on SIGTERM/SIGINT

## Project Structure

```
fastify-sample/
├── src/
│   ├── server.js    # Fastify server with routes
│   └── workers.js   # Worker definitions
├── package.json
├── queue.db         # SQLite database (created on first run)
└── README.md
```
