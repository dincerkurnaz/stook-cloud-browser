import express from 'express';
import busboy from 'busboy';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  ListBucketsCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const ENV_ENDPOINT = process.env.S3_ENDPOINT;
const ENV_REGION = process.env.S3_REGION || 'us-east-1';
const ENV_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const ENV_SECRET_KEY = process.env.S3_SECRET_KEY;
const ENV_BUCKET = process.env.S3_BUCKET || '';
const ENV_PATH_STYLE = (process.env.S3_PATH_STYLE || 'true') === 'true';
const AUTO_CREATE_BUCKET = (process.env.AUTO_CREATE_BUCKET || 'false') === 'true';
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || String(5 * 1024 * 1024 * 1024), 10);
const RENAME_PARALLELISM = parseInt(process.env.RENAME_PARALLELISM || '16', 10);
const COOKIE_NAME = 'sb_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

const sessions = new Map(); // sid -> { client, info, expiresAt, bucketReady:Set }

function buildClient({ endpoint, region, accessKey, secretKey, pathStyle }) {
  return new S3Client({
    endpoint: endpoint || undefined,
    region: region || 'us-east-1',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: pathStyle !== false,
  });
}

function publicInfo(info) {
  return {
    endpoint: info.endpoint || null,
    region: info.region,
    pathStyle: !!info.pathStyle,
    defaultBucket: info.defaultBucket || '',
    accessKey: info.accessKey ? info.accessKey.slice(0, 4) + '…' + info.accessKey.slice(-2) : '',
    source: info.source || 'user',
  };
}

function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function newSession(info) {
  const sid = crypto.randomBytes(24).toString('hex');
  const client = buildClient(info);
  sessions.set(sid, { client, info, bucketReady: new Set(), expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(sid); return null; }
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  return s;
}

let envSessionId = null;
function ensureEnvSession() {
  if (!ENV_ACCESS_KEY || !ENV_SECRET_KEY) return null;
  if (envSessionId && sessions.has(envSessionId)) return envSessionId;
  envSessionId = newSession({
    endpoint: ENV_ENDPOINT,
    region: ENV_REGION,
    accessKey: ENV_ACCESS_KEY,
    secretKey: ENV_SECRET_KEY,
    pathStyle: ENV_PATH_STYLE,
    defaultBucket: ENV_BUCKET,
    source: 'env',
  });
  return envSessionId;
}

function requireSession(req, res, next) {
  const cookies = parseCookies(req);
  let sid = cookies[COOKIE_NAME];
  let session = getSession(sid);
  if (!session) {
    sid = ensureEnvSession();
    if (sid) {
      session = getSession(sid);
      setSessionCookie(res, sid);
    }
  }
  if (!session) return res.status(401).json({ error: 'Not connected', code: 'NoSession' });
  req.session = session;
  req.s3 = session.client;
  next();
}

function normalizePrefix(p) {
  if (!p) return '';
  let v = String(p).replace(/^\/+/, '');
  if (v && !v.endsWith('/')) v += '/';
  return v;
}

function basename(key) {
  const cleaned = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = cleaned.lastIndexOf('/');
  return i === -1 ? cleaned : cleaned.slice(i + 1);
}

function copySource(bucket, key) {
  return `/${bucket}/${key.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
}

function safeError(res, err, status = 500) {
  const httpStatus = err.$metadata?.httpStatusCode || status;
  console.error('[error]', err.name, err.message);
  res.status(httpStatus).json({ error: err.message || String(err), code: err.name || 'Error' });
}

async function ensureBucket(req, bucket) {
  if (req.session.bucketReady.has(bucket)) return;
  try {
    await req.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    req.session.bucketReady.add(bucket);
    return;
  } catch (err) {
    if (!AUTO_CREATE_BUCKET) throw err;
  }
  try {
    await req.s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
  }
  req.session.bucketReady.add(bucket);
}

async function parallelMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

/* ---- connection management ---- */

app.get('/api/connection', (req, res) => {
  const cookies = parseCookies(req);
  let session = getSession(cookies[COOKIE_NAME]);
  if (!session) {
    const envSid = ensureEnvSession();
    if (envSid) {
      session = getSession(envSid);
      setSessionCookie(res, envSid);
    }
  }
  if (!session) return res.json({ connected: false, hasEnv: false });
  res.json({ connected: true, ...publicInfo(session.info) });
});

app.post('/api/connect', async (req, res) => {
  const { endpoint, region, accessKey, secretKey, pathStyle, defaultBucket } = req.body || {};
  if (!accessKey || !secretKey) return res.status(400).json({ error: 'Access key and secret key required' });
  const info = {
    endpoint: endpoint?.trim() || undefined,
    region: (region || 'us-east-1').trim(),
    accessKey: accessKey.trim(),
    secretKey: secretKey.trim(),
    pathStyle: pathStyle !== false,
    defaultBucket: (defaultBucket || '').trim(),
    source: 'user',
  };
  // verify by listing buckets
  const client = buildClient(info);
  try {
    await client.send(new ListBucketsCommand({}));
  } catch (err) {
    return safeError(res, err, 400);
  }
  // replace any existing session for this cookie
  const cookies = parseCookies(req);
  const oldSid = cookies[COOKIE_NAME];
  if (oldSid && sessions.has(oldSid)) sessions.delete(oldSid);
  const sid = newSession(info);
  setSessionCookie(res, sid);
  res.json({ connected: true, ...publicInfo(info) });
});

app.post('/api/disconnect', (req, res) => {
  const cookies = parseCookies(req);
  const sid = cookies[COOKIE_NAME];
  if (sid) sessions.delete(sid);
  if (sid === envSessionId) envSessionId = null;
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ---- everything below requires a session ---- */

app.use('/api', (req, res, next) => {
  if (req.path === '/connection' || req.path === '/connect' || req.path === '/disconnect') return next();
  return requireSession(req, res, next);
});

app.get('/api/buckets', async (req, res) => {
  try {
    const out = await req.s3.send(new ListBucketsCommand({}));
    res.json({ buckets: (out.Buckets || []).map((b) => ({ name: b.Name, createdAt: b.CreationDate })) });
  } catch (err) { safeError(res, err); }
});

app.post('/api/buckets', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(name)) {
    return res.status(400).json({ error: 'Invalid bucket name' });
  }
  try {
    await req.s3.send(new CreateBucketCommand({ Bucket: name }));
    req.session.bucketReady.add(name);
    res.json({ ok: true, name });
  } catch (err) { safeError(res, err); }
});

app.get('/api/list', async (req, res) => {
  const bucket = req.query.bucket || req.session.info.defaultBucket;
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  const prefix = normalizePrefix(req.query.prefix || '');
  const token = req.query.token || undefined;
  try {
    await ensureBucket(req, bucket);
    const out = await req.s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, Delimiter: '/',
      ContinuationToken: token, MaxKeys: 1000,
    }));
    const folders = (out.CommonPrefixes || []).map((p) => ({
      type: 'folder', key: p.Prefix, name: basename(p.Prefix),
    }));
    const files = (out.Contents || [])
      .filter((o) => o.Key !== prefix)
      .map((o) => ({
        type: 'file', key: o.Key, name: basename(o.Key),
        size: o.Size, lastModified: o.LastModified, etag: o.ETag,
      }));
    res.json({
      bucket, prefix, folders, files,
      nextToken: out.IsTruncated ? out.NextContinuationToken : null,
    });
  } catch (err) { safeError(res, err); }
});

app.post('/api/folder', async (req, res) => {
  const { bucket = req.session.info.defaultBucket, prefix = '', name } = req.body || {};
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  if (!name || /[\/\\]/.test(name)) return res.status(400).json({ error: 'Invalid folder name' });
  try {
    await ensureBucket(req, bucket);
    const key = normalizePrefix(prefix) + name + '/';
    await req.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: '', ContentType: 'application/x-directory' }));
    res.json({ ok: true, key });
  } catch (err) { safeError(res, err); }
});

app.post('/api/upload', async (req, res) => {
  const bucket = req.query.bucket || req.session.info.defaultBucket;
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  const prefix = normalizePrefix(req.query.prefix || '');
  try { await ensureBucket(req, bucket); } catch (err) { return safeError(res, err); }

  const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE } });
  const uploaded = [];
  const pending = [];
  let aborted = false;

  bb.on('file', (_field, file, info) => {
    const relPath = info.filename;
    const key = prefix + relPath;
    const upload = new Upload({
      client: req.s3,
      params: { Bucket: bucket, Key: key, Body: file, ContentType: info.mimeType || 'application/octet-stream' },
      queueSize: 4, partSize: 8 * 1024 * 1024,
    });
    pending.push(upload.done()
      .then(() => uploaded.push({ key, name: relPath }))
      .catch((e) => { aborted = true; file.resume(); throw e; }));
  });
  bb.on('finish', async () => {
    try {
      await Promise.all(pending);
      if (aborted) throw new Error('Upload aborted');
      res.json({ ok: true, uploaded });
    } catch (err) { safeError(res, err); }
  });
  bb.on('error', (err) => safeError(res, err));
  req.pipe(bb);
});

app.get('/api/download', async (req, res) => {
  const bucket = req.query.bucket || req.session.info.defaultBucket;
  const key = req.query.key;
  if (!bucket || !key) return res.status(400).json({ error: 'bucket and key required' });
  try {
    const head = await req.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const obj = await req.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    res.setHeader('Content-Type', head.ContentType || 'application/octet-stream');
    if (head.ContentLength) res.setHeader('Content-Length', head.ContentLength);
    const inline = req.query.inline === '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(key))}"`);
    obj.Body.pipe(res);
  } catch (err) { safeError(res, err); }
});

app.get('/api/presign', async (req, res) => {
  const bucket = req.query.bucket || req.session.info.defaultBucket;
  const key = req.query.key;
  const expires = Math.min(parseInt(req.query.expires || '3600', 10), 7 * 24 * 3600);
  if (!bucket || !key) return res.status(400).json({ error: 'bucket and key required' });
  try {
    const url = await getSignedUrl(req.s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expires });
    res.json({ url, expiresIn: expires });
  } catch (err) { safeError(res, err); }
});

app.delete('/api/object', async (req, res) => {
  const bucket = req.query.bucket || req.session.info.defaultBucket;
  const key = req.query.key;
  if (!bucket || !key) return res.status(400).json({ error: 'bucket and key required' });
  try {
    if (key.endsWith('/')) await deletePrefix(req.s3, bucket, key);
    else await req.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    res.json({ ok: true });
  } catch (err) { safeError(res, err); }
});

app.delete('/api/objects', async (req, res) => {
  const { bucket = req.session.info.defaultBucket, keys = [] } = req.body || {};
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: 'keys required' });
  try {
    const flat = [];
    for (const k of keys) {
      if (k.endsWith('/')) {
        let token;
        do {
          const out = await req.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: k, ContinuationToken: token }));
          for (const o of out.Contents || []) flat.push(o.Key);
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);
      } else flat.push(k);
    }
    for (let i = 0; i < flat.length; i += 1000) {
      const batch = flat.slice(i, i + 1000).map((Key) => ({ Key }));
      await req.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
    }
    res.json({ ok: true, deleted: flat.length });
  } catch (err) { safeError(res, err); }
});

async function deletePrefix(client, bucket, prefix) {
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const objs = (out.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } }));
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
}

app.post('/api/rename', async (req, res) => {
  const { bucket = req.session.info.defaultBucket, from, to } = req.body || {};
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    if (from.endsWith('/')) {
      let token;
      const allKeys = [];
      do {
        const out = await req.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: from, ContinuationToken: token }));
        for (const o of out.Contents || []) allKeys.push(o.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      await parallelMap(allKeys, RENAME_PARALLELISM, async (oldKey) => {
        const newKey = to + oldKey.slice(from.length);
        await req.s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: copySource(bucket, oldKey), Key: newKey }));
      });
      for (let i = 0; i < allKeys.length; i += 1000) {
        const batch = allKeys.slice(i, i + 1000).map((Key) => ({ Key }));
        await req.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } }));
      }
    } else {
      await req.s3.send(new CopyObjectCommand({ Bucket: bucket, CopySource: copySource(bucket, from), Key: to }));
      await req.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
    }
    res.json({ ok: true });
  } catch (err) { safeError(res, err); }
});

// expire idle sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (s.expiresAt < now) sessions.delete(sid);
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`S3 Browser listening on http://localhost:${PORT}`);
  if (ENV_ACCESS_KEY) console.log(`  env credentials present → auto-connect enabled`);
  else console.log(`  no env credentials → connect screen will be shown`);
});
