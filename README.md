# Nexconn Social — Custom-built public chat (no SDK)

This project replaces Nexconn SDK, Supabase Auth, fixed student IDs, and login forms with a custom Node.js + Express + Socket.IO + PostgreSQL chat application.

## Included
- Public website link; no signup or password form.
- Server-created anonymous guest identity stored in a signed, HTTP-only cookie.
- Real-time chat using Socket.IO (our own server implementation; no chat vendor SDK).
- Create and join public rooms.
- PostgreSQL message and room persistence.
- Live message/guest/room analytics from real database queries.
- Responsive custom interface.
- API rate limiting and basic message validation.
- Render deployment configuration.

## Important capacity note
There is no hard-coded maximum student count, but no website can promise infinitely many simultaneous users. Capacity depends on the Render web service, PostgreSQL connection limits, network, and message rate. The included presence counter is process-local and this single-instance starter does not yet use a Redis Socket.IO adapter for multi-instance presence. For larger traffic, upgrade the hosting/database and add Redis adapter, connection limits, monitoring, and load testing.

## Run locally
1. Install Node.js 20+.
2. Create a PostgreSQL database.
3. Copy `.env.example` to `.env`.
4. Set `SESSION_SECRET` to a long random secret and set `DATABASE_URL`.
5. `npm install`
6. `npm start`
7. Open `http://localhost:3000`.

The app creates the tables and the `general` room automatically.

## Deploy to Render
1. Push this folder to a GitHub repository.
2. In Render choose **New → Blueprint** and select the repository containing `render.yaml`.
3. Render provisions the Node web service and PostgreSQL database. If the free database option is unavailable, select an available PostgreSQL plan.
4. Check environment variables, especially `SESSION_SECRET`, `DATABASE_URL`, and `DATABASE_SSL`.
5. Wait for deploy, then open the generated `onrender.com` URL.
6. Test from two separate browsers/devices: send messages, create a room, join it, and confirm messages persist after refresh.

## Security and moderation before public sharing
Public anonymous chat can attract spam and abuse. Rate limiting is enabled, but before a broad public launch add message reporting, blocking, moderation, retention/deletion policy, stronger per-guest limits, and monitoring. Do not ask students to post personal contact details.
