const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors());

// ========== FILE JSON STORAGE ==========
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const VIP_REQUESTS_FILE = path.join(DATA_DIR, 'vip_requests.json');

// Đảm bảo thư mục data tồn tại
async function ensureDataDir() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

// Đọc dữ liệu từ file JSON
async function readJSON(filePath, defaultValue = []) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  }
}

// Ghi dữ liệu vào file JSON
async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// ========== CONFIG ==========
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'sangdev_admin_2025';
const LINK4M_TOKEN = process.env.LINK4M_TOKEN || '689c1a6b064610241256e98e';
// Dùng API v2
const LINK4M_API = 'https://link4m.co/api-shorten/v2';

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Quá nhiều request, thử lại sau 15 phút' }
});
app.use(limiter);

// ========== AUTO DELETE EXPIRED KEYS ==========
async function cleanExpiredKeys() {
  const keys = await readJSON(KEYS_FILE, []);
  const nowTime = Math.floor(Date.now() / 1000);
  const validKeys = keys.filter(key => key.expires_at > nowTime);
  
  if (validKeys.length !== keys.length) {
    await writeJSON(KEYS_FILE, validKeys);
    console.log(`[Cleanup] Đã xóa ${keys.length - validKeys.length} key hết hạn`);
  }
}

// Chạy cleanup mỗi giờ
setInterval(cleanExpiredKeys, 60 * 60 * 1000);

// ========== HELPERS ==========
function generateKey(type) {
  const prefix = type === 'vip' ? 'VIP' : 'FREE';
  const random = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `SANGDEV-${prefix}-${random.slice(0,4)}-${random.slice(4,8)}-${random.slice(8,12)}`;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function expiresAt(type) {
  if (type === 'free') return now() + 6 * 3600;        // 6 giờ
  if (type === 'vip')  return now() + 7 * 24 * 3600;   // 1 tuần
  return now();
}

// ========== LINK4M BYPASS ==========
async function createLink4mLink(req, res) {
  try {
    const pendingToken = crypto.randomBytes(16).toString('hex');
    const targetUrl = `${req.protocol}://${req.get('host')}/verify-link4m?token=${pendingToken}`;

    const response = await axios.get(`${LINK4M_API}?api=${LINK4M_TOKEN}&url=${encodeURIComponent(targetUrl)}&format=json`);
    const data = response.data;

    // FIX: Xử lý response từ Link4m API v2
    let shortenedUrl = null;
    
    // Kiểm tra các format response khác nhau
    if (data && typeof data === 'object') {
      if (data.shortenedUrl) {
        shortenedUrl = data.shortenedUrl;
      } else if (data.shortened) {
        shortenedUrl = data.shortened;
      } else if (data.url) {
        shortenedUrl = data.url;
      } else if (data.link) {
        shortenedUrl = data.link;
      } else if (data.data && data.data.shortenedUrl) {
        shortenedUrl = data.data.shortenedUrl;
      } else if (data.result && data.result.shortenedUrl) {
        shortenedUrl = data.result.shortenedUrl;
      }
    }

    if (!shortenedUrl) {
      console.log("[Link4m] Response không có link:", JSON.stringify(data));
      return res.json({ success: false, message: 'Không tạo được link4m, thử lại sau' });
    }

    const pendingList = await readJSON(PENDING_FILE, []);
    pendingList.push({
      token: pendingToken,
      created_at: now(),
      used: 0
    });
    await writeJSON(PENDING_FILE, pendingList);

    // Trả về link rút gọn
    return res.json({
      success: true,
      link: shortenedUrl,
      token: pendingToken,
      message: 'Vượt link này để nhận key free 6 giờ'
    });
  } catch (err) {
    console.error('[Link4m]', err.message);
    return res.json({ success: false, message: 'Lỗi hệ thống: ' + err.message });
  }
}

// Trang xác minh link4m với giao diện đẹp
app.get('/verify-link4m', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="vi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Lỗi - SangDev Key System</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: linear-gradient(135deg, #0a0a0a 0%, #1a0033 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
          }
          .error-box {
            background: rgba(0,0,0,0.8);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 50px;
            text-align: center;
            border: 1px solid #ff4444;
            max-width: 500px;
            margin: 20px;
          }
          .error-icon {
            font-size: 64px;
            margin-bottom: 20px;
          }
          h2 { color: #ff4444; margin-bottom: 15px; }
          p { color: #aaa; margin-top: 20px; }
          .btn {
            display: inline-block;
            margin-top: 25px;
            padding: 12px 30px;
            background: #ff4444;
            color: #fff;
            text-decoration: none;
            border-radius: 10px;
            font-weight: bold;
            transition: transform 0.2s;
          }
          .btn:hover { transform: scale(1.05); }
        </style>
      </head>
      <body>
        <div class="error-box">
          <div class="error-icon">❌</div>
          <h2>Token không hợp lệ</h2>
          <p>Vui lòng truy cập lại từ link được cung cấp</p>
          <a href="/" class="btn">Về trang chủ</a>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const pendingList = await readJSON(PENDING_FILE, []);
    const validToken = pendingList.find(p => p.token === token && p.used === 0 && p.created_at > now() - 3600);

    if (!validToken) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Hết hạn - SangDev Key System</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              background: linear-gradient(135deg, #0a0a0a 0%, #1a0033 100%);
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              color: #fff;
            }
            .expired-box {
              background: rgba(0,0,0,0.8);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 50px;
              text-align: center;
              border: 1px solid #ffaa00;
              max-width: 500px;
              margin: 20px;
            }
            .expired-icon { font-size: 64px; margin-bottom: 20px; }
            h2 { color: #ffaa00; margin-bottom: 15px; }
            p { color: #aaa; margin-top: 20px; }
            .btn {
              display: inline-block;
              margin-top: 25px;
              padding: 12px 30px;
              background: #ffaa00;
              color: #000;
              text-decoration: none;
              border-radius: 10px;
              font-weight: bold;
              transition: transform 0.2s;
            }
            .btn:hover { transform: scale(1.05); }
          </style>
        </head>
        <body>
          <div class="expired-box">
            <div class="expired-icon">⏰</div>
            <h2>Link đã hết hạn</h2>
            <p>Mỗi link chỉ có hiệu lực trong 1 giờ. Vui lòng tạo link mới.</p>
            <a href="/" class="btn">Nhận link mới</a>
          </div>
        </body>
        </html>
      `);
    }

    // Đánh dấu đã sử dụng
    validToken.used = 1;
    await writeJSON(PENDING_FILE, pendingList);

    // Tạo key mới
    const newKey = generateKey('free');
    const exp = expiresAt('free');
    const keys = await readJSON(KEYS_FILE, []);
    keys.push({
      key_value: newKey,
      key_type: 'free',
      hwid: null,
      created_at: now(),
      expires_at: exp,
      is_active: 1,
      note: null
    });
    await writeJSON(KEYS_FILE, keys);

    const expDate = new Date(exp * 1000).toLocaleString('vi-VN');
    
    // Giao diện đẹp hiển thị key
    return res.send(`
      <!DOCTYPE html>
      <html lang="vi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Key Free - SangDev System</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: linear-gradient(135deg, #0a0a0a 0%, #0a2a1a 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            max-width: 550px;
            width: 100%;
            animation: fadeInUp 0.6s ease-out;
          }
          @keyframes fadeInUp {
            from {
              opacity: 0;
              transform: translateY(30px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .card {
            background: rgba(10, 10, 10, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 24px;
            padding: 40px;
            text-align: center;
            border: 1px solid rgba(0, 255, 136, 0.3);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
          }
          .success-icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #00ff88, #00cc66);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 25px;
            font-size: 48px;
            animation: bounce 0.5s ease;
          }
          @keyframes bounce {
            0%, 100% { transform: scale(0); }
            50% { transform: scale(1.1); }
            70% { transform: scale(0.95); }
          }
          h1 {
            color: #00ff88;
            font-size: 28px;
            margin-bottom: 10px;
          }
          .subtitle {
            color: #888;
            margin-bottom: 30px;
            font-size: 14px;
          }
          .key-box {
            background: #000;
            border: 2px solid #00ff88;
            border-radius: 16px;
            padding: 20px;
            margin: 20px 0;
            position: relative;
          }
          .key-label {
            position: absolute;
            top: -12px;
            left: 20px;
            background: #000;
            padding: 0 10px;
            color: #00ff88;
            font-size: 12px;
            font-weight: bold;
          }
          .key-value {
            font-family: 'Courier New', monospace;
            font-size: 18px;
            font-weight: bold;
            color: #ffcc00;
            word-break: break-all;
            letter-spacing: 1px;
          }
          .expiry-info {
            background: rgba(0, 255, 136, 0.1);
            border-radius: 12px;
            padding: 15px;
            margin: 20px 0;
          }
          .expiry-label {
            color: #888;
            font-size: 12px;
            margin-bottom: 5px;
          }
          .expiry-date {
            color: #00ff88;
            font-size: 16px;
            font-weight: bold;
          }
          .copy-btn {
            background: linear-gradient(135deg, #00ff88, #00cc66);
            color: #000;
            border: none;
            padding: 14px 30px;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
            margin-top: 10px;
            width: 100%;
          }
          .copy-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(0, 255, 136, 0.4);
          }
          .copy-btn:active {
            transform: translateY(0);
          }
          .note {
            color: #666;
            font-size: 12px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #222;
          }
          .home-link {
            display: inline-block;
            margin-top: 20px;
            color: #00ff88;
            text-decoration: none;
            font-size: 14px;
          }
          .home-link:hover {
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card">
            <div class="success-icon">✓</div>
            <h1>🎉 KEY THÀNH CÔNG</h1>
            <div class="subtitle">Key free của bạn đã được tạo</div>
            
            <div class="key-box">
              <div class="key-label">🔑 KEY FREE</div>
              <div class="key-value" id="keyValue">${newKey}</div>
            </div>
            
            <div class="expiry-info">
              <div class="expiry-label">⏱ HẾT HẠN VÀO LÚC</div>
              <div class="expiry-date">${expDate}</div>
            </div>
            
            <button class="copy-btn" onclick="copyKey()">
              📋 COPY KEY
            </button>
            
            <div class="note">
              💡 Lưu ý: Key free có hiệu lực 6 giờ.<br>
              🔥 Nâng cấp lên VIP để sử dụng 1 tuần và nhiều tính năng hơn!
            </div>
            
            <a href="/" class="home-link">← Quay lại trang chủ</a>
          </div>
        </div>
        
        <script>
          function copyKey() {
            const key = document.getElementById('keyValue').innerText;
            navigator.clipboard.writeText(key).then(() => {
              const btn = document.querySelector('.copy-btn');
              const originalText = btn.innerHTML;
              btn.innerHTML = '✅ ĐÃ COPY!';
              setTimeout(() => {
                btn.innerHTML = originalText;
              }, 2000);
            });
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[verify-link4m]', err.message);
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>Lỗi hệ thống</title></head>
      <body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh">
        <div style="text-align:center"><h2>❌ Lỗi hệ thống</h2><p>Vui lòng thử lại sau</p></div>
      </body>
      </html>
    `);
  }
});

// ========== API ROUTES ==========
// ==================== NHẬN KEY FREE - TẠO KEY TRƯỚC ====================
app.get('/get-free-key', async (req, res) => {
  try {
    // Bước 1: Tạo key trước
    const newKey = generateKey('free');
    const exp = expiresAt('free');
    const expDate = new Date(exp * 1000).toLocaleString('vi-VN');

    // Bước 2: Tạo URL verify chứa luôn key
    const verifyUrl = `${req.protocol}://${req.get('host')}/verify-key?key=${encodeURIComponent(newKey)}`;

    // Bước 3: Tạo link rút gọn từ Link4m
    const apiUrl = `${LINK4M_API}?api=${LINK4M_TOKEN}&url=${encodeURIComponent(verifyUrl)}&format=json`;

    const response = await axios.get(apiUrl);
    const data = response.data;

    // FIX: Xử lý response từ Link4m API v2
    let shortenedUrl = null;
    
    if (data && typeof data === 'object') {
      if (data.shortenedUrl) {
        shortenedUrl = data.shortenedUrl;
      } else if (data.shortened) {
        shortenedUrl = data.shortened;
      } else if (data.url) {
        shortenedUrl = data.url;
      } else if (data.link) {
        shortenedUrl = data.link;
      } else if (data.data && data.data.shortenedUrl) {
        shortenedUrl = data.data.shortenedUrl;
      } else if (data.result && data.result.shortenedUrl) {
        shortenedUrl = data.result.shortenedUrl;
      }
    }

    if (!shortenedUrl) {
      console.log("[Link4m] Response không có link:", JSON.stringify(data));
      return res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Lỗi - SangDev</title>
          <style>
            * { margin:0; padding:0; box-sizing:border-box; }
            body {
              background: linear-gradient(135deg, #0a0a0a 0%, #1a0033 100%);
              font-family: 'Segoe UI', sans-serif;
              color: #fff;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .error-container {
              background: rgba(0,0,0,0.8);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 50px;
              text-align: center;
              border: 1px solid #ff4444;
              max-width: 500px;
            }
            h2 { color: #ff4444; margin-bottom: 15px; }
            .btn {
              display: inline-block;
              margin-top: 25px;
              padding: 12px 30px;
              background: #ff4444;
              color: #fff;
              text-decoration: none;
              border-radius: 10px;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="error-container">
            <h2>❌ Lỗi từ Link4m</h2>
            <p>Không thể tạo link rút gọn. Vui lòng thử lại sau.</p>
            <p style="font-size:12px;color:#666;margin-top:10px">Chi tiết: API không trả về link</p>
            <a href="/" class="btn">Thử lại</a>
          </div>
        </body>
        </html>
      `);
    }

    // Lưu key vào database ngay (để sau này check được)
    const keys = await readJSON(KEYS_FILE, []);
    keys.push({
      key_value: newKey,
      key_type: 'free',
      hwid: null,
      created_at: now(),
      expires_at: exp,
      is_active: 1,
      note: 'Tạo từ link4m'
    });
    await writeJSON(KEYS_FILE, keys);

    // Hiển thị trang có link rút gọn
    res.send(`
      <!DOCTYPE html>
      <html lang="vi">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Nhận Key Free - SangDev</title>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body {
            background: linear-gradient(135deg, #0a0a0a 0%, #0a2a1a 100%);
            font-family: 'Segoe UI', sans-serif;
            color: #fff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .container {
            background: rgba(15,15,15,0.95);
            border: 2px solid #00ff88;
            border-radius: 24px;
            padding: 50px 40px;
            text-align: center;
            max-width: 520px;
          }
          h1 { color: #00ff88; font-size: 28px; margin-bottom: 15px; }
          .link-box {
            background: #000;
            padding: 20px;
            border-radius: 12px;
            margin: 25px 0;
            word-break: break-all;
            font-family: monospace;
            font-size: 16px;
            color: #ffcc00;
          }
          .btn {
            background: linear-gradient(135deg, #00ff88, #00cc66);
            color: #000;
            padding: 16px 50px;
            font-size: 18px;
            font-weight: bold;
            border: none;
            border-radius: 50px;
            cursor: pointer;
            margin-top: 20px;
            text-decoration: none;
            display: inline-block;
          }
          .btn:hover { transform: scale(1.08); }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎁 NHẬN KEY FREE</h1>
          <p>Vượt link bên dưới để nhận key</p>
          
          <div class="link-box">${shortenedUrl}</div>

          <a href="${shortenedUrl}" target="_blank" class="btn">🚀 VƯỢT LINK NGAY</a>

          <p style="margin-top: 35px; color:#888; font-size:14px;">
            Key đã được tạo sẵn.<br>
            Sau khi vượt link, key sẽ hiển thị ngay.
          </p>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('[get-free-key]', err);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>Lỗi hệ thống</title></head>
      <body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh">
        <div style="text-align:center"><h2>❌ Lỗi hệ thống</h2><p>${err.message}</p><a href="/" style="color:#00ff88">Quay lại</a></div>
      </body>
      </html>
    `);
  }
});

// Route nhận key từ URL sau khi vượt link4m
app.get('/verify-key', async (req, res) => {
  const { key } = req.query;

  if (!key) {
    return res.send(`<h2 style="color:red">Không tìm thấy key</h2>`);
  }

  // Kiểm tra key có tồn tại và còn hạn không
  const keys = await readJSON(KEYS_FILE, []);
  const keyData = keys.find(k => k.key_value === key && k.is_active === 1);

  if (!keyData || now() > keyData.expires_at) {
    return res.send(`<h2 style="color:red">Key không hợp lệ hoặc đã hết hạn</h2>`);
  }

  const expDate = new Date(keyData.expires_at * 1000).toLocaleString('vi-VN');

  res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Key Free - SangDev</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background: linear-gradient(135deg, #0a0a0a, #0a2a1a); color: #fff; font-family: 'Segoe UI'; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { background: rgba(10,10,10,0.95); border: 2px solid #00ff88; border-radius: 24px; padding: 50px; text-align: center; max-width: 500px; }
        .key { font-size: 20px; color: #ffcc00; background: #000; padding: 20px; border-radius: 12px; word-break: break-all; }
        .btn { background: #00ff88; color: #000; border: none; padding: 12px 30px; border-radius: 12px; font-weight: bold; cursor: pointer; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🎉 KEY CỦA BẠN</h1>
        <div class="key">${key}</div>
        <p>Hết hạn: ${expDate}</p>
        <button class="btn" onclick="navigator.clipboard.writeText('${key}'); this.innerText='Đã copy!'">
          📋 COPY KEY
        </button>
        <p style="margin-top:20px"><a href="/" style="color:#00ff88">← Quay lại trang chủ</a></p>
      </div>
    </body>
    </html>
  `);
});

// ========== ADMIN PANEL ==========
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.body?.admin_secret || req.query?.secret;
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
  }
  next();
}

// Admin API endpoints
app.post('/admin/create-vip', adminAuth, async (req, res) => {
  const { note } = req.body;
  try {
    const newKey = generateKey('vip');
    const exp = expiresAt('vip');
    const keys = await readJSON(KEYS_FILE, []);
    keys.push({
      key_value: newKey,
      key_type: 'vip',
      hwid: null,
      created_at: now(),
      expires_at: exp,
      is_active: 1,
      note: note || null
    });
    await writeJSON(KEYS_FILE, keys);
    return res.json({
      success: true,
      key: newKey,
      expires_at: exp,
      expires_date: new Date(exp * 1000).toLocaleString('vi-VN')
    });
  } catch (err) {
    console.error('[admin-create-vip]', err.message);
    return res.json({ success: false, message: err.message });
  }
});

app.post('/admin/approve-vip', adminAuth, async (req, res) => {
  const { request_id } = req.body;
  if (!request_id) return res.json({ success: false, message: 'Thiếu request_id' });

  try {
    const newKey = generateKey('vip');
    const exp = expiresAt('vip');
    const keys = await readJSON(KEYS_FILE, []);
    keys.push({
      key_value: newKey,
      key_type: 'vip',
      hwid: null,
      created_at: now(),
      expires_at: exp,
      is_active: 1,
      note: `request_id:${request_id}`
    });
    await writeJSON(KEYS_FILE, keys);
    
    const requests = await readJSON(VIP_REQUESTS_FILE, []);
    const requestIndex = requests.findIndex(r => r.id == request_id);
    if (requestIndex !== -1) {
      requests[requestIndex].status = 'approved';
      requests[requestIndex].key_value = newKey;
      await writeJSON(VIP_REQUESTS_FILE, requests);
    }
    
    return res.json({ success: true, key: newKey, expires_date: new Date(exp * 1000).toLocaleString('vi-VN') });
  } catch (err) {
    console.error('[admin-approve-vip]', err.message);
    return res.json({ success: false, message: err.message });
  }
});

app.get('/admin/list-keys', adminAuth, async (req, res) => {
  try {
    const keys = await readJSON(KEYS_FILE, []);
    return res.json({ success: true, keys: keys.reverse().slice(0, 100) });
  } catch (err) {
    console.error('[admin-list-keys]', err.message);
    return res.json({ success: false, message: err.message });
  }
});

app.get('/admin/list-requests', adminAuth, async (req, res) => {
  try {
    const requests = await readJSON(VIP_REQUESTS_FILE, []);
    return res.json({ success: true, requests: requests.reverse() });
  } catch (err) {
    console.error('[admin-list-requests]', err.message);
    return res.json({ success: false, message: err.message });
  }
});

app.delete('/admin/revoke-key', adminAuth, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ success: false, message: 'Thiếu key' });
  try {
    const keys = await readJSON(KEYS_FILE, []);
    const keyIndex = keys.findIndex(k => k.key_value === key);
    if (keyIndex !== -1) {
      keys[keyIndex].is_active = 0;
      await writeJSON(KEYS_FILE, keys);
    }
    return res.json({ success: true, message: 'Đã vô hiệu hóa key' });
  } catch (err) {
    console.error('[admin-revoke-key]', err.message);
    return res.json({ success: false, message: err.message });
  }
});

// VIP Request endpoint
app.post('/request-vip', async (req, res) => {
  const { name, contact, amount } = req.body;
  if (!name || !contact) {
    return res.json({ success: false, message: 'Vui lòng điền đầy đủ thông tin' });
  }
  
  try {
    const requests = await readJSON(VIP_REQUESTS_FILE, []);
    const newRequest = {
      id: Date.now(),
      name,
      contact,
      amount: amount || '',
      created_at: now(),
      status: 'pending',
      key_value: null
    };
    requests.push(newRequest);
    await writeJSON(VIP_REQUESTS_FILE, requests);
    
    return res.json({ 
      success: true, 
      message: 'Yêu cầu đã được gửi! Admin sẽ liên hệ và duyệt trong thời gian sớm nhất.' 
    });
  } catch (err) {
    console.error('[request-vip]', err.message);
    return res.json({ success: false, message: 'Lỗi hệ thống' });
  }
});

// ========== MAIN PAGE ==========
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SangDev Tool - Key System</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0a0a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; min-height: 100vh; }
        .hero { background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0a0a0a 100%);
                padding: 60px 20px; text-align: center; border-bottom: 1px solid #00ff8820; }
        h1 { font-size: 2.5rem; color: #00ff88; text-shadow: 0 0 20px #00ff8840; margin-bottom: 10px; }
        .sub { color: #888; margin-bottom: 40px; }
        .cards { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; padding: 40px 20px; max-width: 900px; margin: 0 auto; }
        .card { background: #111; border: 1px solid #333; border-radius: 16px; padding: 30px; width: 260px; text-align: center; transition: all 0.3s; }
        .card:hover { border-color: #00ff88; transform: translateY(-5px); box-shadow: 0 10px 30px #00ff8820; }
        .card.vip { border-color: #ffcc00; }
        .card.vip:hover { border-color: #ffcc00; box-shadow: 0 10px 30px #ffcc0020; }
        .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: bold; margin-bottom: 15px; }
        .badge.free { background: #00ff8820; color: #00ff88; border: 1px solid #00ff88; }
        .badge.vip { background: #ffcc0020; color: #ffcc00; border: 1px solid #ffcc00; }
        .price { font-size: 1.8rem; font-weight: bold; margin: 10px 0; }
        .price.free { color: #00ff88; }
        .price.vip { color: #ffcc00; }
        ul { list-style: none; margin: 15px 0; text-align: left; }
        li { padding: 5px 0; color: #aaa; font-size: 14px; }
        li::before { content: "✓ "; color: #00ff88; }
        .card.vip li::before { color: #ffcc00; }
        .btn { display: inline-block; margin-top: 20px; padding: 12px 28px; border-radius: 10px; font-weight: bold; cursor: pointer; border: none; font-size: 14px; text-decoration: none; }
        .btn-free { background: #00ff88; color: #000; }
        .btn-vip { background: #ffcc00; color: #000; }
        .btn:hover { opacity: 0.85; }
        .section { padding: 40px 20px; max-width: 700px; margin: 0 auto; }
        .section h2 { color: #00ff88; margin-bottom: 20px; text-align: center; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; color: #aaa; font-size: 13px; }
        input, textarea { width: 100%; background: #111; border: 1px solid #333; border-radius: 8px;
                          padding: 10px 14px; color: #fff; font-size: 14px; outline: none; }
        input:focus, textarea:focus { border-color: #00ff88; }
        .alert { padding: 12px 18px; border-radius: 8px; margin-top: 15px; font-size: 14px; }
        .alert-success { background: #00ff8815; border: 1px solid #00ff88; color: #00ff88; }
        .alert-error { background: #ff444415; border: 1px solid #ff4444; color: #ff4444; }
        footer { text-align: center; padding: 30px; color: #444; font-size: 13px; border-top: 1px solid #1a1a1a; }
        .admin-link { position: fixed; bottom: 20px; right: 20px; background: #00ff88; color: #000; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 12px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="hero">
        <h1>⚡ SANGDEV TOOL</h1>
        <p class="sub">Hệ thống Key Authentication - Bảo mật & Ổn định</p>
        <div class="cards">
          <div class="card">
            <span class="badge free">FREE</span>
            <div class="price free">Miễn phí</div>
            <p style="color:#666;font-size:13px">Vượt link để nhận key</p>
            <ul>
              <li>Thời hạn 6 giờ</li>
              <li>Tất cả nhiệm vụ cơ bản</li>
              <li>Gia hạn bằng link mới</li>
            </ul>
            <a href="/get-free-key" class="btn btn-free">Nhận Key Free</a>
          </div>
          <div class="card vip">
            <span class="badge vip">VIP</span>
            <div class="price vip">Liên hệ</div>
            <p style="color:#888;font-size:13px">Admin duyệt sau khi thanh toán</p>
            <ul>
              <li>Thời hạn 1 tuần</li>
              <li>Toàn bộ tính năng VIP</li>
              <li>Hỗ trợ ưu tiên</li>
            </ul>
            <button class="btn btn-vip" onclick="document.getElementById('vipForm').scrollIntoView({behavior:'smooth'})">Mua Key VIP</button>
          </div>
        </div>
      </div>

      <div class="section" id="vipForm">
        <h2>💎 Đăng ký Key VIP</h2>
        <div class="form-group">
          <label>Họ tên / Username</label>
          <input type="text" id="vipName" placeholder="Tên của bạn">
        </div>
        <div class="form-group">
          <label>Facebook / Telegram / Zalo</label>
          <input type="text" id="vipContact" placeholder="Link liên hệ">
        </div>
        <div class="form-group">
          <label>Ghi chú (tùy chọn)</label>
          <textarea id="vipNote" rows="3" placeholder="Ghi chú thêm..."></textarea>
        </div>
        <button class="btn btn-vip" style="width:100%" onclick="submitVip()">Gửi yêu cầu</button>
        <div id="vipAlert"></div>
      </div>

      <footer>SangDev Tool &copy; 2025 | Hỗ trợ lập trình</footer>
      <a href="/admin" class="admin-link">🔐 Admin</a>

      <script>
        async function submitVip() {
          const name = document.getElementById('vipName').value.trim();
          const contact = document.getElementById('vipContact').value.trim();
          const amount = document.getElementById('vipNote').value.trim();
          if (!name || !contact) {
            document.getElementById('vipAlert').innerHTML = '<div class="alert alert-error">Vui lòng điền đầy đủ thông tin!</div>';
            return;
          }
          const res = await fetch('/request-vip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, contact, amount })
          });
          const data = await res.json();
          document.getElementById('vipAlert').innerHTML =
            data.success
              ? '<div class="alert alert-success">' + data.message + '</div>'
              : '<div class="alert alert-error">' + data.message + '</div>';
        }
      </script>
    </body>
    </html>
  `);
});

// Admin giao diện
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Panel - SangDev Key System</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0a0a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #00ff88, #00cc66); padding: 20px; border-radius: 12px; margin-bottom: 30px; text-align: center; }
        .header h1 { color: #000; margin-bottom: 10px; }
        .login-form { background: #111; padding: 30px; border-radius: 12px; max-width: 400px; margin: 50px auto; text-align: center; }
        .login-form input { width: 100%; padding: 12px; margin: 10px 0; background: #222; border: 1px solid #333; color: #fff; border-radius: 8px; }
        .login-form button { background: #00ff88; color: #000; padding: 12px 30px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; }
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .tab-btn { padding: 10px 20px; background: #111; border: 1px solid #333; border-radius: 8px; cursor: pointer; color: #888; }
        .tab-btn.active { background: #00ff88; color: #000; border-color: #00ff88; }
        .tab-content { display: none; background: #111; padding: 20px; border-radius: 12px; }
        .tab-content.active { display: block; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #222; }
        th { background: #1a1a1a; color: #00ff88; }
        .status-pending { color: #ffaa00; }
        .status-approved { color: #00ff88; }
        button { padding: 6px 12px; border-radius: 6px; cursor: pointer; border: none; }
        .btn-approve { background: #00ff88; color: #000; }
        .btn-revoke { background: #ff4444; color: #fff; }
        .btn-create { background: #00ff88; color: #000; padding: 10px 20px; margin-top: 10px; }
        input, textarea { background: #222; border: 1px solid #333; color: #fff; padding: 8px; border-radius: 6px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; color: #888; }
      </style>
    </head>
    <body>
      <div class="container" id="app">
        <div class="header">
          <h1>🔐 Admin Panel - SangDev Key System</h1>
          <p>Quản lý key và yêu cầu VIP</p>
        </div>
        
        <div id="loginSection" class="login-form">
          <h2>Đăng nhập Admin</h2>
          <input type="password" id="adminSecret" placeholder="Nhập Admin Secret" />
          <button type="button" onclick="login()">Đăng nhập</button>
        </div>
        
        <div id="adminContent" style="display:none;">
          <div class="tabs">
            <button class="tab-btn active" onclick="showTab('requests')">📋 Yêu cầu VIP</button>
            <button class="tab-btn" onclick="showTab('keys')">🔑 Quản lý Key</button>
            <button class="tab-btn" onclick="showTab('create')">✨ Tạo Key VIP</button>
          </div>
          
          <div id="requestsTab" class="tab-content active">
            <h2>Yêu cầu mua key VIP</h2>
            <div id="requestsList"></div>
          </div>
          
          <div id="keysTab" class="tab-content">
            <h2>Danh sách Key</h2>
            <div id="keysList"></div>
          </div>
          
          <div id="createTab" class="tab-content">
            <h2>Tạo Key VIP thủ công</h2>
            <div class="form-group">
              <label>Ghi chú (tùy chọn)</label>
              <textarea id="keyNote" rows="3" placeholder="Ghi chú cho key này..."></textarea>
            </div>
            <button class="btn-create" onclick="createVipKey()">✨ Tạo Key VIP</button>
            <div id="createResult"></div>
          </div>
        </div>
      </div>
      
      <script>
        let adminSecret = '';
        
        async function login() {
          const secret = document.getElementById('adminSecret').value;
          if (!secret) {
            alert('Vui lòng nhập Admin Secret');
            return;
          }
          
          const res = await fetch('/admin/list-requests?secret=' + secret);
          if (res.status === 403) {
            alert('Sai Admin Secret!');
            return;
          }
          
          adminSecret = secret;
          document.getElementById('loginSection').style.display = 'none';
          document.getElementById('adminContent').style.display = 'block';
          loadRequests();
          loadKeys();
        }
        
        async function loadRequests() {
          const res = await fetch('/admin/list-requests?secret=' + adminSecret);
          const data = await res.json();
          if (data.success) {
            const html = '<table><thead> <th>ID</th><th>Tên</th><th>Liên hệ</th><th>Ghi chú</th><th>Ngày tạo</th><th>Trạng thái</th><th>Key</th><th>Thao tác</th> </thead><tbody>' +
              data.requests.map(req => \`
                 <tr>
                   <td>\${req.id}</td>
                   <td>\${req.name}</td>
                   <td>\${req.contact}</td>
                   <td>\${req.amount || ''}</td>
                   <td>\${new Date(req.created_at * 1000).toLocaleString('vi-VN')}</td>
                  <td class="status-\${req.status}">\${req.status === 'pending' ? 'Chờ duyệt' : 'Đã duyệt'}</td>
                   <td>\${req.key_value || '-'}</td>
                   <td>\${req.status === 'pending' ? \`<button class="btn-approve" onclick="approveRequest(\${req.id})">Duyệt</button>\` : 'Đã duyệt'}</td>
                 </tr>
              \`).join('') + '</tbody></table>';
            document.getElementById('requestsList').innerHTML = html;
          }
        }
        
        async function loadKeys() {
          const res = await fetch('/admin/list-keys?secret=' + adminSecret);
          const data = await res.json();
          if (data.success) {
            const html = '<table><thead><tr><th>Key</th><th>Loại</th><th>HWID</th><th>Ngày tạo</th><th>Hết hạn</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>' +
              data.keys.map(key => \`
                <tr>
                  <td><code>\${key.key_value}</code></td>
                  <td>\${key.key_type.toUpperCase()}</td>
                  <td>\${key.hwid || 'Chưa kích hoạt'}</td>
                  <td>\${new Date(key.created_at * 1000).toLocaleString('vi-VN')}</td>
                  <td>\${new Date(key.expires_at * 1000).toLocaleString('vi-VN')}</td>
                  <td>\${key.is_active ? '✅ Hoạt động' : '❌ Đã khóa'}</td>
                  <td>\${key.is_active ? \`<button class="btn-revoke" onclick="revokeKey('\${key.key_value}')">Thu hồi</button>\` : 'Đã thu hồi'}</td>
                </tr>
              \`).join('') + '</tbody></table>';
            document.getElementById('keysList').innerHTML = html;
          }
        }
        
        async function approveRequest(id) {
          if (!confirm('Xác nhận duyệt yêu cầu này?')) return;
          const res = await fetch('/admin/approve-vip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: id, admin_secret: adminSecret })
          });
          const data = await res.json();
          if (data.success) {
            alert('Đã duyệt! Key VIP: ' + data.key);
            loadRequests();
            loadKeys();
          } else {
            alert('Lỗi: ' + data.message);
          }
        }
        
        async function createVipKey() {
          const note = document.getElementById('keyNote').value;
          const res = await fetch('/admin/create-vip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note, admin_secret: adminSecret })
          });
          const data = await res.json();
          if (data.success) {
            document.getElementById('createResult').innerHTML = \`
              <div style="margin-top: 20px; padding: 15px; background: #00ff8815; border: 1px solid #00ff88; border-radius: 8px;">
                <strong>✅ Key VIP đã tạo:</strong><br>
                <code style="font-size: 16px; color: #ffcc00;">\${data.key}</code><br>
                Hết hạn: \${data.expires_date}
              </div>
            \`;
            loadKeys();
          } else {
            alert('Lỗi: ' + data.message);
          }
        }
        
        async function revokeKey(key) {
          if (!confirm('Xác nhận thu hồi key này?')) return;
          const res = await fetch('/admin/revoke-key', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key, admin_secret: adminSecret })
          });
          const data = await res.json();
          if (data.success) {
            alert('Đã thu hồi key');
            loadKeys();
          } else {
            alert('Lỗi: ' + data.message);
          }
        }
        
        function showTab(tab) {
          document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
          document.getElementById(tab + 'Tab').classList.add('active');
          event.target.classList.add('active');
          if (tab === 'requests') loadRequests();
          if (tab === 'keys') loadKeys();
        }
      </script>
    </body>
    </html>
  `);
});
// ========== CHECK KEY API (dành cho tool Python) ==========
app.post('/check-key', async (req, res) => {
  const { key, hwid } = req.body;
  if (!key) {
    return res.json({ success: false, message: 'Thiếu key' });
  }

  try {
    const keys = await readJSON(KEYS_FILE, []);
    const keyData = keys.find(k => k.key_value === key && k.is_active === 1);
    if (!keyData) {
      return res.json({ success: false, message: 'Key không tồn tại hoặc đã bị vô hiệu hóa', expired: false });
    }
    const nowTime = now();
    if (nowTime > keyData.expires_at) {
      return res.json({ success: false, message: 'Key đã hết hạn', expired: true });
    }

    // Ghi nhận HWID (nếu muốn)
    if (keyData.hwid === null && hwid) {
      keyData.hwid = hwid;
      await writeJSON(KEYS_FILE, keys);
    }

    const remainingSeconds = keyData.expires_at - nowTime;
    const remainingHours = (remainingSeconds / 3600).toFixed(1);
    return res.json({
      success: true,
      key_type: keyData.key_type,
      remaining: `${remainingHours} giờ`,
      expires_at: keyData.expires_at
    });
  } catch (err) {
    console.error('[check-key]', err);
    return res.json({ success: false, message: 'Lỗi server' });
  }
});

// ========== START ==========
const PORT = process.env.PORT || 3000;

// Khởi động server ngay lập tức
(async () => {
  await ensureDataDir();
  
  // Khởi tạo các file JSON nếu chưa có
  const files = [KEYS_FILE, PENDING_FILE, VIP_REQUESTS_FILE];
  for (const file of files) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '[]');
    }
  }
  
  await cleanExpiredKeys();
  app.listen(PORT, () => {
    console.log(`\n✅ SERVER ĐÃ CHẠY THÀNH CÔNG!`);
    console.log(`📍 Địa chỉ: http://localhost:${PORT}`);
    console.log(`🔑 Admin Secret: ${ADMIN_SECRET}`);
    console.log(`📁 Dữ liệu lưu tại: ${DATA_DIR}\n`);
  });
})();
