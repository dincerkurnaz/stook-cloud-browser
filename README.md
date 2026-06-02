# Stook · Cloud Storage Browser

A modern, end-user-friendly browser for **Stook Cloud Storage** and any S3-compatible object storage. Connect from the UI to your storage — credentials never go in env vars or config files.

> Fast, Flexible, S3-Compatible Object Storage — by [Medianova](https://www.medianova.com/product/stook-cloud-storage/).

![status: stable](https://img.shields.io/badge/status-stable-brightgreen) ![docker](https://img.shields.io/badge/runs%20on-Docker-2496ED) ![cross--platform](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-supported-blue)

---

## Highlights

- 🔐 **Sign in from the browser** — endpoint, region, keys, path-style, default bucket. Verified with a real `ListBuckets` call.
- 🚀 **Built for scale** — virtualized list (renders only what's visible), paginated via `ContinuationToken`, batched delete & rename.
- 📂 **Drag & drop** uploads, including dropping entire folders.
- 🧭 Breadcrumbs, multi-bucket picker, sortable columns, multi-select, keyboard navigation.
- 👀 **In-browser preview** for images, video, audio, PDF, text, and code.
- 🔗 **Pre-signed share links** with selectable expiry (1h / 1d / 7d).
- 🌓 Automatic light / dark theme.

---

## Quick Start

The browser runs as a small Docker container. The only thing you need installed is **Docker Desktop** (or Docker Engine on Linux). Works the same on Windows, macOS and Linux.

### 1. Install Docker

| OS         | Get Docker                                                                  |
|------------|-----------------------------------------------------------------------------|
| Windows    | <https://docs.docker.com/desktop/install/windows-install/>                  |
| macOS      | <https://docs.docker.com/desktop/install/mac-install/>                      |
| Linux      | <https://docs.docker.com/engine/install/>                                   |

### 2. Get the code

```bash
git clone https://github.com/dincerkurnaz/stook-cloud-browser.git
cd stook-cloud-browser
```

> Don't have `git`? Download the ZIP from GitHub (green **Code** → **Download ZIP**) and unzip it.

### 3. Start it

**Windows (PowerShell or cmd) / macOS / Linux** — same command:

```bash
docker compose up -d
```

Open **<http://localhost:3000>** in your browser.

### 4. Stop it

```bash
docker compose down
```

---

## Connecting to your storage

When the browser opens you'll see the connection screen. Fill in:

- **Endpoint URL** — your storage endpoint (e.g. `https://s3.your-storage.com`). Reachable **from inside the app container's network**, so for services on your local machine use `host.docker.internal`.
- **Region** — pick from the dropdown or choose *Custom…*.
- **Access key** & **Secret key** — your credentials. Secrets stay only on the server side, never in the browser, never on disk.
- **Path-style** — leave ON (recommended).
- **Default bucket** *(optional)* — which bucket to open by default.

Press **Test & connect**. The form is rejected immediately if the credentials are wrong.

### Want to try it without your real credentials?

A demo storage service is bundled in `docker-compose.yml`. After `docker compose up -d`, use these values in the connect form:

| Field        | Value                  |
|--------------|------------------------|
| Endpoint URL | `http://storage:9000`  |
| Region       | `us-east-1`            |
| Access key   | `stookadmin`           |
| Secret key   | `stookadmin`           |
| Path-style   | on                     |

To run **without** the demo service: `docker compose up -d app`.

---

## Architecture

- **Backend** — Node.js + Express + AWS SDK v3. Per-session S3 client keyed by `HttpOnly` cookie. `forcePathStyle: true` by default.
- **Frontend** — Vanilla JavaScript, no framework. Manual list virtualization (44 px rows, overscan 8). Pages auto-fetched as you scroll.
- **Credentials** — held server-side in memory only, expired after 12 hours of inactivity. The browser optionally remembers endpoint, region and access key in `localStorage` (never the secret).

## API

All endpoints except `/api/connection`, `/api/connect`, `/api/disconnect` require a valid session cookie (`sb_sid`).

| Method   | Path                              | Purpose                                     |
|----------|-----------------------------------|---------------------------------------------|
| `GET`    | `/api/connection`                 | Current session info (or `connected:false`) |
| `POST`   | `/api/connect`                    | Verify credentials and start a session      |
| `POST`   | `/api/disconnect`                 | Clear the session                           |
| `GET`    | `/api/buckets`                    | List buckets                                |
| `POST`   | `/api/buckets`                    | Create a bucket                             |
| `GET`    | `/api/list?bucket&prefix&token`   | List a folder (`Delimiter: /`)              |
| `POST`   | `/api/folder`                     | Create a folder marker                      |
| `POST`   | `/api/upload?bucket&prefix`       | Multipart upload (`multipart/form-data`)    |
| `GET`    | `/api/download?bucket&key&inline` | Stream an object                            |
| `GET`    | `/api/presign?bucket&key&expires` | Pre-signed `GET` URL                        |
| `DELETE` | `/api/object?bucket&key`          | Delete a key (or a prefix recursively)      |
| `DELETE` | `/api/objects`                    | Batch delete (`{ bucket, keys[] }`)         |
| `POST`   | `/api/rename`                     | Server-side copy + delete (folders too)     |

## Configuration

Optional environment variables (none required):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `AUTO_CREATE_BUCKET` | `false` | Auto-create a bucket when first listed/uploaded into |
| `MAX_UPLOAD_SIZE` | `5368709120` | Max upload size per file (bytes) |
| `RENAME_PARALLELISM` | `16` | Concurrency for folder rename copy operations |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_PATH_STYLE` | — | If all set, the app auto-creates a default session and skips the connect screen (for headless deployments). |

## Troubleshooting

- **`http://localhost:3000` doesn't open** — Docker Desktop may not be running. Start it, then re-run `docker compose up -d`.
- **"port 3000 already in use"** — Another service is using it. Change `3000:3000` in `docker-compose.yml` to e.g. `8080:3000` and open `http://localhost:8080`.
- **Connection fails with *SignatureDoesNotMatch*** — Check the access key / secret combination, double-check trailing whitespace.
- **Connection fails with *getaddrinfo / ENOTFOUND*** — The endpoint hostname isn't reachable from the container. For a service on the host machine, use `http://host.docker.internal:<port>` instead of `localhost`.
