// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const fileType = require('file-type');
const mime = require('mime-types');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CONFIG (via env or defaults)
const PORT = process.env.PORT || 3000;
const STORAGE = (process.env.STORAGE || 'local').toLowerCase(); // 'local' or 's3'
const BASE_URL = process.env.BASE_URL || null; // if not set, build from request
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const THUMB_DIR = path.join(UPLOAD_DIR, 'thumbs');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES || '5242880', 10); // 5MB
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '30', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // optional delete key

// Ensure dirs exist for local storage
if (STORAGE === 'local') {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
}

// Configure S3 if requested
let s3 = null;
if (STORAGE === 's3') {
  AWS.config.update({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
  s3 = new AWS.S3();
}

// Rate limiter
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/upload', limiter);

// Multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Allowed mime types
const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'
]);

// Helper: build base URL (prefer env or request)
function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// Utility: upload buffer to S3
async function uploadBufferToS3(buffer, key, mimeType) {
  const params = {
    Bucket: process.env.AWS_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ACL: 'public-read',
  };
  await s3.putObject(params).promise();
  return `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;
}

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Upload endpoint
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });

    // detect real file type
    const ft = await fileType.fromBuffer(req.file.buffer);
    const detected = ft ? ft.mime : req.file.mimetype;

    if (!ALLOWED.has(detected)) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // generate filename: timestamp-random.ext
    const ext = mime.extension(detected) || 'png';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const thumbName = filename.replace(`.${ext}`, `_thumb.${ext}`);
    const uploadDate = new Date().toISOString();

    // create thumbnail buffer
    const thumbBuffer = await sharp(req.file.buffer)
      .resize({ width: 1024, height: 1024, fit: 'inside' })
      .toBuffer();

    let fileUrl, thumbUrl;

    if (STORAGE === 's3') {
      // upload original and thumb to S3
      fileUrl = await uploadBufferToS3(req.file.buffer, `images/${filename}`, detected);
      thumbUrl = await uploadBufferToS3(thumbBuffer, `images/${thumbName}`, detected);
    } else {
      // local write
      const outPath = path.join(UPLOAD_DIR, filename);
      const thumbPath = path.join(THUMB_DIR, thumbName);
      await fs.promises.writeFile(outPath, req.file.buffer);
      await fs.promises.writeFile(thumbPath, thumbBuffer);

      const base = getBaseUrl(req);
      fileUrl = `${base}/uploads/${encodeURIComponent(filename)}`;
      thumbUrl = `${base}/uploads/thumbs/${encodeURIComponent(thumbName)}`;
    }

    // Return metadata
    return res.json({
      file: filename,
      url: fileUrl,
      thumbnail: thumbUrl,
      mime: detected,
      size: req.file.size,
      date: uploadDate
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// List endpoint (returns latest first)
app.get('/api/list', async (req, res) => {
  try {
    if (STORAGE === 's3') {
      // list from S3 (listObjectsV2, prefix images/)
      const params = { Bucket: process.env.AWS_BUCKET, Prefix: 'images/' };
      const data = await s3.listObjectsV2(params).promise();
      const items = (data.Contents || []).filter(o => !o.Key.endsWith('/')).map(o => {
        const key = o.Key;
        const file = path.basename(key);
        const thumb = file.replace('.', '_thumb.');
        return {
          file,
          url: `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`,
          thumbnail: `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/images/${encodeURIComponent(thumb)}`,
          size: o.Size,
          date: o.LastModified
        };
      }).reverse();
      return res.json(items);
    } else {
      // local listing
      const files = await fs.promises.readdir(UPLOAD_DIR);
      const images = files.filter(f => f !== 'thumbs').filter(f => !fs.lstatSync(path.join(UPLOAD_DIR, f)).isDirectory());
      const items = await Promise.all(images.map(async (f) => {
        const stat = await fs.promises.stat(path.join(UPLOAD_DIR, f));
        const ext = path.extname(f).slice(1);
        const thumb = f.replace(`.${ext}`, `_thumb.${ext}`);
        return {
          file: f,
          url: `${getBaseUrl(req)}/uploads/${f}`,
          thumbnail: `${getBaseUrl(req)}/uploads/thumbs/${thumb}`,
          size: stat.size,
          date: stat.mtime.toISOString()
        };
      }));
      items.sort((a, b) => new Date(b.date) - new Date(a.date));
      return res.json(items);
    }
  } catch (err) {
    console.error('List error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Serve uploaded files when local
if (STORAGE === 'local') {
  app.use('/uploads', express.static(UPLOAD_DIR, {
    dotfiles: 'ignore',
    index: false,
    maxAge: '7d',
  }));
}

// Delete endpoint (protected by ADMIN_KEY if set)
app.delete('/api/delete/:file', async (req, res) => {
  const key = req.query.key || '';
  if (ADMIN_KEY && key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const file = req.params.file;
  try {
    if (STORAGE === 's3') {
      await s3.deleteObject({ Bucket: process.env.AWS_BUCKET, Key: `images/${file}` }).promise();
      const ext = path.extname(file).slice(1);
      const thumb = file.replace(`.${ext}`, `_thumb.${ext}`);
      await s3.deleteObject({ Bucket: process.env.AWS_BUCKET, Key: `images/${thumb}` }).promise();
    } else {
      const fpath = path.join(UPLOAD_DIR, file);
      if (fs.existsSync(fpath)) await fs.promises.unlink(fpath);
      const ext = path.extname(file).slice(1);
      const thumb = path.join(THUMB_DIR, file.replace(`.${ext}`, `_thumb.${ext}`));
      if (fs.existsSync(thumb)) await fs.promises.unlink(thumb);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fallback to index for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT} (STORAGE=${STORAGE})`);
});