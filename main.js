const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: 'Менеджер контейнеров ЭЦП',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#0f1117',
    show: false,
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ─── helpers ──────────────────────────────────────────────────────────────────

function findCsptest() {
  const paths = [
    'C:\\Program Files (x86)\\Crypto Pro\\CSP\\csptest.exe',
    'C:\\Program Files\\Crypto Pro\\CSP\\csptest.exe'
  ];
  return paths.find(p => fs.existsSync(p)) || null;
}

function findCryptcp() {
  const paths = [
    'C:\\Program Files (x86)\\Crypto Pro\\CSP\\cryptcp.exe',
    'C:\\Program Files\\Crypto Pro\\CSP\\cryptcp.exe'
  ];
  return paths.find(p => fs.existsSync(p)) || null;
}

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'buffer' }, (err, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout)
        ? stdout.toString('cp866').replace(/\r\n/g, '\n')
        : (stdout || '');
      const errStr = Buffer.isBuffer(stderr)
        ? stderr.toString('cp866')
        : (stderr || '');
      resolve({ ok: !err, code: err ? err.code : 0, out, err: errStr });
    });
  });
}

// ─── enumerate containers ─────────────────────────────────────────────────────

ipcMain.handle('enum-containers', async () => {
  const csptest = findCsptest();
  if (!csptest) return { error: 'csptest.exe не найден. Проверьте установку КриптоПро CSP.' };

  // List all containers
  const res = await runCmd(`"${csptest}" -keyset -enum_cont -fqcn -verifyc`);
  const lines = res.out.split('\n').map(l => l.trim()).filter(Boolean);

  const containers = [];
  for (const line of lines) {
    // Lines like: \\.\HDIMAGE\name\...
    if (!line.startsWith('\\\\.\\') && !line.startsWith('HDIMAGE')) continue;

    const contName = line.trim();
    const certRes = await runCmd(
      `"${csptest}" -property -dump -cont "${contName}"`
    );

    const props = parseCertProps(certRes.out);
    containers.push({ container: contName, ...props });
  }

  return { containers };
});

function parseCertProps(raw) {
  const get = (re) => { const m = raw.match(re); return m ? m[1].trim() : ''; };
  return {
    name:        get(/SubjectName[:\s]+CN=([^\n,]+)/i) ||
                 get(/Субъект[:\s]+CN=([^\n,]+)/i) ||
                 get(/Subject[:\s]+CN=([^\n,]+)/i) || '—',
    inn:         get(/INN[=:]([0-9]+)/i) || get(/ИНН[=:]([0-9]+)/i) || '—',
    validFrom:   get(/(?:Not Before|Начало)[:\s]+([^\n]+)/i) || '—',
    validTo:     get(/(?:Not After|Окончание)[:\s]+([^\n]+)/i) || '—',
    thumbprint:  get(/SHA1[:\s]+([0-9A-Fa-f]+)/i) ||
                 get(/Отпечаток[:\s]+([0-9A-Fa-f]+)/i) || '—',
    serial:      get(/Serial[:\s]+([0-9A-Fa-f\s]+)/i) || '—',
    reader:      raw.match(/HDIMAGE\\[^\s]+/) ? raw.match(/HDIMAGE\\[^\s]+/)[0] : '—',
    shortName:   raw.match(/\\([^\\]+)\\[^\\]+\s*$/) ? raw.match(/\\([^\\]+)\\[^\\]+\s*$/)[1] : '—',
  };
}

// ─── install certificate ──────────────────────────────────────────────────────

ipcMain.handle('install-cert', async (_, contName) => {
  const csptest = findCsptest();
  if (!csptest) return { ok: false, error: 'csptest.exe не найден' };

  const res = await runCmd(`"${csptest}" -property -cinstall -cont "${contName}"`);
  return { ok: res.ok, out: res.out, error: res.err };
});

// ─── install all certificates ────────────────────────────────────────────────

ipcMain.handle('install-all-certs', async (_, containers) => {
  const csptest = findCsptest();
  if (!csptest) return { ok: false, error: 'csptest.exe не найден' };

  const results = [];
  for (const c of containers) {
    const res = await runCmd(`"${csptest}" -property -cinstall -cont "${c.container}"`);
    results.push({ name: c.name || c.container, ok: res.ok });
  }
  return { ok: true, results };
});

// ─── extract archive ──────────────────────────────────────────────────────────

ipcMain.handle('choose-archive', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите архив с контейнером ЭЦП',
    filters: [{ name: 'Архивы', extensions: ['zip', 'rar', '7z'] }],
    properties: ['openFile']
  });
  if (result.canceled) return { canceled: true };
  return { filePath: result.filePaths[0] };
});

ipcMain.handle('extract-archive', async (_, archivePath) => {
  const destRoot = path.join(os.homedir(), 'AppData', 'Local', 'Crypto Pro');
  if (!fs.existsSync(destRoot)) fs.mkdirSync(destRoot, { recursive: true });

  const baseName = path.basename(archivePath, path.extname(archivePath))
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'container';

  let destName = baseName;
  let counter = 1;
  while (fs.existsSync(path.join(destRoot, destName))) {
    destName = baseName + counter++;
  }

  const destPath = path.join(destRoot, destName);
  fs.mkdirSync(destPath, { recursive: true });

  const ext = path.extname(archivePath).toLowerCase();
  let res;

  if (ext === '.zip') {
    // Use PowerShell for zip
    res = await runCmd(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destPath}' -Force"`
    );
  } else {
    // Try system tar for rar/7z (Windows 10 1803+ has tar)
    res = await runCmd(`tar -xf "${archivePath}" -C "${destPath}"`);
    if (!res.ok) {
      // Try 7zip if present
      const sevenZip = 'C:\\Program Files\\7-Zip\\7z.exe';
      if (fs.existsSync(sevenZip)) {
        res = await runCmd(`"${sevenZip}" x "${archivePath}" -o"${destPath}" -y`);
      } else {
        return { ok: false, error: 'Для RAR/7z установите 7-Zip' };
      }
    }
  }

  if (!res.ok) return { ok: false, error: res.err || res.out };

  // Flatten single inner folder
  const items = fs.readdirSync(destPath);
  if (items.length === 1) {
    const inner = path.join(destPath, items[0]);
    if (fs.statSync(inner).isDirectory()) {
      const innerItems = fs.readdirSync(inner);
      for (const f of innerItems) {
        fs.renameSync(path.join(inner, f), path.join(destPath, f));
      }
      fs.rmdirSync(inner);
    }
  }

  return { ok: true, destPath, shortName: destName };
});

// ─── open folder ─────────────────────────────────────────────────────────────

ipcMain.handle('open-cryptopro-folder', async () => {
  const p = path.join(os.homedir(), 'AppData', 'Local', 'Crypto Pro');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  shell.openPath(p);
  return { ok: true };
});

ipcMain.handle('open-cpanel', async () => {
  const paths = [
    'C:\\Program Files (x86)\\Crypto Pro\\CSP\\cpconfig.exe',
    'C:\\Program Files\\Crypto Pro\\CSP\\cpconfig.exe'
  ];
  const found = paths.find(p => fs.existsSync(p));
  if (found) exec(`"${found}"`);
  else shell.openPath('C:\\Program Files (x86)\\Crypto Pro\\CSP');
  return { ok: true };
});

ipcMain.handle('open-cptools', async () => {
  const paths = [
    'C:\\Program Files (x86)\\Crypto Pro\\CSP\\CpDlls.exe',
    'C:\\Program Files (x86)\\Crypto Pro\\CSP\\cptools.exe',
    'C:\\Program Files\\Crypto Pro\\CSP\\cptools.exe'
  ];
  const found = paths.find(p => fs.existsSync(p));
  if (found) exec(`"${found}"`);
  return { ok: true };
});
