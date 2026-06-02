# Stook · Cloud Storage Browser

A modern, end-user-friendly web browser for [**Stook Cloud Object Storage**](https://www.medianova.com/product/stook-cloud-storage/) — Medianova's fast, secure, and scalable S3-compatible object storage.

> *Stook: Cloud Object Storage — A fast, secure, and scalable cloud object storage solution by Medianova.*

Customers connect from the browser using the Access Key, Secret Key and Endpoint provided in their Medianova customer panel — no config files, no env vars, no CLI.

![status: stable](https://img.shields.io/badge/status-stable-brightgreen) ![docker](https://img.shields.io/badge/runs%20on-Docker-2496ED) ![cross--platform](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-supported-blue)

---

## What you can do

- 🔐 **Sign in from the browser** with your Stook Access Key & Secret Key — verified by a real `ListBuckets` call.
- 📁 **Browse, upload, download, rename, delete** files and folders across your Stook buckets.
- 📂 **Drag & drop** files and entire folders for upload (recursive, parallel).
- 🔗 **Pre-signed share links** with selectable expiry (1 hour / 1 day / 7 days).
- 👀 **In-browser preview** for images, video, audio, PDF, text, and code.
- 🧭 Breadcrumbs, multi-bucket picker, sortable columns, multi-select, keyboard navigation.
- 🚀 Virtualized list — buckets with hundreds of thousands of objects feel instant.
- 🌓 Automatic light / dark theme.

---

## Quick Start (Windows · macOS · Linux)

Customers only need **Docker Desktop** (or Docker Engine on Linux). The same command runs everywhere.

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

### 3. Start the browser

**Windows (PowerShell or cmd) · macOS · Linux** — same command:

```bash
docker compose up -d
```

Open **<http://localhost:3000>** in any browser.

### 4. Stop it

```bash
docker compose down
```

---

## Connecting to your Stook bucket

When the browser opens you'll see the connection screen. Fill it in using the credentials from your **Medianova customer panel → Stook → Credentials** page:

| Field          | Where to find it                                                                |
|----------------|---------------------------------------------------------------------------------|
| Endpoint URL   | The **Endpoint** value on the *Stook Credentials* page, e.g. `https://xxxxx.mncdn.com` |
| Region         | `us-east-1` (default — leave as-is)                                             |
| Access key     | The **Access Key** shown on the *Stook Credentials* page                        |
| Secret key     | The **Secret Key** — you must re-enter your customer-panel password to view it  |
| Path-style     | On (recommended)                                                                |
| Default bucket | *(optional)* — the bucket name you want to open by default                      |

Press **Test & connect**. If anything is wrong (typo in the keys, wrong endpoint), you'll see the exact error from Stook on the form — nothing is stored.

> 💡 The secret never leaves the server's memory; the browser only sees the endpoint, region and access key (and only if you tick *Remember on this browser*).

---

## How customers get the credentials

From the Medianova panel:

1. Go to **Stook → Credentials**.
2. Click **Create Credentials** (or pick an existing one).
3. Copy the **Access Key**.
4. Re-enter your panel password and copy the **Secret Key**.
5. Copy the **Endpoint URL** shown on the same page.

That's it — paste those three values into the browser's connect screen and press *Test & connect*.

---

## Under the hood

- **Backend** — Node.js + Express + AWS SDK v3. Per-session S3 client keyed by an `HttpOnly` cookie. Path-style addressing (`forcePathStyle: true`) by default.
- **Frontend** — Vanilla JavaScript, no framework. Manual list virtualization (44 px rows, 8-row overscan). Pages auto-fetched as you scroll, using S3 `ContinuationToken`.
- **Credentials** — held server-side in memory only, expire after 12 hours of inactivity. Optionally, the browser remembers your endpoint, region and access key in `localStorage` (never the secret).

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
| `AUTO_CREATE_BUCKET` | `false` | Auto-create a bucket on first list/upload |
| `MAX_UPLOAD_SIZE` | `5368709120` | Max upload size per file (bytes) |
| `RENAME_PARALLELISM` | `16` | Concurrency for folder rename operations |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` / `S3_PATH_STYLE` | — | If all set, the app auto-creates a default session and skips the connect screen (for headless deployments). |

## Troubleshooting

- **`http://localhost:3000` doesn't open** — make sure Docker Desktop is running, then re-run `docker compose up -d`.
- **"port 3000 already in use"** — another service is using it. Change `3000:3000` in `docker-compose.yml` to e.g. `8080:3000` and open `http://localhost:8080`.
- **Connection fails with *SignatureDoesNotMatch*** — re-check the Access Key and Secret Key for trailing whitespace.
- **Connection fails with *getaddrinfo / ENOTFOUND*** — re-check the Endpoint URL from the Medianova panel. It should look like `https://xxxxx.mncdn.com`.

---

Support & questions: <https://www.medianova.com/contact/>
