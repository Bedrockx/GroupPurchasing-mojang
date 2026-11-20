const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const repo = path.resolve(__dirname, '..');
const client = path.join(repo, 'client');
const fromClient = createRequire(path.join(client, 'package.json'));
const group = 'js/ArtifactsGroupPurchasing';
const output = path.join(__dirname, 'out');
const release = path.join(output, 'upload');
const fullRelease = path.join(output, 'full');
const names = ['mojang.zip', 'ArtifactsGroupPurchasing.zip', 'app.asar'];

function trackedFiles(...paths) {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: repo, encoding: 'utf8' })
        .split('\0').filter(Boolean);
}

function copy(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

function makeZip(tool, folder, dest) {
    // 显式以 UTF-8 保存中文路径，并检查所有条目的 CRC。
    execFileSync(tool, ['a', '-tzip', '-mm=Deflate', '-mcu=on', '-bso0', dest, '.'], { cwd: folder, stdio: 'inherit' });
    execFileSync(tool, ['t', '-bso0', dest], { stdio: 'inherit' });
}

function buildPackages(work, ready, fullZip) {
    const zip = fromClient('7zip-bin').path7za;
    const builder = fromClient.resolve('electron-builder/cli.js');
    const electron = path.join(path.dirname(fromClient.resolve('electron/package.json')), 'dist');
    const build = path.join(work, 'build');
    execFileSync(process.execPath, [builder, '--win', 'dir', '--x64',
        '--config.directories.output=' + build, '--config.electronDist=' + electron,
        '--config.win.signAndEditExecutable=false'], { cwd: client, stdio: 'inherit' });

    const desktopFull = path.join(build, 'win-unpacked');
    const desktopUpdate = path.join(work, 'desktop-update');
    const asar = path.join(desktopFull, 'resources', 'app.asar');
    copy(asar, path.join(desktopUpdate, 'resources', 'app.asar'));
    copy(asar, path.join(ready, 'app.asar'));
    for (const file of trackedFiles('client/updater.ps1', 'client/modelUser', 'client/modelUserLcb')) {
        const relative = file.slice('client/'.length);
        copy(path.join(repo, file), path.join(desktopUpdate, relative));
        copy(path.join(repo, file), path.join(desktopFull, relative));
    }
    for (const required of ['updater.ps1', 'modelUser', 'modelUserLcb']) {
        fs.accessSync(path.join(desktopUpdate, required));
    }
    fs.accessSync(path.join(desktopFull, 'mojang.exe'));
    fs.mkdirSync(path.join(desktopFull, 'namePng'), { recursive: true });
    makeZip(zip, desktopUpdate, path.join(ready, 'mojang.zip'));
    makeZip(zip, desktopFull, fullZip);

    const groupFolder = path.join(work, 'group');
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, group, 'manifest.json'), 'utf8'));
    const entries = ['manifest.json', manifest.main, manifest.settings_ui, 'README.md'];
    const excludes = (manifest.saved_files || []).map(glob => ':(top,exclude,glob)' + group + '/' + glob);
    for (const file of trackedFiles(...entries.map(name => group + '/' + name), group + '/assets', ...excludes)) {
        if (!/\.(zip|rar|7z|log)$/i.test(file)) {
            copy(path.join(repo, file), path.join(groupFolder, file.slice(group.length + 1)));
        }
    }
    for (const name of [...entries, 'assets']) fs.accessSync(path.join(groupFolder, name));
    // 只取仓库原厂图片，不发布用户对同名文件的修改。
    const stockImage = 'assets/targetItems/保留/禽肉.png';
    if (trackedFiles(group + '/' + stockImage).length) {
        fs.mkdirSync(path.dirname(path.join(groupFolder, stockImage)), { recursive: true });
        fs.writeFileSync(path.join(groupFolder, stockImage),
            execFileSync('git', ['show', ':' + group + '/' + stockImage], { cwd: repo }));
    }
    for (const dir of ['records', 'targets']) fs.mkdirSync(path.join(groupFolder, dir));
    fs.writeFileSync(path.join(groupFolder, 'command.json'), '{}');
    makeZip(zip, groupFolder, path.join(ready, 'ArtifactsGroupPurchasing.zip'));
    return manifest.version;
}

function publishPackages(ready, previous, fullZip, fullTarget) {
    // 并行构建各用临时目录，发布时只允许一批替换输出。
    const lockPath = path.join(output, '.publish-lock');
    const lock = fs.openSync(lockPath, 'wx');
    try {
        fs.mkdirSync(fullRelease, { recursive: true });
        if (fs.existsSync(release)) {
            if (!fs.lstatSync(release).isDirectory() || fs.readdirSync(release).some(file => !names.includes(file))) {
                throw new Error('out/upload 有额外文件，请先移出后重新打包');
            }
            fs.renameSync(release, previous);
        }
        try {
            fs.renameSync(ready, release);
            // 同版本重建替换单个完整 ZIP，其他版本的完整包仍留在 full。
            fs.renameSync(fullZip, fullTarget);
        } catch (error) {
            if (!fs.existsSync(ready)) fs.renameSync(release, ready);
            if (fs.existsSync(previous)) fs.renameSync(previous, release);
            throw error;
        }
    } finally {
        fs.closeSync(lock);
        fs.unlinkSync(lockPath);
    }
}

function run() {
    const desktopVersion = fromClient('./package.json').version;
    if (typeof desktopVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(desktopVersion)) {
        throw new Error('桌面版本无法用于完整包文件名');
    }
    const fullName = `mojang-${desktopVersion}-full.zip`;
    fs.mkdirSync(output, { recursive: true });
    const work = fs.mkdtempSync(path.join(output, '.work-'));
    const ready = path.join(work, 'ready');
    const previous = path.join(work, 'previous');
    const fullZip = path.join(work, fullName);
    const fullTarget = path.join(fullRelease, fullName);
    let published = false;
    try {
        const groupVersion = buildPackages(work, ready, fullZip);
        publishPackages(ready, previous, fullZip, fullTarget);
        published = true;
        console.log('桌面版本 %s，团购版本 %s。', desktopVersion, groupVersion);
        console.log('桌面完整包 %s', fullTarget);
        console.log('上传文件目录 %s', release);
    } finally {
        // 恢复失败时保留上一批文件供取回。
        if (published || !fs.existsSync(previous)) fs.rmSync(work, { recursive: true, force: true });
        else console.error('已保留上一批文件：', previous);
    }
}

try {
    run();
} catch (error) {
    console.error('打包失败：', error.message);
    process.exitCode = 1;
}
