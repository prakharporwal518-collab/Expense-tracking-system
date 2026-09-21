import fs from 'node:fs';
import path from 'node:path';

/**
 * The database is a file, so the directory holding it must exist and be
 * writable before SQLite is opened. When it is not, the raw failure is an
 * opaque "EACCES: permission denied, mkdir '/var/data'" that names neither the
 * setting at fault nor the fix — most often a DB_FILE pointing at a mount that
 * was never attached.
 */
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENOENT']);

export class StorageError extends Error {
  constructor(directory, dbFile, cause) {
    super(`Cannot use "${directory}" for the database: ${cause.message}`);
    this.name = 'StorageError';
    this.directory = directory;
    this.dbFile = dbFile;
    this.cause = cause;
    this.guidance = buildGuidance(directory, dbFile, cause);
  }
}

function buildGuidance(directory, dbFile, cause) {
  const readOnly = cause.code === 'EROFS';
  return [
    '',
    '  ✖ FinTrack cannot open its database.',
    '',
    `    DB_FILE:  ${dbFile}`,
    `    Problem:  ${directory} ${readOnly ? 'is on a read-only filesystem' : 'is not writable'} (${cause.code})`,
    '',
    '    This usually means DB_FILE points at a disk that is not mounted.',
    '',
    '    Fix — pick one:',
    '',
    '      1. Keep the data (needs a persistent disk)',
    `         Render → Disks → Add Disk, Mount Path "${directory}".`,
    '         Disks require a paid instance type. Leave DB_FILE as it is.',
    '',
    '      2. Run without a disk (data resets on every deploy)',
    '         Render → Environment → delete the DB_FILE variable.',
    '         It then defaults to ./data inside the project, which is writable.',
    '         Fine for a demo; do not use it for records you want to keep.',
    '',
    '      3. Running locally',
    '         Point DB_FILE at a directory you can write to, or unset it.',
    '',
    ''
  ].join('\n');
}

/** Creates the database directory if needed and proves it is writable. */
export function ensureDbLocation(dbFile) {
  if (dbFile === ':memory:') return;
  const directory = path.dirname(path.resolve(dbFile));
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
  } catch (err) {
    if (UNWRITABLE.has(err.code)) throw new StorageError(directory, dbFile, err);
    throw err;
  }
}
