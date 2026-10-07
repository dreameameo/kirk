# kerk

Small self-hosted watcher for software releases. It polls GitHub, GitLab or any web page on a schedule, remembers the version it last saw, and pings you when it changes. One process, no runtime dependencies, state in a JSON file, dashboard bundled in.

## Run it

```sh
# from source (Node >= 22)
node src/kerk.js config.json

# Docker
docker compose up -d            # config + state live in ./data

# single binary (embeds the dashboard)
npm run build:binary && ./dist/kerk config.json
```

If the config file doesn't exist, kerk writes a default one and starts with an empty dashboard on http://localhost:8080. Config path: first argument, or `KERK_CONFIG`. See `config.example.json` for every option.

## Config

| key | default | notes |
|---|---|---|
| `listen` | `0.0.0.0:8080` | |
| `dataDir` | `./data` | holds `state.json`; relative to the config file |
| `interval` | `1h` | default poll interval (`30s`, `15m`, `6h`, `1d`; minimum 30s). Override per project. |
| `auth` | disabled | `{enabled, username, password}`: HTTP Basic for UI and API. `/health` stays open. |
| `github.token` | none | raises the GitHub rate limit; `github.apiUrl` for Enterprise |
| `notifiers` | `{}` | named notification targets (below) |
| `projects` | `[]` | things to watch (below) |

Env overrides: `KERK_LISTEN`, `KERK_DATA_DIR`, `KERK_USERNAME`, `KERK_PASSWORD`, `KERK_GITHUB_TOKEN`. Env secrets are never written back to the file. kerk refuses to start with auth enabled and no password. Put it behind HTTPS if it's exposed: Basic auth is only as private as the transport.

**Projects**: `type` is `github` (`repo: owner/name`, optional `prereleases: true`; falls back to the newest tag if there are no releases), `gitlab` (`repo: group/project`, optional `host`), or `url` (`url` + `regex`; capture group 1, or the whole match, is the version). `notify` lists notifier names; omit it to use all of them.

The first check only records a baseline, so adding a project never fires an alert. Alerts fire when the version string changes.

**Notifiers**: `gotify` (`url`, `token`, `priority`), `slack` (incoming webhook `url`), `discord` (webhook `url`), `ntfy` (topic `url`, optional `token`), `telegram` (`token`, `chat_id`), `webhook` (`url`, optional `method`, `headers`, `body`, `secret`). Webhook `body` can be an object or string using `{{project}} {{version}} {{previous}} {{url}} {{title}} {{message}}`; with `secret` set, requests carry `X-Kerk-Signature: sha256=<hmac of body>`.

Adding or removing projects and notifiers in the dashboard rewrites those two sections of the config file, so the file must be writable (mount a directory, not a single file, in Docker).

## API

Base `/api/v1`, JSON in and out, same Basic auth as the UI. Writes must send `Content-Type: application/json`.

```
GET    /projects                  list with current state
POST   /projects                  add (checks immediately)
GET    /projects/:id
POST   /projects/:id/check        check now
DELETE /projects/:id
GET    /notifiers                 secrets are masked
POST   /notifiers                 {name, type, ...fields}
POST   /notifiers/test            test an unsaved config
POST   /notifiers/:name/test      send a test message
DELETE /notifiers/:name
GET    /health                    unauthenticated
```

```sh
curl -u admin:pw -H 'Content-Type: application/json' localhost:8080/api/v1/projects \
  -d '{"name":"Caddy","type":"github","repo":"caddyserver/caddy"}'
```

## Tests

`npm test` starts kerk against mock GitHub/notifier servers and checks baseline, change detection, every notifier type, auth, masking, and config persistence.
