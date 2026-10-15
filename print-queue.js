const { BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('./logger');

// Windows: print through the printer driver's own paper list (System.Drawing),
// instead of Chromium's custom page size which some drivers (DNP) misread.
const WIN_PRINT_PS = `
param($Img,$Printer,$W,$H,$Copies,$Borderless)
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile($Img)
$pd=New-Object System.Drawing.Printing.PrintDocument
if($Printer){$pd.PrinterSettings.PrinterName=$Printer}
$pd.PrinterSettings.Copies=[int16]$Copies
$wIn=[math]::Round([double]$W/25.4*100); $hIn=[math]::Round([double]$H/25.4*100)
$best=$null; $bd=1e9
foreach($p in $pd.PrinterSettings.PaperSizes){
  $d=[math]::Abs($p.Width-$wIn)+[math]::Abs($p.Height-$hIn)
  $isB=($p.PaperName -match 'borderless|no margin')
  if($Borderless -eq '1' -and $isB){$d-=5}
  if($Borderless -ne '1' -and $isB){$d+=5}
  if($d -lt $bd){$bd=$d;$best=$p}
}
if($best){$pd.DefaultPageSettings.PaperSize=$best}
$pd.DefaultPageSettings.Margins=New-Object System.Drawing.Printing.Margins(0,0,0,0)
$pd.OriginAtMargins=$false
$pd.add_PrintPage({ param($s,$e)
  $ps=$e.PageSettings
  $e.Graphics.DrawImage($img, -$ps.HardMarginX, -$ps.HardMarginY, $ps.PaperSize.Width, $ps.PaperSize.Height)
  $e.HasMorePages=$false })
$pd.Print()
$img.Dispose()
Write-Output ("paper=" + $best.PaperName + " " + $best.Width + "x" + $best.Height)
`;

class PrintQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.processing = false;
    this.jobIdCounter = 1;
  }

  enqueue(job) {
    const id = this.jobIdCounter++;
    const entry = { id, status: 'queued', attempts: 0, ...job };
    this.queue.push(entry);
    logger.info('print job queued', { id, printerName: job.printerName, copies: job.copies, borderless: job.borderless });
    this.emit('update', this.snapshot());
    this._processNext();
    return id;
  }

  retry(id) {
    const job = this.queue.find(j => j.id === id);
    if (!job) return false;
    job.status = 'queued';
    job.lastError = null;
    this.emit('update', this.snapshot());
    this._processNext();
    return true;
  }

  snapshot() {
    if (this.queue.length > 20) this.queue = this.queue.slice(-20);
    return this.queue.map(({ dataUrl, ...rest }) => rest);
  }

  async _processNext() {
    if (this.processing) return;
    const job = this.queue.find(j => j.status === 'queued');
    if (!job) return;

    this.processing = true;
    job.status = 'printing';
    job.attempts += 1;
    this.emit('update', this.snapshot());

    try {
      const result = await this._printJob(job);
      job.status = result.success ? 'printed' : 'failed';
      job.lastError = result.failureReason || null;
      logger.info('print job finished', { id: job.id, success: result.success, attempts: job.attempts });
    } catch (err) {
      job.status = 'failed';
      job.lastError = String(err);
      logger.error('print job threw', { id: job.id, error: String(err) });
    }

    this.processing = false;
    this.emit('update', this.snapshot());
    this._processNext();
  }

  _printJobWin(job) {
    return new Promise((resolve) => {
      const tmp = app.getPath('temp');
      const stamp = `${job.id}-${Date.now()}`;
      const png = path.join(tmp, `print-${stamp}.png`);
      const ps1 = path.join(tmp, `print-${stamp}.ps1`);
      try {
        fs.writeFileSync(png, Buffer.from(job.dataUrl.split(',')[1], 'base64'));
        fs.writeFileSync(ps1, WIN_PRINT_PS, 'utf-8');
      } catch (e) {
        return resolve({ success: false, failureReason: 'Could not prepare print file: ' + String(e) });
      }
      const done = (r) => {
        try { fs.unlinkSync(png); } catch (e) {}
        try { fs.unlinkSync(ps1); } catch (e) {}
        resolve(r);
      };
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Img', png,
        '-Printer', job.printerName || '',
        '-W', String(job.widthMM), '-H', String(job.heightMM),
        '-Copies', String(Math.max(1, job.copies || 1)),
        '-Borderless', job.borderless ? '1' : '0'
      ], { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
        logger.info('win print output', { out: String(stdout).trim(), err: String(stderr).trim() });
        if (err) return done({ success: false, failureReason: 'Print failed: ' + (String(stderr).trim() || err.message) });
        done({ success: true, failureReason: null });
      });
    });
  }

  _printJob(job) {
    if (process.platform === 'win32') return this._printJobWin(job);
    return new Promise((resolve) => {
      const printWin = new BrowserWindow({ show: false });
      const html = `<!DOCTYPE html><html><head><style>
        * { margin:0; padding:0; }
        html, body { width:100%; height:100%; background:#fff; }
        img { width:100%; height:100%; object-fit:fill; display:block; }
      </style></head><body><img src="${job.dataUrl}" /></body></html>`;
      const tmpFile = path.join(app.getPath('temp'), `print-${job.id}-${Date.now()}.html`);

      try {
        fs.writeFileSync(tmpFile, html, 'utf-8');
      } catch (e) {
        printWin.close();
        resolve({ success: false, failureReason: 'Could not prepare print file: ' + String(e) });
        return;
      }

      const cleanup = () => {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        try { printWin.close(); } catch (e) {}
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve({ success: false, failureReason: 'Print timed out' });
      }, 60000);

      printWin.loadFile(tmpFile).then(() => {
        const printOptions = {
          silent: true,
          printBackground: true,
          copies: Math.max(1, job.copies || 1),
          pageSize: {
            width: Math.round(job.widthMM * 1000),
            height: Math.round(job.heightMM * 1000)
          }
        };
        if (job.borderless) {
          printOptions.margins = { marginType: 'none' };
        }
        if (job.printerName) printOptions.deviceName = job.printerName;

        printWin.webContents.print(printOptions, (success, failureReason) => {
          clearTimeout(timeout);
          cleanup();
          resolve({ success, failureReason: failureReason || null });
        });
      }).catch((err) => {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: false, failureReason: String(err) });
      });
    });
  }
}

module.exports = new PrintQueue();