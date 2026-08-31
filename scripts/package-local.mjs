import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REQUIRED_OUTPUTS = [
  'manifest.json',
  'sidepanel.html',
  'offscreen.html',
  'background.js',
  'audio/buy-alert.wav',
];

export const artifactName = (version) =>
  `Fomo-Live-Feed-v${version}-chrome.zip`;

const escapeHtml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export const renderGuide = ({ version, builtAt }) => {
  const safeVersion = escapeHtml(version);
  const safeBuiltAt = escapeHtml(builtAt);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Fomo Live Feed · 开始使用</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    body { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; line-height: 1.65; }
    h1 { margin-bottom: 4px; } h2 { margin-top: 32px; }
    .meta { color: #64748b; font-size: 13px; }
    .card { padding: 16px 18px; border: 1px solid #94a3b8; border-radius: 10px; margin: 14px 0; }
    code { padding: 2px 5px; border-radius: 4px; background: rgb(148 163 184 / 20%); }
    li + li { margin-top: 7px; }
    .safe { border-color: #22c55e; }
    @media (max-width: 520px) { body { padding: 20px 14px 48px; } }
  </style>
</head>
<body>
  <h1>Fomo Live Feed</h1>
  <p class="meta">版本 ${safeVersion} · 构建时间 ${safeBuiltAt}</p>

  <h2>四步完成安装</h2>
  <div class="card">
    <p><strong>Windows：</strong>右键 ZIP，选择“全部解压缩”，再选择解压后的文件夹。</p>
    <p><strong>macOS：</strong>连按两下 ZIP 完成解压，再选择解压后的文件夹。</p>
  </div>
  <ol class="card">
    <li>把收到的 ZIP 压缩包解压到一个固定目录。</li>
    <li>在 Chrome 地址栏打开 <code>chrome://extensions</code>。</li>
    <li>打开右上角的“开发者模式”。</li>
    <li>点击“加载已解压的扩展程序”，选择刚才解压的目录。</li>
  </ol>

  <h2>安装后如何开始</h2>
  <ol class="card">
    <li>打开 <code>https://fomo.family/</code> 并登录。</li>
    <li>安装或更新插件后，刷新一次 Fomo 页面。</li>
    <li>点击 Chrome 工具栏里的 Fomo Live Feed 图标，打开右侧信息流（Side Panel）。</li>
    <li>关注交易员的新动态会实时进入 Side Panel；插件不会在交易页面额外弹出通知卡片。</li>
  </ol>
  <p>插件从已登录的 Fomo 页面观察实时动态。使用期间请至少保持一个已登录的 Fomo 标签页开启。</p>

  <h2>没有看到消息？</h2>
  <ul class="card">
    <li>确认使用 Chrome 138 或更新版本。</li>
    <li>确认 Fomo 已登录，而且标签页没有关闭。</li>
    <li>安装、更新或重新加载插件后，刷新一次 Fomo 页面。</li>
    <li>打开 Side Panel，检查连接状态和诊断信息。</li>
    <li>实时列表只会显示关注交易员之后产生并被插件捕获的活动。</li>
  </ul>

  <h2>以后如何更新</h2>
  <ol class="card">
    <li>退出 Chrome 后，用新版压缩包内容替换旧目录中的文件。</li>
    <li>重新打开 <code>chrome://extensions</code>，点击插件卡片上的“重新加载”。</li>
    <li>刷新已经打开的 Fomo 页面。</li>
  </ol>

  <h2>隐私与安全</h2>
  <div class="card safe">
    <p>插件不连接钱包，不读取助记词或私钥，不请求签名，不代替用户交易，也不会索要 Fomo 登录凭据。</p>
    <p>插件只在本地保存所需的动态历史和设置。</p>
  </div>
</body>
</html>
`;
};

export const parseManifest = (source, expectedVersion) => {
  let manifest;

  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error('invalid manifest.json');
  }

  if (
    manifest?.manifest_version !== 3 ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error(
      'manifest.json must describe a versioned Manifest V3 extension',
    );
  }

  if (manifest.version !== expectedVersion) {
    throw new Error(
      `manifest version ${manifest.version} does not match package version ${expectedVersion}`,
    );
  }

  return manifest;
};

const BANNED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  '.output',
  'tests',
  'src',
  '.wxt',
]);

export const assertAllowedRelativePaths = (paths) => {
  for (const path of paths) {
    const segments = path.split('/');
    const banned =
      path.includes('\\') ||
      segments.includes('__MACOSX') ||
      segments.some((segment) => BANNED_SEGMENTS.has(segment)) ||
      segments.some(
        (segment) => segment === '.env' || segment.startsWith('.env.'),
      );

    if (banned) {
      throw new Error(`banned release path: ${path}`);
    }
  }
};

export const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });

const listRelativeFiles = async (root, current = root) => {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join('/'));
    }
  }

  return files.sort();
};

const requireFile = async (path, label) => {
  try {
    await readFile(path);
  } catch {
    throw new Error(`missing required release file: ${label}`);
  }
};

export const packageLocalRelease = async ({
  projectRoot,
  builtAt = new Date().toISOString(),
}) => {
  const root = resolve(projectRoot);
  const packageSource = await readFile(join(root, 'package.json'), 'utf8');
  const packageMetadata = JSON.parse(packageSource);
  const version = packageMetadata.version;

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json must contain a release version');
  }

  const sourceDirectory = join(root, '.output', 'chrome-mv3');
  for (const required of REQUIRED_OUTPUTS) {
    await requireFile(join(sourceDirectory, required), required);
  }

  const manifestSource = await readFile(
    join(sourceDirectory, 'manifest.json'),
    'utf8',
  );
  parseManifest(manifestSource, version);

  const outputDirectory = join(root, '.output');
  const stagingDirectory = join(outputDirectory, 'local-release');
  const releasesDirectory = join(outputDirectory, 'releases');
  const filename = artifactName(version);
  const artifactPath = join(releasesDirectory, filename);
  const temporaryArtifactPath = join(releasesDirectory, `.${filename}.tmp.zip`);
  const checksumPath = `${artifactPath}.sha256`;

  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(releasesDirectory, { recursive: true });
  await cp(sourceDirectory, stagingDirectory, { recursive: true });
  await writeFile(
    join(stagingDirectory, 'START-HERE.html'),
    renderGuide({ version, builtAt }),
    'utf8',
  );

  const stagedFiles = await listRelativeFiles(stagingDirectory);
  assertAllowedRelativePaths(stagedFiles);
  for (const required of [...REQUIRED_OUTPUTS, 'START-HERE.html']) {
    if (!stagedFiles.includes(required)) {
      throw new Error(`missing required staged file: ${required}`);
    }
  }

  await rm(temporaryArtifactPath, { force: true });
  await execFileAsync('zip', ['-q', '-r', temporaryArtifactPath, '.'], {
    cwd: stagingDirectory,
  });

  const { stdout } = await execFileAsync(
    'unzip',
    ['-Z1', temporaryArtifactPath],
    { encoding: 'utf8' },
  );
  const archiveEntries = stdout.trim().split('\n').filter(Boolean);
  assertAllowedRelativePaths(archiveEntries);
  if (!archiveEntries.includes('manifest.json')) {
    throw new Error('release archive must contain manifest.json at its root');
  }
  if (!archiveEntries.includes('START-HERE.html')) {
    throw new Error('release archive must contain START-HERE.html at its root');
  }

  await rm(artifactPath, { force: true });
  await rename(temporaryArtifactPath, artifactPath);
  const digest = await sha256File(artifactPath);
  await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`, 'utf8');

  return { artifactPath, checksumPath };
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === resolve(invokedPath)
) {
  packageLocalRelease({ projectRoot: process.cwd() })
    .then(({ artifactPath, checksumPath }) => {
      console.log(`Release ZIP: ${artifactPath}`);
      console.log(`SHA-256: ${checksumPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
