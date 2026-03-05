require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const db           = require('./db');
const migrate      = require('./migrate');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
  store: new pgSession({ pool: db, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'changeme',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, '../web')));
app.use('/auth',  require('./routes/auth'));
app.use('/user',  require('./routes/user'));
app.use('/user/convert', require('./routes/convert'));
app.use('/admin', require('./routes/admin'));

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Archie Image' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../web/login.html')));

async function start() {
  let retries = 5;
  while (retries > 0) {
    try {
      await migrate();
      break;
    } catch (err) {
      retries--;
      console.error(`[Startup] Migrate gagal, sisa ${retries} retries:`, err.message || err);
      if (retries === 0) break;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  app.listen(PORT, () => {
    console.log(`Archie Image running on port ${PORT}`);
    const { startQueue } = require('./queue/processor');
    startQueue();
  });
}

start();
