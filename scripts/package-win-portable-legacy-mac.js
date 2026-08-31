/**
 * package-win-portable-legacy-mac.js
 *
 * 为什么需要这个脚本：
 *   electron-builder 24.13.3 使用的 nsis-3.0.4.1/mac/makensis 是以 macOS 10.15
 *   为最低版本构建的，其二进制依赖 `____chkstk_darwin` 符号。在 macOS 10.13.6 上
 *   该符号不存在，导致 makensis 无法启动，Windows portable 打包失败。
 *
 * 兼容方案（不是降低 electron-builder，也不是整体降级 NSIS）：
 *   保留 nsis-3.0.4.1 的 Include / Plugins / Stubs 等资源不变，
 *   仅用 nsis-3.0.3.0 的 mac/makensis（最低支持 macOS 10.13）替换掉
 *   nsis-3.0.4.1/mac/makensis，同时通过 NSISDIR 让 makensis 仍定位到 3.0.4.1 的资源目录。
 *
 * 本脚本自行准备 electron-builder 所需的 NSIS 资源，不依赖 electron-builder 自身下载。
 * 整个流程中 electron-builder 只执行一次。
 * 不修改 node_modules/electron-builder 内的任何源码。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');

// electron-builder 的 NSIS 缓存根目录
const EB_CACHE_ROOT = path.join(
  os.homedir(),
  'Library', 'Caches', 'electron-builder'
);

// NSIS compiler
const NSIS_4041_DIR = path.join(
  EB_CACHE_ROOT,
  'nsis',
  'nsis-3.0.4.1'
);

// NSIS plugins/resources
const NSIS_RESOURCES_DIR = path.join(
  EB_CACHE_ROOT,
  'nsis-resources',
  'nsis-resources-3.4.1'
);

// 项目级下载缓存（node_modules/.cache 已在 .gitignore 中）
const BUILD_CACHE_DIR = path.join(PROJECT_ROOT, 'node_modules', '.cache', 'openchat-build');

// 下载 URL
const NSIS_4041_URL =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z';
const NSIS_RESOURCES_URL =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z';
const COMPAT_MAKENSIS_URL =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.3.0/nsis-3.0.3.0.7z';

const REQUEST_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`[legacy-mac] ${message}`);
}

function fail(message) {
  console.error(`[legacy-mac] ${message}`);
  process.exit(1);
}

/**
 * 按优先级读取代理环境变量，返回代理 URL 字符串，无代理时返回 null。
 * 优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy
 */
function getProxyUrl() {
  const candidates = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
  for (const key of candidates) {
    const val = process.env[key];
    if (val && val.trim()) {
      return val.trim();
    }
  }
  return null;
}

/**
 * 下载文件，自动检测代理环境变量。
 * 支持 301/302/307/308 重定向，重定向后代理继续生效。
 * 先写 `.tmp`，成功后 rename；失败时删除临时文件。
 * 设置 30 秒请求超时。
 */
function download(url, destPath, label) {
  const proxyUrl = getProxyUrl();
  const useProxy = !!proxyUrl;

  if (useProxy) {
    log(`downloading ${label} via proxy...`);
  } else {
    log(`downloading ${label}...`);
  }

  return new Promise((resolve, reject) => {
    const tmpPath = `${destPath}.tmp`;

    const attempt = (currentUrl, redirects) => {
      const isHttps = currentUrl.startsWith('https:');
      const mod = isHttps ? https : http;

      const options = {
        headers: { 'User-Agent': 'openchat-build-legacy-mac' },
      };

      // HTTPS 代理
      if (useProxy && isHttps) {
        let HttpsProxyAgent;
        try {
          HttpsProxyAgent = require('https-proxy-agent');
        } catch (_err) {
          reject(new Error('https-proxy-agent 未安装，无法通过代理下载。请先执行 npm install。'));
          return;
        }
        options.agent = new HttpsProxyAgent(proxyUrl);
      }
      // HTTP 代理（仅重定向到 HTTP 时可能用到）
      if (useProxy && !isHttps) {
        let HttpProxyAgent;
        try {
          HttpProxyAgent = require('http-proxy-agent');
        } catch (_err) {
          // http-proxy-agent 可能不存在，忽略代理尝试直连
        }
        if (HttpProxyAgent) {
          options.agent = new HttpProxyAgent(proxyUrl);
        }
      }

      const req = mod.get(currentUrl, options, (res) => {
        // 处理重定向（301/302/307/308）
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= 10) {
            reject(new Error('too many redirects'));
            return;
          }
          attempt(new URL(res.headers.location, currentUrl).toString(), redirects + 1);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`download failed with HTTP ${res.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(tmpPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmpPath, destPath);
            resolve();
          });
        });
        file.on('error', (err) => {
          fs.unlink(tmpPath, () => {});
          reject(err);
        });
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        fs.unlink(tmpPath, () => {});
        reject(new Error(`download timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });

      req.on('error', (err) => {
        fs.unlink(tmpPath, () => {});
        reject(err);
      });
    };

    attempt(url, 0);
  });
}

/**
 * 返回项目内的 7za 路径（来自 electron-builder 依赖的 7zip-bin）。
 * 无法加载时直接失败，不要求用户安装 Homebrew 或系统 7z。
 */
function resolve7za() {
  let path7za;
  try {
    path7za = require('7zip-bin').path7za;
  } catch (err) {
    fail('无法加载 7zip-bin（electron-builder 依赖）。请先执行 npm install 后再运行此命令。');
  }

  if (!path7za || !fs.existsSync(path7za)) {
    fail(`7zip-bin 提供的 7za 不存在：${path7za}`);
  }

  try {
    fs.chmodSync(path7za, 0o755);
  } catch (_err) {
    // 忽略 chmod 失败
  }

  return path7za;
}

/**
 * 在目录树中查找文件（深度优先，有限深度）。
 */
function findFile(dir, name, maxDepth) {
  if (maxDepth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 解压 .7z 到临时目录，然后整理到 targetDir。
 *
 * 7z 压缩包可能有两种结构：
 *   - 内容直接包含 mac/、Include/、Plugins/ 等（无顶层目录）
 *   - 内容被一个顶层目录包裹（如 nsis-3.0.4.1/）
 *
 * 解压后统一处理：确保 targetDir 直接包含实际内容，不额外嵌套。
 */
function extract7z(archivePath, targetDir, path7za) {
  const extractDir = `${targetDir}.extract-tmp`;

  // 清理上次失败残留
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_err) {}

  fs.mkdirSync(extractDir, { recursive: true });

  const result = spawnSync(path7za, ['x', archivePath, `-o${extractDir}`, '-y'], {
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`7za 解压失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`7za 解压失败，退出码 ${result.status}`);
  }

  // 判断解压结果结构
  let entries;
  try {
    entries = fs.readdirSync(extractDir, { withFileTypes: true });
  } catch (_err) {
    fail(`无法读取解压目录：${extractDir}`);
  }

  const realEntries = entries.filter(e => !e.name.startsWith('.') || e.name === '.DS_Store');
  const dirs = realEntries.filter(e => e.isDirectory());
  const files = realEntries.filter(e => e.isFile());

  // 如果只有一个目录且没有文件，说明是包裹结构，需要去掉外层
  if (dirs.length === 1 && files.length === 0) {
    const wrapperDir = path.join(extractDir, dirs[0].name);
    fs.renameSync(wrapperDir, targetDir);
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_err) {}
  } else {
    // 内容已在根层级，直接重命名
    if (fs.existsSync(targetDir)) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_err) {}
    }
    fs.renameSync(extractDir, targetDir);
  }
}

/**
 * 下载并解压 .7z 归档到目标目录。
 * 下载的 .7z 文件缓存到项目本地目录，解压仅在目标目录不存在时执行。
 */
async function fetchAndExtract(label, url, archiveName, targetDir) {
  fs.mkdirSync(BUILD_CACHE_DIR, { recursive: true });

  const archivePath = path.join(BUILD_CACHE_DIR, archiveName);

  if (!fs.existsSync(archivePath)) {
    await download(url, archivePath, label);
  }

  if (!fs.existsSync(targetDir)) {
    log(`extracting ${label}...`);
    const path7za = resolve7za();
    extract7z(archivePath, targetDir, path7za);
  }
}

/**
 * 准备兼容版 makensis：从 nsis-3.0.3.0 中提取 mac/makensis，返回其路径。
 */
async function prepareCompatibleMakensis() {
  const compatDir = path.join(BUILD_CACHE_DIR, 'nsis-3.0.3.0');

  await fetchAndExtract(
    'compatible makensis',
    COMPAT_MAKENSIS_URL,
    'nsis-3.0.3.0.7z',
    compatDir
  );

  const compatMakensis = path.join(compatDir, 'mac', 'makensis');
  if (fs.existsSync(compatMakensis)) {
    try { fs.chmodSync(compatMakensis, 0o755); } catch (_err) {}
    return compatMakensis;
  }

  // 兜底：搜索
  const found = findFile(compatDir, 'makensis', 4);
  if (!found) {
    fail('解压后未找到兼容版 mac/makensis');
  }
  try { fs.chmodSync(found, 0o755); } catch (_err) {}
  return found;
}

/**
 * 验证 makensis 不依赖 ____chkstk_darwin。
 */
function verifyMakensisCompatible(makensisPath) {
  const result = spawnSync('nm', ['-u', makensisPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fail(`nm -u ${makensisPath} 失败，无法验证 makensis 兼容性`);
  }
  if (result.stdout.includes('____chkstk_darwin')) {
    fail(
      'makensis 替换失败：____chkstk_darwin 仍然存在。\n' +
      '兼容版二进制可能版本不正确。'
    );
  }
}

/**
 * 用兼容版 makensis 替换 nsis-3.0.4.1 中的版本。
 * 备份原文件、chmod、并验证替换结果。
 */
function patchMakensis(targetMakensis, compatMakensis) {
  if (fs.existsSync(targetMakensis)) {
    const backupPath = `${targetMakensis}.10.15.original`;
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(targetMakensis, backupPath);
    }
  }

  fs.copyFileSync(compatMakensis, targetMakensis);
  fs.chmodSync(targetMakensis, 0o755);

  verifyMakensisCompatible(targetMakensis);
}

/**
 * 执行项目本地 electron-builder（仅一次）。
 */
function runElectronBuilder() {
  const builderBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'electron-builder');
  if (!fs.existsSync(builderBin)) {
    fail(`未找到本地 electron-builder：${builderBin}`);
  }

  const env = Object.assign({}, process.env, {
    NSISDIR: NSIS_4041_DIR,
  });

  const result = spawnSync(builderBin, ['--win', 'portable'], {
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    fail(`electron-builder 执行失败：${result.error.message}`);
  }

  return result.status === null ? 1 : result.status;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (process.platform !== 'darwin') {
    fail('此命令仅用于旧版 macOS（10.13）。正常构建请使用：npm run package:win:portable');
  }

  // 1. 准备 NSIS 3.0.4.1 资源（脚本自行下载，不依赖 electron-builder）
  await fetchAndExtract(
    'NSIS 3.0.4.1',
    NSIS_4041_URL,
    'nsis-3.0.4.1.7z',
    NSIS_4041_DIR
  );

  // 2. 准备 NSIS resources 3.4.1
  await fetchAndExtract(
    'NSIS resources 3.4.1',
    NSIS_RESOURCES_URL,
    'nsis-resources-3.4.1.7z',
    NSIS_RESOURCES_DIR
  );

  // 3. 验证 NSIS 3.0.4.1 的 makensis 存在
  const targetMakensis = path.join(NSIS_4041_DIR, 'mac', 'makensis');
  if (!fs.existsSync(targetMakensis)) {
    fail(
      `NSIS 3.0.4.1 的 makensis 不存在：${targetMakensis}\n` +
      '7z 压缩包结构可能与预期不符，请检查解压结果。'
    );
  }

  // 4. 准备兼容版 makensis（来自 nsis-3.0.3.0）
  const compatMakensis = await prepareCompatibleMakensis();

  // 5. 替换 makensis
  log('patching makensis for macOS 10.13');
  patchMakensis(targetMakensis, compatMakensis);

  // 6. 执行 electron-builder（仅此一次）
  log('building Windows portable package...');
  const code = runElectronBuilder();
  process.exit(code);
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});