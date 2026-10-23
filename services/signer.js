import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 打包后 signer/out、signer/lib、vendor/*.jar 作为 extraResources 放在 process.resourcesPath；
// 主进程打包时设 HG_RES_DIR=resourcesPath。惰性解析（在 start() 里读），避免 ESM import 提升
// 导致主进程还没来得及 setenv。
function resBase() { return process.env.HG_RES_DIR || ROOT; }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitTcp(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('signer startup timeout'));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function isConnError(e) {
  const msg = String(e?.message || e);
  const code = e?.cause?.code || e?.code || '';
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|terminated|other side closed/i.test(msg)
    || /ECONNREFUSED|ECONNRESET|EPIPE/.test(code);
}

export class Signer {
  constructor() {
    this.proc = null;
    this.port = null;
    this.stopping = false;
    this.starting = null; // 进行中的 start，避免并发重启
  }

  async start() {
    this.stopping = false;
    if (this.proc && this.proc.exitCode === null) return this;
    if (this.starting) return this.starting;
    this.starting = this._spawn().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _spawn() {
    const port = await freePort();
    const java = process.env.JAVA_BIN || 'java';
    const signerDir = path.join(resBase(), 'signer');
    const jar = path.join(resBase(), 'vendor', 'unidbg-libs.jar');
    const required = [
      path.join(signerDir, 'out', 'dev', 'hongguo', 'sign', 'MetasecHarness.class'),
      jar,
      path.join(signerDir, 'lib', 'libmetasec_ml.so'),
      path.join(signerDir, 'lib', 'libc++_shared.so'),
      path.join(signerDir, 'lib', 'ms_16777218.bin'),
    ];
    const missing = required.filter((p) => !fs.existsSync(p));
    if (missing.length) {
      throw new Error(
        '缺少签名运行资源：\n  ' + missing.join('\n  ')
        + '\n公开仓库不附带这些文件；见 vendor/README.md、signer/lib/README.md，或运行 tools/setup-assets.sh',
      );
    }
    const proc = spawn(java, [
      '-Dsigner.root=lib',
      '-cp', `out:${jar}`,
      'dev.hongguo.sign.MetasecHarness', 'serve', String(port),
    ], {
      cwd: signerDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    // 子进程退出：标记为“死”，下次调用触发重启；主动 stop 的退出不算异常。
    proc.once('exit', (code) => {
      if (this.proc === proc) { this.proc = null; this.port = null; }
      if (!this.stopping && code !== 0) {
        console.error(`[signer] 子进程退出 code=${code}，下次签名将自动重启`);
      }
    });
    this.proc = proc;
    this.port = port;
    await waitTcp(port);
    return this;
  }

  // 保证签名进程在运行：崩了就重启（退避，最多 3 次）。
  async ensureUp() {
    if (this.stopping) throw new Error('signer stopping');
    if (this.proc && this.proc.exitCode === null && this.port) return;
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try { await this.start(); return; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
    }
    throw new Error(`signer 启动失败: ${lastErr?.message || lastErr}`);
  }

  async sign(url, headers) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this.ensureUp();
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/sign`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, headers }),
          signal: AbortSignal.timeout(120000),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error); // 签名逻辑错误：不重启、直接上抛
        return json;
      } catch (e) {
        // 连接类错误多半是进程中途崩了：重启一次再试；其它错误直接抛。
        if (attempt < 2 && !this.stopping && isConnError(e)) {
          this.proc = null; this.port = null;
          continue;
        }
        throw e;
      }
    }
    throw new Error('signer sign failed'); // 不可达
  }

  stop() {
    this.stopping = true;
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill('SIGTERM'); } catch {}
    }
    this.proc = null;
    this.port = null;
  }
}
