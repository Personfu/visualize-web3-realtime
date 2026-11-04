import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const reserved = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
/** Keep state in the working directory's managed data folder; never relocate it. */
export function managedStatePath(configured, workspace = process.cwd()) {
    if (configured === ':memory:')
        return ':memory:';
    if (typeof configured !== 'string' || configured.includes('\0'))
        throw new Error('Invalid managed state configuration');
    const base = realpathSync(workspace);
    const directory = join(base, 'data');
    const candidate = resolve(base, configured);
    const file = basename(candidate);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.(?:db|sqlite|sqlite3)$/.test(file) ||
        reserved.has(file.split('.')[0].toUpperCase()) || candidate !== join(directory, file)) {
        throw new Error('State must remain in the managed data directory');
    }
    // basename removes directory control; the parent is our fixed managed root.
    return join(directory, basename(file));
}
function entry(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw new Error('Managed state metadata is unavailable');
    }
}
export function prepareStatePath(configured, workspace = process.cwd()) {
    const path = managedStatePath(configured, workspace);
    if (path === ':memory:')
        return path;
    const directory = dirname(path);
    const parent = entry(directory);
    if (parent && (parent.isSymbolicLink() || !parent.isDirectory()))
        throw new Error('Managed state directory is unsafe');
    if (!parent)
        mkdirSync(directory, { mode: 0o700 });
    for (const suffix of ['', '-wal', '-shm']) {
        const file = entry(path + suffix);
        if (file && (file.isSymbolicLink() || !file.isFile()))
            throw new Error('Managed state file is unsafe');
    }
    return path;
}
