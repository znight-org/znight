# users-api

Users CRUD over HTTP (Express adapter), built on the providers of
[`@znight-examples/shared`](../../packages/shared). Part of the [monorepo example](../../README.md).

```sh
bun run dev                                  # http://localhost:3000 (npm run dev)
bun run build && bun run start               # production build, Node.js or Bun (--runtime)
USERS_SNAPSHOT_FILE=.data/users.json bun run start   # users saved on shutdown, restored at startup
bun run test                                 # TestBed / TestApp
bun run test:e2e                             # + end-to-end on Node.js and Bun, compiled-library flow
```

| Route               | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `GET /users`        | `?limit=20&after=<id>`: a page of users in creation order         |
| `POST /users`       | `{"email", "name"}` → 201 + `location` (409 if the email is used) |
| `GET /users/:id`    | 404 when unknown                                                  |
| `PATCH /users/:id`  | `{"email"?, "name"?}`                                             |
| `DELETE /users/:id` | 204                                                               |
| `GET /health`       | `{"status": "ok", "time", "users"}`                               |

| Variable              | Default | Description                                         |
| --------------------- | ------- | --------------------------------------------------- |
| `PORT`                | `3000`  | HTTP port (`0`: a free port)                        |
| `USERS_SNAPSHOT_FILE` | —       | JSON file restored at startup, saved on shutdown    |
| `API_EXPOSE_ERRORS`   | `false` | Send the message of unexpected errors (development) |
| `LOG_LEVEL`           | `info`  | `debug`, `info`, `warn`...                          |
